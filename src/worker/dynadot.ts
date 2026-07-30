import { configuredValue, secret } from "./env-utils";
import { ProviderError } from "./provider-error";

interface DynadotResponse {
  [key: string]: {
    ResponseCode?: number | string;
    Status?: string;
    Error?: string;
  };
}

async function endpoint(env: Env): Promise<string> {
  return String(await configuredValue(env, "DYNADOT_SANDBOX")) === "true"
    ? "https://api-sandbox.dynadot.com/api3.json"
    : "https://api.dynadot.com/api3.json";
}

async function dynadotRequest(env: Env, params: Record<string, string>): Promise<DynadotResponse> {
  const apiKey = secret(env, "DYNADOT_API_KEY");
  if (!apiKey) {
    throw new ProviderError("dynadot", null, "missing_key", false, "尚未配置 Dynadot API Key。");
  }
  const url = new URL(await endpoint(env));
  url.searchParams.set("key", apiKey);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  let response: Response;
  try {
    response = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    const timeout = error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
    throw new ProviderError(
      "dynadot",
      null,
      timeout ? "timeout" : "network_error",
      true,
      timeout ? "Dynadot 请求超时。" : "无法连接 Dynadot。",
    );
  }
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new ProviderError(
      "dynadot",
      response.status,
      `http_${response.status}`,
      retryable,
      retryable ? "Dynadot 暂时不可用，请稍后重试。" : "Dynadot 拒绝了请求，请检查配置。",
    );
  }
  try {
    const parsed = await response.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid_response");
    }
    return parsed as DynadotResponse;
  } catch {
    throw new ProviderError("dynadot", response.status, "invalid_response", true, "Dynadot 返回了无效响应。");
  }
}

function getStatus(body: DynadotResponse): { ok: boolean; message: string } {
  const first = Object.values(body)[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    return { ok: false, message: "Dynadot 返回为空。" };
  }
  const code = String(first.ResponseCode ?? "");
  const status = String(first.Status ?? "").toLowerCase();
  const ok = code === "0" || status === "success";
  return { ok, message: first.Error || first.Status || (ok ? "success" : "Dynadot 操作失败。") };
}

export async function isDomainInDynadot(env: Env, domain: string): Promise<boolean> {
  if (!secret(env, "DYNADOT_API_KEY")) {
    return false;
  }
  const body = await dynadotRequest(env, { command: "domain_info", domain });
  const status = getStatus(body);
  return status.ok;
}

export async function setNameservers(env: Env, domain: string, nameservers: string[]): Promise<void> {
  const params: Record<string, string> = {
    command: "set_ns",
    domain,
  };
  nameservers.slice(0, 13).forEach((nameserver, index) => {
    params[`ns${index}`] = nameserver;
  });
  const body = await dynadotRequest(env, params);
  const status = getStatus(body);
  if (!status.ok) {
    throw new ProviderError("dynadot", 200, "operation_rejected", false, "Dynadot 拒绝了 Nameserver 更新。");
  }
}
