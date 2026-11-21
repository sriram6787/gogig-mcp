/**
 * The gateway Claude connects to (claude.ai / Claude desktop custom connector,
 * Claude Code `--transport http`).
 *
 * POST /mcp carries Claude's MCP messages (Streamable HTTP, stateless: every
 * request stands alone) and needs `Authorization: Bearer <token>`. Every tool
 * call goes to the gogig API with the person's own gogig token, so the API
 * decides what they see. The token arrives one of two ways:
 *   - OAuth (MCP_PUBLIC_URL set): the person clicks Connect in Claude and signs
 *     in through gogig-ui (oauth.ts); Claude then holds and refreshes its token
 *   - pasted (MCP_OAUTH=off): a gogig token typed into the connector's request
 *     header, for testing
 *
 * GET /downloads/<id>/<name> serves report files for DOWNLOAD_TTL_MINUTES.
 *
 * Env (see .env.example):
 *   GOGIG_API_URL         gogig API base URL (default http://localhost:3000)
 *   GOGIG_UI_URL          gogig-ui base URL, where people sign in (OAuth)
 *   GOGIG_CLIENT_ID       AuthClient the gateway signs in as (default mcp_gogig)
 *   GOGIG_CLIENT_SECRET   that AuthClient's secret_key (OAuth)
 *   GOGIG_AUTH_ORIGIN     sent as Origin, in that client's allowedUrls (default MCP_PUBLIC_URL)
 *   MCP_PUBLIC_URL        this gateway's public https address; turns on OAuth
 *   MCP_OAUTH=off         keep pasted tokens even with MCP_PUBLIC_URL set
 *   MCP_PORT / MCP_HOST   where to listen (default 127.0.0.1:5100; HTTPS goes in front)
 *   MCP_DATA_DIR          where Claude's client registrations are kept (default ./.data)
 *   MCP_DEBUG=1           log each sign-in request and answer (secrets cut short)
 */
import { join } from "node:path";
import express, { Request, RequestHandler, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { DOWNLOAD_TTL_MINUTES, getDownload, putDownload } from "./downloads";
import { GogigOAuthProvider, inspectGogigToken } from "./oauth";
import { makeApi, registerGogigTools, SaveFile } from "./tools/index";

const API_URL = process.env.GOGIG_API_URL || "http://localhost:3000";
const UI_URL = (process.env.GOGIG_UI_URL || "").replace(/\/+$/, "");
const CLIENT_ID = process.env.GOGIG_CLIENT_ID || "mcp_gogig";
const CLIENT_SECRET = process.env.GOGIG_CLIENT_SECRET || "";
const PORT = Number(process.env.MCP_PORT || 5100);
const HOST = process.env.MCP_HOST || "127.0.0.1";
const PUBLIC_URL = (process.env.MCP_PUBLIC_URL || "").replace(/\/+$/, "");
const DATA_DIR = process.env.MCP_DATA_DIR || join(__dirname, "..", ".data");
// MCP_OAUTH=off keeps pasted-token sign-in while MCP_PUBLIC_URL still builds download links.
const OAUTH = Boolean(PUBLIC_URL) && process.env.MCP_OAUTH !== "off";

if (OAUTH && (!UI_URL || !CLIENT_SECRET)) {
  console.error("OAuth needs GOGIG_UI_URL and GOGIG_CLIENT_SECRET (or set MCP_OAUTH=off for pasted tokens).");
  process.exit(1);
}

const app = express();
// Behind a tunnel or proxy: trust its X-Forwarded-* (protocol, client IP for rate limits).
app.set("trust proxy", 1);

// MCP_DEBUG=1 adds what each sign-in request asked for and what we answered.
const DEBUG = process.env.MCP_DEBUG === "1";
// Secrets and tokens are cut to a short prefix in debug lines.
const SECRET_KEYS = new Set(["client_secret", "code", "code_verifier", "code_challenge", "refresh_token", "access_token", "state"]);
function redact(value: any): any {
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.has(k) && typeof v === "string" ? `${v.slice(0, 6)}…(${v.length} chars)` : v;
  }
  return out;
}
const isEmpty = (v: any) => !v || (typeof v === "object" && Object.keys(v).length === 0);

// One line per request (sign-in steps, /mcp, downloads): method, path, status and any OAuth error name.
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const started = Date.now();
  let failure = "";
  let sent: any;
  const json = res.json.bind(res);
  res.json = ((body: any) => {
    sent = body;
    if (body && typeof body === "object" && typeof body.error === "string") {
      failure = ` ${body.error}${body.error_description ? ` (${body.error_description})` : ""}`;
    }
    return json(body);
  }) as typeof res.json;
  res.on("finish", () => {
    // originalUrl, not path: inside the SDK's sign-in router `path` is relative to its mount.
    const path = req.originalUrl.split("?")[0];
    console.log(`[http] ${new Date().toLocaleTimeString()} ${req.method} ${path} -> ${res.statusCode}${failure} ${Date.now() - started}ms`);
    if (!DEBUG || path.startsWith("/downloads") || path.startsWith("/oauth/")) return;
    const scheme = (req.headers.authorization || "").split(" ")[0] || "none";
    console.log(`        from: ${req.get("user-agent") || "?"} | auth header: ${scheme}`);
    if (!isEmpty(req.query)) console.log(`        query: ${JSON.stringify(redact(req.query))}`);
    const isMcp = path === "/" || path === "/mcp";
    if (!isEmpty(req.body)) {
      const shown = isMcp
        ? { method: req.body.method, params: req.body.params?.clientInfo ? { clientInfo: req.body.params.clientInfo, protocolVersion: req.body.params.protocolVersion } : req.body.params?.name }
        : redact(req.body);
      console.log(`        body: ${JSON.stringify(shown)}`);
    }
    const challenge = res.getHeader("www-authenticate");
    if (challenge) console.log(`        www-authenticate: ${challenge}`);
    if (!isMcp && sent !== undefined) console.log(`        answer: ${JSON.stringify(redact(sent))}`);
  });
  next();
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", oauth: OAUTH });
});

