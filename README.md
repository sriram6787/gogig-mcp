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

25 tools. All are read-only except the two that start a report (Claude asks first).

| File in `src/tools/` | Tool | API route |
|---|---|---|
| `stats.ts` | `find_campaign` | `GET /getStatsCampaigns` |
| | `campaign_summary`, `flags_on_campaign`, `executors_on_campaign`, `tasks_per_day` | `GET /getCampaignStats` (`include=flags`, `executors`, `days`) |
| | `overall_summary` | `GET /getStatsOverview` |
| `campaigns.ts` | `my_campaigns` | `GET /getCampaignsByUserId` |
| | `campaign_details` | `GET /getCampaignDetailsByCampaignId` (questionnaire and geofence shape left out) |
| | `campaign_team` | `GET /getCampaignHierarchy` (people tree, no phones) |
| | `my_team` | `GET /getUserBySuperiorId` (no phones) |
| `flags.ts` | `flagged_summary` | `GET /getFlaggedSummary` |
| | `flag_reasons` | `GET /getValidationReasonCatalog` |
| `tasks.ts` | `list_tasks` | `GET /getQuestionaireResponseByGigIdV2` (max 10 per page) |
| `stores.ts` | `list_stores` | `GET /getBrandingMedia` (account admins see their stores, gOGig admins all; first N rows plus a total) |
| | `store_types` | `GET /getBrandingMediaTypes` |
| `agencies.ts` | `agency_performance` | `GET /getAgencyPerformance` |
| | `flagged_tasks_by_agency` | `GET /getAgencyFlaggedTasks` |
| `insights.ts` | `attention_summary`, `attention_list` | `GET /getinsightsSummary`, `GET /getInsights` |
| | `activity_log` | `GET /campaign/:id/activity-log`, `GET /account/activity-log` |
| `reports.ts` | `generate_report` (**asks first**) | `POST /createGenerateReportRequest` (PDF or ZIP, emailed) |
| | `report_status` | `GET /getReportJob` |
| | `generate_excel_report` (**asks first**) | `GET /generateExcelReport` (15 min download link) |
| `admin.ts` | `executor_app_status`, `review_queue` | `GET /executorAppStatus`, `GET /manualReviewStats` (gOGig admin roles only) |

### Rules for adding a tool

- **One `tool(...)` block** in the file for its area (or a new file, registered in `src/tools/index.ts`), plus a route in the API if the data is not served yet.
- **Only wrap a route that checks the caller's access to the id it is given** (is this person on that campaign, account or team?). The tools pass the person's own token, so the route is the only guard. Routes that take any `gigId`, `taskId`, `userId` or `accountId` from any logged-in user are NOT wrapped until the API checks them: `getTaskByTaskId`, `userTaskReports`, `getUsersWorkingOnAGig`, `getMapPaths`, `getAllResponses`, `getGeofence`, `getAgenciesByBrandId`, and the `/credits/accounts|campaigns` reads. Also skipped: `getStoresByUserId` (loads every task of every campaign; `my_campaigns` covers it) and `getManualUploadStores` (part of the add-a-task-by-hand flow).
- **Read-only by default.** Tools that start work pass `false` as the last argument to `tool()`, so Claude asks first.
- **Phone numbers never reach Claude.** `redact()` in `src/tools/kit.ts` drops any key containing `phone`, `mobile`, `contact` or `whatsapp` from every result.
- **Keep results small.** Whitelist fields with `pick()`, and cap page sizes; Claude pays for every byte it reads.

`npm run build` deletes `dist/` first, so a stale compiled file can never shadow a newer one.

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
