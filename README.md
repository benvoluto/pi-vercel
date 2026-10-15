# pi-vercel

Vercel integration for the [pi coding agent](https://pi.dev) — brings the
"Vercel plugin for coding agents" experience to pi.

It adds three things to a pi session:

1. **The hosted Vercel MCP server** (`https://mcp.vercel.com`, 230+ tools) so the
   model can query projects, deployments, environment variables, logs, traces,
   and search the Vercel docs.
2. **A safe `vercel` CLI tool** the model can call to run deployment/project
   operations. It runs the CLI with an argument array (no shell), truncates
   large output, blocks interactive commands, and asks for confirmation before
   production or destructive operations.
3. **Convenience slash commands**: `/vercel`, `/vercel-deploy`, `/vercel-logs`,
   `/vercel-list`, `/vercel-env`, `/vercel-link`, `/vercel-open`,
   `/vercel-whoami`, `/vercel-login`.

## Prerequisites

- **pi** installed (`pi --version`).
- **Vercel CLI** on your `PATH`:
  ```bash
  npm i -g vercel        # or: pnpm add -g vercel
  vercel --version
  ```
  (If your CLI lives elsewhere, set `PI_VERCEL_BIN=/path/to/vercel`.)

## Install

Pick one source.

**From git** (recommended for sharing):
```bash
pi install git:github.com/<owner>/pi-vercel
```

**From a local checkout** (e.g. a shared folder or cloned repo):
```bash
pi install /path/to/pi-vercel
```

**Try it for one session without installing:**
```bash
pi -e /path/to/pi-vercel
```

`pi install` writes the package to `~/.pi/agent/settings.json` (personal). Add
`-l` / `--local` to install it into the current project's `.pi/settings.json`
instead (loads after project trust is granted). Run `pi list` to confirm, and
`pi remove <source>` to uninstall.

## Authenticate (two separate logins)

Registering ≠ signing in. There are two independent credentials:

1. **MCP server** (used by the `mcp__vercel__*` tools) — inside a pi session run:
   ```
   /mcp login vercel
   ```
   A browser opens; approve it. Tokens are stored in `~/.pi/agent/mcp-auth.json`.
   Run `/mcp` any time to check status (it should read `connected, N tools`).

2. **Vercel CLI** (used by the `vercel` tool and the slash commands) — in a
   terminal run:
   ```
   vercel login
   ```

## Usage

Just ask the agent naturally — e.g. *"deploy this project to preview"*,
*"show the logs for my latest deployment"*, *"list my Vercel projects"* — and it
will use the `vercel` tool or the Vercel MCP tools.

Or drive it with slash commands:

| Command | Does |
|---|---|
| `/vercel <args>` | Run any Vercel CLI command, e.g. `/vercel inspect <url>` |
| `/vercel-deploy` | Deploy the current project (append `--prod` for production) |
| `/vercel-logs` | Show deployment logs (optionally pass a URL/id) |
| `/vercel-list` | List recent deployments |
| `/vercel-env` | Manage env vars (defaults to `ls`) |
| `/vercel-link` | Link the current directory to a Vercel project |
| `/vercel-open` | Open the project in the Vercel dashboard |
| `/vercel-whoami` | Show the logged-in CLI user |
| `/vercel-login` | Launch `vercel login` (browser) |

### Safety behavior

- **Blocked in the tool**: `login`, `dev`, `signup` (interactive/long-running).
  Use a terminal or `/vercel-login` for those.
- **Confirmation prompt** (when a UI is present) before production deploys
  (`--prod` / `--target=production`) and destructive commands (`rm`, `remove`,
  `rollback`, `promote`, `redeploy`, `alias`, `env rm`, `project rm`,
  `domains rm`, `logout`).
- Output is truncated for the model; full output is written to a temp file when
  it is large.

## Configuration (optional env vars)

| Variable | Default | Purpose |
|---|---|---|
| `PI_VERCEL_MCP` | `1` | Set `0` to not register the MCP server from this extension |
| `PI_VERCEL_MCP_EXPOSURE` | `direct` | MCP tool exposure: `direct`, `codemode`, `deferred`, `hidden` |
| `PI_VERCEL_MCP_URL` | `https://mcp.vercel.com` | Override the MCP endpoint |
| `PI_VERCEL_BIN` | `vercel` | Path to the Vercel CLI binary |

### Prefer config-file MCP (optional)

The extension registers the MCP server per-session, which the **interactive**
`/mcp` sees. If you also want the **shell** command `pi mcp login vercel` and
non-interactive `/mcp` to see it, set `PI_VERCEL_MCP=0` and add it to
`~/.pi/agent/mcp.json` instead:

```json
{
  "mcpServers": {
    "vercel": {
      "url": "https://mcp.vercel.com",
      "exposure": "direct",
      "description": "Vercel: projects, deployments, env vars, logs, and docs search."
    }
  }
}
```

## Tests

Unit tests for the production/destructive/blocked gating logic:

```bash
npm test
```

## Uninstall

```bash
pi remove git:github.com/<owner>/pi-vercel   # or the local path you installed
```

## License

MIT
