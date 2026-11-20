/**
 * OAuth sign-in for the gateway, through gogig-ui's own login.
 *
 * A person adds the connector by URL in Claude and clicks Connect. The SDK's
 * mcpAuthRouter serves the standard endpoints (discovery, /authorize, /token,
 * /register, PKCE checks); this provider is the gogig-specific part:
 *
 *   authorize         sends the browser to gogig-ui /connect/claude?request=<id>.
 *                     gogig-ui signs the person in as usual (ProtectedRoute) and
 *                     asks them to Allow
 *   /oauth/ui-callback  gogig-ui sends the browser back with a one-time code from
 *                     the API (POST /mcpConnect/code). The gateway exchanges it,
 *                     server to server, at POST /mcpConnect/token with the MCP
 *                     client's credentials, for the person's gogig session, then
 *                     returns the browser to Claude with an OAuth code
 *   token             that code becomes a gateway-issued OPAQUE access token (1h)
 *                     and refresh token for Claude. The gogig session stays here;
 *                     on each tool call the gateway swaps in the real gogig token,
 *                     so the API's guards and scoping are unchanged
 *   renewal           the gateway renews the 4h gogig token itself through the
 *                     API's own POST /renewAccessToken
 *
 * Stored IN MEMORY: sign-in requests (10 min), codes (5 min), sessions (30 days),
 * so a restart signs everyone out (they click Connect again) and one process
 * must serve all traffic. Claude's client registrations are kept in a JSON file.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import bcrypt from "bcryptjs";
import type { Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

const REQUEST_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
const ACCESS_TTL_MS = 60 * 60_000; // what Claude's token lives
const REFRESH_TTL_MS = 30 * 24 * 3600_000; // how long a person stays connected without signing in again
const RENEW_BEFORE_MS = 2 * 60_000; // renew the gogig token when it has less than this left

const newId = () => randomBytes(24).toString("hex");

// ------------------------------------------------------------- gogig auth ---

export interface GogigAuthConfig {
  apiUrl: string;
  /** gogig-ui, where people sign in and allow access (/connect/claude). */
  uiUrl: string;
  /** AuthClient.clientId the gateway signs in as, e.g. mcp_gogig. */
  clientId: string;
  /** That AuthClient's secret_key. Sent bcrypt-hashed, as POST /getM2MToken callers do. */
  clientSecret: string;
  /** Sent as Origin; must be one of that AuthClient's allowedUrls. */
  origin: string;
}

interface GogigSession {
  accessToken: string;
  expiresAt: number; // ms
  refreshToken?: string;
}

async function readJson(res: globalThis.Response): Promise<any> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { message: text.slice(0, 200) };
  }
}

const apiMessage = (body: any, fallback: string) =>
  String(body?.errorCause ?? body?.message ?? body?.error ?? fallback);

const baseOf = (cfg: GogigAuthConfig) => cfg.apiUrl.replace(/\/+$/, "");

