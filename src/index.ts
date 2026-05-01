import "dotenv/config";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

const LINEAR_API_URL = "https://api.linear.app/graphql";
const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
const DOCS_REPO_PATH = process.env.DOCS_REPO_PATH;
const MONOREPO_PATH = process.env.MONOREPO_PATH;
const REPO_PATH = process.env.REPO_PATH || process.cwd();
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, "..", "linear-pr-gen.log");
const PUSHOVER_TOKEN = process.env.PUSHOVER_TOKEN;
const PUSHOVER_USER = process.env.PUSHOVER_USER;
const GIT_USER_NAME = process.env.GIT_USER_NAME;
const GIT_USER_EMAIL = process.env.GIT_USER_EMAIL;

if (!LINEAR_API_KEY) {
  writeLog("ERROR", "LINEAR_API_KEY environment variable is required");
  process.exit(1);
}

function writeLog(level: "INFO" | "ERROR", message: string) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

function log(message: string) {
  writeLog("INFO", message);
}

function logError(message: string) {
  writeLog("ERROR", message);
}

interface LinearComment {
  id: string;
  body: string;
  createdAt: string;
  user: {
    name: string;
  };
}

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  team: {
    id: string;
    name: string;
  };
  state: {
    id: string;
    name: string;
  };
  comments: {
    nodes: LinearComment[];
  };
}

interface LinearState {
  id: string;
  name: string;
  type: string;
}

