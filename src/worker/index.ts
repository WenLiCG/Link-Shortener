import { handleApi, apiError } from "./api";
import { runScheduled } from "./automation";
import { handleRedirect } from "./redirect";
import { staticResponse } from "./static-assets";
import { handleTargetService } from "./target-service";

function isAdminHost(hostname: string, env: Env): boolean {
  const adminHost = (env.ADMIN_HOST || "").toLowerCase();
  const host = hostname.toLowerCase();
  return (
    host === adminHost ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.endsWith(".workers.dev")
  );
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (!isAdminHost(url.hostname, env)) {
        return new Response("Not found", { status: 404 });
      }
      try {
        return await handleApi(request, env, ctx);
      } catch (error) {
        return apiError(error);
      }
    }
    if (isAdminHost(url.hostname, env)) {
      const assets = Reflect.get(env, "ASSETS") as Fetcher | undefined;
      return assets ? assets.fetch(request) : staticResponse(url.pathname) ?? new Response("Not found", { status: 404 });
    }
    const targetResponse = await handleTargetService(request, env);
    if (targetResponse) {
      return targetResponse;
    }
    return handleRedirect(request, env, ctx);
  },
  async scheduled(_event, env, ctx): Promise<void> {
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;
