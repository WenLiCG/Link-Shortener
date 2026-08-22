import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Cloud,
  ExternalLink,
  Filter,
  Globe2,
  Info,
  KeyRound,
  Layers3,
  Link2,
  LockKeyhole,
  LogOut,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Shield,
  ServerCog,
  Trash2,
  X,
} from "lucide-react";
import { runSerialBatch } from "./batch";
import { useOperationPolling } from "./hooks/useOperationPolling";
import {
  initialConfigurationResult,
  targetConfigurationItems,
  type TargetConfigurationItem,
  type TargetConfigurationResult,
} from "./target-configuration";
import "./styles.css";

type ApiBody<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
type View = "domains" | "add" | "nameservers" | "cloudflare-delete" | "registrars" | "short-links" | "targets" | "detail" | "settings";
type RedirectMode = "target_service" | "target_service_forward" | "direct";

interface TargetService {
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
  cloudflareZoneName: string | null;
  cloudflareZoneStatus: string | null;
  cloudflareNameservers: string[];
  dynadotStatus: string;
  lastError: string | null;
  lastCheckedAt: string | null;
}

interface DomainGroup {
  id: string;
  name: string;
}

interface ShortLink {
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

interface RedirectDomain {
  id: string;
  domain: string;
  redirectMode: RedirectMode;
  directTargetHost: string | null;
  targetForwardHost: string | null;
  targetHost: string;
  targetName: string;
  groupId: string | null;
  groupName: string | null;
  hideReferer: boolean;
  status: string;
  nameserverStatus: string;
  dnsStatus: string;
  routeStatus: string;
  cloudflareZoneStatus: string | null;
  dynadotStatus: string;
  lastError: string | null;
  createdAt: string;
  lastAccessedAt: string | null;
  traffic: number;
}

interface DomainDetail extends RedirectDomain {
  jobs: Array<{
    id: string;
    status: string;
    currentStep: string;
    errorMessage: string | null;
    createdAt: string;
    steps: Array<{ id: string; step: string; status: string; message: string | null; createdAt: string }>;
  }>;
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
    visitedAt: string;
  }>;
}

interface SummaryStats {
  totalDomains: number;
  activeDomains: number;
  failedDomains: number;
  waitingDomains: number;
  visits: number;
  visitsToday: number;
}

interface SettingsCheck {
  adminHost: string | null;
  workerScriptName: string;
  hasAdminPasswordHash: boolean;
  hasSessionSecret: boolean;
  hasVisitorHashSecret: boolean;
  hasPasswordPepper: boolean;
  hasCloudflareAccountId: boolean;
  hasCloudflareApiToken: boolean;
  hasDynadotApiKey: boolean;
  dynadotSandbox: boolean;
  visitEventRetentionDays: number;
}

interface RegistrarProvider {
  id: string;
  name: string;
  role: string;
  automation: string;
  configured: boolean;
  sandbox?: boolean;
}

interface RegistrarStatus {
  providers: RegistrarProvider[];
}

interface NameserverToolResult {
  domain: string;
  ok: boolean;
  status: string;
  message: string;
  nameservers: string[];
  zoneStatus?: string;
  jobId?: string;
  requestKey?: string;
}

interface CloudflareDeleteResult {
  domain: string;
  ok: boolean;
  status: string;
  message: string;
  zoneId?: string;
  jobId?: string;
  requestKey?: string;
}

interface CloudflareZoneItem {
  id: string;
  name: string;
  status: string;
  nameServers: string[];
  createdOn: string | null;
  modifiedOn: string | null;
}

interface CreateDomainResult {
  domain: string;
  ok: boolean;
  id?: string;
  jobId?: string;
  status?: string;
  error?: string;
  retryPayload?: CreateDomainPayload;
}

interface CreateDomainPayload {
  domains: string;
  redirectMode: RedirectMode;
  targetServiceId: string;
  directTargetHost: string;
  targetForwardHost: string;
  groupId: string | null;
  newGroupName: string;
  hideReferer: boolean;
}

interface OperationJob {
  id: string;
  subjectId: string;
  status: "queued" | "running" | "retry_wait" | "completed" | "failed";
  currentStep: string;
  errorMessage: string | null;
  payload: Record<string, unknown>;
}

const ADD_RESULTS_STORAGE_KEY = "link-shortener-add-results-v1";
const NAMESERVER_RESULTS_STORAGE_KEY = "link-shortener-nameserver-results-v1";
const ZONE_DELETE_RESULTS_STORAGE_KEY = "link-shortener-zone-delete-results-v1";
const REQUEST_TIMEOUT_MS = 45_000;
const DOMAIN_PROCESS_TIMEOUT_MS = 120_000;
const DOMAIN_POLL_INTERVAL_MS = 3_000;

function loadStoredResults<T>(key: string): T[] | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as T[] : null;
  } catch {
    return null;
  }
}

function splitDomainInput(input: string): string[] {
  return input
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function api<T>(
  path: string,
  init?: RequestInit,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(path, {
      ...init,
      cache: "no-store",
      signal: options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const body = (await response.json()) as ApiBody<T>;
    if (!body.ok) {
      throw new Error(body.error.message);
    }
    return body.data;
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error("请求超时，已继续处理下一项。");
    }
    throw error;
  }
}

function operationResult<T>(job: OperationJob): Partial<T> {
  const result = job.payload.result;
  return result && typeof result === "object" && !Array.isArray(result) ? result as Partial<T> : {};
}

async function waitForOperation(jobId: string): Promise<OperationJob> {
  const deadline = Date.now() + DOMAIN_PROCESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const job = await api<OperationJob>(`/api/jobs/${jobId}`, undefined, { timeoutMs: 15_000 });
    if (job.status === "completed") {
      return job;
    }
    if (job.status === "failed") {
      throw new Error(job.errorMessage ?? "处理失败，请手动重新执行。");
    }
    await sleep(DOMAIN_POLL_INTERVAL_MS);
  }
  throw new Error("处理超时，后台任务仍会继续；可点击右侧按钮查询或重新执行。");
}

