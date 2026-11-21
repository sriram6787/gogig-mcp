/**
 * The console's own report routes, so the files are exactly what the console
 * produces and the same access and hierarchy rules apply.
 * POST /createGenerateReportRequest, GET /getReportJob, GET /generateExcelReport.
 * The two that start work are not read-only, so Claude asks before running them.
 */
import { campaignId, dateFilter, day, Kit, reasonCodes } from "./kit";
import { z } from "zod";

export function registerReportTools({ api, saveFile, tool }: Kit): void {
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
