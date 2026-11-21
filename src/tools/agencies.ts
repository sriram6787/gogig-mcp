/** Agencies under a brand. GET /getAgencyPerformance, /getAgencyFlaggedTasks (brand admins and gOGig admins only). */
import { z } from "zod";
import { campaignId, day, Kit, page, pageSize } from "./kit";

export function registerAgencyTools({ api, tool }: Kit): void {
  tool(
    "agency_performance",
    "How each agency working under the user's brand is delivering (every active " +
      'brand for a gOGig admin); use for "how many agencies are working" and ' +
      '"which agency is best/worst". Brand admins, brand points of contact and ' +
      "gOGig admins only. Unlike the other tools, the date range picks the " +
      "CAMPAIGNS running in it (start/end dates overlapping), then counts all their " +
      "work. Pass agency_id for one agency's detail.",
    {
      from_date: day("First"),
      to_date: day("Last"),
      agency_id: z.string().optional().describe("One agency's id, for its detail."),
    },
    async ({ from_date, to_date, agency_id }) =>
      api.get("/getAgencyPerformance", {
        startDate: from_date,
        endDate: to_date,
        agencyId: agency_id,
        include: agency_id ? "campaigns" : undefined,
      }),
  );

  tool(
    "flagged_tasks_by_agency",
    "One agency's flagged submissions on one campaign, newest first: task, " +
      "executor, when, and the reasons. The follow-up to agency_performance when " +
      "an agency has many flags. Brand admins, brand points of contact and " +
      "gOGig admins only. Get the agency id from agency_performance.",
    {
      agency_id: z.string().min(1).describe("The agency's id, from agency_performance."),
      campaign_id: campaignId,
      page,
      page_size: pageSize(50, 20),
    },
    async ({ agency_id, campaign_id, page, page_size }) =>
      api.get("/getAgencyFlaggedTasks", { agencyId: agency_id, gigId: campaign_id, page, pageSize: page_size }),
  );
}
