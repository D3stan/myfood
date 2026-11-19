# MyFood

## Local Development

Copy `.env.example` to `.env` and adjust as needed:

```sh
cp .env.example .env
npm run dev:server
```

To test the remote `/mcp` endpoint locally, generate a secret and set `MCP_SECRET` in `.env`:

```sh
openssl rand -hex 32
```

### AI

`AI_PROVIDER` picks the model backend (default `agy`).

| Variable | Provider | Meaning |
|---|---|---|
| `AI_PROVIDER` | both | `agy` (local CLI) or `openai` (OpenAI-compatible HTTP API) |
| `AI_TIMEOUT_MS` | both | per-call timeout, default 180000 |
| `AI_MODEL` | both | model name; required for `openai`, `agy` defaults to `gemini-3.8-flash-low` |
| `AI_BASE_URL`, `AI_API_KEY` | openai | API root (e.g. `https://api.openai.com/v1`) and bearer key |
| `AI_JSON_MODE` | openai | `object` (default, `json_object`) or `schema` (strict `json_schema`; some models reject our schema) |
| `AI_CMD`, `AI_EFFORT` | agy | command to run (default `agy`) and effort (default `low`) |

## Deploy

Production runs on VM 101 (`myfood@192.168.2.32`), behind a Cloudflare Tunnel.

```sh
scripts/deploy.sh                 # deploy HEAD
scripts/deploy.sh myfood@host abc123  # deploy another commit / host
scripts/deploy.sh --rollback      # back to the previous release
```

What it does:

1. Builds and tests **the commit** in a scratch folder (`git archive`). Uncommitted changes are never deployed; it warns when the commit isn't pushed.
2. Uploads it to `/opt/myfood/releases/<commit>/` (unchanged files are hard links to the live release) and runs `npm ci --omit=dev` there, while the old release keeps serving.
3. Installs the systemd units, `/etc/myfood.env` (printing a diff when it changes) and the helper scripts.
4. Points `/opt/myfood/current` at the new release in one step and restarts `myfood.service`.
5. Waits up to 30 s for `/api/health` to report that commit as `build`. If it doesn't, it switches back to the previous release and prints the service log.

The last 5 releases are kept; `/opt/myfood/previous` is what `--rollback` goes to. Check what's live with `curl -s https://<host>/api/health`: `build` is the commit.

## MCP Server

MyFood exposes an MCP server over both **remote Streamable HTTP** (`/mcp`) and **local stdio** (`npm run mcp`).

### Remote Streamable HTTP (`/mcp`)

**Per-user tokens.** Each member can create their own token in Settings → MCP and copy the connector URL `https://<host>/mcp/<token>` (or send it as `Authorization: Bearer <token>`). It works even when `MCP_SECRET` is unset, and every tool acts as that member: any `user_id` argument is ignored. Tokens with other scopes (Siri) don't open `/mcp`, and MCP tokens don't open `/api`. Revoke them on the same page.

The global `MCP_SECRET` keeps working unchanged (`user_id` argument, otherwise the default user). With no `MCP_SECRET` and no valid MCP token the endpoint answers 503; a wrong token answers 401.

The `/mcp` endpoint accepts `MCP_SECRET` (when set) in:

```
Authorization: Bearer <MCP_SECRET>
```

On production (VM 101), `scripts/deploy.sh` overwrites `/etc/myfood.env` from `deploy/myfood.env` on every deploy. Keep `MCP_SECRET` in `/etc/myfood-mcp.env` instead (see `deploy/myfood-mcp.env.example`):

```sh
sudo install -o pantry -g pantry -m 600 deploy/myfood-mcp.env.example /etc/myfood-mcp.env
# edit /etc/myfood-mcp.env with a real `openssl rand -hex 32` value
sudo systemctl restart myfood.service
```

or with the secret as the last path segment, for clients that can't send headers:

```
https://myfood.0xpuddu.com/mcp/<MCP_SECRET>
```

#### claude.ai (web, Desktop, mobile)

claude.ai custom connectors can't send an `Authorization` header, so use the path-token URL:

1. claude.ai → **Settings → Connectors → Add custom connector**.
2. Name: `MyFood`. URL: `https://myfood.0xpuddu.com/mcp/<MCP_SECRET>`. Leave OAuth fields empty → **Add**.
3. In a chat, open the **+ / tools** menu and enable MyFood.

The connector syncs to Claude Desktop and the mobile apps on the same account. Anyone with the URL has full access: treat it like a password, and rotate `MCP_SECRET` (then re-add the connector) if it leaks.

#### Claude Code

In `~/.claude.json` or `.mcp.json`:

```json
{
  "mcpServers": {
    "myfood": {
      "type": "http",
      "url": "https://myfood.0xpuddu.com/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_SECRET>"
      }
    }
  }
}
```

#### Cursor / Codex

In Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "myfood": {
      "url": "https://myfood.0xpuddu.com/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_SECRET>"
      }
    }
  }
}
```

In Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.myfood]
url = "https://myfood.0xpuddu.com/mcp"
bearer_token_env_var = "MYFOOD_MCP_SECRET"
```

### Local Stdio (`npm run mcp`)

For local stdio clients (e.g. Claude Desktop, Claude Code, or Cursor running against a local checkout):

Stdio runs no scheduled deals sync: call the `sync_catalogs` tool to fetch offers. It matches new offers with the AI (jobs folder `JOBS_DIR`, else `DATA_DIR/jobs`) unless `match` is false.

```json
{
  "mcpServers": {
    "myfood": {
      "command": "npm",
      "args": ["run", "--silent", "mcp"],
      "cwd": "/path/to/myfood",
      "env": {
        "DATA_DIR": "/path/to/myfood/data"
      }
    }
  }
}
```

## Guest view

`/guest` shows the shared pantry (read-only, personal items hidden) to anyone with the guest passcode.

Get the passcode: **Me tab, Guest access** (Copy / New code). On the server it is also printed once at start-up: read it in the Dokploy app logs (search for "guest code").

A new code logs every guest out. Wrong tries are throttled (5 a minute).

## Siri Shortcuts

Two shortcuts (AI logging, and picking a meal to log). Plan, requests and setup: [docs/siri.md](docs/siri.md).
Me tab, Siri Shortcut card, has a **Copy setup text** button for each: paste it into Shortcuts' AI builder.

## Nutrition

Items carry kcal, protein and fat per unit. A cooked meal's totals are always summed from its ingredients;
typed totals only apply to a macro none of the ingredients have data for.
