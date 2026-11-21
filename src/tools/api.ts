/**
 * The client every tool talks to the gogig API through.
 *
 * Each call carries the CALLER's gogig token, so the API's own guards and
 * scoping decide what they see. Nothing in this repo touches the database.
 */
const TIMEOUT_MS = 60_000;
// The Excel route builds the workbook inline, up to ~50k rows.
const FILE_TIMEOUT_MS = 180_000;

export type Params = Record<string, string | number | boolean | undefined>;

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
