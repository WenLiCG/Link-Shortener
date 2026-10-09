import { afterEach, describe, expect, it, vi } from "vitest";
import { runSerialBatch } from "../src/app/src/batch";

afterEach(() => vi.useRealTimers());

describe("serial batch runner", () => {
  it("never overlaps items", async () => {
    const calls: string[] = [];
    await runSerialBatch(["a", "b", "c"], async (item) => {
      calls.push(`start:${item}`);
      await Promise.resolve();
      calls.push(`end:${item}`);
      return item;
    }, () => undefined);

    expect(calls).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
  });

  it("continues after the worker reports its own request timeout", async () => {
    const processed: string[] = [];
    const outcomes: Array<{ item: string; ok: boolean }> = [];
    await runSerialBatch(["slow", "next"], async (item) => {
      if (item === "slow") {
        throw new Error("请求超时");
      }
      processed.push(item);
      return item;
    }, (item, outcome) => {
      outcomes.push({ item, ok: outcome.ok });
    });

    expect(processed).toEqual(["next"]);
    expect(outcomes).toEqual([
      { item: "slow", ok: false },
      { item: "next", ok: true },
    ]);
  });

  it("does not start the next item when a worker exceeds the former outer timeout", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const batch = runSerialBatch(["slow", "next"], async (item) => {
      calls.push(`start:${item}`);
      if (item === "slow") await new Promise((resolve) => setTimeout(resolve, 165_000));
      calls.push(`end:${item}`);
      return item;
    }, () => undefined);
    await vi.advanceTimersByTimeAsync(130_000);
    expect(calls).toEqual(["start:slow"]);
    await vi.advanceTimersByTimeAsync(35_000);
    await batch;
    expect(calls).toEqual(["start:slow", "end:slow", "start:next", "end:next"]);
  });
});
