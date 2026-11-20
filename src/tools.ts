/**
 * The gogig-analytics tools, shared by both ways of serving them:
 *   gogig-analytics.ts       stdio, started by Claude on one person's machine
 *   gogig-analytics-http.ts  HTTP, a hosted link Claude connects to
 *
 * Each tool makes one call to the gogig API with the CALLER's token, so the
 * API's own guards and scoping decide what they see. Nothing here touches the
 * database.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const TIMEOUT_MS = 60_000;
// The Excel route builds the workbook inline, up to ~50k rows.
const FILE_TIMEOUT_MS = 180_000;

type Params = Record<string, string | number | undefined>;

export interface DownloadedFile {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface GogigApi {
  get(path: string, params?: Params): Promise<any>;
  post(path: string, body: Record<string, unknown>): Promise<any>;
  getFile(path: string, params?: Params): Promise<DownloadedFile>;
}

/** Hands a file to the person: a short-lived link (HTTP) or a saved path (stdio). */
export type SaveFile = (file: DownloadedFile) => Promise<{ link?: string; path?: string; note?: string }>;

/** Calls against `baseUrl` carrying the Bearer token `token()` returns. */
export function makeApi(baseUrl: string, token: () => string | undefined): GogigApi {
  const base = baseUrl.replace(/\/+$/, "");

  const call = async (path: string, init: RequestInit, params: Params, timeoutMs: number) => {
    const bearer = (token() || "").trim().replace(/^bearer\s+/i, "");
    if (!bearer) throw new Error("No gogig token: sign in again.");

    const url = new URL(base + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }

    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(`Could not reach the gogig API at ${base}: ${(e as Error).message}`);
    }
    if (res.status === 401) {
      throw new Error("The gogig token was rejected (expired, or signed in on another device). Sign in again.");
    }
    if (res.status === 403) {
      throw new Error("Access denied: this account cannot see that data.");
    }
    return res;
  };

  const json = async (res: Response) => {
    const text = await res.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON; keep the text for the error below.
    }
    if (!res.ok) {
      const detail = body?.errorCause ?? body?.message ?? body?.cause ?? body;
      const shown = typeof detail === "string" ? detail.slice(0, 300) : JSON.stringify(detail);
      throw new Error(`API ${res.status}: ${shown}`);
    }
    return body;
  };

  return {
    get: async (path, params = {}) => json(await call(path, {}, params, TIMEOUT_MS)),
    post: async (path, body) =>
      json(
        await call(
          path,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
          {},
          TIMEOUT_MS,
        ),
      ),
    getFile: async (path, params = {}) => {
      const res = await call(path, {}, params, FILE_TIMEOUT_MS);
      if (!res.ok) await json(res); // throws with the API's message
      const disposition = res.headers.get("content-disposition") || "";
      const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
      return {
        filename: named ? decodeURIComponent(named) : "report.xlsx",
        contentType: res.headers.get("content-type") || "application/octet-stream",
        data: Buffer.from(await res.arrayBuffer()),
      };
    },
  };
}

const day = (what: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
    .optional()
    .describe(`${what} day, YYYY-MM-DD, inclusive. Optional.`);
const campaignId = z.string().min(1).describe("The campaign's gigId, from find_campaign.");
const reasonCodes = z
  .array(z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/))
  .max(50)
  .optional()
  .describe("Only tasks flagged with these reason codes, e.g. [\"entryOutOfGeoFence\"]. Optional.");

// "from,to" the way the report routes take dates; one date alone means that single day.
const dateFilter = (from?: string, to?: string) =>
  from || to ? `${from || to},${to || from}` : undefined;

