export type BatchOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error };

export async function runSerialBatch<TInput, TResult>(
  items: TInput[],
  worker: (item: TInput) => Promise<TResult>,
  onResult: (item: TInput, outcome: BatchOutcome<TResult>) => void,
): Promise<void> {
  for (const item of items) {
    try {
      onResult(item, { ok: true, value: await worker(item) });
    } catch (error) {
      onResult(item, { ok: false, error: error instanceof Error ? error : new Error("处理失败。") });
    }
  }
}
