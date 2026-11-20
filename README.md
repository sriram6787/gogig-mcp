# gogig-mcp

The MCP server that lets Claude answer gogig campaign questions and create the
console's reports **as the signed-in gogig user**. People add it in Claude as a
custom connector, click **Connect**, and sign in through **gogig-ui's normal
login**. Every tool calls the gogig API with that person's own token, so the
API decides what they see. Nothing here touches the database.

```
Claude ──► gogig-mcp (this repo) ──► gogig API (gogig-api-nestjs) ──► MySQL
              │  ▲
   /authorize │  │ /oauth/ui-callback?code=…
              ▼  │
        gogig-ui /connect/claude  (normal sign-in, then "Allow")
```

## How sign-in works

1. Claude calls the gateway with no token, gets `401`, discovers the sign-in metadata and registers itself (standard MCP OAuth, served by the SDK).
2. `/authorize` sends the browser to **gogig-ui `/connect/claude?request=<id>`**. A signed-out person goes through gogig-ui's own sign-in first (its `ProtectedRoute`), then sees **Allow / Cancel**.
3. On Allow, gogig-ui gets a one-time code from the API (`POST /mcpConnect/code`) and sends the browser to the gateway's `/oauth/ui-callback`.
4. The gateway exchanges the code, server to server, at `POST /mcpConnect/token`, authenticated as the **`mcp_gogig`** client. The API answers with an ordinary gogig session for that person, under `mcp_gogig`.
5. The gateway gives Claude its **own opaque tokens** (`gga_…` for 1h, `ggr_…` for 30 days), never the gogig JWT, keeps the gogig session, renews it through `POST /renewAccessToken`, and swaps the real gogig token in on every tool call.

Pieces in other repos:

| Repo | What |
|---|---|
| gogig-api-nestjs | `src/modules/mcp-connect` (`POST /mcpConnect/code`, `POST /mcpConnect/token`), `src/modules/campaign-stats` (the stats routes) |
| gogig-ui | `/connect/claude` page (`src/components/connectClaude`), `VITE_MCP_GATEWAY_URL` |

## Tools

| Tool | API route | Changes anything? |
|---|---|---|
| `find_campaign` | `GET /getStatsCampaigns` | no |
| `campaign_summary` | `GET /getCampaignStats` | no |
| `flags_on_campaign` | `GET /getCampaignStats?include=flags` | no |
| `executors_on_campaign` | `GET /getCampaignStats?include=executors` | no |
| `tasks_per_day` | `GET /getCampaignStats?include=days` | no |
| `overall_summary` | `GET /getStatsOverview` | no |
| `agency_performance` | `GET /getAgencyPerformance` | no |
| `generate_report` | `POST /createGenerateReportRequest` (PDF or ZIP, emailed) | **yes**, Claude asks first |
| `report_status` | `GET /getReportJob` | no |
| `generate_excel_report` | `GET /generateExcelReport` (15 min download link) | **yes**, Claude asks first |

Add a question: one `tool(...)` block in `src/tools.ts`, plus a route or `include=` block in the API if the data is not served yet.

## The `mcp_gogig` client

One `AuthClient` row, created by hand (replace the secret with a long random string, and list every address the gateway sends as Origin):

```sql
INSERT INTO AuthClient (clientId, name, allowedUrls, secret_key)
VALUES ('mcp_gogig', 'Claude MCP connector', 'http://localhost:5100', '<long random secret>');
```

Check `DESCRIBE AuthClient;` first in case the table has other required columns. `allowedUrls` is comma-separated. Keep `mcp_gogig` out of `SINGLE_SESSION_CLIENT_IDS`, so connecting Claude does not sign people out of the console.

## Run

```bash
npm install
npm run build
```

Copy `.env.example` to `.env`, fill it in, and export it (or set the variables in pm2). Then:

```bash
npm start          # HTTP gateway, port 5100
npm run start:stdio  # stdio, for one machine (GOGIG_TOKEN required)
```

### Local test

1. gogig API from gogig-api-nestjs (branch with `mcp-connect` and `campaign-stats`) on port 5000.
2. gogig-ui on port 3000, with `VITE_MCP_GATEWAY_URL=http://localhost:5100` in its `.env`.
3. A tunnel to the gateway: `cloudflared tunnel --url http://127.0.0.1:5100`.
4. The gateway, with `MCP_PUBLIC_URL` set to the tunnel address, `GOGIG_UI_URL=http://localhost:3000`, the client secret, and `GOGIG_AUTH_ORIGIN=http://localhost:5100`.
5. In Claude: Customize → Connectors → Add custom connector → `https://<tunnel>/mcp`, **Sign in now**, Add, Connect. gogig-ui opens, sign in, **Allow**.

Claude Code: `claude mcp add --scope user --transport http gogig https://<tunnel>/mcp`, then `/mcp` → Authenticate.

The gateway prints one `[http]` line per request; `MCP_DEBUG=1` adds what each sign-in request asked for.

## Deploy

- Run `npm start` as its own pm2 app behind HTTPS, e.g. `https://mcp.<domain>`, with `MCP_PUBLIC_URL` set to that address and `GOGIG_UI_URL` to the live gogig-ui.
- Add that address to the `mcp_gogig` row's `allowedUrls`, and set gogig-ui's `VITE_MCP_GATEWAY_URL` to it.
- Sessions, sign-in codes and download links live in memory: run one process, and a restart signs everyone out. Move them to an encrypted shared store (Redis or the DB) before scaling, and rotate refresh tokens then.

## Known issue

On claude.ai / Claude desktop, after a successful sign-in (`POST /token -> 200`) Claude has sometimes shown "Couldn't connect" without calling the gateway again; the same server connects from Claude Code. If it happens, report it to Anthropic (github.com/anthropics/claude-ai-mcp/issues) with the `ofid_` reference.

## Definitions

- **Done** = `assignmentStatus = 'success' AND hidden = 0` (the console's `totalCompleted`).
- **Flagged** = done with `taskValidation = 'error'`, by reason code (geofence is `entryOutOfGeoFence`), distinct by task, `info` reasons excluded.
- Stats dates filter **work submitted** in the range (UTC days); `getAgencyPerformance` dates pick the **campaigns running** in the range.