/** Registers the tools on `server`, each answering through `api`; files go through `saveFile`. */
export function registerGogigTools(server: McpServer, api: GogigApi, saveFile: SaveFile): void {
  // Plain signature: the SDK's generic one recurses too deep under the root tsconfig (TS2589).
  const register = server.registerTool.bind(server) as (
    name: string,
    config: {
      description: string;
      inputSchema: z.ZodRawShape;
      annotations: { readOnlyHint: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
    },
    cb: (args: any) => Promise<unknown>,
  ) => unknown;

  // `readOnly: false` marks tools that start work or send email, so Claude asks first.
  const tool = (
    name: string,
    description: string,
    shape: z.ZodRawShape,
    run: (args: any) => Promise<unknown>,
    readOnly = true,
  ) => {
    register(
      name,
      {
        description,
        inputSchema: shape,
        annotations: readOnly
          ? { readOnlyHint: true }
          : { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async (args: any) => {
        try {
          const data = await run(args);
          // Compact JSON: Claude reads every byte of a result, and pays for it in tokens.
          return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
        } catch (e) {
          return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
        }
      },
    );
  };

  // ---------------------------------------------------------------- stats ---

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
      limit: z.number().int().min(1).max(200).optional().describe("How many, 1-200. Default 50."),
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

  // -------------------------------------------------------------- reports ---
  // The console's own report routes, so the files are exactly what the
  // console produces and the same access and hierarchy rules apply.

  tool(
    "generate_report",
    "Start the campaign's PDF report (kind 'pdf') or ZIP of original photos " +
      "(kind 'zip'), the same files the console's report page makes. It runs in " +
      "the background (often several minutes) and is EMAILED to the user's own " +
      "account address, returned here masked as emailTo. Covers everyone the user " +
      "may see. Dates and reason codes narrow the PDF only. Check progress, and " +
      "get the download link once ready, with report_status.",
    {
      campaign_id: campaignId,
      kind: z.enum(["pdf", "zip"]).describe("'pdf' report or 'zip' of original photos."),
      from_date: day("First"),
      to_date: day("Last"),
      reason_codes: reasonCodes,
    },
    async ({ campaign_id, kind, from_date, to_date, reason_codes }) =>
      api.post("/createGenerateReportRequest", {
        gigId: campaign_id,
        action: kind === "zip" ? "generateZIP" : "generatePDF",
        executionIds: "",
        ...(kind === "pdf" && dateFilter(from_date, to_date)
          ? { dateFilter: dateFilter(from_date, to_date) }
          : {}),
        ...(kind === "pdf" && reason_codes?.length ? { validationReason: reason_codes.join(",") } : {}),
      }),
    false,
  );

  tool(
    "report_status",
    "Progress of the user's PDF and ZIP reports for a campaign, and their " +
      "download links once status is 'success' (links stay valid for about 48 " +
      "hours). Statuses: pending, processing, in_progress, success, failed.",
    { campaign_id: campaignId },
    async ({ campaign_id }) => {
      const job = await api.get("/getReportJob", { gigId: campaign_id });
      if (!job) return { message: "No report has been generated for this campaign yet." };
      return {
        pdf: { status: job.pdfStatus ?? null, progress: job.pdfProgress ?? null, url: job.pdfUrl ?? null, generatedAt: job.pdfGeneratedAt ?? null },
        zip: { status: job.zipStatus ?? null, progress: job.zipProgress ?? null, url: job.zipUrl ?? null, generatedAt: job.zipGeneratedAt ?? null },
      };
    },
  );

  tool(
    "generate_excel_report",
    "Build the campaign's Excel report now (the console's Excel download) and " +
      "return a link to the .xlsx file. Covers everyone the user may see; dates " +
      "and reason codes narrow it. Large campaigns can take a minute. Give the " +
      "user the link; it expires.",
    {
      campaign_id: campaignId,
      from_date: day("First"),
      to_date: day("Last"),
      reason_codes: reasonCodes,
    },
    async ({ campaign_id, from_date, to_date, reason_codes }) => {
      const file = await api.getFile("/generateExcelReport", {
        gigId: campaign_id,
        dateFilter: dateFilter(from_date, to_date),
        validationReason: reason_codes?.length ? reason_codes.join(",") : undefined,
      });
      const saved = await saveFile(file);
      return { filename: file.filename, sizeKb: Math.round(file.data.length / 1024), ...saved };
    },
    false,
  );
}
