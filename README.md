# linear-claude-pr-generator

Picks up your Linear triage issues and autonomously implements them as GitHub PRs using Claude Code.

For each issue in Triage that you created, it:

1. Moves the issue to Backlog, assigns it to you, and sets priority to Medium
2. Spawns a `claude` agent in your local repo that reads the codebase, implements the fix, and opens a GitHub PR

All output is written to a log file (default: `linear-pr-gen.log` in the project root) so it runs cleanly under cron.

---

## Prerequisites

Install these before starting:

| Tool | Install | Verify |
|------|---------|--------|
| Node.js 18+ | [nodejs.org](https://nodejs.org) or `brew install node` | `node --version` |
| Claude Code CLI | `npm install -g @anthropic-ai/claude-code` | `claude --version` |
| GitHub CLI | `brew install gh` or [cli.github.com](https://cli.github.com) | `gh --version` |
| Git | Pre-installed on most systems | `git --version` |

---

## Installation

```bash
git clone https://github.com/your-org/linear-claude-pr-generator
cd linear-claude-pr-generator
npm install
npm run build
```

---

## Configuration

### 1. Create your `.env` file

```bash
cp .env.example .env
```

Open `.env` and fill in each value (see the sections below for how to get each one).

### 2. Linear API key

1. Go to [linear.app/settings/api](https://linear.app/settings/api)
2. Click **Create key**, give it a name (e.g. `claude-pr-gen`)
3. Copy the key — it starts with `lin_api_`
4. Set `LINEAR_API_KEY=lin_api_...` in `.env`

The tool will act as whichever Linear user owns this key.

### 3. GitHub token

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens) and click **Generate new token (classic)**
2. Give it a name, set expiration, and check these scopes:
   - `repo` (full repo access — needed to push branches and open PRs)
   - `workflow` (needed if any repos use GitHub Actions)
3. Copy the token — it starts with `ghp_`
4. Set `GH_TOKEN=ghp_...` in `.env`

The `gh` CLI will use this token automatically via the environment variable — no separate `gh auth login` needed when running under cron.

### 4. Claude / Anthropic API key

**Standard account:**
1. Go to [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. Click **Create Key**, copy it — it starts with `sk-ant-`
3. Set `ANTHROPIC_API_KEY=sk-ant-...` in `.env`

**Enterprise account:**
- Use the API key issued by your organization (format may vary)
- If your org uses a custom API gateway or proxy, also set `ANTHROPIC_BASE_URL=https://your-enterprise-endpoint`
- Leave `ANTHROPIC_BASE_URL` unset to use the default Anthropic API

### 5. Authenticate Claude Code CLI

The `claude` CLI needs to be authenticated once on the machine. Run this interactively (not under cron):

```bash
claude
```

Follow the login prompts. After authenticating, the CLI stores credentials locally and subsequent runs (including cron) will use them automatically alongside `ANTHROPIC_API_KEY`.

### 6. Repo paths

Set `DOCS_REPO_PATH` and/or `MONOREPO_PATH` to the absolute paths of your local git repos:

```
DOCS_REPO_PATH=/Users/you/code/my-docs
MONOREPO_PATH=/Users/you/code/my-monorepo
```

When both are set, the Claude agent receives both paths in its prompt and decides which repo (or repos) to make changes in based on the issue content. If a single issue touches both, it will implement changes and open PRs in each.

Each repo must:
- Have a GitHub remote (so `gh pr create` can push and open PRs)
- Have a clean working tree before each run (the agent will create its own branch)

If neither `DOCS_REPO_PATH` nor `MONOREPO_PATH` is set, the tool falls back to `REPO_PATH`, or the current working directory if that is also unset.

### 7. Log file (optional)

By default logs are written to `linear-pr-gen.log` in this project's root. To change the location:

```
LOG_FILE=/var/log/linear-pr-gen.log
```

Make sure the directory exists and is writable. Logs append on each run — rotate with `logrotate` or a similar tool if needed.

---

## Running manually

```bash
# Build and run
npm run build
npm start

# Or run without building (development)
npm run dev
```

Tail the log in a separate terminal:

```bash
tail -f linear-pr-gen.log
```

---

## Running on a cron schedule

Build once, then add a cron entry. To edit your crontab:

```bash
crontab -e
```

Example — run every hour at :00:

```cron
0 * * * * cd /path/to/linear-claude-pr-generator && /usr/local/bin/node dist/index.js >> /tmp/cron-stderr.log 2>&1
```

Tips for cron:
- Use absolute paths everywhere — cron runs with a minimal `PATH`
- Find your node path with `which node`, your project path with `pwd`
- The `>> /tmp/cron-stderr.log 2>&1` redirect captures any startup errors that happen before the log file is initialized (e.g. missing `.env`)
- The `.env` file is loaded automatically by dotenv as long as cron runs from the project directory (`cd /path/to/project`)
- `GH_TOKEN` and `ANTHROPIC_API_KEY` in `.env` mean you don't need interactive `gh auth login` or `claude` login flows in cron

**macOS note:** On macOS, cron jobs may be blocked by Full Disk Access. If the agent can't read files in your repo, go to System Settings → Privacy & Security → Full Disk Access and add `/usr/sbin/cron`.

---

## Environment variable reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LINEAR_API_KEY` | Yes | — | Linear API key (`lin_api_...`) |
| `DOCS_REPO_PATH` | No | — | Absolute path to the docs repo Claude can work in |
| `MONOREPO_PATH` | No | — | Absolute path to the monorepo Claude can work in |
| `REPO_PATH` | No | `cwd` | Fallback repo path (used only when both above are unset) |
| `GH_TOKEN` | Yes | — | GitHub token for `gh` CLI — needs `repo` scope |
| `ANTHROPIC_API_KEY` | Yes | — | Anthropic/Claude API key (`sk-ant-...`) |
| `ANTHROPIC_BASE_URL` | No | `https://api.anthropic.com` | Override for enterprise API endpoints |
| `LOG_FILE` | No | `./linear-pr-gen.log` | Path to the append-only log file |

---

## How it works

1. Authenticates with Linear using your API key and resolves your user ID
2. Queries for all issues in Triage state that you created
3. For each issue:
   - Fetches the team's workflow states and finds the Backlog state
   - Updates the issue: moves to Backlog, assigns to you, sets priority to Medium
   - Spawns `claude --dangerously-skip-permissions --print <prompt>` with all configured repo paths in the prompt
   - The agent determines which repo(s) are relevant, creates a branch in each, implements the fix, commits, and opens a GitHub PR per repo
4. All output (including the claude agent's full output) is appended to the log file
5. Issues are processed sequentially — one agent at a time

The branch name format is `<identifier>-<slugified-title>` (e.g. `eng-42-fix-login-redirect`), truncated to keep it reasonable.

---

## Troubleshooting

**"LINEAR_API_KEY environment variable is required"**
The `.env` file isn't being found. Make sure it exists in the project root and you ran `cp .env.example .env`.

**`gh pr create` fails with auth error**
Confirm `GH_TOKEN` is set in `.env` and has the `repo` scope. Test with `GH_TOKEN=your_token gh auth status`.

**Claude agent exits with a non-zero code**
Check the log file — the full agent output is captured there. Common causes: the repo has uncommitted changes, the branch already exists, or `ANTHROPIC_API_KEY` is invalid.

**No issues processed**
The tool only picks up issues that are in Triage state AND were created by the Linear user who owns `LINEAR_API_KEY`. Check both conditions in Linear.

**cron job runs but nothing happens**
Add `env > /tmp/cron-env.log` as a line before the main command to inspect what environment cron sees. Verify the `.env` path is correct and the node binary path matches `which node`.
