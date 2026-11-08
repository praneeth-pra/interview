// Sign-in for AI connectors (Claude's custom connectors, Claude Code and other MCP apps) to the /mcp endpoint: OAuth 2.1
// with PKCE and dynamic client registration, as the MCP spec asks. An app registers itself, sends the admin to
// /admin/oauth/authorize (under /admin, where the sign-in cookie goes), the admin signs in with the usual emailed code
// and presses Allow, and the app swaps the code it gets for an access token (1 hour) and a refresh token (60 days).
// A token works only while its admin is still on the admin list; owners' tokens also reach the owner-only tools.
import { MCP_REDIRECT_HOSTS } from "./config";
import { type OAuthClient, type OAuthToken, isAdmin, oauthStore } from "./data";
import { BASE_HEADERS, CSP, json } from "./http";
import { saveStore } from "./store";
import { DAY_MS, type Fields, sha256 } from "./util";
import { createHash, randomBytes } from "node:crypto";

const ACCESS_SECONDS = 3600;
const REFRESH_DAYS = 60;
const CODE_MS = 5 * 60000;
const MAX_CLIENTS = 200;

// Metadata documents (RFC 9728 and RFC 8414): where an app finds out how to sign in.
export const resourceMetadata = (base: string) => ({
  resource: base + "/mcp",
  authorization_servers: [base],
  bearer_methods_supported: ["header"],
  resource_name: "Hi-Techie interviews",
});
export const serverMetadata = (base: string) => ({
  issuer: base,
  authorization_endpoint: base + "/admin/oauth/authorize",
  token_endpoint: base + "/oauth/token",
  registration_endpoint: base + "/oauth/register",
  revocation_endpoint: base + "/oauth/revoke",
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  revocation_endpoint_auth_methods_supported: ["none"],
  scopes_supported: ["read"],
});

// Where an app may send the admin back to: Claude (claude.ai, claude.com), apps on the admin's own computer (Claude
// Code, Claude Desktop) and any host listed in MCP_REDIRECT_HOSTS. Anything else is refused at registration, so a
// stranger's app can't collect a code even if an admin is tricked into pressing Allow.
const DEFAULT_HOSTS = ["claude.ai", "claude.com"];
export function redirectOk(uri: string) {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "http:") return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return [...DEFAULT_HOSTS, ...MCP_REDIRECT_HOSTS].some((h) => host === h || host.endsWith("." + h));
}

// POST /oauth/register (RFC 7591): any app may register, with redirect addresses from the list above.
export async function registerClient(body: Fields): Promise<Response> {
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (!uris.length || uris.length > 10 || uris.some((u) => u.length > 500))
    return json({ error: "invalid_redirect_uri", error_description: "Give one to ten redirect_uris." }, 400);
  const bad = uris.find((u) => !redirectOk(u));
  if (bad) return json({ error: "invalid_redirect_uri", error_description: "This server doesn't send sign-ins to " + bad }, 400);
  const name =
    (typeof body.client_name === "string" ? body.client_name : "")
      .replace(/[\x00-\x1f\x7f]/g, "")
      .trim()
      .slice(0, 60) || "An AI app";
  const client: OAuthClient = { id: randomBytes(16).toString("hex"), name, redirects: uris, created: new Date().toISOString() };
  const s = oauthStore.data;
  s.clients.push(client);
  // keep the list bounded: drop the oldest apps that hold no tokens
  if (s.clients.length > MAX_CLIENTS) {
    const used = new Set(s.tokens.map((t) => t.client));
    const idle = s.clients.filter((c) => !used.has(c.id)).slice(0, s.clients.length - MAX_CLIENTS);
    s.clients = s.clients.filter((c) => !idle.includes(c));
  }
  await saveStore(oauthStore).catch(() => {});
  return json(
    {
      client_id: client.id,
      client_name: client.name,
      redirect_uris: client.redirects,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_id_issued_at: Math.floor(Date.parse(client.created) / 1000),
    },
    201,
  );
}

// What an authorize request asks for, checked. An error before the redirect address is known is shown to the admin;
// after that, it goes back to the app.
export type AuthAsk = { client: OAuthClient; redirect: string; state: string; challenge: string };
export function readAuthAsk(p: URLSearchParams): AuthAsk | { error: string } | { redirectError: string; redirect: string; state: string } {
  const client = oauthStore.data.clients.find((c) => c.id === p.get("client_id"));
  if (!client) return { error: "This app isn't registered here. Remove the connector and add it again." };
  const redirect = p.get("redirect_uri") ?? (client.redirects.length === 1 ? client.redirects[0] : "");
  if (!client.redirects.includes(redirect)) return { error: "This app asked to go back to an address it didn't register." };
  const state = (p.get("state") ?? "").slice(0, 500);
  if (p.get("response_type") !== "code") return { redirectError: "unsupported_response_type", redirect, state };
  const challenge = p.get("code_challenge") ?? "";
  if (p.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge))
    return { redirectError: "invalid_request", redirect, state };
  return { client, redirect, state, challenge };
}
export const backTo = (redirect: string, params: Record<string, string>) => {
  const u = new URL(redirect);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { ...BASE_HEADERS, Location: u.toString() } });
};
// The consent page may post its form only here and to the app's own address (the answer redirects there).
export const consentCsp = (redirect: string) => CSP.page.replace("form-action 'self'", "form-action 'self' " + new URL(redirect).origin);