app.get(["/downloads/:id", "/downloads/:id/:name"], (req, res) => {
  const file = getDownload(String(req.params.id));
  if (!file) {
    res.status(404).type("text").send("This download link has expired. Ask Claude to generate the report again.");
    return;
  }
  res
    .status(200)
    .set("Content-Type", file.contentType)
    .set("Content-Disposition", `attachment; filename="${file.filename.replace(/"/g, "")}"`)
    .send(file.data);
});

// --------------------------------------------------------------- sign-in ---

// Claude checks that the sign-in metadata names the SAME address it was given, so
// /mcp and the bare address each advertise themselves.
let bearer: RequestHandler; // for <public>/mcp
let bearerBare: RequestHandler; // for <public>/
if (OAUTH) {
  const provider = new GogigOAuthProvider(
    {
      apiUrl: API_URL,
      uiUrl: UI_URL,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      origin: process.env.GOGIG_AUTH_ORIGIN || PUBLIC_URL,
    },
    join(DATA_DIR, "oauth-clients.json"),
  );
  const resourceUrl = new URL(`${PUBLIC_URL}/mcp`);
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(PUBLIC_URL),
      resourceServerUrl: resourceUrl,
      resourceName: "gogig",
    }),
  );
  // gogig-ui sends the browser back here after the person allows (or cancels).
  app.get("/oauth/ui-callback", provider.handleUiCallback);
  // The bare address (what people paste when they leave off /mcp) is its own resource.
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({ resource: PUBLIC_URL, authorization_servers: [`${PUBLIC_URL}/`], resource_name: "gogig" });
  });
  bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
  });
  bearerBare = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: `${PUBLIC_URL}/.well-known/oauth-protected-resource`,
  });
} else {
  bearer = bearerBare = requireBearerAuth({ verifier: { verifyAccessToken: async (t: string) => inspectGogigToken(t) } });
}

// ------------------------------------------------------------------- MCP ---

async function handleMcp(req: Request, res: Response) {
  // OAuth: Claude holds a gateway token and the gogig token comes from the session behind it.
  // Pasted-token mode: the pasted token is the gogig token.
  const token = (req.auth!.extra?.gogigToken as string | undefined) ?? req.auth!.token;
  const base = PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  const saveFile: SaveFile = async (file) => ({
    link: `${base}/downloads/${putDownload(file)}/${encodeURIComponent(file.filename)}`,
    note: `Link expires in ${DOWNLOAD_TTL_MINUTES} minutes.`,
  });

  // One server and transport per request, bound to this caller's token.
  const server = new McpServer({ name: "gogig-mcp", version: "0.4.0" });
  registerGogigTools(server, makeApi(API_URL, () => token), saveFile);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[mcp] request failed:", e);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32000, message: "Internal server error" }, id: null });
    }
  }
}

// One line per request: what Claude asked and what token it sent (never the token itself).
function logRequest(req: Request, _res: Response, next: () => void) {
  const header = req.headers.authorization;
  let auth = "no Authorization header";
  if (header) {
    const match = /^bearer\s+(.+)$/i.exec(header.trim());
    if (!match) auth = "Authorization header without 'Bearer '";
    else if (match[1].startsWith("gga_")) auth = "OAuth token issued by this gateway";
    else {
      try {
        const p = JSON.parse(Buffer.from(match[1].split(".")[1] ?? "", "base64url").toString("utf8"));
        const expired = typeof p.exp === "number" && p.exp * 1000 <= Date.now();
        auth = `token for ${p.sub} (${p.role}), ${expired ? "EXPIRED" : "valid until"} ${new Date(p.exp * 1000).toLocaleString()}`;
      } catch {
        auth = "token is not a gogig JWT";
      }
    }
  }
  const rpc = req.body?.method ?? "?";
  const tool = req.body?.params?.name ? ` ${req.body.params.name}` : "";
  console.log(`[mcp] ${new Date().toLocaleTimeString()} ${rpc}${tool} | ${auth}`);
  next();
}

// The bare address works too, so a pasted URL without /mcp still connects.
const MCP_PATHS = ["/mcp", "/"];
const jsonBody = express.json({ limit: "4mb" });
app.post("/mcp", jsonBody, logRequest, bearer, (req, res) => void handleMcp(req, res));
app.post("/", jsonBody, logRequest, bearerBare, (req, res) => void handleMcp(req, res));
// Stateless: nothing to stream back on GET and no session to end on DELETE.
app.all(MCP_PATHS, (_req, res) => {
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});

app.listen(PORT, HOST, () => {
  console.log(`gogig-mcp gateway on http://${HOST}:${PORT}/mcp (API ${API_URL})`);
  console.log(
    OAUTH
      ? `OAuth sign-in on via ${UI_URL}/connect/claude as ${CLIENT_ID}; public address ${PUBLIC_URL}`
      : `OAuth off: pasted tokens only${PUBLIC_URL ? `; download links use ${PUBLIC_URL}` : ""}`,
  );
});
