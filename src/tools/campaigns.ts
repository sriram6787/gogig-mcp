/**
 * The user's campaigns and the people on them.
 * GET /getCampaignsByUserId, /getCampaignDetailsByCampaignId, /getCampaignHierarchy, /getUserBySuperiorId.
 * Every route scopes to the caller's own campaigns or team, so nothing here widens access.
 */
import { z } from "zod";
import { campaignId, csv, day, joined, Kit, page, pageSize, pick } from "./kit";

const CAMPAIGN_ROW = [
  "gigId", "gigTitle", "companyName", "city", "jobType", "status",
  "gigStartDate", "gigEndDate", "totalTaskToBeDone", "totalCompleted", "totalFlagged",
  "lastActivity", "totalTasksCompletedToday", "completedLast7Days", "completedLast30Days", "groupName",
];

const CAMPAIGN_DETAIL = [
  "gigId", "gigTitle", "companyName", "status", "archive", "gigStartDate", "gigEndDate",
  "address", "city", "state", "region", "jobType", "totalTaskToBeDone", "totalTaskDone",
  "totalFlaggedTasks", "totalWarnedTasks", "completedAt", "isMapPath",
];

// A hierarchy node, without contact details; children kept.
const person = (node: any): any => ({
  userId: node.userId,
  name: node.firstName ?? node.userFirstName,
  role: node.role,
  isActive: node.isActive,
  children: (node.children || []).map(person),
});

const countPeople = (nodes: any[]): number =>
  nodes.reduce((sum, node) => sum + 1 + countPeople(node.children || []), 0);

export function registerCampaignTools({ api, tool }: Kit): void {
  tool(
    "my_campaigns",
    "List the user's campaigns with progress (done, flagged, last activity), " +
      "filtered and paged. Open campaigns by default; set completed to see " +
      "finished ones. The dates pick campaigns whose run dates overlap the range. " +
      "Use for \"which campaigns are running in Mumbai\" or \"which campaigns are " +
      "nearly complete\". To find one campaign by name, find_campaign is quicker.",
    {
      search: z.string().min(2).optional().describe("Part of the title, company, city or medium."),
      company: csv("Company names."),
      city: csv("City names."),
      job_type: csv("Job types."),
      progress: z
        .array(z.enum(["notStarted", "inProgress", "nearCompletion", "delivered"]))
        .optional()
        .describe("Only campaigns in these progress bands. Optional."),
      from_date: day("First"),
      to_date: day("Last"),
      completed: z.boolean().optional().describe("true for finished campaigns only. Default: open campaigns."),
      sort: z
        .enum(["lastActivity_new", "lastActivity_old", "progress_high", "progress_low", "campaignTitle_asc", "campaignTitle_desc"])
        .optional()
        .describe("Order. Default: newest created first."),
      page,
      page_size: pageSize(50, 20),
    },
    async (a) => {
      const res = await api.get("/getCampaignsByUserId", {
        search: a.search,
        company: joined(a.company),
        city: joined(a.city),
        jobType: joined(a.job_type),
        progress: joined(a.progress),
        startDate: a.from_date,
        endDate: a.to_date,
        isCompleted: a.completed ? "true" : undefined,
        sortType: a.sort,
        page: a.page,
        pageSize: a.page_size,
      });
      return {
        data: (res?.data || []).map((row: any) => ({
          ...pick(row, CAMPAIGN_ROW),
          teamSize: (row.assignedUsers || []).length,
        })),
        pagination: res?.pagination,
      };
    },
  );

  tool(
    "campaign_details",
    "The setup and headline numbers of one campaign: title, company, city, " +
      "dates, status, target tasks, tasks done, flagged and warned. Does not " +
      "include the questionnaire or the geofence shape.",
    { campaign_id: campaignId },
    async ({ campaign_id }) => {
      const res = await api.get("/getCampaignDetailsByCampaignId", { campaignId: campaign_id });
      return { ...pick(res?.campaign, CAMPAIGN_DETAIL), ongroundRoles: res?.ongroundRoles };
    },
  );

  tool(
    "campaign_team",
    "Who works on a campaign and who reports to whom, as a tree (name, role, " +
      "active or not), plus the brand and agencies on it. You see your own " +
      "branch of the tree unless you are a gOGig admin or the campaign owner. " +
      "No phone numbers.",
    { campaign_id: campaignId },
    async ({ campaign_id }) => {
      const res = await api.get("/getCampaignHierarchy", { campaignId: campaign_id });
      const children = res?.children || [];
      return { campaignId: res?.campaignId, people: countPeople(children), team: children.map(person), entities: res?.entities };
    },
  );

  tool(
    "my_team",
    "The people who report directly or indirectly to the user (name, role). " +
      "Pass a campaign to see each person's role on it and whether they are " +
      "assigned elsewhere. No phone numbers.",
    { campaign_id: campaignId.optional() },
    async ({ campaign_id }) => {
      const res = await api.get("/getUserBySuperiorId", { campaignId: campaign_id });
      return (res?.users || []).map((u: any) =>
        pick(u, ["userId", "fullName", "role", "campaignRole", "ongroundRole", "assignedElsewhere"]),
      );
    },
  );
}
