# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build   # compile TypeScript → dist/
npm start       # run compiled output
npm run dev     # run via ts-node (no build step)
```

There are no tests. `npm run build` is the only verification step.

## Architecture

The entire implementation lives in `src/index.ts` — a single TypeScript file compiled to `dist/index.js`. There are no modules, classes, or helper files.

**Flow:**

1. Load `.env`, validate `LINEAR_API_KEY`
2. Call Linear GraphQL API to get the authenticated user, resolve `simon@gauntlet.xyz` by email, and fetch triage issues created by either
3. Set `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars from `GIT_USER_NAME`/`GIT_USER_EMAIL` (or fall back to the Linear account's name/email)
4. Take the **first** triage issue only (one per run to avoid overlap)
5. Move that issue to In Progress, assign to self, set priority Medium via `issueUpdate` mutation
6. Check for existing open PRs matching the issue identifier via `gh pr list --search`
7. Spawn `claude --permission-mode bypassPermissions --print <prompt>` with the issue details and repo paths; stream its stdout/stderr to the log file
8. Send a Pushover notification on success or failure

**Branch naming** (`runClaudeAgent`): new branches are named `<identifier-lowercase>-<slugified-title>` truncated to 40 characters (e.g. `eng-42-fix-login-redirect`). When an existing PR is found, the agent checks out that branch instead.

**Priority value**: Linear priority 3 = Medium (hardcoded in `updateIssue`).

**Repo path resolution** (`buildRepoPaths`): uses `DOCS_REPO_PATH` and/or `MONOREPO_PATH` when set; falls back to `REPO_PATH`, then `cwd`. The agent prompt includes all configured paths and instructs Claude to choose the relevant repo(s).

**PR deduplication** (`findExistingPRs`): before spawning the agent, searches each repo for open PRs whose title/branch contains the issue identifier. If found, the agent prompt tells it to check out and update the existing branch rather than create a new one.

**Logging**: all output (including the spawned agent's stdout/stderr) appends to `LOG_FILE` (default: `linear-pr-gen.log`). Nothing is written to stdout/stderr so the tool runs cleanly under cron.

## Key env vars

| Variable | Purpose |
|----------|---------|
| `LINEAR_API_KEY` | Required. Linear GraphQL auth |
| `DOCS_REPO_PATH` / `MONOREPO_PATH` | Repos the agent can work in |
| `REPO_PATH` | Fallback repo when neither above is set (default: `cwd`) |
| `GH_TOKEN` | GitHub token — passed to `gh` CLI |
| `ANTHROPIC_API_KEY` | Passed through to the `claude` subprocess |
| `ANTHROPIC_BASE_URL` | Optional enterprise API endpoint override |
| `GIT_USER_NAME` / `GIT_USER_EMAIL` | Git commit attribution |
| `LOG_FILE` | Append-only log path (default: `linear-pr-gen.log` in project root) |
| `PUSHOVER_TOKEN` / `PUSHOVER_USER` | Optional push notifications |

## Claude attribution settings

By default the Claude Code CLI appends a `Co-Authored-By: Claude` trailer to commits and may override the git author. To disable this when running under cron, set the following in `~/.claude/settings.json`:

```json
{
  "attribution": {
    "commit": "",
    "pr": ""
  }
}
```