// Codes live in memory for 5 minutes and work once.
const codes = new Map<string, { client: string; redirect: string; challenge: string; email: string; exp: number }>();
export function issueCode(ask: AuthAsk, email: string) {
  const now = Date.now();
  for (const [k, v] of codes) if (v.exp < now) codes.delete(k);
  const code = randomBytes(32).toString("hex");
  codes.set(sha256(code), { client: ask.client.id, redirect: ask.redirect, challenge: ask.challenge, email, exp: now + CODE_MS });
  return code;
}

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const tokenError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);
async function issueTokens(email: string, client: string, grant: string) {
  const access = randomBytes(32).toString("hex");
  const refresh = randomBytes(32).toString("hex");
  const now = Date.now();
  const s = oauthStore.data;
  s.tokens = s.tokens.filter((t) => t.exp > now);
  s.tokens.push(
    { id: sha256(access), kind: "access", email, client, grant, exp: now + ACCESS_SECONDS * 1000 },
    { id: sha256(refresh), kind: "refresh", email, client, grant, exp: now + REFRESH_DAYS * DAY_MS },
  );
  try {
    await saveStore(oauthStore);
  } catch {
    return tokenError("server_error", "Couldn't save the sign-in. Try again.", 500);
  }
  return json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: "read" });
}
// POST /oauth/token: a code (with its PKCE verifier) or a refresh token for a new pair. A refresh token works once.
export async function tokenRequest(p: URLSearchParams, loginOn: boolean): Promise<Response> {
  const clientId = p.get("client_id") ?? "";
  const grantType = p.get("grant_type");
  if (grantType === "authorization_code") {
    const key = sha256(p.get("code") ?? "");
    const c = codes.get(key);
    codes.delete(key);
    if (!c || c.exp < Date.now() || c.client !== clientId) return tokenError("invalid_grant", "The code isn't valid or has expired.");
    if ((p.get("redirect_uri") ?? c.redirect) !== c.redirect) return tokenError("invalid_grant", "The redirect_uri doesn't match.");
    const verifier = p.get("code_verifier") ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || b64url(createHash("sha256").update(verifier).digest()) !== c.challenge)
      return tokenError("invalid_grant", "The code_verifier doesn't match.");
    if (loginOn && !isAdmin(c.email)) return tokenError("invalid_grant", "This email isn't on the admin list any more.");
    return issueTokens(c.email, c.client, randomBytes(16).toString("hex"));
  }
  if (grantType === "refresh_token") {
    const id = sha256(p.get("refresh_token") ?? "");
    const s = oauthStore.data;
    const t = s.tokens.find((x) => x.id === id && x.kind === "refresh");
    if (!t || t.exp < Date.now() || t.client !== clientId) return tokenError("invalid_grant", "Sign in again.");
    // the old pair stops working, whatever happens next
    s.tokens = s.tokens.filter((x) => x.grant !== t.grant);
    if (loginOn && !isAdmin(t.email)) {
      await saveStore(oauthStore).catch(() => {});
      return tokenError("invalid_grant", "This email isn't on the admin list any more.");
    }
    return issueTokens(t.email, t.client, t.grant);
  }
  return tokenError("unsupported_grant_type", "Use authorization_code or refresh_token.");
}
// POST /oauth/revoke (RFC 7009): disconnecting ends the whole connection, both tokens.
export async function revokeToken(p: URLSearchParams): Promise<Response> {
  const id = sha256(p.get("token") ?? "");
  const t = oauthStore.data.tokens.find((x) => x.id === id);
  if (t) {
    oauthStore.data.tokens = oauthStore.data.tokens.filter((x) => x.grant !== t.grant);
    await saveStore(oauthStore).catch(() => {});
  }
  return new Response(null, { status: 200, headers: BASE_HEADERS });
}
// The admin behind a request's bearer token, or null.
export function bearerOf(req: Request, loginOn: boolean): OAuthToken | null {
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer ([a-f0-9]{64})$/i);
  if (!m) return null;
  const id = sha256(m[1].toLowerCase());
  const t = oauthStore.data.tokens.find((x) => x.id === id && x.kind === "access");
  if (!t || t.exp < Date.now()) return null;
  if (loginOn && !isAdmin(t.email)) return null;
  if (!oauthStore.data.clients.some((c) => c.id === t.client)) return null;
  return t;
}
