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

## MCP Server

MyFood exposes an MCP server over both **remote Streamable HTTP** (`/mcp`) and **local stdio** (`npm run mcp`).

### Remote Streamable HTTP (`/mcp`)

The `/mcp` endpoint requires `MCP_SECRET` to be set and accepts requests with:

```
Authorization: Bearer <MCP_SECRET>
```

On production (VM 101), `scripts/deploy.sh` overwrites `/etc/myfood.env` from `deploy/myfood.env` on every deploy. Keep `MCP_SECRET` in `/etc/myfood-mcp.env` instead (see `deploy/myfood-mcp.env.example`):

```sh
sudo install -o pantry -g pantry -m 600 deploy/myfood-mcp.env.example /etc/myfood-mcp.env
# edit /etc/myfood-mcp.env with a real `openssl rand -hex 32` value
sudo systemctl restart myfood.service
```

#### Claude (claude.ai / Claude Desktop / Claude Code)

For remote HTTP in Claude Code (`~/.claude.json` or `.mcp.json`) or `claude.ai` custom connector:

```json
{
  "mcpServers": {
    "myfood": {
      "type": "http",
      "url": "https://food.0xpuddu.com/mcp",
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
      "url": "https://food.0xpuddu.com/mcp",
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
url = "https://food.0xpuddu.com/mcp"
bearer_token_env_var = "MYFOOD_MCP_SECRET"
```

### Local Stdio (`npm run mcp`)

For local stdio clients (e.g. Claude Desktop, Claude Code, or Cursor running against a local checkout):

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

Get the passcode: **Me tab, Guest access** (Copy / New code). On the server it is also printed at start-up, or read it with:

```sh
journalctl -u myfood | grep -i "guest code" | tail -1
```

A new code logs every guest out. Wrong tries are throttled (5 a minute).

## Siri Shortcuts

Two shortcuts (AI logging, and picking a meal to log). Plan, requests and setup: [docs/siri.md](docs/siri.md).
Me tab, Siri Shortcut card, has a **Copy setup text** button for each: paste it into Shortcuts' AI builder.

## Nutrition

Items carry kcal, protein and fat per unit. A cooked meal's totals are always summed from its ingredients;
typed totals only apply to a macro none of the ingredients have data for.
