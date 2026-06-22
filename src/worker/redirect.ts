import { findDomainByHost, recordVisit } from "./db";
import { buildTargetUrl, noRefererHtml } from "./shared";

function firstLanguage(header: string | null): string | null {
  const value = header?.split(",")[0]?.split(";")[0]?.trim();
  return value || null;
}

function numberFromCf(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clientFromUserAgent(userAgent: string | null): { operatingSystem: string | null; browser: string | null; deviceType: string | null } {
  const ua = userAgent ?? "";
  const lower = ua.toLowerCase();
  const operatingSystem =
    /windows nt/i.test(ua) ? "Windows"
      : /iphone|ipad|ipod/i.test(ua) ? "iOS"
        : /android/i.test(ua) ? "Android"
          : /mac os x|macintosh/i.test(ua) ? "macOS"
            : /linux/i.test(ua) ? "Linux"
              : null;
  const browser =
    /edg\//i.test(ua) ? "Edge"
      : /opr\//i.test(ua) ? "Opera"
        : /firefox\//i.test(ua) ? "Firefox"
          : /samsungbrowser\//i.test(ua) ? "Samsung Internet"
            : /chrome\//i.test(ua) || /crios\//i.test(ua) ? "Chrome"
              : /safari\//i.test(ua) ? "Safari"
                : /bot|crawler|spider|slurp|bingpreview/i.test(ua) ? "Bot"
                  : null;
  const deviceType =
    /bot|crawler|spider|slurp|bingpreview/i.test(ua) ? "Bot"
      : /ipad|tablet|playbook|silk/i.test(lower) ? "Tablet"
        : /mobile|iphone|ipod|android.*mobile/i.test(lower) ? "Mobile"
          : ua ? "Desktop" : null;
  return { operatingSystem, browser, deviceType };
}

const IGNORED_PAGE_VIEW_PATHS = new Set([
  "/favicon.ico",
  "/robots.txt",
  "/sitemap.xml",
  "/apple-touch-icon.png",
  "/apple-touch-icon-precomposed.png",
  "/browserconfig.xml",
  "/manifest.json",
  "/site.webmanifest",
]);

export function shouldRecordPageView(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }
  const url = new URL(request.url);
  const pathname = url.pathname.toLowerCase();
  if (IGNORED_PAGE_VIEW_PATHS.has(pathname) || /\.(?:avif|css|gif|ico|jpe?g|js|json|map|png|svg|webp|xml|txt|woff2?)$/i.test(pathname)) {
    return false;
  }
  const purpose = `${request.headers.get("purpose") ?? ""} ${request.headers.get("sec-purpose") ?? ""}`.toLowerCase();
  if (purpose.includes("prefetch") || purpose.includes("prerender")) {
    return false;
  }
  const fetchMode = request.headers.get("sec-fetch-mode");
  if (fetchMode && fetchMode !== "navigate") {
    return false;
  }
  const fetchDest = request.headers.get("sec-fetch-dest");
  if (fetchDest && fetchDest !== "document" && fetchDest !== "empty") {
    return false;
  }
  const accept = request.headers.get("accept")?.toLowerCase();
  if (accept && !accept.includes("text/html") && !accept.includes("*/*")) {
    return false;
  }
  return true;
}

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
  const userAgent = request.headers.get("user-agent");
  const client = clientFromUserAgent(userAgent);
  const targetUrl =
    domain.redirectMode === "target_service_forward"
      ? buildTargetUrl(domain.targetHost).replace(/\/$/, `/go/${domain.id}`)
      : buildTargetUrl(domain.targetHost);
  if (shouldRecordPageView(request)) {
    ctx.waitUntil(
      recordVisit(env.DB, {
        redirectDomainId: domain.id,
        host,
        path: url.pathname,
        referer: request.headers.get("referer"),
        country: request.cf?.country ? String(request.cf.country) : null,
        region: request.cf?.region ? String(request.cf.region) : null,
        city: request.cf?.city ? String(request.cf.city) : null,
        timezone: request.cf?.timezone ? String(request.cf.timezone) : null,
        latitude: numberFromCf(request.cf?.latitude),
        longitude: numberFromCf(request.cf?.longitude),
        language: firstLanguage(request.headers.get("accept-language")),
        operatingSystem: client.operatingSystem,
        browser: client.browser,
        deviceType: client.deviceType,
        userAgent,
        targetHost: domain.redirectMode === "direct" ? domain.directTargetHost ?? domain.targetHost : domain.targetHost,
        hideReferer: domain.hideReferer,
      }),
    );
  }
  if (domain.hideReferer) {
    return noRefererHtml(targetUrl);
  }
  return Response.redirect(targetUrl, 302);
}
