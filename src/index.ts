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
          creator: { id: { eq: $userId } }
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
    query($teamId: ID!) {
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
  backlogStateId: string,
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
  `, { id: issueId, stateId: backlogStateId, assigneeId: userId });
}

function buildRepoPaths(): { label: string; path: string }[] {
  const repos: { label: string; path: string }[] = [];
  if (DOCS_REPO_PATH) repos.push({ label: "docs", path: DOCS_REPO_PATH });
  if (MONOREPO_PATH) repos.push({ label: "monorepo", path: MONOREPO_PATH });
  if (repos.length === 0) repos.push({ label: "repo", path: REPO_PATH });
  return repos;
}

function runClaudeAgent(issue: LinearIssue, repoPaths: { label: string; path: string }[]): Promise<void> {
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

  const prompt = `You are working on a software project. Your task is to implement the solution for a Linear issue and open a GitHub PR.

## Linear Issue

**ID:** ${issue.identifier}
**Title:** ${issue.title}
**URL:** ${issue.url}
**Description:**
${issue.description || "(no description provided)"}

## Repos

${repoSection}

## Instructions

1. ${repoInstruction}
2. Read the relevant codebase(s) to understand the code for this issue.
3. Implement the solution described in the issue.
4. Create a new git branch named \`${issue.identifier.toLowerCase()}-${issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}\` in the repo(s) you are changing.
5. Commit your changes with a descriptive message referencing the issue identifier.
6. Push the branch and create a GitHub PR using \`gh pr create\` for each repo you changed. Each PR body must include:
   - A summary of the changes made
   - A **Test Plan** section with a markdown checklist of concrete steps a reviewer can follow to verify the changes work correctly (e.g. specific commands to run, UI flows to exercise, edge cases to check)
   - A link to the Linear issue: ${issue.url}
7. Output the PR URL(s) when done.

Work autonomously and make reasonable decisions. If the description is unclear, implement your best interpretation.`;

  const primaryRepoPath = repoPaths[0].path;

  return new Promise((resolve, reject) => {
    log(`Starting Claude agent for ${issue.identifier}: ${issue.title}`);
    repoPaths.forEach((r) => log(`  Repo [${r.label}]: ${r.path}`));

    const child = spawn(
      "claude",
      ["--dangerously-skip-permissions", "--print", prompt],
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

  const triageIssues = await getTriageIssues(user.id);
  log(`Found ${triageIssues.length} triage issue(s) created by you`);

  if (triageIssues.length === 0) {
    log("Nothing to do.");
    return;
  }

  const backlogStateByTeam = new Map<string, string>();

  for (const issue of triageIssues) {
    log(`Processing ${issue.identifier}: ${issue.title}`);

    if (!backlogStateByTeam.has(issue.team.id)) {
      const states = await getTeamStates(issue.team.id);
      const backlog = states.find(
        (s) => s.type === "backlog" || s.name.toLowerCase() === "backlog"
      );
      if (!backlog) {
        logError(`Could not find Backlog state for team ${issue.team.name}, skipping`);
        continue;
      }
      backlogStateByTeam.set(issue.team.id, backlog.id);
    }

    const backlogStateId = backlogStateByTeam.get(issue.team.id)!;

    await updateIssue(issue.id, backlogStateId, user.id);
    log(`  Updated: moved to Backlog, assigned to ${user.name}, priority Medium`);

    try {
      await runClaudeAgent(issue, repoPaths);
    } catch (err) {
      logError(`Claude agent failed for ${issue.identifier}: ${err}`);
    }
  }

  log(`Done`);
}

main().catch((err) => {
  logError(String(err));
  process.exit(1);
});
