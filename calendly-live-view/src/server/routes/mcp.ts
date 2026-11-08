// AI connectors: the MCP endpoint (/mcp), its OAuth sign-in (/oauth/*, and /admin/oauth/authorize where the admin's
// sign-in cookie is sent) and the metadata documents apps read first (/.well-known/*).
import { sessionOf } from "../auth";
import { LOGIN_ON } from "../config";
import { isOwner } from "../data";
import { BASE_HEADERS, type Srv, clientIp, json, sendShell, underLimit } from "../http";
import { baseUrl } from "../links";
import { handleRpc } from "../mcp";
import {
  backTo,
  bearerOf,
  consentCsp,
  issueCode,
  readAuthAsk,
  registerClient,
  resourceMetadata,
  revokeToken,
  serverMetadata,
  tokenRequest,
} from "../oauth";
import { LOGIN, connectPage } from "../pages";
import { asFields, safeEq, sha256 } from "../util";

// Apps in a browser (MCP Inspector and the like) call these from other sites. They carry a bearer token, never the
// admin's cookie, so any site may call them.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "WWW-Authenticate",
  "Access-Control-Max-Age": "86400",
};
const withCors = (res: Response) => {
  for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
  return res;
};
const MAX_MCP_BODY = 100_000;
const PROTECTED = ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"];
const AS_META = ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"];

// A form (or JSON) body as search params, for the token endpoints.
async function formOf(req: Request): Promise<URLSearchParams | null> {
  const raw = await req.text();
  if (raw.length > 5000) return null;
  if ((req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    try {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(asFields(JSON.parse(raw)))) if (typeof v === "string") p.set(k, v);
      return p;
    } catch {
      return null;
    }
  }
  return new URLSearchParams(raw);
}
const plain = (text: string, status: number) =>
  new Response(text, { status, headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
// Binds the consent form to the admin's session, on top of the Lax cookie (which other sites' forms don't carry).
const formKey = (sessionId: string, client: string) => sha256("oauth-consent:" + sessionId + ":" + client);

export async function mcpRoute(req: Request, url: URL, srv: Srv): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;
  const isApi = path === "/mcp" || path.startsWith("/oauth/") || PROTECTED.includes(path) || AS_META.includes(path);
  if (isApi && method === "OPTIONS") return new Response(null, { status: 204, headers: { ...BASE_HEADERS, ...CORS } });
  const base = baseUrl(req);

  if (PROTECTED.includes(path) && method === "GET") return withCors(json(resourceMetadata(base)));
  if (AS_META.includes(path) && method === "GET") return withCors(json(serverMetadata(base)));

  if (path === "/oauth/register" && method === "POST") {
    if (!underLimit("oauth-reg:" + clientIp(req, srv), 20, 3600000))
      return withCors(json({ error: "slow_down", error_description: "Too many apps registered from this network." }, 429));
    const raw = await req.text();
    let body: unknown = null;
    try {
      body = raw.length <= 10000 ? JSON.parse(raw) : null;
    } catch {}
    if (!body) return withCors(json({ error: "invalid_client_metadata", error_description: "Send JSON." }, 400));
    return withCors(await registerClient(asFields(body)));
  }
  if ((path === "/oauth/token" || path === "/oauth/revoke") && method === "POST") {
    if (!underLimit("oauth-token:" + clientIp(req, srv), 60, 600000))
      return withCors(json({ error: "slow_down", error_description: "Too many tries. Wait 10 minutes." }, 429));
    const p = await formOf(req);
    if (!p) return withCors(json({ error: "invalid_request" }, 400));
    return withCors(path === "/oauth/token" ? await tokenRequest(p, LOGIN_ON) : await revokeToken(p));
  }

  if (path === "/admin/oauth/authorize" && (method === "GET" || method === "POST")) {
    const me = LOGIN_ON ? sessionOf(req) : null;
    if (LOGIN_ON && !me) {
      // signing in reloads this page, which then asks to allow the app
      if (method === "GET") return sendShell(req, LOGIN);
      return plain("Your sign-in ended. Go back to the app and connect again.", 401);
    }
    const params = method === "GET" ? url.searchParams : await formOf(req);
    if (!params) return plain("Bad request.", 400);
    const ask = readAuthAsk(params);
    if ("error" in ask) return plain(ask.error, 400);
    if ("redirectError" in ask) return backTo(ask.redirect, { error: ask.redirectError, state: ask.state });
    const email = me?.email ?? "";
    const key = formKey(me?.id ?? "", ask.client.id);
    if (method === "GET")
      return connectPage(req, consentCsp(ask.redirect), {
        client: ask.client.name,
        target: new URL(ask.redirect).host,
        email,
        owner: isOwner(email),
        fields: {
          response_type: "code",
          client_id: ask.client.id,
          redirect_uri: ask.redirect,
          state: ask.state,
          code_challenge: ask.challenge,
          code_challenge_method: "S256",
          key,
        },
      });
    if (!safeEq(params.get("key") ?? "", key)) return plain("This page is out of date. Go back to the app and connect again.", 403);
    if (params.get("choice") !== "allow") return backTo(ask.redirect, { error: "access_denied", state: ask.state });
    console.log("ai connector allowed: " + (email || "(sign-in off)") + " → " + ask.client.name + " (" + new URL(ask.redirect).host + ")");
    return backTo(ask.redirect, { code: issueCode(ask, email), state: ask.state, iss: base });
  }

  if (path === "/mcp") {
    const token = bearerOf(req, LOGIN_ON);
    if (!token)
      return withCors(
        json({ error: "Sign in to use this connector." }, 401, {
          "WWW-Authenticate": 'Bearer resource_metadata="' + base + '/.well-known/oauth-protected-resource/mcp"',
        }),
      );
    // one JSON answer per POST; there is no event stream to open and no session to end
    if (method !== "POST") return withCors(json({ error: "Method not allowed." }, 405, { Allow: "POST, OPTIONS" }));
    if (!underLimit("mcp:" + token.grant, 600, 600000)) return withCors(json({ error: "Too many requests. Wait a few minutes." }, 429));
    const raw = await req.text();
    if (raw.length > MAX_MCP_BODY) return withCors(json({ error: "Too large." }, 413));
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return withCors(json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } }, 400));
    }
    const who = { email: token.email, owner: isOwner(token.email) };
    if (Array.isArray(msg)) {
      const out = msg
        .slice(0, 20)
        .map((m) => handleRpc(m, who))
        .filter((r) => r !== null);
      return withCors(out.length ? json(out) : new Response(null, { status: 202, headers: BASE_HEADERS }));
    }
    const out = handleRpc(msg, who);
    return withCors(out ? json(out) : new Response(null, { status: 202, headers: BASE_HEADERS }));
  }
  return null;
}
