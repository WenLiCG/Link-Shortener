export const DOMAIN_STATUS = [
  "validating",
  "cloudflare_zone",
  "nameserver_update",
  "waiting_nameserver",
  "dns_configured",
  "route_configured",
  "active",
  "failed",
] as const;

export type DomainStatus = (typeof DOMAIN_STATUS)[number];
export type RedirectMode = "target_service" | "target_service_forward" | "direct";

export type ApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "server_error";

export interface ApiErrorBody {
  ok: false;
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

export interface ApiSuccessBody<T> {
  ok: true;
  data: T;
}

export type ApiBody<T> = ApiSuccessBody<T> | ApiErrorBody;

export interface TargetService {
  id: string;
  name: string;
  targetHost: string;
  forwardTargetHost: string | null;
  usageCount: number;
  description: string;
  healthStatus: "unknown" | "checking" | "ok" | "failed";
  healthHttpStatus: number | null;
  healthError: string | null;
  healthCheckedAt: string | null;
  automationStatus: string;
  nameserverStatus: string;
  dnsStatus: string;
  cloudflareZoneId: string | null;
  cloudflareZoneName: string | null;
  cloudflareZoneStatus: string | null;
  cloudflareNameservers: string[];
  dynadotStatus: string;
  lastError: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DomainGroup {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShortLink {
  id: string;
  targetServiceId: string;
  targetHost: string;
  code: string;
  shortUrl: string;
  originalUrl: string;
  hideReferer: boolean;
  visitCount: number;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
}

export interface RedirectDomain {
  id: string;
  domain: string;
  targetServiceId: string | null;
  redirectMode: RedirectMode;
  directTargetHost: string | null;
  targetForwardHost: string | null;
  deletedTargetHost?: string | null;
  targetHost: string;
  targetName: string;
  groupId: string | null;
  groupName: string | null;
  hideReferer: boolean;
  listVisible: boolean;
  status: DomainStatus;
  nameserverStatus: string;
  dnsStatus: string;
  routeStatus: string;
  cloudflareZoneId: string | null;
  cloudflareZoneStatus: string | null;
  cloudflareNameservers: string[];
  dynadotStatus: string;
  lastError: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
  traffic: number;
}

export interface JobStep {
  id: string;
  jobId: string;
  step: string;
  status: string;
  message: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface DomainJob {
  id: string;
  redirectDomainId: string;
  type: string;
  status: string;
  currentStep: string;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  steps: JobStep[];
}

export interface DomainDetail extends RedirectDomain {
  jobs: DomainJob[];
  sources: Array<{ referer: string; visits: number }>;
  trend: Array<{ day: string; visits: number }>;
  geography: {
    countries: Array<{ country: string | null; visits: number }>;
    regions: Array<{ country: string | null; region: string | null; visits: number }>;
    cities: Array<{ country: string | null; region: string | null; city: string | null; visits: number }>;
    locations: Array<{ country: string | null; city: string | null; latitude: number; longitude: number; visits: number }>;
  };
  clientStats: {
    languages: Array<{ language: string | null; visits: number }>;
    timezones: Array<{ timezone: string | null; visits: number }>;
    operatingSystems: Array<{ operatingSystem: string | null; visits: number }>;
    browsers: Array<{ browser: string | null; visits: number }>;
    deviceTypes: Array<{ deviceType: string | null; visits: number }>;
  };
  recentVisits: Array<{
    id: string;
    host: string;
    path: string;
    referer: string | null;
    country: string | null;
    region: string | null;
    city: string | null;
    timezone: string | null;
    latitude: number | null;
    longitude: number | null;
    language: string | null;
    operatingSystem: string | null;
    browser: string | null;
    deviceType: string | null;
    userAgent: string | null;
    targetHost: string;
    hideReferer: boolean;
    visitedAt: string;
  }>;
}

export interface SummaryStats {
  totalDomains: number;
  activeDomains: number;
  failedDomains: number;
  waitingDomains: number;
  visits: number;
  visitsToday: number;
}

export function normalizeDomain(input: string): string {
  let value = input.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, "");
  value = value.split("/")[0] ?? value;
  value = value.split("?")[0] ?? value;
  value = value.replace(/^\*\./, "");
  value = value.replace(/\.$/, "");
  return value;
}

export function isValidDomain(domain: string): boolean {
  if (domain.length < 3 || domain.length > 253) {
    return false;
  }
  if (domain.includes("..") || domain.startsWith("-") || domain.endsWith("-")) {
    return false;
  }
  const labels = domain.split(".");
  if (labels.length < 2) {
    return false;
  }
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export function domainMatchesHost(domain: string, host: string): boolean {
  const normalizedHost = normalizeDomain(host.split(":")[0] ?? host);
  return normalizedHost === domain || normalizedHost.endsWith(`.${domain}`);
}

export function buildTargetUrl(targetHost: string): string {
  const raw = targetHost.trim();
  const value = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported_protocol");
    }
    return url.href;
  } catch {
    const host = normalizeDomain(targetHost);
    return `https://${host}/`;
  }
}

export function noRefererHtml(targetUrl: string): Response {
  const escaped = targetUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const scriptTarget = JSON.stringify(targetUrl);
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Redirecting</title></head><body><script>window.location.replace(${scriptTarget});</script><noscript><meta http-equiv="refresh" content="0;url=${escaped}"></noscript></body></html>`,
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
        "cache-control": "no-store",
      },
    },
  );
}

export function noRefererRedirect(targetUrl: string, status = 302): Response {
  return new Response(null, {
    status,
    headers: {
      location: targetUrl,
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}

export function daysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
