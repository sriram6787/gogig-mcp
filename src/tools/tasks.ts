/**
 * Individual submitted tasks. GET /getQuestionaireResponseByGigIdV2, the console's task list: it
 * checks the caller is on the campaign and narrows executors to their own branch of the team.
 * Rows carry full answers and photo links, so pages are kept small.
 */
import { z } from "zod";
import { campaignId, csv, day, joined, Kit, page, pageSize } from "./kit";

export function registerTaskTools({ api, tool }: Kit): void {
  tool(
    "list_tasks",
    "The submitted tasks on a campaign, newest first, each with its answers, photo " +
      "links, status, who did it and why it was flagged. Filter by dates, executor, " +
      "flag reason or flagged/warned only. Returns up to 10 per page (default 5) " +
      "with counts for the WHOLE filtered set: count, flagCount, warnedCount. For " +
      "totals only, use campaign_summary or flags_on_campaign instead. No phone numbers.",
    {
      campaign_id: campaignId,
      from_date: day("First"),
      to_date: day("Last"),
      executor_ids: csv("Only tasks by these executors (userIds, from executors_on_campaign)."),
      reason_codes: csv('Only tasks flagged with these reason codes, e.g. ["entryOutOfGeoFence"].'),
      flagged_only: z.boolean().optional().describe("true for flagged tasks only."),
      warned_only: z.boolean().optional().describe("true for warned tasks only."),
      rc_number: z.string().min(1).max(50).optional().describe("Only tasks with this RC number."),
      page,
      page_size: pageSize(10, 5),
    },
    async (a) =>
      api.get("/getQuestionaireResponseByGigIdV2", {
        gigId: a.campaign_id,
        startDate: a.from_date,
        endDate: a.to_date,
        executorIds: joined(a.executor_ids),
        flaggedReasonCode: joined(a.reason_codes),
        isFlagged: a.flagged_only ? "true" : undefined,
        taskValidation: a.warned_only ? "warn" : undefined,
        rcNumber: a.rc_number,
        page: a.page,
        pageSize: a.page_size ?? 5,
      }),
  );
}
