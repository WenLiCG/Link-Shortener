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

async function dynadotRequest(env: Env, params: Record<string, string>, signal?: AbortSignal): Promise<DynadotResponse> {
  const apiKey = secret(env, "DYNADOT_API_KEY");
  if (!apiKey) {
    throw new ProviderError("dynadot", null, "missing_key", false, "尚未配置 Dynadot API Key。");
  }
  const url = new URL(await endpoint(env));
  url.searchParams.set("key", apiKey);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const timeoutSignal = AbortSignal.timeout(10_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response: Response | undefined;
  try {
    requestSignal.throwIfAborted();
    response = await fetch(url.toString(), { signal: requestSignal });
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
    const parsed = await response.json();
    requestSignal.throwIfAborted();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ProviderError("dynadot", response.status, "invalid_response", true, "Dynadot 返回了无效响应。");
    }
    return parsed as DynadotResponse;
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }
    const timeout = requestSignal.aborted || error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
    const invalid = error instanceof SyntaxError;
    throw new ProviderError(
      "dynadot",
      response?.status ?? null,
      timeout ? "timeout" : invalid ? "invalid_response" : "network_error",
      true,
      timeout ? "Dynadot 请求超时。" : invalid ? "Dynadot 返回了无效响应。" : "无法连接 Dynadot。",
    );
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

export async function isDomainInDynadot(env: Env, domain: string, signal?: AbortSignal): Promise<boolean> {
  if (!secret(env, "DYNADOT_API_KEY")) {
    return false;
  }
  const body = await dynadotRequest(env, { command: "domain_info", domain }, signal);
  const status = getStatus(body);
  return status.ok;
}

export async function setNameservers(env: Env, domain: string, nameservers: string[], signal?: AbortSignal): Promise<void> {
  const params: Record<string, string> = {
    command: "set_ns",
    domain,
  };
  nameservers.slice(0, 13).forEach((nameserver, index) => {
    params[`ns${index}`] = nameserver;
  });
  const body = await dynadotRequest(env, params, signal);
  const status = getStatus(body);
  if (!status.ok) {
    throw new ProviderError("dynadot", 200, "operation_rejected", false, "Dynadot 拒绝了 Nameserver 更新。");
  }
}
