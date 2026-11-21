/**
 * What needs attention, and what changed. GET /getinsightsSummary, /getInsights (brands, agencies and
 * gOGig admins; a brand sees the whole campaign, others their own branch),
 * GET /campaign/:id/activity-log and /account/activity-log (scoped by account and role in the API).
 */
import { z } from "zod";
import { campaignId, csv, day, joined, Kit, page, pageSize } from "./kit";

const HEALTH = ["critical", "watch", "info", "healthy"] as const;
const TYPES = [
  "noSubmissions", "pastEndDate", "underDelivered", "almostComplete",
  "overDelivered", "highInvalidRate", "noTeam", "unusedInviteCode",
] as const;

export function registerInsightTools({ api, tool }: Kit): void {
  tool(
    "attention_summary",
    "How many of the user's campaigns need attention (critical, watch, info, " +
      "healthy), plus flagged and done-today totals. Optionally the top flag reasons " +
      "and how fast proof is submitted. Slow on large accounts (several seconds); " +
      "call it once, not repeatedly. Brands, agencies and gOGig admins only.",
    {
      from_date: day("First"),
      to_date: day("Last"),
      include: z.array(z.enum(["flagReasons", "proofFreshness"])).optional().describe("Extra blocks. Optional."),
    },
    async ({ from_date, to_date, include }) =>
      api.get("/getinsightsSummary", { startDate: from_date, endDate: to_date, include: joined(include) }),
  );

  tool(
    "attention_list",
    "The campaigns that need attention and why, most urgent first. Types: " +
      "noSubmissions, pastEndDate, underDelivered, almostComplete, overDelivered, " +
      "highInvalidRate, noTeam, unusedInviteCode. Health: critical, watch, info, " +
      "healthy. Slow on large accounts. Brands, agencies and gOGig admins only.",
    {
      types: z.array(z.enum(TYPES)).optional().describe("Only these kinds of finding."),
      health: z.array(z.enum(HEALTH)).optional().describe("Only these levels."),
      job_type: csv("Job types."),
      city: csv("City names."),
      company: csv("Company names."),
      search: z.string().min(2).optional().describe("Part of a title, company or city."),
      from_date: day("First"),
      to_date: day("Last"),
      page,
      page_size: pageSize(50, 20),
    },
    async (a) =>
      api.get("/getInsights", {
        type: joined(a.types),
        health: joined(a.health),
        jobType: joined(a.job_type),
        city: joined(a.city),
        company: joined(a.company),
        search: a.search,
        startDate: a.from_date,
        endDate: a.to_date,
        page: a.page,
        pageSize: a.page_size,
      }),
  );

  tool(
    "activity_log",
    "What changed on a campaign recently: who changed what and when (team " +
      "changes, settings, status). Give a campaign, or leave it out for the " +
      "latest changes across the user's accounts. Newest first, paged.",
    { campaign_id: campaignId.optional(), page, page_size: pageSize(50, 20) },
    async ({ campaign_id, page, page_size }) =>
      api.get(
        campaign_id ? `/campaign/${encodeURIComponent(campaign_id)}/activity-log` : "/account/activity-log",
        { page, pageSize: page_size },
      ),
  );
}
