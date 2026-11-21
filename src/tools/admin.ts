/**
 * gOGig-internal views, for the people who run the platform. Both routes refuse other roles, so a
 * client who calls these gets "Access denied". GET /executorAppStatus, /manualReviewStats.
 */
import { z } from "zod";
import { campaignId, day, Kit, page, pageSize } from "./kit";

export function registerAdminTools({ api, tool }: Kit): void {
  tool(
    "executor_app_status",
    "gOGig admins and operations only. The executor app's health: which version " +
      "and device each executor runs, and whether their photos are queued, " +
      "uploading, failed or uploaded per campaign. Filter by platform, version, " +
      "dates or a search. No phone numbers.",
    {
      search: z.string().min(2).max(190).optional().describe("Executor name or last campaign id."),
      platform: z.enum(["android", "ios", "pwa"]).optional(),
      version_code: z.number().int().min(1).optional().describe("Exact app version code."),
      from_date: day("First"),
      to_date: day("Last"),
      sort: z
        .enum(["recent", "oldest", "version_desc", "version_asc", "captured_desc", "captured_asc"])
        .optional()
        .describe("Order. Default: most recent report first."),
      page,
      page_size: pageSize(20, 10),
    },
    async (a) =>
      api.get("/executorAppStatus", {
        search: a.search,
        platform: a.platform,
        versionCode: a.version_code,
        fromDate: a.from_date,
        toDate: a.to_date,
        sort: a.sort,
        page: a.page,
        pageSize: a.page_size ?? 10,
      }),
  );

  tool(
    "review_queue",
    "gOGig admins only. The manual review desk: how many items are done, claimed " +
      "and pending, how many reviewers are active, each reviewer's work, and a " +
      "trend over the last N days, weeks or months. Optionally for one campaign " +
      "or one queue (rc, serial, flag).",
    {
      unit: z.enum(["day", "week", "month"]).optional().describe("Bucket size. Default day."),
      count: z.number().int().min(1).max(366).optional().describe("How many buckets back. Default 1; max 366 days, 104 weeks, 24 months."),
      campaign_id: campaignId.optional(),
      queue: z.enum(["rc", "serial", "flag"]).optional().describe("Only this queue."),
      include_flag: z.boolean().optional().describe("Count flag review in the all-queues totals."),
    },
    async (a) =>
      api.get("/manualReviewStats", {
        unit: a.unit,
        count: a.count,
        gigId: a.campaign_id,
        queue: a.queue,
        includeFlag: a.include_flag ? "true" : undefined,
      }),
  );
}
