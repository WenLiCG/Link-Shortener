import { findDomainForwardTarget, findShortLinkByCode, findTargetByHost, recordShortLinkVisit } from "./db";
import { buildTargetUrl, noRefererHtml } from "./shared";

function html(targetHost: string): string {
  const escaped = targetHost.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escaped}</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#1d2433;background:#f5f7fb}
    main{width:min(520px,calc(100vw - 32px));padding:28px;border:1px solid #dce3ee;border-radius:8px;background:#fff;box-shadow:0 24px 80px rgba(35,48,74,.12)}
    h1{margin:0 0 8px;font-size:22px}
    p{margin:0;color:#667085;line-height:1.6}
    code{display:inline-block;margin-top:14px;padding:6px 8px;border-radius:6px;background:#f8fafc;color:#0c6b58;font-weight:700}
  </style>
</head>
<body>
  <main>
    <h1>目标服务已就绪</h1>
    <p>这个域名已经由跳转管理系统承接，可作为入口域名的最终跳转目标。</p>
    <code>${escaped}</code>
  </main>
</body>
</html>`;
}

export async function handleTargetService(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const host = url.host.split(":")[0]?.toLowerCase() ?? url.hostname.toLowerCase();
  const target = await findTargetByHost(env.DB, host);
  if (!target) {
    return null;
  }
  if (url.pathname.startsWith("/api/")) {
    return new Response("Not found", { status: 404 });
  }
  const forwardMatch = url.pathname.match(/^\/go\/([^/]+)\/?$/);
  if (forwardMatch) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    const forwardHost = await findDomainForwardTarget(env.DB, forwardMatch[1], target.targetHost);
    if (!forwardHost) {
      return new Response("Forward target is not configured.", { status: 404 });
    }
    return Response.redirect(buildTargetUrl(forwardHost), 302);
  }
  const shortCodeMatch = url.pathname.match(/^\/([A-Za-z0-9_-]{3,32})\/?$/);
  if (shortCodeMatch) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    const shortLink = await findShortLinkByCode(env.DB, target.targetHost, shortCodeMatch[1]);
    if (shortLink) {
      if (request.method === "GET") {
        await recordShortLinkVisit(env.DB, shortLink.id);
      }
      if (shortLink.hideReferer && request.method === "GET") {
        return noRefererHtml(shortLink.originalUrl);
      }
      return Response.redirect(shortLink.originalUrl, 302);
    }
    return new Response("Short link is not configured.", { status: 404 });
  }
  if (request.method === "HEAD") {
    return new Response(null, {
      status: 204,
      headers: {
        "cache-control": "no-store",
      },
    });
  }
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }
  return new Response(html(target.targetHost), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
