/** Flagged work. GET /getFlaggedSummary, /getValidationReasonCatalog. Both are scoped to the caller's campaigns or static. */
import { z } from "zod";
import { campaignId, day, joined, Kit, page, pageSize } from "./kit";

export function registerFlagTools({ api, tool }: Kit): void {
  tool(
    "flagged_summary",
    "Flagged work for ONE campaign, or across ALL the user's open campaigns " +
      "when no campaign is given: total flagged, submitted and unvalidated " +
      "tasks, and optionally the top reasons, the campaigns with the most flags " +
      "(account-wide only) and a day-by-day trend. Account-wide it covers open, " +
      "non-demo campaigns and honours the dates; for one campaign the dates " +
      "are ignored (use flags_on_campaign for a date range).",
    {
      campaign_id: campaignId.optional(),
      include: z
        .array(z.enum(["reasons", "campaigns", "trend"]))
        .optional()
        .describe("Extra blocks. 'campaigns' works account-wide only."),
      from_date: day("First"),
      to_date: day("Last"),
      page,
      page_size: pageSize(50, 20),
    },
    async (a) => {
      const include = a.campaign_id ? a.include?.filter((block: string) => block !== "campaigns") : a.include;
      return api.get("/getFlaggedSummary", {
        gigId: a.campaign_id,
        include: joined(include),
        startDate: a.from_date,
        endDate: a.to_date,
        page: a.page,
        pageSize: a.page_size,
      });
    },
  );

  tool(
    "flag_reasons",
    "The list of reason codes a task can be flagged with, each with its title " +
      "and meaning. Call this to find the right code for a reason the user " +
      "names in words (for example geofence or duplicate) before filtering on it.",
    {},
    async () => api.get("/getValidationReasonCatalog"),
  );
}
