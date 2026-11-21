/** Counts: tasks done, executors, flags, per-day, across campaigns. GET /getStatsCampaigns, /getCampaignStats, /getStatsOverview. */
import { z } from "zod";
import { campaignId, day, Kit, pageSize } from "./kit";

export function registerStatsTools({ api, tool }: Kit): void {
  tool(
    "find_campaign",
    "Find the user's campaigns by title, company or city (max 20, newest first, " +
      "no demos). Always call this first when the user names a campaign in words, " +
      "then pass the returned gigId to the other tools.",
    { search: z.string().min(2).describe("Part of the title, company or city.") },
    async ({ search }) => (await api.get("/getStatsCampaigns", { search }))?.data ?? [],
  );

  tool(
    "campaign_summary",
    "Tasks done and distinct executors on one campaign, optionally between two " +
      "dates matched on when each task was submitted. Done = successful, " +
      "non-hidden tasks (the console's totalCompleted rule). `scope` in the answer " +
      "says whether it counts the whole campaign or only the user's own team.",
    { campaign_id: campaignId, from_date: day("First"), to_date: day("Last") },
    async ({ campaign_id, from_date, to_date }) =>
      api.get("/getCampaignStats", { gigId: campaign_id, startDate: from_date, endDate: to_date }),
  );

  tool(
    "flags_on_campaign",
    "Flagged tasks on a campaign and WHY they were flagged, by reason code. Use " +
      'for "how many tasks are flagged", "how many geofence flags" (code ' +
      "entryOutOfGeoFence), duplicate codes, and so on. flags.totalFlagged is done " +
      "tasks with taskValidation 'error'; flags.reasons counts distinct tasks per " +
      "reason, so reasons can sum higher than the total (one task can have several). " +
      "Reasons the campaign marks as 'info' are not counted. Also returns tasksDone, " +
      'so "done vs flagged" needs only this call.',
    { campaign_id: campaignId, from_date: day("First"), to_date: day("Last") },
    async ({ campaign_id, from_date, to_date }) =>
      api.get("/getCampaignStats", {
        gigId: campaign_id,
        startDate: from_date,
        endDate: to_date,
        include: "flags",
      }),
  );

  tool(
    "executors_on_campaign",
    "The executors who did tasks on a campaign, busiest first (name and task " +
      "count only). Same date, done and scope rules as campaign_summary.",
    {
      campaign_id: campaignId,
      from_date: day("First"),
      to_date: day("Last"),
      limit: pageSize(200, 50),
    },
    async ({ campaign_id, from_date, to_date, limit }) =>
      api.get("/getCampaignStats", {
        gigId: campaign_id,
        startDate: from_date,
        endDate: to_date,
        include: "executors",
        limit,
      }),
  );

  tool(
    "tasks_per_day",
    "Day-by-day tasks done and active executors on one campaign.",
    { campaign_id: campaignId, from_date: day("First"), to_date: day("Last") },
    async ({ campaign_id, from_date, to_date }) =>
      api.get("/getCampaignStats", {
        gigId: campaign_id,
        startDate: from_date,
        endDate: to_date,
        include: "days",
      }),
  );

  tool(
    "overall_summary",
    "Done work across ALL of the user's campaigns (every campaign for a gOGig " +
      "admin): tasks, executors, campaigns with work in the range. Demo campaigns " +
      "excluded. Includes the 20 busiest campaigns.",
    { from_date: day("First"), to_date: day("Last") },
    async ({ from_date, to_date }) =>
      api.get("/getStatsOverview", { startDate: from_date, endDate: to_date }),
  );
}
