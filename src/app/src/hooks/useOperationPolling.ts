import { useEffect, useMemo, useRef } from "react";
import { ApiError, isOperationPending, operationPollDelay, type OperationJob } from "../operations";

interface PageVisibility extends EventTarget { readonly hidden: boolean }
type PollState = { nextAt: number; failures: number };

export function startOperationPolling(
  operationIds: string[],
  fetchOperation: (id: string, signal: AbortSignal) => Promise<OperationJob>,
  onError: (id: string, error: unknown) => void,
  intervalMs: number,
  visibility?: PageVisibility,
  savedState = new Map<string, PollState>(),
): () => void {
  const controller = new AbortController();
  for (const id of savedState.keys()) if (!operationIds.includes(id)) savedState.delete(id);
  const pending = new Map(operationIds.map((id) => {
    const state = savedState.get(id) ?? { nextAt: 0, failures: 0 };
    savedState.set(id, state);
    return [id, state];
  }));
  let timer: ReturnType<typeof setTimeout>;
  let refreshing = false;
  function schedule() {
    clearTimeout(timer);
    if (controller.signal.aborted || visibility?.hidden || pending.size === 0) return;
    const nextAt = Math.min(...[...pending.values()].map((state) => state.nextAt));
    timer = setTimeout(() => void refresh(), Math.max(0, nextAt - Date.now()));
  }
  async function refresh() {
    if (refreshing || controller.signal.aborted || visibility?.hidden) return;
    refreshing = true;
    await Promise.all([...pending].filter(([, state]) => state.nextAt <= Date.now()).map(async ([id, state]) => {
      try {
        const job = await fetchOperation(id, controller.signal);
        if (controller.signal.aborted) return;
        if (!isOperationPending(job)) pending.delete(id);
        state.failures = 0;
        state.nextAt = Date.now() + operationPollDelay(job, intervalMs);
      } catch (error) {
        if (!controller.signal.aborted) {
          if (error instanceof ApiError && (error.status === 404 || error.status === 401)) pending.delete(id);
          state.failures++;
          state.nextAt = Date.now() + Math.min(60_000, intervalMs * 2 ** Math.min(state.failures, 5));
          onError(id, error);
        }
      }
    }));
    refreshing = false;
    schedule();
  }
  const onVisibilityChange = () => {
    clearTimeout(timer);
    if (!visibility?.hidden) {
      for (const state of pending.values()) state.nextAt = 0;
      void refresh();
    }
  };
  visibility?.addEventListener("visibilitychange", onVisibilityChange);
  void refresh();
  return () => {
    controller.abort();
    clearTimeout(timer);
    visibility?.removeEventListener("visibilitychange", onVisibilityChange);
  };
}

export function useOperationPolling(
  operationIds: string[],
  fetchOperation: (id: string, signal: AbortSignal) => Promise<OperationJob>,
  intervalMs = 3_000,
  onError: (id: string, error: unknown) => void,
): void {
  const callbacks = useRef({ fetchOperation, onError });
  const savedState = useRef(new Map<string, PollState>());
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
      (id, error) => callbacks.current.onError(id, error), intervalMs,
      (globalThis as { document?: PageVisibility }).document, savedState.current);
  }, [intervalMs, operationKey]);
}
