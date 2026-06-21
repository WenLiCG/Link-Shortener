import { findDomainByHost, recordVisit } from "./db";
import { buildTargetUrl, noRefererHtml } from "./shared";

export async function handleRedirect(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const host = url.host.split(":")[0] ?? url.host;
  if (url.pathname.startsWith("/api/")) {
    return new Response("Not found", { status: 404 });
  }
  const domain = await findDomainByHost(env.DB, host);
  if (!domain) {
    return new Response("Redirect domain is not configured.", { status: 404 });
  }
  const targetUrl =
    domain.redirectMode === "target_service_forward"
      ? buildTargetUrl(domain.targetHost).replace(/\/$/, `/go/${domain.id}`)
      : buildTargetUrl(domain.targetHost);
  ctx.waitUntil(
    recordVisit(env.DB, {
      redirectDomainId: domain.id,
      host,
      path: url.pathname,
      referer: request.headers.get("referer"),
      country: request.cf?.country ? String(request.cf.country) : null,
      userAgent: request.headers.get("user-agent"),
      targetHost: domain.redirectMode === "direct" ? domain.directTargetHost ?? domain.targetHost : domain.targetHost,
      hideReferer: domain.hideReferer,
    }),
  );
  if (domain.hideReferer) {
    return noRefererHtml(targetUrl);
  }
  return Response.redirect(targetUrl, 302);
}
