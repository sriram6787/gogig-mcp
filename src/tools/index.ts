/**
 * The gogig tools, shared by both ways of serving them:
 *   stdio.ts  started by Claude on one person's machine
 *   http.ts   a hosted link Claude connects to
 *
 * Each tool makes calls to the gogig API with the CALLER's token, so the API's
 * own guards and scoping decide what they see. One file per area; add a tool by
 * adding a `tool(...)` block to the matching file (or a new file registered below).
 *
 *   stats.ts      counts: done, executors, flags, per day          find_campaign, campaign_summary, ...
 *   campaigns.ts  campaign list, details, team                      my_campaigns, campaign_team, ...
 *   flags.ts      flagged work and reason codes                     flagged_summary, flag_reasons
 *   tasks.ts      individual submitted tasks                        list_tasks
 *   stores.ts     stores and which campaigns they are on            list_stores, store_types
 *   agencies.ts   agency delivery                                   agency_performance, ...
 *   insights.ts   what needs attention, activity log                attention_*, activity_log
 *   reports.ts    PDF / ZIP / Excel (the only ones that start work) generate_*, report_status
 *   admin.ts      gOGig-internal views (admin roles only)           executor_app_status, review_queue
 *
 * Only add a tool for a route that checks the caller's access to the id it is given.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GogigApi, SaveFile } from "./api";
import { registerAdminTools } from "./admin";
import { registerAgencyTools } from "./agencies";
import { registerCampaignTools } from "./campaigns";
import { registerFlagTools } from "./flags";
import { registerInsightTools } from "./insights";
import { makeKit } from "./kit";
import { registerReportTools } from "./reports";
import { registerStatsTools } from "./stats";
import { registerStoreTools } from "./stores";
import { registerTaskTools } from "./tasks";

export { makeApi } from "./api";
export type { DownloadedFile, GogigApi, SaveFile } from "./api";

/** Registers every tool on `server`, each answering through `api`; files go through `saveFile`. */
export function registerGogigTools(server: McpServer, api: GogigApi, saveFile: SaveFile): void {
  const kit = makeKit(server, api, saveFile);
  registerStatsTools(kit);
  registerCampaignTools(kit);
  registerFlagTools(kit);
  registerTaskTools(kit);
  registerStoreTools(kit);
  registerAgencyTools(kit);
  registerInsightTools(kit);
  registerReportTools(kit);
  registerAdminTools(kit);
}
