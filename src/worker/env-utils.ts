export type SecretName =
  | "ADMIN_PASSWORD_HASH"
  | "SESSION_SECRET"
  | "CLOUDFLARE_ACCOUNT_ID"
  | "CLOUDFLARE_API_TOKEN"
  | "DYNADOT_API_KEY";

export type ConfigName = SecretName | "DYNADOT_SANDBOX";

export function secret(env: Env, name: SecretName): string | undefined {
  const value = Reflect.get(env, name) as unknown;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function configuredValue(env: Env, name: ConfigName): Promise<string | undefined> {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ? LIMIT 1").bind(name).first<{ value?: string }>();
    if (typeof row?.value === "string" && row.value.length > 0) {
      return row.value;
    }
  } catch {
    // Settings are optional during bootstrap; fall back to deployed env/secrets.
  }
  const value = Reflect.get(env, name) as unknown;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function hasConfiguredValue(env: Env, name: ConfigName): Promise<boolean> {
  return Boolean(await configuredValue(env, name));
}
