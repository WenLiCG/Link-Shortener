export interface StaticAsset {
  content: string;
  contentType: string;
  encoding?: "base64" | "text";
}

export const STATIC_ASSETS: Record<string, StaticAsset> = {};

export function staticResponse(pathname: string): Response | null {
  const asset = STATIC_ASSETS[pathname] ?? STATIC_ASSETS["/index.html"];
  if (!asset) {
    return null;
  }
  const body =
    asset.encoding === "base64"
      ? Uint8Array.from(atob(asset.content), (char) => char.charCodeAt(0))
      : asset.content;
  return new Response(body, {
    headers: {
      "content-type": asset.contentType,
      "cache-control": pathname === "/index.html" ? "no-store" : "public, max-age=31536000, immutable",
    },
  });
}
