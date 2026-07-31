export type BatchOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error };

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("处理超时，已继续下一项。")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export async function runSerialBatch<TInput, TResult>(
  items: TInput[],
  worker: (item: TInput) => Promise<TResult>,
  onResult: (item: TInput, outcome: BatchOutcome<TResult>) => void,
  timeoutMs = 130_000,
): Promise<void> {
  for (const item of items) {
    try {
      onResult(item, { ok: true, value: await withTimeout(worker(item), timeoutMs) });
    } catch (error) {
      onResult(item, { ok: false, error: error instanceof Error ? error : new Error("处理失败。") });
    }
  }
}