/** Swaps gogig-ui's one-time code for the person's gogig session (POST /mcpConnect/token). */
async function gogigExchangeCode(cfg: GogigAuthConfig, secretHash: string, code: string): Promise<GogigSession> {
  const res = await fetch(`${baseOf(cfg)}/mcpConnect/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      clientid: cfg.clientId,
      clientsecret: secretHash,
      Origin: cfg.origin,
    },
    body: JSON.stringify({ code }),
  });
  const body = await readJson(res);
  if (!res.ok || !body.token) {
    throw new Error(res.status >= 500 ? "gogig is unavailable right now" : apiMessage(body, "gogig refused the sign-in"));
  }
  return {
    accessToken: body.token,
    expiresAt: Number(body.expiresAt) || Date.now() + 4 * 3600_000,
    refreshToken: body.refreshToken,
  };
}

/** A fresh access token from the API's own refresh route. */
async function gogigRenew(cfg: GogigAuthConfig, refreshToken: string): Promise<GogigSession> {
  const res = await fetch(`${baseOf(cfg)}/renewAccessToken?clientId=${encodeURIComponent(cfg.clientId)}`, {
    method: "POST",
    headers: { Cookie: `refreshToken=${encodeURIComponent(refreshToken)}`, Origin: cfg.origin },
  });
  const body = await readJson(res);
  if (!res.ok || !body.token) throw new InvalidGrantError("gogig session ended: sign in again");
  return { accessToken: body.token, expiresAt: Number(body.expiresAt) || Date.now() + 4 * 3600_000, refreshToken };
}

/**
 * Reads a pasted gogig JWT's own expiry (pasted-token mode). The signature is
 * NOT checked here: every tool call goes to the API, which verifies it.
 */
export function inspectGogigToken(token: string): AuthInfo {
  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    throw new InvalidTokenError("Not a gogig token");
  }
  if (!payload?.sub) throw new InvalidTokenError("Not a gogig token");
  if (typeof payload.exp === "number" && payload.exp * 1000 <= Date.now()) {
    throw new InvalidTokenError("Token has expired");
  }
  return { token, clientId: String(payload.azp || "gogig"), scopes: [], expiresAt: payload.exp };
}

// ---------------------------------------------------------- client store ---

/** Claude's client registration(s), kept in a small JSON file. */
class FileClientsStore implements OAuthRegisteredClientsStore {
  private clients = new Map<string, OAuthClientInformationFull>();

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      for (const c of JSON.parse(readFileSync(file, "utf8")) as OAuthClientInformationFull[]) {
        this.clients.set(c.client_id, c);
      }
    }
  }

  getClient(clientId: string) {
    return this.clients.get(clientId);
  }

  registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) {
    // The SDK's register handler has already filled in client_id.
    const full = {
      ...client,
      client_id: (client as OAuthClientInformationFull).client_id ?? newId(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    } as OAuthClientInformationFull;
    this.clients.set(full.client_id, full);
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify([...this.clients.values()], null, 2));
    return full;
  }
}

// ------------------------------------------------------------ the page ---

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const messagePage = (text: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>gogig for Claude</title>
<style>body{font-family:system-ui,sans-serif;background:#f5f5f4;color:#1c1917;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
.card{background:#fff;border:1px solid #e7e5e4;border-radius:12px;padding:28px;max-width:380px}h1{font-size:20px;margin:0 0 8px}p{color:#57534e;font-size:14px;margin:0}</style>
</head><body><div class="card"><h1>gogig for Claude</h1><p>${esc(text)}</p></div></body></html>`;

// -------------------------------------------------------------- provider ---

interface PendingRequest {
  clientId: string;
  params: AuthorizationParams;
  expiresAt: number;
}

interface IssuedCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  session: GogigSession;
  expiresAt: number;
}

/** One signed-in person: their gogig session, and the opaque refresh token Claude holds for it. */
interface Grant {
  clientId: string;
  session: GogigSession;
  refreshToken: string;
  refreshExpiresAt: number;
}

export class GogigOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: FileClientsStore;
  private readonly secretHash: string;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly codes = new Map<string, IssuedCode>();
  private readonly byAccess = new Map<string, { grant: Grant; expiresAt: number }>();
  private readonly byRefresh = new Map<string, Grant>();

  constructor(private readonly cfg: GogigAuthConfig, clientsFile: string) {
    this.clientsStore = new FileClientsStore(clientsFile);
    // Hashed once: the API compares the stored secret against any valid hash of it.
    this.secretHash = bcrypt.hashSync(cfg.clientSecret, 10);
    setInterval(() => this.prune(), 60_000).unref();
  }

  private prune() {
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expiresAt <= now) this.pending.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt <= now) this.codes.delete(k);
    for (const [k, v] of this.byAccess) if (v.expiresAt <= now) this.byAccess.delete(k);
    for (const [k, g] of this.byRefresh) if (g.refreshExpiresAt <= now) this.byRefresh.delete(k);
  }

  /** GET /authorize, already validated by the SDK: hand the person to gogig-ui. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const requestId = newId();
    this.pending.set(requestId, { clientId: client.client_id, params, expiresAt: Date.now() + REQUEST_TTL_MS });
    const signIn = new URL("/connect/claude", this.cfg.uiUrl);
    signIn.searchParams.set("request", requestId);
    res.redirect(302, signIn.toString());
  }

  /** GET /oauth/ui-callback?request_id=…&code=… (or &error=…) from gogig-ui. */
  handleUiCallback = async (req: Request, res: Response): Promise<void> => {
    const requestId = String(req.query.request_id || "");
    const pending = this.pending.get(requestId);
    if (!pending || pending.expiresAt <= Date.now()) {
      res.status(400).type("html").send(messagePage("This sign-in has expired. Go back to Claude and click Connect again."));
      return;
    }
    this.pending.delete(requestId); // one use, whatever happens next

    if (req.query.error) {
      this.backToClaude(res, pending, { error: "access_denied", error_description: "Access was not allowed in gogig" });
      return;
    }
    const code = String(req.query.code || "");
    if (!code) {
      res.status(400).type("html").send(messagePage("The sign-in came back without a code. Go back to Claude and click Connect again."));
      return;
    }

    let session: GogigSession;
    try {
      session = await gogigExchangeCode(this.cfg, this.secretHash, code);
    } catch (e) {
      console.error(`[oauth] connect code exchange failed: ${(e as Error).message}`);
      res
        .status(502)
        .type("html")
        .send(messagePage(`Couldn't finish connecting (${(e as Error).message}). Go back to Claude and click Connect again.`));
      return;
    }

    const issued = newId();
    this.codes.set(issued, {
      clientId: pending.clientId,
      codeChallenge: pending.params.codeChallenge,
      redirectUri: pending.params.redirectUri,
      session,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    this.backToClaude(res, pending, { code: issued });
  };

  /** Sends the browser back to Claude's callback, carrying `state`. */
  private backToClaude(res: Response, pending: PendingRequest, values: Record<string, string>) {
    const back = new URL(pending.params.redirectUri);
    for (const [k, v] of Object.entries(values)) back.searchParams.set(k, v);
    if (pending.params.state) back.searchParams.set("state", pending.params.state);
    res.redirect(302, back.toString());
  }

  private codeFor(client: OAuthClientInformationFull, code: string): IssuedCode {
    const issued = this.codes.get(code);
    if (!issued || issued.expiresAt <= Date.now() || issued.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return issued;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.codeFor(client, code).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const issued = this.codeFor(client, code);
    if (redirectUri && redirectUri !== issued.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    this.codes.delete(code); // one use only
    const grant: Grant = {
      clientId: client.client_id,
      session: issued.session,
      refreshToken: `ggr_${newId()}`,
      refreshExpiresAt: Date.now() + REFRESH_TTL_MS,
    };
    this.byRefresh.set(grant.refreshToken, grant);
    return this.issue(grant);
  }

  /** A new opaque access token for `grant`. The refresh token stays the same. */
  private issue(grant: Grant): OAuthTokens {
    const access = `gga_${newId()}`;
    this.byAccess.set(access, { grant, expiresAt: Date.now() + ACCESS_TTL_MS });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_MS / 1000,
      refresh_token: grant.refreshToken,
    };
  }

  /** The grant's gogig session, renewed first if it is about to run out. Throws once it has ended. */
  private async freshSession(grant: Grant): Promise<GogigSession> {
    const session = grant.session;
    if (session.expiresAt - Date.now() > RENEW_BEFORE_MS) return session;
    if (!session.refreshToken) throw new InvalidGrantError("gogig session ended: sign in again");
    grant.session = await gogigRenew(this.cfg, session.refreshToken);
    return grant.session;
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const grant = this.byRefresh.get(refreshToken);
    if (!grant || grant.refreshExpiresAt <= Date.now() || grant.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    try {
      await this.freshSession(grant);
    } catch {
      this.byRefresh.delete(refreshToken);
      throw new InvalidGrantError("gogig session ended: sign in again");
    }
    return this.issue(grant);
  }

  /**
   * Checks Claude's opaque token and hands the gateway the person's real gogig
   * token in `extra.gogigToken`, renewed if needed. A dead gogig session makes
   * the token invalid, so Claude refreshes, fails, and asks the person to sign in.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const entry = this.byAccess.get(token);
    if (!entry || entry.expiresAt <= Date.now()) throw new InvalidTokenError("Token has expired");
    let session: GogigSession;
    try {
      session = await this.freshSession(entry.grant);
    } catch {
      throw new InvalidTokenError("gogig session ended: sign in again");
    }
    return {
      token,
      clientId: entry.grant.clientId,
      scopes: [],
      expiresAt: Math.floor(entry.expiresAt / 1000),
      extra: { gogigToken: session.accessToken },
    };
  }
}
