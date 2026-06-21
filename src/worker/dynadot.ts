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
  const apiKey = await configuredValue(env, "DYNADOT_API_KEY");
  if (!apiKey) {
    throw new Error("缺少 DYNADOT_API_KEY。");
  }
  const url = new URL(await endpoint(env));
  url.searchParams.set("key", apiKey);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString());
  const body = (await response.json()) as DynadotResponse;
  if (!response.ok) {
    throw new Error("Dynadot API 请求失败。");
  }
  return body;
}

function getStatus(body: DynadotResponse): { ok: boolean; message: string } {
  const first = Object.values(body)[0];
  if (!first) {
    return { ok: false, message: "Dynadot 返回为空。" };
  }
  const code = String(first.ResponseCode ?? "");
  const status = String(first.Status ?? "").toLowerCase();
  const ok = code === "0" || status === "success";
  return { ok, message: first.Error || first.Status || (ok ? "success" : "Dynadot 操作失败。") };
}

export async function isDomainInDynadot(env: Env, domain: string): Promise<boolean> {
  if (!(await configuredValue(env, "DYNADOT_API_KEY"))) {
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
    throw new Error(status.message);
  }
}
import { configuredValue } from "./env-utils";
