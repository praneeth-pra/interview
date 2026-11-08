// Sends each request to the public site, admin sign-in, AI connectors (MCP) or the admin area.
import { BASE_HEADERS, type Srv, json } from "../http";
import { adminRoute } from "./admin";
import { authRoute } from "./auth";
import { mcpRoute } from "./mcp";
import { publicRoute } from "./public";

export async function route(req: Request, srv: Srv): Promise<Response> {
  const url = new URL(req.url);
  const res = (await publicRoute(req, url, srv)) ?? (await authRoute(req, url, srv)) ?? (await mcpRoute(req, url, srv));
  if (res) return res;
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/"))
    return (await adminRoute(req, url, srv)) ?? json({ error: "Not found." }, 404);
  return new Response("Not found", { status: 404, headers: BASE_HEADERS });
}