async function linearQuery<T>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: LINEAR_API_KEY!,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await response.json()) as { data: T; errors?: unknown[] };
  if (json.errors) {
    throw new Error(`Linear API error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

async function getCurrentUser(): Promise<{ id: string; name: string; email: string }> {
  const data = await linearQuery<{ viewer: { id: string; name: string; email: string } }>(`
    query {
      viewer {
        id
        name
        email
      }
    }
  `);
  return data.viewer;
}


async function getTriageIssues(userId: string): Promise<LinearIssue[]> {
  const data = await linearQuery<{
    issues: { nodes: LinearIssue[] };
  }>(`
    query($userId: ID!) {
      issues(
        filter: {
          or: [
            { creator: { id: { eq: $userId } } }
            { assignee: { id: { eq: $userId } } }
          ]
          state: { type: { eq: "triage" } }
        }
        first: 50
      ) {
        nodes {
          id
          identifier
          title
          description
          url
          team {
            id
            name
          }
          state {
            id
            name
          }
          comments(orderBy: createdAt) {
            nodes {
              id
              body
              createdAt
              user {
                name
              }
            }
          }
        }
      }
    }
  `, { userId });
  return data.issues.nodes;
}

async function getTeamStates(teamId: string): Promise<LinearState[]> {
  const data = await linearQuery<{
    team: { states: { nodes: LinearState[] } };
  }>(`
    query($teamId: String!) {
      team(id: $teamId) {
        states {
          nodes {
            id
            name
            type
          }
        }
      }
    }
  `, { teamId });
  return data.team.states.nodes;
}

async function updateIssue(
  issueId: string,
  inProgressStateId: string,
  userId: string
): Promise<void> {
  await linearQuery(`
    mutation($id: String!, $stateId: String!, $assigneeId: String!) {
      issueUpdate(
        id: $id
        input: {
          stateId: $stateId
          assigneeId: $assigneeId
          priority: 3
        }
      ) {
        success
        issue {
          id
          identifier
          state { name }
          assignee { name }
          priority
        }
      }
    }
  `, { id: issueId, stateId: inProgressStateId, assigneeId: userId });
}

async function sendPushover(title: string, message: string): Promise<void> {
  if (!PUSHOVER_TOKEN || !PUSHOVER_USER) return;
  try {
    await fetch("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: PUSHOVER_TOKEN, user: PUSHOVER_USER, title, message }),
    });
  } catch (err) {
    logError(`Pushover notification failed: ${err}`);
  }
}

interface ExistingPR {
  repoLabel: string;
  repoPath: string;
  url: string;
  number: number;
  title: string;
  headRefName: string;
}

async function findExistingPRs(
  issueIdentifier: string,
  repoPaths: { label: string; path: string }[]
): Promise<ExistingPR[]> {
  const results: ExistingPR[] = [];
  for (const repo of repoPaths) {
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          "gh",
          ["pr", "list", "--search", issueIdentifier, "--state", "open", "--json", "url,number,title,headRefName"],
          { cwd: repo.path, env: { ...process.env } }
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on("close", (code) => {
          if (code === 0) resolve(stdout);
          else reject(new Error(stderr));
        });
        child.on("error", reject);
      });
      const prs = JSON.parse(output || "[]") as { url: string; number: number; title: string; headRefName: string }[];
      for (const pr of prs) {
        results.push({ repoLabel: repo.label, repoPath: repo.path, ...pr });
      }
    } catch (err) {
      log(`Could not search PRs in ${repo.label}: ${err}`);
    }
  }
  return results;
}

function buildRepoPaths(): { label: string; path: string }[] {
  const repos: { label: string; path: string }[] = [];
  if (DOCS_REPO_PATH) repos.push({ label: "docs", path: DOCS_REPO_PATH });
  if (MONOREPO_PATH) repos.push({ label: "monorepo", path: MONOREPO_PATH });
  if (repos.length === 0) repos.push({ label: "repo", path: REPO_PATH });
  return repos;
}

function runClaudeAgent(
  issue: LinearIssue,
  repoPaths: { label: string; path: string }[],
  existingPRs: ExistingPR[]
): Promise<void> {
  const repoSection =
    repoPaths.length === 1
      ? `**Repo path:** ${repoPaths[0].path}`
      : repoPaths
          .map((r) => `- **${r.label}:** ${r.path}`)
          .join("\n");

  const repoInstruction =
    repoPaths.length === 1
      ? `Work in the repo at ${repoPaths[0].path}.`
      : `You have access to multiple repos listed above. Read the issue and choose the most appropriate repo (or repos) to make changes in. Implement all changes needed across whichever repos are relevant.`;

  const commentsSection =
    issue.comments.nodes.length > 0
      ? `\n## Comments\n\n${issue.comments.nodes
          .map(
            (c) =>
              `**${c.user?.name ?? "Unknown"}** (${new Date(c.createdAt).toLocaleString()}):\n${c.body}`
          )
          .join("\n\n")}`
      : "";

  const existingPRSection =
    existingPRs.length > 0
      ? `\n## Existing Pull Request(s)\n\n${existingPRs
          .map(
            (pr) =>
              `- [${pr.repoLabel}] **${pr.title}** — ${pr.url}\n  Branch: \`${pr.headRefName}\` in \`${pr.repoPath}\``
          )
          .join("\n")}\n`
      : "";

  const branchInstruction =
    existingPRs.length > 0
      ? existingPRs
          .map(
            (pr) =>
              `For repo [${pr.repoLabel}], check out the existing branch \`${pr.headRefName}\` in \`${pr.repoPath}\` and update it.`
          )
          .join(" ")
      : `Create a new git branch named \`${issue.identifier.toLowerCase()}-${issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}\` in the repo(s) you are changing.`;

  const prInstruction =
    existingPRs.length > 0
      ? `Push the updated branch(es) and update the existing PR(s) listed above (use \`gh pr edit\` if needed). Each PR body must include:\n   - A summary of the changes made\n   - A **Test Plan** section with a markdown checklist of concrete steps a reviewer can follow to verify the changes work correctly\n   - A link to the Linear issue: ${issue.url}`
      : `Push the branch and create a GitHub PR using \`gh pr create\` for each repo you changed. Each PR body must include:\n   - A summary of the changes made\n   - A **Test Plan** section with a markdown checklist of concrete steps a reviewer can follow to verify the changes work correctly (e.g. specific commands to run, UI flows to exercise, edge cases to check)\n   - A link to the Linear issue: ${issue.url}`;

  const prompt = `You are working on a software project. Your task is to implement the solution for a Linear issue and open a GitHub PR.

## Linear Issue

**ID:** ${issue.identifier}
**Title:** ${issue.title}
**URL:** ${issue.url}
**Description:**
${issue.description || "(no description provided)"}
${commentsSection}
## Repos

${repoSection}
${existingPRSection}
## Instructions

1. ${repoInstruction}
2. Read the relevant codebase(s) to understand the code for this issue.
3. Implement the solution described in the issue. If there are comments on the issue, treat the most recent comments as the authoritative direction — they may override or refine the original description.
4. ${branchInstruction}
5. Commit your changes with a descriptive message referencing the issue identifier.
6. ${prInstruction}
7. Output the PR URL(s) when done.

Work autonomously and make reasonable decisions. If the description is unclear, implement your best interpretation.`;

  const primaryRepoPath = repoPaths[0].path;

  return new Promise((resolve, reject) => {
    log(`Starting Claude agent for ${issue.identifier}: ${issue.title}`);
    repoPaths.forEach((r) => log(`  Repo [${r.label}]: ${r.path}`));

    const child = spawn(
      "claude",
      ["--permission-mode", "bypassPermissions", "--print", prompt],
      {
        cwd: primaryRepoPath,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      }
    );

    child.stdout.on("data", (chunk: Buffer) => {
      fs.appendFileSync(LOG_FILE, chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      fs.appendFileSync(LOG_FILE, chunk);
    });

    child.on("close", (code) => {
      if (code === 0) {
        log(`Agent completed for ${issue.identifier}`);
        resolve();
      } else {
        logError(`Agent failed for ${issue.identifier} (exit code ${code})`);
        reject(new Error(`Claude agent exited with code ${code}`));
      }
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to spawn Claude agent: ${err.message}`));
    });
  });
}

async function main() {
  const repoPaths = buildRepoPaths();
  log(`Starting linear-claude-pr-generator`);
  repoPaths.forEach((r) => log(`  Repo [${r.label}]: ${path.resolve(r.path)}`));
  log(`  Log file: ${LOG_FILE}`);

  const user = await getCurrentUser();
  log(`Authenticated as: ${user.name} (${user.email})`);

  const gitAuthorName = GIT_USER_NAME || user.name;
  const gitAuthorEmail = GIT_USER_EMAIL || user.email;
  process.env.GIT_AUTHOR_NAME = gitAuthorName;
  process.env.GIT_AUTHOR_EMAIL = gitAuthorEmail;
  process.env.GIT_COMMITTER_NAME = gitAuthorName;
  process.env.GIT_COMMITTER_EMAIL = gitAuthorEmail;
  log(`Git author: ${gitAuthorName} <${gitAuthorEmail}>`);

  log(`Fetching triage issues created by or assigned to ${user.email}`);
  const triageIssues = await getTriageIssues(user.id);
  log(`Found ${triageIssues.length} triage issue(s)`);

  if (triageIssues.length === 0) {
    log("Nothing to do.");
    return;
  }

  // Process only the first triage issue per run to avoid long-running overlaps
  const issue = triageIssues[0];
  log(`Processing ${issue.identifier}: ${issue.title} (${triageIssues.length - 1} remaining)`);

  const states = await getTeamStates(issue.team.id);
  const inProgress = states.find(
    (s) => s.type === "started" || s.name.toLowerCase() === "in progress"
  );
  if (!inProgress) {
    logError(`Could not find In Progress state for team ${issue.team.name}, skipping`);
    return;
  }

  await updateIssue(issue.id, inProgress.id, user.id);
  log(`  Updated: moved to In Progress, assigned to ${user.email}, priority Medium`);

  const existingPRs = await findExistingPRs(issue.identifier, repoPaths);
  if (existingPRs.length > 0) {
    log(`  Found ${existingPRs.length} existing PR(s) for ${issue.identifier}: ${existingPRs.map((p) => p.url).join(", ")}`);
  }

  try {
    await runClaudeAgent(issue, repoPaths, existingPRs);
    log(`Done`);
    await sendPushover(
      `PR ready: ${issue.identifier}`,
      `${issue.title}\n${issue.url}`
    );
  } catch (err) {
    logError(`Claude agent failed for ${issue.identifier}: ${err}`);
    await sendPushover(
      `PR failed: ${issue.identifier}`,
      `${issue.title} — agent exited with error. Check logs.`
    );
  }
}

main().catch((err) => {
  logError(String(err));
  process.exit(1);
});
