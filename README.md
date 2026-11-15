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
