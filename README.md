# linear-claude-pr-generator

Picks up your Linear triage issues and autonomously implements them as GitHub PRs using Claude Code.

For each issue in Triage that you created, it:

1. Moves the issue to Backlog, assigns it to you, and sets priority to Medium
2. Spawns a `claude` agent in your local repo that reads the codebase, implements the fix, and opens a GitHub PR

## Prerequisites

- [Claude Code](https://claude.ai/code) CLI (`claude`) installed and authenticated
- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
- A local clone of the repo you want Claude to work in, with a GitHub remote

## Setup

```bash
npm install
cp .env.example .env
# fill in .env
```

`.env` values:

| Variable | Required | Description |
|---|---|---|
| `LINEAR_API_KEY` | Yes | Linear API key from [linear.app/settings/api](https://linear.app/settings/api) |
| `REPO_PATH` | No | Absolute path to the local git repo. Defaults to `cwd`. |

## Usage

```bash
# development
npm run dev

# or build and run
npm run build
npm start
```

The tool authenticates with Linear as the owner of `LINEAR_API_KEY`, finds all triage issues you created, and processes them sequentially. Claude agents run one at a time, streaming output to your terminal.

## How it works

Each Claude agent receives the issue title, description, and URL and is instructed to:

- Create a branch named `<identifier>-<slugified-title>`
- Implement the solution
- Commit with a descriptive message
- Open a GitHub PR with a summary, test plan, and link back to the Linear issue
