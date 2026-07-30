export class ProviderError extends Error {
  constructor(
    public readonly provider: "cloudflare" | "dynadot",
    public readonly status: number | null,
    public readonly code: string,
    public readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
