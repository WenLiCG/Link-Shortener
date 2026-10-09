import { useEffect, useMemo, useRef } from "react";
import { ApiError } from "../operations";

export function startOperationPolling(
  operationIds: string[],
  fetchOperation: (id: string, signal: AbortSignal) => Promise<void>,
  onError: (id: string, error: unknown) => void,
  intervalMs: number,
): () => void {
  const controller = new AbortController();
  const stopped = new Set<string>();
  let timer: ReturnType<typeof setTimeout>;
  let failures = 0;
  async function refresh() {
    const outcomes = await Promise.all(operationIds.filter((id) => !stopped.has(id)).map(async (id) => {
      try {
        await fetchOperation(id, controller.signal);
        return true;
      } catch (error) {
        if (!controller.signal.aborted) {
          if (error instanceof ApiError && (error.status === 404 || error.status === 401)) stopped.add(id);
          onError(id, error);
        }
        return false;
      }
    }));
    if (controller.signal.aborted || stopped.size === operationIds.length) return;
    failures = outcomes.every(Boolean) ? 0 : failures + 1;
    timer = setTimeout(() => void refresh(), Math.min(60_000, intervalMs * 2 ** Math.min(failures, 5)));
  }
  void refresh();
  return () => { controller.abort(); clearTimeout(timer); };
}

export function useOperationPolling(
  operationIds: string[],
  fetchOperation: (id: string, signal: AbortSignal) => Promise<void>,
  intervalMs = 3_000,
  onError: (id: string, error: unknown) => void,
): void {
  const callbacks = useRef({ fetchOperation, onError });
  callbacks.current = { fetchOperation, onError };
  const operationKey = useMemo(
    () => [...new Set(operationIds)].sort().join(","),
    [operationIds],
  );

  useEffect(() => {
    if (!operationKey) {
      return;
    }
    return startOperationPolling(operationKey.split(","),
      (id, signal) => callbacks.current.fetchOperation(id, signal),
      (id, error) => callbacks.current.onError(id, error), intervalMs);
  }, [intervalMs, operationKey]);
}
