import { useEffect, useMemo } from "react";

export function useOperationPolling(
  operationIds: string[],
  fetchOperation: (id: string, signal: AbortSignal) => Promise<void>,
  intervalMs = 3_000,
): void {
  const operationKey = useMemo(
    () => [...new Set(operationIds)].sort().join(","),
    [operationIds],
  );

  useEffect(() => {
    if (!operationKey) {
      return;
    }
    const controller = new AbortController();
    const refresh = () => Promise.all(
      operationKey.split(",").map((id) => fetchOperation(id, controller.signal)),
    ).catch(() => undefined);
    const timer = window.setInterval(() => void refresh(), intervalMs);
    void refresh();
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [fetchOperation, intervalMs, operationKey]);
}