function formatDate(value: string | null): string {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusText(status: string): string {
  const map: Record<string, string> = {
    validating: "校验中",
    cloudflare_zone: "接入 Zone",
    nameserver_update: "改 NS",
    waiting_nameserver: "等待生效",
    dns_configured: "DNS 已配",
    route_configured: "路由已配",
    active: "可用",
    failed: "失败",
    queued: "已创建任务",
    running: "处理中",
    retry_wait: "等待重试",
    pending: "待处理",
    configured: "已配置",
    submitted: "已提交",
    deleted: "已删除",
    not_found: "未找到",
    manual_required: "需手动",
    inherited_zone: "继承 Zone",
    unknown: "未知",
    checking: "检测中",
    ok: "OK",
  };
  return map[status] ?? status;
}

function statusClass(status: string): string {
  if (status === "active" || status === "configured" || status === "completed" || status === "ok") return "good";
  if (status === "failed") return "bad";
  if (status === "checking" || status === "unknown" || status.includes("waiting") || status.includes("manual")) return "warn";
  return "neutral";
}

function Badge({ status }: { status: string }) {
  return <span className={`badge ${statusClass(status)}`}>{statusText(status)}</span>;
}

function redirectModeText(mode: RedirectMode): string {
  if (mode === "direct") return "直接跳转";
  if (mode === "target_service_forward") return "目标服务二段跳";
  return "到目标服务";
}

function targetDisplay(domain: RedirectDomain): string {
  if (domain.redirectMode === "target_service_forward" && domain.targetForwardHost) {
    return `${domain.targetHost} -> ${domain.targetForwardHost}`;
  }
  return domain.targetHost;
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <CircleDot size={28} />
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

type ResultSummaryItem = { ok: boolean; status?: string | null };

function isProcessingStatus(status?: string | null): boolean {
  return !status || ["queued", "running", "retry_wait", "pending", "checking", "validating", "cloudflare_zone", "nameserver_update", "dns_configured", "route_configured", "waiting_nameserver"].includes(status);
}

function ResultSummary({ items, total }: { items: ResultSummaryItem[] | null; total?: number }) {
  if (!items) {
    return null;
  }
  const expected = Math.max(total ?? items.length, items.length);
  const failed = items.filter((item) => !item.ok || item.status === "failed").length;
  const processing = items.filter((item) => item.ok && isProcessingStatus(item.status)).length + Math.max(0, expected - items.length);
  const success = items.filter((item) => item.ok && item.status !== "failed" && !isProcessingStatus(item.status)).length;
  const processed = success + failed;
  return (
    <div className="result-summary">
      <span>已处理 {processed} / {expected}</span>
      <strong className="good">成功 {success}</strong>
      <strong className="bad">失败 {failed}</strong>
      <strong className="warn">处理中 {processing}</strong>
    </div>
  );
}

type GeoTab = "countries" | "regions" | "cities";
type CountryMeta = { name: string; lat: number; lon: number };
type GeoJsonGeometry = { type: "Polygon" | "MultiPolygon"; coordinates: number[][][] | number[][][][] };
type GeoJsonFeature = { type: "Feature"; properties: { ISO_A2?: string; NAME?: string }; geometry: GeoJsonGeometry };
type CountriesGeoJson = { type: "FeatureCollection"; features: GeoJsonFeature[] };

const COUNTRY_META: Record<string, CountryMeta> = {
  AE: { name: "阿联酋", lat: 24.4, lon: 54.4 },
  AR: { name: "阿根廷", lat: -34.6, lon: -58.4 },
  AT: { name: "奥地利", lat: 48.2, lon: 16.4 },
  AU: { name: "澳大利亚", lat: -33.9, lon: 151.2 },
  BE: { name: "比利时", lat: 50.9, lon: 4.4 },
  BR: { name: "巴西", lat: -15.8, lon: -47.9 },
  CA: { name: "加拿大", lat: 45.4, lon: -75.7 },
  CH: { name: "瑞士", lat: 46.9, lon: 7.4 },
  CL: { name: "智利", lat: -33.4, lon: -70.7 },
  CN: { name: "中国", lat: 35.9, lon: 104.2 },
  CO: { name: "哥伦比亚", lat: 4.7, lon: -74.1 },
  CZ: { name: "捷克", lat: 50.1, lon: 14.4 },
  DE: { name: "德国", lat: 52.5, lon: 13.4 },
  DK: { name: "丹麦", lat: 55.7, lon: 12.6 },
  EG: { name: "埃及", lat: 30, lon: 31.2 },
  ES: { name: "西班牙", lat: 40.4, lon: -3.7 },
  FI: { name: "芬兰", lat: 60.2, lon: 24.9 },
  FR: { name: "法国", lat: 48.9, lon: 2.4 },
  GB: { name: "英国", lat: 51.5, lon: -0.1 },
  HK: { name: "中国香港", lat: 22.3, lon: 114.2 },
  ID: { name: "印度尼西亚", lat: -6.2, lon: 106.8 },
  IE: { name: "爱尔兰", lat: 53.3, lon: -6.3 },
  IL: { name: "以色列", lat: 32.1, lon: 34.8 },
  IN: { name: "印度", lat: 28.6, lon: 77.2 },
  IT: { name: "意大利", lat: 41.9, lon: 12.5 },
  JP: { name: "日本", lat: 35.7, lon: 139.7 },
  KR: { name: "韩国", lat: 37.6, lon: 127 },
  MX: { name: "墨西哥", lat: 19.4, lon: -99.1 },
  MY: { name: "马来西亚", lat: 3.1, lon: 101.7 },
  NL: { name: "荷兰", lat: 52.4, lon: 4.9 },
  NO: { name: "挪威", lat: 59.9, lon: 10.8 },
  NZ: { name: "新西兰", lat: -41.3, lon: 174.8 },
  PH: { name: "菲律宾", lat: 14.6, lon: 121 },
  PL: { name: "波兰", lat: 52.2, lon: 21 },
  PT: { name: "葡萄牙", lat: 38.7, lon: -9.1 },
  RO: { name: "罗马尼亚", lat: 44.4, lon: 26.1 },
  RU: { name: "俄罗斯", lat: 55.8, lon: 37.6 },
  SA: { name: "沙特", lat: 24.7, lon: 46.7 },
  SE: { name: "瑞典", lat: 59.3, lon: 18.1 },
  SG: { name: "新加坡", lat: 1.3, lon: 103.8 },
  TH: { name: "泰国", lat: 13.8, lon: 100.5 },
  TR: { name: "土耳其", lat: 39.9, lon: 32.9 },
  TW: { name: "中国台湾", lat: 25, lon: 121.5 },
  UA: { name: "乌克兰", lat: 50.5, lon: 30.5 },
  US: { name: "美国", lat: 39.8, lon: -98.6 },
  VN: { name: "越南", lat: 21, lon: 105.8 },
  ZA: { name: "南非", lat: -26.2, lon: 28 },
};

function countryCode(value: string | null): string {
  return value?.trim().toUpperCase() || "UN";
}

function countryName(value: string | null): string {
  const code = countryCode(value);
  if (code === "T1") return "Tor";
  if (code === "UN") return "未知国家";
  try {
    return new Intl.DisplayNames(["zh-CN"], { type: "region" }).of(code) ?? COUNTRY_META[code]?.name ?? code;
  } catch {
    return COUNTRY_META[code]?.name ?? code;
  }
}

function geoPoint(meta: CountryMeta): { x: number; y: number } {
  return {
    x: ((meta.lon + 180) / 360) * 100,
    y: ((90 - meta.lat) / 180) * 100,
  };
}

function geoPointFromLatLon(latitude: number, longitude: number): { x: number; y: number } {
  return {
    x: ((longitude + 180) / 360) * 100,
    y: ((90 - latitude) / 180) * 100,
  };
}

function projectCoordinate(coordinate: number[]): [number, number] {
  const lon = coordinate[0] ?? 0;
  const lat = coordinate[1] ?? 0;
  return [((lon + 180) / 360) * 1000, ((90 - lat) / 180) * 520];
}

function ringPath(ring: number[][]): string {
  return ring
    .map((coordinate, index) => {
      const [x, y] = projectCoordinate(coordinate);
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function featurePath(feature: GeoJsonFeature): string {
  if (feature.geometry.type === "Polygon") {
    return (feature.geometry.coordinates as number[][][]).map((ring) => `${ringPath(ring)} Z`).join(" ");
  }
  return (feature.geometry.coordinates as number[][][][])
    .flatMap((polygon) => polygon.map((ring) => `${ringPath(ring)} Z`))
    .join(" ");
}

function countryFill(visits: number, maxVisits: number): string {
  if (visits <= 0) {
    return "#dce3ee";
  }
  const ratio = Math.max(0.18, Math.min(1, visits / Math.max(1, maxVisits)));
  if (ratio > 0.75) return "#31b996";
  if (ratio > 0.5) return "#4c7ff0";
  if (ratio > 0.3) return "#f4b740";
  return "#f35f78";
}

function GeoPanel({ geography }: { geography: DomainDetail["geography"] }) {
  const [tab, setTab] = useState<GeoTab>("countries");
  const [geoJson, setGeoJson] = useState<CountriesGeoJson | null>(null);
  const countries = geography.countries;
  const total = countries.reduce((sum, row) => sum + row.visits, 0);
  const maxCountry = Math.max(1, ...countries.map((row) => row.visits));
  const countryStats = useMemo(() => new Map(countries.map((row) => [countryCode(row.country), row.visits])), [countries]);
  const rows =
    tab === "countries"
      ? countries.map((row) => ({
          key: countryCode(row.country),
          label: `${countryCode(row.country)} ${countryName(row.country)}`,
          visits: row.visits,
        }))
      : tab === "regions"
        ? geography.regions.map((row, index) => ({
            key: `${row.country ?? "UN"}-${row.region ?? "unknown"}-${index}`,
            label: `${countryName(row.country)} / ${row.region || "未知地区"}`,
            visits: row.visits,
          }))
        : geography.cities.map((row, index) => ({
            key: `${row.country ?? "UN"}-${row.region ?? "unknown"}-${row.city ?? "unknown"}-${index}`,
            label: `${countryName(row.country)} / ${row.city || "未知城市"}`,
            visits: row.visits,
          }));
  const maxRow = Math.max(1, ...rows.map((row) => row.visits));

  useEffect(() => {
    let cancelled = false;
    fetch("/countries.geojson")
      .then((response) => response.json() as Promise<CountriesGeoJson>)
      .then((data) => {
        if (!cancelled) {
          setGeoJson(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGeoJson(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="panel geo-panel">
      <div className="panel-title">
        <h3>地理位置</h3>
        <span>基于 Cloudflare 请求地理信息</span>
      </div>
      {total === 0 ? (
        <EmptyState title="暂无地理数据" text="入口域名产生访问后，这里会展示国家、地区和城市分布。" />
      ) : (
        <div className="geo-layout">
          <div className="geo-map">
            {geoJson ? (
              <svg viewBox="0 0 1000 520" role="img" aria-label="访问来源地图">
                {geoJson.features.map((feature, index) => {
                  const code = countryCode(feature.properties.ISO_A2 ?? null);
                  const visits = countryStats.get(code) ?? 0;
                  return (
                    <path
                      key={`${code}-${index}`}
                      className={visits > 0 ? "geo-country active" : "geo-country"}
                      d={featurePath(feature)}
                      fill={countryFill(visits, maxCountry)}
                      fillRule="evenodd"
                    >
                      <title>{`${countryName(code)} ${visits}`}</title>
                    </path>
                  );
                })}
              </svg>
            ) : (
              <div className="geo-loading">地图数据加载中</div>
            )}
          </div>
          <div className="geo-side">
            <div className="segmented">
              <button className={tab === "countries" ? "active" : ""} onClick={() => setTab("countries")}>国家</button>
              <button className={tab === "regions" ? "active" : ""} onClick={() => setTab("regions")}>地区</button>
              <button className={tab === "cities" ? "active" : ""} onClick={() => setTab("cities")}>城市</button>
            </div>
            <div className="geo-list">
              {rows.length === 0 ? (
                <EmptyState title="暂无数据" text="该维度还没有可展示的访问记录。" />
              ) : (
                rows.slice(0, 12).map((row) => {
                  const percent = total > 0 ? Math.round((row.visits / total) * 100) : 0;
                  return (
                    <div key={row.key} className="geo-row">
                      <div><span>{row.label}</span><strong>{row.visits} ({percent}%)</strong></div>
                      <i style={{ width: `${Math.max(4, (row.visits / maxRow) * 100)}%` }} />
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

type BreakdownTab = { key: string; label: string; rows: Array<{ key: string; label: string; visits: number }> };

function formatLanguage(value: string | null): string {
  if (!value) return "未知";
  try {
    const language = value.split("-")[0] ?? value;
    const name = new Intl.DisplayNames(["zh-CN"], { type: "language" }).of(language);
    return name ? `${name} (${value})` : value;
  } catch {
    return value;
  }
}

function BreakdownPanel({ title, tabs }: { title: string; tabs: BreakdownTab[] }) {
  const [activeKey, setActiveKey] = useState(tabs[0]?.key ?? "");
  const active = tabs.find((tab) => tab.key === activeKey) ?? tabs[0];
  const rows = active?.rows ?? [];
  const total = rows.reduce((sum, row) => sum + row.visits, 0);
  const maxRow = Math.max(1, ...rows.map((row) => row.visits));

  return (
    <section className="panel breakdown-panel">
      <div className="panel-title">
        <h3>{title}</h3>
        {tabs.length > 1 && (
          <div className="segmented">
            {tabs.map((tab) => (
              <button key={tab.key} className={active?.key === tab.key ? "active" : ""} onClick={() => setActiveKey(tab.key)}>{tab.label}</button>
            ))}
          </div>
        )}
      </div>
      {rows.length === 0 || total === 0 ? (
        <EmptyState title="暂无数据" text="产生访问后会展示该维度的分布。" />
      ) : (
        <div className="breakdown-list">
          {rows.slice(0, 8).map((row) => {
            const percent = total > 0 ? Math.round((row.visits / total) * 100) : 0;
            return (
              <div key={row.key} className="breakdown-row">
                <div><span>{row.label || "未知"}</span><strong>{row.visits} ({percent}%)</strong></div>
                <i style={{ width: `${Math.max(4, (row.visits / maxRow) * 100)}%` }} />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function AnalyticsPanels({ detail }: { detail: DomainDetail }) {
  return (
    <div className="analytics-grid">
      <BreakdownPanel
        title="来源"
        tabs={[{
          key: "referer",
          label: "来源",
          rows: detail.sources.map((source) => ({
            key: source.referer,
            label: source.referer,
            visits: source.visits,
          })),
        }]}
      />
      <BreakdownPanel
        title="语言 / 时区"
        tabs={[
          {
            key: "language",
            label: "语言",
            rows: detail.clientStats.languages.map((row, index) => ({
              key: `${row.language ?? "unknown"}-${index}`,
              label: formatLanguage(row.language),
              visits: row.visits,
            })),
          },
          {
            key: "timezone",
            label: "时区",
            rows: detail.clientStats.timezones.map((row, index) => ({
              key: `${row.timezone ?? "unknown"}-${index}`,
              label: row.timezone || "未知",
              visits: row.visits,
            })),
          },
        ]}
      />
      <BreakdownPanel
        title="设备"
        tabs={[{
          key: "deviceType",
          label: "设备类型",
          rows: detail.clientStats.deviceTypes.map((row, index) => ({
            key: `${row.deviceType ?? "unknown"}-${index}`,
            label: row.deviceType || "未知",
            visits: row.visits,
          })),
        }]}
      />
      <BreakdownPanel
        title="系统 / 浏览器"
        tabs={[
          {
            key: "os",
            label: "操作系统",
            rows: detail.clientStats.operatingSystems.map((row, index) => ({
              key: `${row.operatingSystem ?? "unknown"}-${index}`,
              label: row.operatingSystem || "未知",
              visits: row.visits,
            })),
          },
          {
            key: "browser",
            label: "浏览器",
            rows: detail.clientStats.browsers.map((row, index) => ({
              key: `${row.browser ?? "unknown"}-${index}`,
              label: row.browser || "未知",
              visits: row.visits,
            })),
          },
        ]}
      />
    </div>
  );
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-shell">
      <form className="login-panel" onSubmit={submit}>
        <div className="brand-mark">
          <Shield size={30} />
        </div>
        <h1>多域名跳转管理</h1>
        <p>输入后台密码进入管理台。</p>
        <label>
          后台密码
          <input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button className="primary" disabled={loading}>
          {loading ? <Loader2 className="spin" size={16} /> : <KeyRound size={16} />}
          登录
        </button>
      </form>
    </main>
  );
}

function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [authError, setAuthError] = useState("");
  const [view, setView] = useState<View>("domains");
  const [selectedDomainId, setSelectedDomainId] = useState<string | null>(null);
  const [domains, setDomains] = useState<RedirectDomain[]>([]);
  const [targets, setTargets] = useState<TargetService[]>([]);
  const [shortLinks, setShortLinks] = useState<ShortLink[]>([]);
  const [groups, setGroups] = useState<DomainGroup[]>([]);
  const [summary, setSummary] = useState<SummaryStats | null>(null);
  const [settings, setSettings] = useState<SettingsCheck | null>(null);
  const [registrars, setRegistrars] = useState<RegistrarStatus | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({ search: "", groupId: "", status: "", days: "", visitedFrom: "", visitedTo: "" });

  async function loadAll() {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (filters.search) params.set("search", filters.search);
      if (filters.groupId) params.set("groupId", filters.groupId);
      if (filters.status) params.set("status", filters.status);
      if (filters.days) params.set("days", filters.days);
      if (filters.visitedFrom) params.set("visitedFrom", filters.visitedFrom);
      if (filters.visitedTo) params.set("visitedTo", filters.visitedTo);
      const [domainData, targetData, shortLinkData, groupData, summaryData, settingsData, registrarData] = await Promise.all([
        api<RedirectDomain[]>(`/api/domains?${params.toString()}`),
        api<TargetService[]>("/api/targets"),
        api<ShortLink[]>("/api/short-links"),
        api<DomainGroup[]>("/api/groups"),
        api<SummaryStats>("/api/stats/summary"),
        api<SettingsCheck>("/api/settings/check"),
        api<RegistrarStatus>("/api/registrars"),
      ]);
      setDomains(domainData);
      setTargets(targetData);
      setShortLinks(shortLinkData);
      setGroups(groupData);
      setSummary(summaryData);
      setSettings(settingsData);
      setRegistrars(registrarData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    api<{ authenticated: boolean }>("/api/me")
      .then((data) => setAuthenticated(data.authenticated))
      .catch((err) => setAuthError(err instanceof Error ? err.message : "后台状态检查失败。"));
  }, []);

  useEffect(() => {
    if (authenticated) {
      void loadAll();
    }
  }, [authenticated, filters.groupId, filters.status, filters.days, filters.visitedFrom, filters.visitedTo]);

  if (authenticated === null) {
    return (
      <div className="boot">
        {authError ? (
          <div className="login-panel">
            <h1>后台暂时无法访问</h1>
            <p>{authError}</p>
            <button className="primary" onClick={() => window.location.reload()}>重新加载</button>
          </div>
        ) : "加载中..."}
      </div>
    );
  }
  if (!authenticated) {
    return <Login onLogin={() => setAuthenticated(true)} />;
  }

  function openDetail(id: string) {
    setSelectedDomainId(id);
    setView("detail");
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST", body: JSON.stringify({}) });
    setAuthenticated(false);
    setView("domains");
    setSelectedDomainId(null);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-title">
          <Cloud size={24} />
          <span>跳转管理</span>
        </div>
        <button className={view === "domains" ? "nav active" : "nav"} onClick={() => setView("domains")}>
          <Globe2 size={18} />
          域名列表
        </button>
        <button className={view === "nameservers" ? "nav active" : "nav"} onClick={() => setView("nameservers")}>
          <Globe2 size={18} />
          CloudFlare接入
        </button>
        <button className={view === "cloudflare-delete" ? "nav active" : "nav"} onClick={() => setView("cloudflare-delete")}>
          <Trash2 size={18} />
          CloudFlare删除
        </button>
        <button className={view === "targets" ? "nav active" : "nav"} onClick={() => setView("targets")}>
          <Layers3 size={18} />
          新增服务域名
        </button>
        <button className={view === "add" ? "nav active" : "nav"} onClick={() => setView("add")}>
          <Plus size={18} />
          新增跳转
        </button>
        <button className={view === "short-links" ? "nav active" : "nav"} onClick={() => setView("short-links")}>
          <Link2 size={18} />
          新增短链接
        </button>
        <button className={view === "registrars" ? "nav active" : "nav"} onClick={() => setView("registrars")}>
          <ServerCog size={18} />
          注册商服务
        </button>
        <button className={view === "settings" ? "nav active" : "nav"} onClick={() => setView("settings")}>
          <Settings size={18} />
          初始化检查
        </button>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>
              {view === "add"
                ? "新增跳转"
                : view === "nameservers"
                  ? "CloudFlare接入"
                  : view === "cloudflare-delete"
                    ? "CloudFlare删除"
                    : view === "registrars"
                      ? "注册商服务"
                      : view === "short-links"
                        ? "新增短链接"
                        : view === "targets"
                          ? "新增服务域名"
                          : view === "settings"
                            ? "初始化检查"
                            : "域名控制台"}
            </h1>
            <p>默认跳转到目标根地址，不保留路径和 Query。</p>
          </div>
          <button className="ghost" onClick={() => void loadAll()}>
            <RefreshCw size={16} className={loading ? "spin" : ""} />
            刷新
          </button>
        </header>
        {error && <div className="alert bad"><AlertTriangle size={16} />{error}</div>}
        {view === "domains" && (
          <DomainsView
            domains={domains}
            groups={groups}
            summary={summary}
            filters={filters}
            setFilters={setFilters}
            onSearch={loadAll}
            onOpen={openDetail}
            onDeleted={loadAll}
          />
        )}
        {view === "add" && <AddViewV2 targets={targets} groups={groups} onCreated={loadAll} />}
        {view === "nameservers" && <NameserverToolView registrars={registrars} />}
        {view === "cloudflare-delete" && <CloudflareZoneDeleteView />}
        {view === "registrars" && <RegistrarsView registrars={registrars} onUpdated={loadAll} />}
        {view === "short-links" && <ShortLinksView targets={targets} shortLinks={shortLinks} onUpdated={loadAll} />}
        {view === "targets" && <TargetsViewV2 targets={targets} onCreated={loadAll} />}
        {view === "settings" && <SettingsView settings={settings} onUpdated={loadAll} onLogout={logout} />}
        {view === "detail" && selectedDomainId && <DetailView id={selectedDomainId} onBack={() => setView("domains")} onUpdated={loadAll} />}
      </main>
    </div>
  );
}

function DomainsView({
  domains,
  groups,
  summary,
  filters,
  setFilters,
  onSearch,
  onOpen,
  onDeleted,
}: {
  domains: RedirectDomain[];
  groups: DomainGroup[];
  summary: SummaryStats | null;
  filters: { search: string; groupId: string; status: string; days: string; visitedFrom: string; visitedTo: string };
  setFilters: React.Dispatch<React.SetStateAction<{ search: string; groupId: string; status: string; days: string; visitedFrom: string; visitedTo: string }>>;
  onSearch: () => Promise<void>;
  onOpen: (id: string) => void;
  onDeleted: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [retryingIds, setRetryingIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");

  async function deleteSelected() {
    if (selected.length === 0 || !window.confirm(`确认删除 ${selected.length} 个跳转服务？默认只删除系统内配置。`)) {
      return;
    }
    setDeleting(true);
    setMessage("");
    try {
      const failures: string[] = [];
      await runSerialBatch(
        selected,
        async (id) => {
          const queued = await api<{ jobId: string }>("/api/domains", {
            method: "DELETE",
            headers: { "idempotency-key": crypto.randomUUID() },
            body: JSON.stringify({ ids: [id] }),
          });
          await waitForOperation(queued.jobId);
          return id;
        },
        (id, outcome) => {
          if (!outcome.ok) {
            failures.push(`${id}: ${outcome.error.message}`);
          }
        },
      );
      setSelected([]);
      await onDeleted();
      if (failures.length > 0) {
        setMessage(`${failures.length} 个域名删除失败，其余已继续处理。`);
      }
    } finally {
      setDeleting(false);
    }
  }

  async function retryDomain(domain: RedirectDomain) {
    setRetryingIds((current) => [...new Set([...current, domain.id])]);
    setMessage("");
    try {
      const queued = await api<{ jobId: string }>(`/api/domains/${domain.id}/retry`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await waitForOperation(queued.jobId);
      await onDeleted();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "重新配置失败。");
    } finally {
      setRetryingIds((current) => current.filter((id) => id !== domain.id));
    }
  }

  return (
    <>
      <section className="metric-grid">
        <Metric icon={<Globe2 />} label="域名总数" value={summary?.totalDomains ?? 0} />
        <Metric icon={<CheckCircle2 />} label="可用域名" value={summary?.activeDomains ?? 0} />
        <Metric icon={<Activity />} label="今日候选 UV" value={summary?.visitsToday ?? 0} />
        <Metric icon={<AlertTriangle />} label="失败 / 等待" value={`${summary?.failedDomains ?? 0} / ${summary?.waitingDomains ?? 0}`} />
      </section>
      <div className="explain-note">
        域名总数、可用域名、失败 / 等待是系统内全量入口域名统计；今日候选 UV 按入口域名、客户端 IP 和上海自然日去重，不等同于停放平台认可访问。下方列表会受搜索、状态、Group 和时间筛选影响。
      </div>
      <section className="toolbar">
        <div className="searchbox">
          <Search size={16} />
          <input
            placeholder="搜索入口域名或目标域名"
            value={filters.search}
            onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === "Enter") void onSearch();
            }}
          />
        </div>
        <select value={filters.groupId} onChange={(event) => setFilters((current) => ({ ...current, groupId: event.target.value }))}>
          <option value="">全部 Group</option>
          {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>
        <select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}>
          <option value="">全部状态</option>
          <option value="active">可用</option>
          <option value="waiting_nameserver">等待生效</option>
          <option value="failed">失败</option>
        </select>
        <select value={filters.days} onChange={(event) => setFilters((current) => ({ ...current, days: event.target.value, visitedFrom: "", visitedTo: "" }))}>
          <option value="">全部时间</option>
          <option value="0">今天</option>
          <option value="-1">昨天</option>
          <option value="7">过去 7 天</option>
          <option value="30">过去一个月</option>
          <option value="90">过去三个月</option>
          <option value="180">过去半年</option>
          <option value="365">过去一年</option>
        </select>
        <input
          aria-label="开始日期"
          type="date"
          value={filters.visitedFrom}
          max={filters.visitedTo || undefined}
          onChange={(event) => setFilters((current) => ({ ...current, days: "", visitedFrom: event.target.value }))}
        />
        <span>至</span>
        <input
          aria-label="结束日期"
          type="date"
          value={filters.visitedTo}
          min={filters.visitedFrom || undefined}
          onChange={(event) => setFilters((current) => ({ ...current, days: "", visitedTo: event.target.value }))}
        />
        <button className="ghost" onClick={() => void onSearch()}><Filter size={16} />筛选</button>
        <button className="danger" disabled={selected.length === 0 || deleting} onClick={() => void deleteSelected()}><Trash2 size={16} />删除</button>
      </section>
      {message && <div className="form-error">{message}</div>}
      <section className="table-wrap">
        {domains.length === 0 ? (
          <EmptyState title="没有匹配的入口域名" text="如果上方统计有数量，请检查当前搜索、状态或时间筛选。" />
        ) : (
          <table>
            <thead>
              <tr>
                <th><input type="checkbox" checked={selected.length === domains.length} onChange={(event) => setSelected(event.target.checked ? domains.map((domain) => domain.id) : [])} /></th>
                <th>入口域名</th>
                <th>目标</th>
                <th>Group</th>
                <th>状态</th>
                <th>流量</th>
                <th>Referer</th>
                <th>NS / DNS / Route</th>
                <th>最近访问</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {domains.map((domain) => (
                <tr key={domain.id}>
                  <td><input type="checkbox" checked={selected.includes(domain.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, domain.id] : current.filter((id) => id !== domain.id))} /></td>
                  <td><strong>{domain.domain}</strong>{domain.lastError && <small className="error-line">{domain.lastError}</small>}</td>
                  <td>
                    <strong>{targetDisplay(domain)}</strong>
                    <small>{redirectModeText(domain.redirectMode)}</small>
                  </td>
                  <td>{domain.groupName ?? "-"}</td>
                  <td><Badge status={domain.status} /></td>
                  <td>{domain.traffic}</td>
                  <td>{domain.hideReferer ? "隐藏" : "普通"}</td>
                  <td className="mini-status"><Badge status={domain.nameserverStatus} /><Badge status={domain.dnsStatus} /><Badge status={domain.routeStatus} /></td>
                  <td>{formatDate(domain.lastAccessedAt)}</td>
                  <td className="row-actions">
                    <button
                      className="icon"
                      disabled={retryingIds.includes(domain.id)}
                      onClick={() => void retryDomain(domain)}
                      title="重新配置"
                    >
                      <RefreshCw className={retryingIds.includes(domain.id) ? "spin" : ""} size={16} />
                    </button>
                    <button className="icon" onClick={() => onOpen(domain.id)} title="查看详情"><ChevronRight size={18} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="metric">
      <span>{icon}</span>
      <div>
        <strong>{value}</strong>
        <small>{label}</small>
      </div>
    </div>
  );
}

function ShortLinksView({
  targets,
  shortLinks,
  onUpdated,
}: {
  targets: TargetService[];
  shortLinks: ShortLink[];
  onUpdated: () => Promise<void>;
}) {
  const [targetServiceId, setTargetServiceId] = useState("");
  const [url, setUrl] = useState("");
  const [hideReferer, setHideReferer] = useState(true);
  const [created, setCreated] = useState<ShortLink | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState("");
  const readyTargets = targets.filter((target) => target.healthStatus === "ok" && target.dnsStatus === "configured");

  useEffect(() => {
    if (!targetServiceId && readyTargets.length > 0) {
      setTargetServiceId(readyTargets[0].id);
    }
  }, [readyTargets, targetServiceId]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    try {
      const shortLink = await api<ShortLink>("/api/short-links", {
        method: "POST",
        body: JSON.stringify({ targetServiceId, url, hideReferer }),
      });
      setCreated(shortLink);
      setUrl("");
      await onUpdated();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "生成短链接失败。");
    } finally {
      setLoading(false);
    }
  }

  async function deleteSelected() {
    if (selected.length === 0 || !window.confirm(`确认删除 ${selected.length} 个短链接？`)) {
      return;
    }
    setDeleting(true);
    setMessage("");
    try {
      const failures: string[] = [];
      await runSerialBatch(
        selected,
        (id) => api("/api/short-links", { method: "DELETE", body: JSON.stringify({ ids: [id] }) }),
        (id, outcome) => {
          if (!outcome.ok) {
            failures.push(`${id}: ${outcome.error.message}`);
          }
        },
        REQUEST_TIMEOUT_MS + 1_000,
      );
      setSelected([]);
      await onUpdated();
      if (failures.length > 0) {
        setMessage(`${failures.length} 个短链接删除失败，其余已继续处理。`);
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "删除短链接失败。");
    } finally {
      setDeleting(false);
    }
  }

  async function copyShortUrl(shortUrl: string) {
    try {
      await navigator.clipboard.writeText(shortUrl);
      setMessage("短链接已复制。");
    } catch {
      setMessage(shortUrl);
    }
  }

  return (
    <section className="short-links-page">
      <form className="panel short-create-panel" onSubmit={submit}>
        <h2>生成短链接</h2>
        <label>
          目标服务
          <select value={targetServiceId} onChange={(event) => setTargetServiceId(event.target.value)} required>
            <option value="">请选择已就绪的目标服务</option>
            {readyTargets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.name} - {target.targetHost}
              </option>
            ))}
          </select>
        </label>
        <label>
          原始 URL
          <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/page?x=1" required />
        </label>
        <label className="switch">
          <input type="checkbox" checked={hideReferer} onChange={(event) => setHideReferer(event.target.checked)} />
          <span>隐藏 Referer</span>
          <small>使用 no-referrer 中转页，减少来源暴露但不承诺完全不可追踪。</small>
        </label>
        <button className="primary" disabled={loading || readyTargets.length === 0}>
          {loading ? <Loader2 className="spin" size={16} /> : <Link2 size={16} />}
          生成短链接
        </button>
        {readyTargets.length === 0 && <div className="note">需要先在目标服务里配置一个状态为 OK 且 DNS 已配置的域名。</div>}
        {created && (
          <div className="short-result">
            <small>新短链接</small>
            <strong>{created.shortUrl}</strong>
            <button className="ghost" type="button" onClick={() => void copyShortUrl(created.shortUrl)}>
              复制
            </button>
          </div>
        )}
        {message && <div className="note">{message}</div>}
      </form>

      <div className="panel short-list-panel">
        <div className="panel-head">
          <h2>短链接列表</h2>
          <button className="danger" disabled={selected.length === 0 || deleting} onClick={() => void deleteSelected()}>
            <Trash2 size={16} />
            删除
          </button>
        </div>
        {shortLinks.length === 0 ? (
          <EmptyState title="暂无短链接" text="选择目标服务并输入 URL 后，会生成一个目标服务域名下的短链接。" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={selected.length === shortLinks.length}
                      onChange={(event) => setSelected(event.target.checked ? shortLinks.map((item) => item.id) : [])}
                    />
                  </th>
                  <th>短链接</th>
                  <th>原始 URL</th>
                  <th>Referer</th>
                  <th>访问</th>
                  <th>最近访问</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {shortLinks.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.includes(item.id)}
                        onChange={(event) =>
                          setSelected((current) => (event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id)))
                        }
                      />
                    </td>
                    <td>
                      <strong>{item.shortUrl}</strong>
                      <small>{item.targetHost}</small>
                    </td>
                    <td className="url-cell">{item.originalUrl}</td>
                    <td>{item.hideReferer ? "隐藏" : "普通"}</td>
                    <td>{item.visitCount}</td>
                    <td>{formatDate(item.lastAccessedAt)}</td>
                    <td className="row-actions">
                      <button className="icon" title="复制短链接" onClick={() => void copyShortUrl(item.shortUrl)}>
                        <Link2 size={16} />
                      </button>
                      <a className="icon" href={item.shortUrl} target="_blank" rel="noreferrer" title="打开短链接">
                        <ExternalLink size={16} />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function AddViewV2({ targets, groups, onCreated }: { targets: TargetService[]; groups: DomainGroup[]; onCreated: () => Promise<void> }) {
  const [domains, setDomains] = useState("");
  const [redirectMode, setRedirectMode] = useState<RedirectMode>("direct");
  const [targetServiceId, setTargetServiceId] = useState("");
  const [directTargetHost, setDirectTargetHost] = useState("");
  const [targetForwardHost, setTargetForwardHost] = useState("");
  const [groupId, setGroupId] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [hideReferer, setHideReferer] = useState(true);
  const [result, setResult] = useState<CreateDomainResult[] | null>(
    () => loadStoredResults<CreateDomainResult>(ADD_RESULTS_STORAGE_KEY),
  );
  const [resultTotal, setResultTotal] = useState(
    () => loadStoredResults<CreateDomainResult>(ADD_RESULTS_STORAGE_KEY)?.length ?? 0,
  );
  const [loading, setLoading] = useState(false);
  const [retryingIds, setRetryingIds] = useState<string[]>([]);

  useEffect(() => {
    if (result) {
      window.localStorage.setItem(ADD_RESULTS_STORAGE_KEY, JSON.stringify(result));
    } else {
      window.localStorage.removeItem(ADD_RESULTS_STORAGE_KEY);
    }
  }, [result]);

  const pendingOperationIds = useMemo(
    () => loading ? [] : result?.filter((item) => item.jobId && isProcessingStatus(item.status)).map((item) => item.jobId!) ?? [],
    [loading, result],
  );
  const refreshOperation = useCallback(async (jobId: string, signal: AbortSignal) => {
    const job = await api<OperationJob>(`/api/jobs/${jobId}`, undefined, { timeoutMs: 15_000, signal });
    setResult((current) => current?.map((item) => {
      if (item.jobId !== jobId) {
        return item;
      }
      if (job.status === "completed") {
        return { ...item, ok: true, status: "active", error: undefined };
      }
      if (job.status === "failed") {
        return { ...item, ok: false, status: "failed", error: job.errorMessage ?? "处理失败，请手动重新执行。" };
      }
      return { ...item, status: job.status };
    }) ?? current);
  }, []);
  useOperationPolling(pendingOperationIds, refreshOperation, DOMAIN_POLL_INTERVAL_MS);

  function replaceResult(domain: string, next: CreateDomainResult) {
    setResult((current) => current?.map((item) => (item.domain === domain ? next : item)) ?? current);
  }

  function domainPayload(domain: string): CreateDomainPayload {
    return {
      domains: domain,
      redirectMode,
      targetServiceId: redirectMode === "direct" ? "" : targetServiceId,
      directTargetHost: redirectMode === "direct" ? directTargetHost : "",
      targetForwardHost: redirectMode === "target_service_forward" ? targetForwardHost : "",
      groupId: groupId || null,
      newGroupName,
      hideReferer,
    };
  }

  async function createOneDomain(payload: CreateDomainPayload): Promise<CreateDomainResult> {
    const domain = payload.domains;
    let started: CreateDomainResult = { domain, ok: true, status: "queued", retryPayload: payload };
    try {
      const data = await api<{ results: CreateDomainResult[] }>(
        "/api/domains",
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      const item = data.results[0] ?? { domain, ok: false, error: "服务端没有返回处理结果。" };
      if (!item.ok || !item.id) {
        return { ...item, domain: item.domain || domain, status: item.status ?? "failed", retryPayload: payload };
      }
      started = { ...item, status: "queued", retryPayload: payload };
      replaceResult(domain, started);
      if (!item.jobId) {
        throw new Error("服务端没有返回任务 ID。");
      }
      await waitForOperation(item.jobId);
      return { ...started, ok: true, status: "active", error: undefined };
    } catch (error) {
      return {
        ...started,
        ok: false,
        status: "failed",
        error: error instanceof Error ? error.message : "创建失败。",
        retryPayload: payload,
      };
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      const domainItems = [...new Set(splitDomainInput(domains))];
      if (domainItems.length === 0) {
        setResult([{ domain: "-", ok: false, error: "请至少输入一个入口域名。" }]);
        return;
      }
      setResultTotal(domainItems.length);
      setResult(domainItems.map((domain) => ({
        domain,
        ok: true,
        status: "pending",
        retryPayload: domainPayload(domain),
      })));
      await runSerialBatch(
        domainItems,
        (domain) => createOneDomain(domainPayload(domain)),
        (domain, outcome) => replaceResult(domain, outcome.ok ? outcome.value : {
          domain,
          ok: false,
          status: "failed",
          error: outcome.error.message,
          retryPayload: domainPayload(domain),
        }),
      );
      await onCreated();
    } finally {
      setLoading(false);
    }
  }

  async function retryResult(item: CreateDomainResult) {
    if (!item.id && !item.retryPayload) {
      return;
    }
    const retryKey = item.id ?? item.domain;
    setRetryingIds((current) => [...new Set([...current, retryKey])]);
    setResult((current) =>
      current?.map((entry) => (entry.domain === item.domain ? { ...entry, ok: true, status: "queued", error: undefined } : entry)) ?? current,
    );
    try {
      let next: CreateDomainResult;
      if (item.id) {
        const queued = await api<{ jobId: string; status: string }>(`/api/domains/${item.id}/retry`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        next = { ...item, ok: true, jobId: queued.jobId, status: queued.status, error: undefined };
        replaceResult(item.domain, next);
        await waitForOperation(queued.jobId);
        next = { ...next, status: "active" };
      } else {
        next = await createOneDomain(item.retryPayload as CreateDomainPayload);
      }
      replaceResult(item.domain, next);
      await onCreated();
    } catch (error) {
      setResult((current) =>
        current?.map((entry) =>
          entry.domain === item.domain
            ? { ...entry, status: "failed", error: error instanceof Error ? error.message : "重新执行失败。" }
            : entry,
        ) ?? current,
      );
    } finally {
      setRetryingIds((current) => current.filter((id) => id !== retryKey));
    }
  }

  const needsTargetService = redirectMode !== "direct";

  return (
    <section className="split">
      <form className="panel" onSubmit={submit}>
        <h2>批量新增入口域名</h2>
        <label>
          入口域名
          <textarea placeholder={"abc.com\ntest.com\naaa.net"} value={domains} onChange={(event) => setDomains(event.target.value)} />
        </label>

        <div className="mode-tabs" role="group" aria-label="跳转模式">
          <button type="button" className={redirectMode === "direct" ? "mode-tab active" : "mode-tab"} onClick={() => setRedirectMode("direct")}>
            直接跳转
          </button>
          <button
            type="button"
            className={redirectMode === "target_service_forward" ? "mode-tab active" : "mode-tab"}
            onClick={() => setRedirectMode("target_service_forward")}
          >
            目标服务二段跳
          </button>
        </div>

        {redirectMode === "direct" ? (
          <label>
            直接跳转到任意 URL
            <input value={directTargetHost} onChange={(event) => setDirectTargetHost(event.target.value)} placeholder="https://xxxx.google.com/asas/32edsa/?a=1" required />
          </label>
        ) : (
          <>
            <label>
              目标服务
              <select value={targetServiceId} onChange={(event) => setTargetServiceId(event.target.value)} required>
                <option value="">请选择</option>
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.name} - {target.targetHost}
                  </option>
                ))}
              </select>
            </label>
            {redirectMode === "target_service_forward" && (
              <label>
                二段跳最终 URL
                <input value={targetForwardHost} onChange={(event) => setTargetForwardHost(event.target.value)} placeholder="https://final.example.com/path/to/page" required />
              </label>
            )}
          </>
        )}

        <div className="two-col">
          <label>
            选择 Group
            <select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
              <option value="">不分组</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            新建 Group
            <input value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} placeholder="可选" />
          </label>
        </div>

        <label className="switch">
          <input type="checkbox" checked={hideReferer} onChange={(event) => setHideReferer(event.target.checked)} />
          <span>隐藏 Referer</span>
          <small>使用 no-referrer 中转页，减少来源暴露但不承诺完全不可追踪。</small>
        </label>

        <button className="primary" disabled={loading || (needsTargetService && targets.length === 0)}>
          {loading ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
          开始配置
        </button>
      </form>

      <div className="panel">
        <div className="panel-head">
          <h2>处理结果</h2>
          <ResultSummary items={result} total={resultTotal} />
          <button className="ghost" type="button" disabled={!result} onClick={() => setResult(null)}>
            <X size={16} />
            清空结果
          </button>
        </div>
        {!result ? (
          <EmptyState title="等待提交" text="每个域名会独立显示成功、失败或等待生效。" />
        ) : (
          <div className="result-list">
            {result.map((item) => {
              const failed = !item.ok || item.status === "failed";
              const retryKey = item.id ?? item.domain;
              const canRetry = item.status !== "active" && Boolean(item.id || item.retryPayload);
              return (
              <div key={item.domain} className={failed ? "result fail" : "result ok"}>
                {failed ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
                <span>{item.domain}</span>
                <small>{failed ? item.error : statusText(item.status ?? "queued")}</small>
                {item.ok ? <Badge status={item.status ?? "queued"} /> : <span className="badge bad" title={item.error || "添加失败"}>失败</span>}
                {canRetry && (
                  <button
                    className="icon"
                    type="button"
                    title="手动重新执行"
                    disabled={retryingIds.includes(retryKey)}
                    onClick={() => void retryResult(item)}
                  >
                    {retryingIds.includes(retryKey) ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                  </button>
                )}
              </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function TargetsViewV2({ targets, onCreated }: { targets: TargetService[]; onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [targetHost, setTargetHost] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingIds, setCheckingIds] = useState<string[]>([]);
  const [repairingIds, setRepairingIds] = useState<string[]>([]);
  const [deletingIds, setDeletingIds] = useState<string[]>([]);
  const [actionError, setActionError] = useState("");
  const [manualTargetId, setManualTargetId] = useState<string | null>(null);
  const manualTarget = targets.find((target) => target.id === manualTargetId) ?? null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setActionError("");
    try {
      const queued = await api<{ jobId: string }>("/api/targets", {
        method: "POST",
        body: JSON.stringify({ name, targetHost, forwardTargetHost: "", description }),
      });
      setName("");
      setTargetHost("");
      setDescription("");
      await onCreated();
      await waitForOperation(queued.jobId);
      await onCreated();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "新增目标服务失败。");
    } finally {
      setLoading(false);
    }
  }

  async function checkTarget(target: TargetService) {
    setCheckingIds((current) => [...new Set([...current, target.id])]);
    try {
      await api(`/api/targets/${target.id}/check`, { method: "POST", body: JSON.stringify({}) });
      await onCreated();
    } finally {
      setCheckingIds((current) => current.filter((id) => id !== target.id));
    }
  }

  async function repairTarget(target: TargetService) {
    setRepairingIds((current) => [...new Set([...current, target.id])]);
    setActionError("");
    try {
      const queued = await api<{ jobId: string }>(`/api/targets/${target.id}/repair`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await onCreated();
      await waitForOperation(queued.jobId);
      await onCreated();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "重新配置失败。");
    } finally {
      setRepairingIds((current) => current.filter((id) => id !== target.id));
    }
  }

  async function removeTarget(target: TargetService) {
    const message =
      target.usageCount > 0
        ? `确认删除目标服务 ${target.targetHost}？\n\n它仍被 ${target.usageCount} 个入口域名/短链接使用。删除后，使用它的入口域名会显示为失败，原因是“目标服务列表中服务被删除了”；相关短链接会一起删除。`
        : `确认删除目标服务 ${target.targetHost}？`;
    if (!window.confirm(message)) {
      return;
    }
    setActionError("");
    setDeletingIds((current) => [...new Set([...current, target.id])]);
    try {
      const queued = await api<{ jobId: string }>(`/api/targets/${target.id}`, {
        method: "DELETE",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({}),
      });
      await waitForOperation(queued.jobId);
      await onCreated();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "删除目标服务失败。");
    } finally {
      setDeletingIds((current) => current.filter((id) => id !== target.id));
    }
  }

  return (
    <section className="split">
      <form className="panel" onSubmit={submit}>
        <h2>新增目标服务</h2>
        <label>
          名称
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="主短链服务" />
        </label>
        <label>
          服务域名
          <input value={targetHost} onChange={(event) => setTargetHost(event.target.value)} placeholder="link.example.com" />
        </label>
        <label>
          备注
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <button className="primary" disabled={loading}>
          {loading ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
          保存
        </button>
        <div className="note">添加完成后等 10 秒后手动刷新确认结果。</div>
      </form>

      <div className="panel">
        <h2>目标服务列表</h2>
        {actionError && <div className="alert bad"><AlertTriangle size={16} />{actionError}</div>}
        {targets.length === 0 ? (
          <EmptyState title="暂无目标服务" text="新增跳转前需要先创建目标短链接服务。" />
        ) : (
          <div className="target-list">
            {targets.map((target) => (
              <div key={target.id} className="target-item">
                <div className="target-main">
                  <strong>{target.name}</strong>
                  <small>{target.description || "无备注"}</small>
                  <small>{target.usageCount > 0 ? `被 ${target.usageCount} 个入口域名/短链接使用` : "未被入口域名或短链接使用，可删除"}</small>
                </div>
                <div className="target-health">
                  <Badge status={checkingIds.includes(target.id) || repairingIds.includes(target.id) ? "checking" : target.healthStatus} />
                  <small>
                    {target.healthHttpStatus ? `HTTP ${target.healthHttpStatus}` : target.healthError ?? "尚未检测"} · {formatDate(target.healthCheckedAt)}
                  </small>
                  <span className="mini-status">
                    <Badge status={target.nameserverStatus} />
                    <Badge status={target.dnsStatus} />
                  </span>
                </div>
                <div className="target-actions">
                  <a href={`https://${target.targetHost}`} target="_blank" rel="noreferrer">
                    {target.targetHost}
                    <ExternalLink size={14} />
                  </a>
                  <button className="icon" title="配置说明" onClick={() => setManualTargetId(target.id)}>
                    <Info size={16} />
                  </button>
                  <button className="icon" title="重新配置" disabled={repairingIds.includes(target.id)} onClick={() => void repairTarget(target)}>
                    <Settings className={repairingIds.includes(target.id) ? "spin" : ""} size={16} />
                  </button>
                  <button className="icon" title="重新检测" disabled={checkingIds.includes(target.id)} onClick={() => void checkTarget(target)}>
                    <RefreshCw className={checkingIds.includes(target.id) ? "spin" : ""} size={16} />
                  </button>
                  <button
                    className="icon danger-icon"
                    title={target.usageCount > 0 ? `删除并标记 ${target.usageCount} 个引用配置为异常` : "删除目标服务"}
                    disabled={deletingIds.includes(target.id)}
                    onClick={() => void removeTarget(target)}
                  >
                    {deletingIds.includes(target.id) ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {manualTarget && <ManualConfigModal target={manualTarget} onClose={() => setManualTargetId(null)} onUpdated={onCreated} />}
    </section>
  );
}

function ManualConfigModal({ target, onClose, onUpdated }: { target: TargetService; onClose: () => void; onUpdated: () => Promise<void> }) {
  const [results, setResults] = useState<Record<TargetConfigurationItem, TargetConfigurationResult>>(() => Object.fromEntries(
    targetConfigurationItems.map((item) => [item, initialConfigurationResult(target, item)]),
  ) as Record<TargetConfigurationItem, TargetConfigurationResult>);
  const [pendingItems, setPendingItems] = useState<TargetConfigurationItem[]>([]);

  useEffect(() => {
    let active = true;
    setPendingItems([...targetConfigurationItems]);
    void api<{ configuration: TargetConfigurationResult[] }>(`/api/targets/${target.id}/check`, {
      method: "POST",
      body: JSON.stringify({}),
    }).then(async ({ configuration }) => {
      if (!active) return;
      setResults(Object.fromEntries(configuration.map((item) => [item.item, item])) as Record<TargetConfigurationItem, TargetConfigurationResult>);
      await onUpdated();
    }).catch((error) => {
      if (!active) return;
      const message = error instanceof Error ? error.message : "暂时无法读取配置，请使用各项的信息检查按钮重试。";
      setResults((current) => Object.fromEntries(targetConfigurationItems.map((item) => [item, {
        ...current[item],
        status: "unknown",
        summary: message,
      }])) as Record<TargetConfigurationItem, TargetConfigurationResult>);
    }).finally(() => {
      if (active) setPendingItems([]);
    });
    return () => { active = false; };
  }, [target.id]);

  async function runItem(item: TargetConfigurationItem, action: "check" | "configure") {
    setPendingItems((current) => [...new Set([...current, item])]);
    try {
      const next = await api<TargetConfigurationResult>(`/api/targets/${target.id}/configuration/${item}/${action}`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setResults((current) => ({ ...current, [item]: next }));
      await onUpdated();
    } catch (error) {
      const message = error instanceof Error ? error.message : "操作失败，请按本项说明手动完成。";
      setResults((current) => ({
        ...current,
        [item]: { ...current[item], status: "failed", summary: message },
      }));
    } finally {
      setPendingItems((current) => current.filter((currentItem) => currentItem !== item));
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-label="目标服务配置说明" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>目标服务配置说明</h2>
            <p>{target.targetHost}</p>
          </div>
          <button className="icon" title="关闭" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="config-overview">
          <strong>公网服务状态</strong>
          <div className="mini-status">
            <Badge status={target.healthStatus} />
            <Badge status={target.nameserverStatus} />
            <Badge status={target.dnsStatus} />
          </div>
          <small>{target.lastError ?? target.healthError ?? "逐项检查可确认当前 Cloudflare 配置。"}</small>
        </div>

        <div className="config-check-list">
          {targetConfigurationItems.map((item) => {
            const config = results[item];
            const pending = pendingItems.includes(item);
            const labels: Record<TargetConfigurationItem, string> = {
              zone: "Cloudflare Zone",
              nameserver: "Nameserver",
              dns: "DNS 记录",
              route: "Worker Route",
            };
            const icon = config.status === "passed"
              ? <CheckCircle2 size={18} />
              : config.status === "failed"
                ? <X size={18} />
                : <CircleDot size={18} />;
            return (
              <section key={item} className={`config-check-row ${config.status}`}>
                <div className="config-check-icon">{icon}</div>
                <div className="config-check-copy">
                  <strong>{labels[item]}</strong>
                  <small>{config.summary}</small>
                </div>
                <div className="config-check-actions">
                  <button type="button" disabled={pending} onClick={() => void runItem(item, "configure")}>
                    {pending ? <Loader2 className="spin" size={15} /> : <Settings size={15} />}
                    再次配置
                  </button>
                  <button type="button" disabled={pending} onClick={() => void runItem(item, "check")}>
                    <RefreshCw size={15} />
                    信息检查
                  </button>
                </div>
                <ol className="config-check-steps">
                  {config.manualSteps.map((step) => <li key={step}>{step}</li>)}
                </ol>
              </section>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function NameserverToolView({ registrars }: { registrars: RegistrarStatus | null }) {
  const [domains, setDomains] = useState("");
  const [registrarId, setRegistrarId] = useState("dynadot");
  const [results, setResults] = useState<NameserverToolResult[] | null>(
    () => loadStoredResults<NameserverToolResult>(NAMESERVER_RESULTS_STORAGE_KEY),
  );
  const [resultTotal, setResultTotal] = useState(
    () => loadStoredResults<NameserverToolResult>(NAMESERVER_RESULTS_STORAGE_KEY)?.length ?? 0,
  );
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [retryingDomains, setRetryingDomains] = useState<string[]>([]);
  const dynadot = registrars?.providers.find((provider) => provider.id === "dynadot");

  useEffect(() => {
    if (results) {
      window.localStorage.setItem(NAMESERVER_RESULTS_STORAGE_KEY, JSON.stringify(results));
    } else {
      window.localStorage.removeItem(NAMESERVER_RESULTS_STORAGE_KEY);
    }
  }, [results]);

  const pendingOperationIds = useMemo(
    () => loading ? [] : results?.filter((item) => item.jobId && isProcessingStatus(item.status)).map((item) => item.jobId!) ?? [],
    [loading, results],
  );
  const refreshOperation = useCallback(async (jobId: string, signal: AbortSignal) => {
    const job = await api<OperationJob>(`/api/jobs/${jobId}`, undefined, { timeoutMs: 15_000, signal });
    setResults((current) => current?.map((item) => {
      if (item.jobId !== jobId) {
        return item;
      }
      if (job.status === "completed") {
        return { ...item, ...operationResult<NameserverToolResult>(job), jobId };
      }
      if (job.status === "failed") {
        return { ...item, ok: false, status: "failed", message: job.errorMessage ?? "Nameserver 接入失败。" };
      }
      return { ...item, status: job.status, message: statusText(job.status) };
    }) ?? current);
  }, []);
  useOperationPolling(pendingOperationIds, refreshOperation, DOMAIN_POLL_INTERVAL_MS);

  async function runOneDomain(domain: string, requestKey: string = crypto.randomUUID()): Promise<NameserverToolResult> {
    let started: NameserverToolResult = {
      domain,
      ok: true,
      status: "queued",
      message: "已加入串行处理队列。",
      nameservers: [],
      requestKey,
    };
    try {
      const data = await api<{ results: NameserverToolResult[] }>(
        "/api/nameserver-tool",
        {
          method: "POST",
          headers: { "idempotency-key": requestKey },
          body: JSON.stringify({ domains: domain, registrarId }),
        },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      started = { ...(data.results[0] ?? started), requestKey };
      if (!started.jobId) {
        throw new Error("服务端没有返回任务 ID。");
      }
      const job = await waitForOperation(started.jobId);
      return { ...started, ...operationResult<NameserverToolResult>(job), jobId: started.jobId, requestKey };
    } catch (err) {
      return {
        ...started,
        ok: false,
        status: "failed",
        message: err instanceof Error ? err.message : "Nameserver 接入失败。",
      };
    }
  }

  async function retryOneDomain(item: NameserverToolResult) {
    setRetryingDomains((current) => [...new Set([...current, item.domain])]);
    setResults((current) =>
      current?.map((entry) => (entry.domain === item.domain ? { ...entry, status: "queued", message: "重新执行中..." } : entry)) ?? current,
    );
    const next = await runOneDomain(item.domain);
    setResults((current) => current?.map((entry) => (entry.domain === item.domain ? next : entry)) ?? current);
    setRetryingDomains((current) => current.filter((domain) => domain !== item.domain));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    try {
      const domainItems = [...new Set(splitDomainInput(domains))];
      if (domainItems.length === 0) {
        setMessage("请至少输入一个域名。");
        return;
      }
      setResultTotal(domainItems.length);
      const initial = domainItems.map((domain): NameserverToolResult => ({
        domain,
        ok: true,
        status: "pending",
        message: "等待处理...",
        nameservers: [],
        requestKey: crypto.randomUUID(),
      }));
      setResults(initial);
      await runSerialBatch(
        initial,
        (item) => runOneDomain(item.domain, item.requestKey),
        (item, outcome) => setResults((current) => current?.map((entry) => (
          entry.domain === item.domain
            ? outcome.ok ? outcome.value : { ...entry, ok: false, status: "failed", message: outcome.error.message }
            : entry
        )) ?? current),
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Nameserver 接入失败。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="split nameserver-split">
      <form className="panel" onSubmit={submit}>
        <h2>将域名接入 Cloudflare NS</h2>
        <label>
          域名
          <textarea placeholder={"example.com\nexample.net"} value={domains} onChange={(event) => setDomains(event.target.value)} />
        </label>
        <label>
          注册商
          <select value={registrarId} onChange={(event) => setRegistrarId(event.target.value)}>
            <option value="dynadot">Dynadot 自动修改</option>
            <option value="manual">其他注册商，生成手动配置</option>
          </select>
        </label>
        <div className="note">
          系统会先把域名添加/确认到 Cloudflare Zone，拿到 Cloudflare 当前返回的 Nameserver，再写入注册商或展示给你手动复制。
        </div>
        <div className="alert warn"><AlertTriangle size={16} />批量处理超过 10 个域名容易触发限制，建议分批执行。</div>
        {registrarId === "dynadot" && dynadot && !dynadot.configured && (
          <div className="alert bad"><AlertTriangle size={16} />Dynadot API Key 尚未配置，请先通过 Wrangler Secret 设置。</div>
        )}
        <button className="primary" disabled={loading}>
          {loading ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
          开始处理
        </button>
        {message && <div className="form-error">{message}</div>}
      </form>

      <div className="panel">
        <div className="panel-head">
          <h2>处理结果</h2>
          <ResultSummary items={results} total={resultTotal} />
          <button className="ghost" type="button" disabled={!results} onClick={() => {
            setResults(null);
            setResultTotal(0);
          }}>
            <X size={16} />
            清空结果
          </button>
        </div>
        {!results ? (
          <EmptyState title="等待提交" text="处理后会显示每个域名的 Cloudflare Nameserver 和注册商写入状态。" />
        ) : (
          <div className="result-list">
            {results.map((item) => (
              <div key={item.domain} className={item.ok ? "result ok stack" : "result fail stack"}>
                <div className="result-line">
                  {item.ok ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
                  <span>{item.domain}</span>
                  <Badge status={item.status} />
                  {!item.ok && (
                    <button
                      className="icon"
                      type="button"
                      title="手动重新执行"
                      disabled={retryingDomains.includes(item.domain)}
                      onClick={() => void retryOneDomain(item)}
                    >
                      {retryingDomains.includes(item.domain) ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                    </button>
                  )}
                </div>
                <small>{item.message}</small>
                {item.nameservers.length > 0 && (
                  <code className="ns-list">{item.nameservers.join("\n")}</code>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function CloudflareZoneDeleteView() {
  const [domains, setDomains] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [zones, setZones] = useState<CloudflareZoneItem[]>([]);
  const [selectedZoneIds, setSelectedZoneIds] = useState<string[]>([]);
  const [zoneSearch, setZoneSearch] = useState("");
  const [results, setResults] = useState<CloudflareDeleteResult[] | null>(
    () => loadStoredResults<CloudflareDeleteResult>(ZONE_DELETE_RESULTS_STORAGE_KEY),
  );
  const [resultTotal, setResultTotal] = useState(
    () => loadStoredResults<CloudflareDeleteResult>(ZONE_DELETE_RESULTS_STORAGE_KEY)?.length ?? 0,
  );
  const [loadingZones, setLoadingZones] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [retryingDeletes, setRetryingDeletes] = useState<string[]>([]);

  async function loadZones() {
    setLoadingZones(true);
    setMessage("");
    try {
      const data = await api<{ zones: CloudflareZoneItem[] }>("/api/cloudflare-zones");
      setZones(data.zones);
      setSelectedZoneIds((current) => current.filter((id) => data.zones.some((zone) => zone.id === id)));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "加载 Cloudflare Zone 失败。");
    } finally {
      setLoadingZones(false);
    }
  }

  useEffect(() => {
    void loadZones();
  }, []);

  useEffect(() => {
    if (results) {
      window.localStorage.setItem(ZONE_DELETE_RESULTS_STORAGE_KEY, JSON.stringify(results));
    } else {
      window.localStorage.removeItem(ZONE_DELETE_RESULTS_STORAGE_KEY);
    }
  }, [results]);

  const pendingOperationIds = useMemo(
    () => loading ? [] : results?.filter((item) => item.jobId && isProcessingStatus(item.status)).map((item) => item.jobId!) ?? [],
    [loading, results],
  );
  const refreshOperation = useCallback(async (jobId: string, signal: AbortSignal) => {
    const job = await api<OperationJob>(`/api/jobs/${jobId}`, undefined, { timeoutMs: 15_000, signal });
    const completedResult = job.status === "completed" ? operationResult<CloudflareDeleteResult>(job) : null;
    if (job.status === "completed") {
      setZones((current) => current.filter((zone) => zone.name !== job.subjectId));
    }
    setResults((current) => current?.map((item) => {
      if (item.jobId !== jobId) {
        return item;
      }
      if (job.status === "completed") {
        return { ...item, ...completedResult, jobId };
      }
      if (job.status === "failed") {
        return { ...item, ok: false, status: "failed", message: job.errorMessage ?? "删除 Cloudflare Zone 失败。" };
      }
      return { ...item, status: job.status, message: statusText(job.status) };
    }) ?? current);
  }, []);
  useOperationPolling(pendingOperationIds, refreshOperation, DOMAIN_POLL_INTERVAL_MS);

  const filteredZones = zones.filter((zone) => zone.name.includes(zoneSearch.trim().toLowerCase()));
  const selectedZones = zones.filter((zone) => selectedZoneIds.includes(zone.id));

  async function deleteOneDomain(domain: string, requestKey: string = crypto.randomUUID()): Promise<CloudflareDeleteResult> {
    let started: CloudflareDeleteResult = {
      domain,
      ok: true,
      status: "queued",
      message: "已加入串行删除队列。",
      requestKey,
    };
    try {
      const data = await api<{ results: CloudflareDeleteResult[] }>(
        "/api/cloudflare-zones/delete",
        {
          method: "POST",
          headers: { "idempotency-key": requestKey },
          body: JSON.stringify({ domains: domain, confirmDelete: true }),
        },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      started = { ...(data.results[0] ?? started), requestKey };
      if (!started.jobId) {
        throw new Error("服务端没有返回任务 ID。");
      }
      const job = await waitForOperation(started.jobId);
      return { ...started, ...operationResult<CloudflareDeleteResult>(job), jobId: started.jobId, requestKey };
    } catch (err) {
      return {
        ...started,
        ok: false,
        status: "failed",
        message: err instanceof Error ? err.message : "删除 Cloudflare Zone 失败。",
      };
    }
  }

  async function retryDelete(item: CloudflareDeleteResult) {
    if (!confirmDelete) {
      setMessage("请先勾选确认项。");
      return;
    }
    setRetryingDeletes((current) => [...new Set([...current, item.domain])]);
    setResults((current) =>
      current?.map((entry) => (entry.domain === item.domain ? { ...entry, status: "queued", message: "重新删除中..." } : entry)) ?? current,
    );
    const next = await deleteOneDomain(item.domain);
    setResults((current) => current?.map((entry) => (entry.domain === item.domain ? next : entry)) ?? current);
    if (next.status === "deleted" || next.status === "not_found") {
      setZones((current) => current.filter((zone) => zone.name !== next.domain));
    }
    setRetryingDeletes((current) => current.filter((domain) => domain !== item.domain));
  }

  async function deleteDomains(domainText: string, count: number) {
    if (!confirmDelete) {
      setMessage("请先勾选确认项。");
      return;
    }
    if (count === 0) {
      setMessage("请至少选择或输入一个域名。");
      return;
    }
    if (!window.confirm(`确认从 Cloudflare 删除 ${count} 个 Zone？这会删除该 Zone 下的 DNS 记录和 Worker Routes，但不会删除注册商里的域名。`)) {
      return;
    }
    setMessage("");
    setLoading(true);
    try {
      const domainItems = [...new Set(splitDomainInput(domainText))];
      const initial = domainItems.map((domain): CloudflareDeleteResult => ({
        domain,
        ok: true,
        status: "pending",
        message: "等待删除...",
        requestKey: crypto.randomUUID(),
      }));
      setResultTotal(initial.length);
      setResults(initial);
      await runSerialBatch(
        initial,
        (item) => deleteOneDomain(item.domain, item.requestKey),
        (item, outcome) => {
          const next = outcome.ok
            ? outcome.value
            : { ...item, ok: false, status: "failed", message: outcome.error.message };
          setResults((current) => current?.map((entry) => entry.domain === item.domain ? next : entry) ?? current);
          if (next.status === "deleted" || next.status === "not_found") {
            setZones((current) => current.filter((zone) => zone.name !== next.domain));
          }
        },
      );
      setSelectedZoneIds([]);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "删除 Cloudflare Zone 失败。");
    } finally {
      setLoading(false);
    }
  }

  async function deleteSelected() {
    await deleteDomains(selectedZones.map((zone) => zone.name).join("\n"), selectedZones.length);
  }

  async function submitManual(event: React.FormEvent) {
    event.preventDefault();
    const count = domains.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean).length;
    await deleteDomains(domains, count);
  }

  return (
    <section className="split">
      <div className="panel">
        <div className="panel-head">
          <h2>Cloudflare Zone 列表</h2>
          <button className="ghost" type="button" disabled={loadingZones} onClick={() => void loadZones()}>
            <RefreshCw className={loadingZones ? "spin" : ""} size={16} />
            刷新
          </button>
        </div>
        <div className="alert bad">
          <AlertTriangle size={16} />
          这是危险操作：会删除 Cloudflare 中对应 Zone 及其 DNS 记录、Worker Routes。不会删除注册商里的域名，也不会清理本系统内的入口域名配置。
        </div>
        <label className="switch">
          <input type="checkbox" checked={confirmDelete} onChange={(event) => setConfirmDelete(event.target.checked)} />
          <span>我确认要删除 Cloudflare 中的 Zone</span>
          <small>如果域名仍指向 Cloudflare Nameserver，删除 Zone 后解析可能失效。</small>
        </label>
        <div className="searchbox standalone">
          <Search size={16} />
          <input placeholder="搜索 Cloudflare Zone" value={zoneSearch} onChange={(event) => setZoneSearch(event.target.value.toLowerCase())} />
        </div>
        <div className="panel-head">
          <small>已选择 {selectedZoneIds.length} 个，当前显示 {filteredZones.length} 个</small>
          <button className="danger" type="button" disabled={loading || !confirmDelete || selectedZoneIds.length === 0} onClick={() => void deleteSelected()}>
            {loading ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
            删除选中
          </button>
        </div>
        {loadingZones ? (
          <div className="empty">加载 Cloudflare Zone...</div>
        ) : filteredZones.length === 0 ? (
          <EmptyState title="没有匹配的 Zone" text="请刷新或调整搜索条件。" />
        ) : (
          <div className="table-wrap embedded">
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={filteredZones.length > 0 && filteredZones.every((zone) => selectedZoneIds.includes(zone.id))}
                      onChange={(event) => {
                        const visibleIds = filteredZones.map((zone) => zone.id);
                        setSelectedZoneIds((current) =>
                          event.target.checked ? [...new Set([...current, ...visibleIds])] : current.filter((id) => !visibleIds.includes(id)),
                        );
                      }}
                    />
                  </th>
                  <th>Zone</th>
                  <th>状态</th>
                  <th>Nameserver</th>
                  <th>更新时间</th>
                </tr>
              </thead>
              <tbody>
                {filteredZones.map((zone) => (
                  <tr key={zone.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedZoneIds.includes(zone.id)}
                        onChange={(event) =>
                          setSelectedZoneIds((current) => (event.target.checked ? [...current, zone.id] : current.filter((id) => id !== zone.id)))
                        }
                      />
                    </td>
                    <td><strong>{zone.name}</strong><small>{zone.id}</small></td>
                    <td><Badge status={zone.status} /></td>
                    <td><small>{zone.nameServers.join(", ") || "-"}</small></td>
                    <td>{formatDate(zone.modifiedOn ?? zone.createdOn)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {message && <div className="form-error">{message}</div>}
      </div>

      <div className="panel">
        <form className="inline-form" onSubmit={submitManual}>
          <h2>手动输入删除</h2>
          <label>
            域名
            <textarea placeholder={"old-example.com\nold-example.net"} value={domains} onChange={(event) => setDomains(event.target.value)} />
          </label>
          <button className="danger" disabled={loading || !confirmDelete}>
            {loading ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
            删除输入的 Zone
          </button>
        </form>

        <div className="panel-head result-head">
          <h2>删除结果</h2>
          <ResultSummary items={results} total={resultTotal} />
          <button className="ghost" type="button" disabled={!results} onClick={() => {
            setResults(null);
            setResultTotal(0);
          }}>
            <X size={16} />
            清空结果
          </button>
        </div>
        {!results ? (
          <EmptyState title="等待删除" text="可从左侧列表勾选 Zone 删除，也可以手动输入域名删除。" />
        ) : (
          <div className="result-list">
            {results.map((item) => (
              <div key={item.domain} className={item.ok ? "result ok stack" : "result fail stack"}>
                <div className="result-line">
                  {item.ok ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
                  <span>{item.domain}</span>
                  <Badge status={item.status} />
                  {!item.ok && (
                    <button
                      className="icon"
                      type="button"
                      title="手动重新执行"
                      disabled={retryingDeletes.includes(item.domain)}
                      onClick={() => void retryDelete(item)}
                    >
                      {retryingDeletes.includes(item.domain) ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                    </button>
                  )}
                </div>
                <small>{item.message}</small>
                {item.zoneId && <small>Zone ID: {item.zoneId}</small>}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function RegistrarsView({ registrars, onUpdated }: { registrars: RegistrarStatus | null; onUpdated: () => Promise<void> }) {
  const [dynadotSandbox, setDynadotSandbox] = useState(false);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dynadot = registrars?.providers.find((provider) => provider.id === "dynadot");
    if (dynadot) {
      setDynadotSandbox(Boolean(dynadot.sandbox));
    }
  }, [registrars]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    try {
      await api("/api/registrars", { method: "POST", body: JSON.stringify({ dynadotSandbox }) });
      setMessage("配置已保存。");
      await onUpdated();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存失败。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="split">
      <div className="panel">
        <h2>兼容服务</h2>
        <div className="check-grid">
          {(registrars?.providers ?? []).map((provider) => (
            <div key={provider.id} className={provider.configured ? "check pass" : "check fail"}>
              {provider.configured ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
              <strong>{provider.name}</strong>
              <span>{provider.role}</span>
              <small>{provider.automation}</small>
            </div>
          ))}
        </div>
      </div>

      <form className="panel" onSubmit={submit}>
        <h2>凭据配置</h2>
        <div className="note">
          API 凭据仅保存在 Cloudflare Worker Secrets，不会写入 D1。
          <code>npx wrangler secret put CLOUDFLARE_ACCOUNT_ID</code>
          <code>npx wrangler secret put CLOUDFLARE_API_TOKEN</code>
          <code>npx wrangler secret put DYNADOT_API_KEY</code>
        </div>
        <label className="switch">
          <input type="checkbox" checked={dynadotSandbox} onChange={(event) => setDynadotSandbox(event.target.checked)} />
          <span>使用 Dynadot Sandbox</span>
          <small>生产环境请保持关闭；测试环境可开启。</small>
        </label>
        <button className="primary" disabled={saving}>
          {saving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
          保存 Sandbox 设置
        </button>
        {message && <div className="note">{message}</div>}
      </form>
    </section>
  );
}

function SettingsView({ settings, onUpdated, onLogout }: { settings: SettingsCheck | null; onUpdated: () => Promise<void>; onLogout: () => Promise<void> }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const checks = useMemo(() => {
    if (!settings) return [];
    return [
      ["后台 Host", Boolean(settings.adminHost), settings.adminHost ?? "未配置"],
      ["后台密码 Hash", settings.hasAdminPasswordHash, "ADMIN_PASSWORD_HASH"],
      ["Session Secret", settings.hasSessionSecret, "SESSION_SECRET"],
      ["访问者 Hash Secret", settings.hasVisitorHashSecret, "VISITOR_HASH_SECRET（至少 32 字节）"],
      ["Password Pepper", settings.hasPasswordPepper, "PASSWORD_PEPPER"],
      ["Cloudflare Account", settings.hasCloudflareAccountId, "CLOUDFLARE_ACCOUNT_ID"],
      ["Cloudflare Token", settings.hasCloudflareApiToken, "CLOUDFLARE_API_TOKEN"],
      ["Dynadot API Key", settings.hasDynadotApiKey, settings.dynadotSandbox ? "Sandbox" : "Production"],
      ["访问明细保留", true, `${settings.visitEventRetentionDays} 天`],
    ] as const;
  }, [settings]);

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setPasswordMessage("");
    if (newPassword !== confirmPassword) {
      setPasswordMessage("两次输入的新密码不一致。");
      return;
    }
    setSavingPassword(true);
    try {
      await api("/api/auth/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordMessage("登录密码已更新。");
      await onUpdated();
    } catch (err) {
      setPasswordMessage(err instanceof Error ? err.message : "修改密码失败。");
    } finally {
      setSavingPassword(false);
    }
  }

  async function logout() {
    setLoggingOut(true);
    try {
      await onLogout();
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <section className="split">
      <div className="panel">
        <div className="panel-head">
          <h2>初始化检查</h2>
          <button className="ghost" type="button" disabled={loggingOut} onClick={() => void logout()}>
            {loggingOut ? <Loader2 className="spin" size={16} /> : <LogOut size={16} />}
            退出登录
          </button>
        </div>
        <div className="check-grid">
          {checks.map(([label, pass, detail]) => (
            <div key={label} className={pass ? "check pass" : "check fail"}>
              {pass ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
              <strong>{label}</strong>
              <span>{detail}</span>
            </div>
          ))}
        </div>
        <div className="note">
          Cloudflare Token 需要 Zone、DNS、Workers Routes 相关权限。敏感配置可继续用 Wrangler secrets，也可以在“注册商服务”中保存到服务端设置。
        </div>
      </div>
      <form className="panel" onSubmit={changePassword}>
        <h2>修改登录密码</h2>
        <label>
          当前密码
          <input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required />
        </label>
        <label>
          新密码
          <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={10} required />
        </label>
        <label>
          确认新密码
          <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={10} required />
        </label>
        <button className="primary" disabled={savingPassword}>
          {savingPassword ? <Loader2 className="spin" size={16} /> : <LockKeyhole size={16} />}
          更新密码
        </button>
        {passwordMessage && <div className="note">{passwordMessage}</div>}
      </form>
    </section>
  );
}

function DetailView({ id, onBack, onUpdated }: { id: string; onBack: () => void; onUpdated: () => Promise<void> }) {
  const [detail, setDetail] = useState<DomainDetail | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setDetail(await api<DomainDetail>(`/api/domains/${id}`));
    } finally {
      setLoading(false);
    }
  }

  async function retry() {
    await api(`/api/domains/${id}/retry`, { method: "POST", body: JSON.stringify({}) });
    await onUpdated();
    await load();
  }

  useEffect(() => {
    void load();
  }, [id]);

  if (!detail) {
    return <div className="panel">{loading ? "加载中..." : "未找到域名"}</div>;
  }

  return (
    <section className="detail">
      <button className="ghost" onClick={onBack}>返回列表</button>
      <div className="detail-head">
        <div>
          <h2>{detail.domain}</h2>
          <p>跳转到 {detail.targetHost}</p>
        </div>
        <div className="detail-actions">
          <Badge status={detail.status} />
          <button className="ghost" onClick={() => void retry()}><RefreshCw size={16} />重试</button>
        </div>
      </div>
      <section className="metric-grid">
        <Metric icon={<Activity />} label="累计候选 UV" value={detail.traffic} />
        <Metric icon={<Shield />} label="Referer" value={detail.hideReferer ? "隐藏" : "普通"} />
        <Metric icon={<Cloud />} label="Cloudflare" value={detail.cloudflareZoneStatus ?? "-"} />
        <Metric icon={<Globe2 />} label="Dynadot" value={statusText(detail.dynadotStatus)} />
      </section>
      <GeoPanel geography={detail.geography} />
      <AnalyticsPanels detail={detail} />
      <div className="split">
        <div className="panel">
          <h3>自动化任务</h3>
          {detail.jobs.length === 0 ? <EmptyState title="暂无任务" text="新增或重试后会生成任务记录。" /> : detail.jobs.map((job) => (
            <div key={job.id} className="job">
              <div className="job-title"><Badge status={job.status} /><span>{job.currentStep}</span><small>{formatDate(job.createdAt)}</small></div>
              {job.steps.map((step) => (
                <div key={step.id} className="step"><Badge status={step.status} /><span>{step.step}</span><small>{step.message}</small></div>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="panel">
        <h3>最近访问</h3>
        {detail.recentVisits.length === 0 ? <EmptyState title="暂无候选访问" text="符合候选规则的跳转请求会记录最近 50 条明细。" /> : (
          <table>
            <thead><tr><th>时间</th><th>Host</th><th>路径</th><th>来源</th><th>国家</th></tr></thead>
            <tbody>
              {detail.recentVisits.map((visit) => (
                <tr key={visit.id}><td>{formatDate(visit.visitedAt)}</td><td>{visit.host}</td><td>{visit.path}</td><td>{visit.referer ?? "直接访问"}</td><td>{visit.country ?? "-"}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
