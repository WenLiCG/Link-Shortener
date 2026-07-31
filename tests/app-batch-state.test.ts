import { describe, expect, it } from "vitest";
import { runSerialBatch } from "../src/app/src/batch";

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

  it("reports a timeout and continues with the next item", async () => {
    const processed: string[] = [];
    const outcomes: Array<{ item: string; ok: boolean }> = [];
    await runSerialBatch(["slow", "next"], async (item) => {
      if (item === "slow") {
        await new Promise(() => undefined);
      }
      processed.push(item);
      return item;
    }, (item, outcome) => {
      outcomes.push({ item, ok: outcome.ok });
    }, 10);

    expect(processed).toEqual(["next"]);
    expect(outcomes).toEqual([
      { item: "slow", ok: false },
      { item: "next", ok: true },
    ]);
  });
});
