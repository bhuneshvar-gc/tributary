import { describe, expect, test } from "vitest";
import { describeProgress, formatDuration, liveProgress } from "../src/progress.js";

/** A renderer on a fake terminal and clock: no timer, every update draws. */
function fake() {
  let clock = 0;
  let written = "";
  const progress = liveProgress(
    { write: (s: string) => (written += s), columns: 120 },
    { now: () => clock, tickMs: 0 },
  );
  // Strips colors and cursor control, keeping what's left on screen per line.
  const screen = () =>
    written
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes
      .replace(/\x1b\[[0-9;]*m/g, "")
      .split("\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes
      .map((line) => line.split(/\r\x1b\[2K/).at(-1) ?? "");
  return { progress, screen, advance: (ms: number) => (clock += ms) };
}

describe("formatDuration", () => {
  test.each([
    [250, "250ms"],
    [1_540, "1.5s"],
    [59_940, "59.9s"],
    [65_000, "1m 05s"],
    [3_725_000, "62m 05s"],
  ])("%d ms is %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("live progress", () => {
  test("the live line shows the step, its elapsed time and the total", () => {
    const { progress, screen, advance } = fake();
    progress.update("reading the source schema", "inspect");
    advance(1_200);
    progress.update("collecting the subset: 10 rows", "collect");
    advance(2_500);
    progress.update("collecting the subset: 20 rows", "collect");

    expect(screen().at(-1)).toMatch(/collecting the subset: 20 rows\s+2\.5s · 3\.7s total$/);
  });

  test("a finished step stays on screen as done, with its time", () => {
    const { progress, screen, advance } = fake();
    progress.update("reading the source schema", "inspect");
    advance(1_200);
    progress.update("collecting the subset", "collect");
    advance(300);
    progress.finish();

    expect(screen().slice(0, 2)).toEqual([
      "✓ reading the source schema 1.2s",
      "✓ collecting the subset 300ms",
    ]);
  });

  test("a failed step is marked as failed", () => {
    const { progress, screen, advance } = fake();
    progress.update("loading public.x", "load:public.x");
    advance(50);
    progress.fail();

    expect(screen()[0]).toBe("✗ loading public.x 50ms");
  });

  test("a terminal reporting no width gets lines cut at 80 columns, not to nothing", () => {
    let written = "";
    const progress = liveProgress(
      { write: (s: string) => (written += s), columns: 0 },
      { tickMs: 0 },
    );
    progress.update("reading the source schema");
    expect(written).toContain("reading the source schema");
  });

  test("finishing with no step in progress writes nothing", () => {
    const { progress, screen } = fake();
    progress.finish();
    expect(screen()).toEqual([""]);
  });
});

describe("describeProgress", () => {
  const step = { table: "app.orders", index: 3, total: 12 };

  test.each([
    [{ phase: "inspecting" }, "reading the source schema"],
    [
      { phase: "collecting", rows: 1_234, tables: 5 },
      "collecting the subset: 1,234 rows across 5 tables",
    ],
    [{ phase: "preparing" }, "checking target tables, creating missing ones"],
    [{ phase: "deleting", tables: 4 }, "deleting the subset's rows from 4 target tables (--fresh)"],
    [
      { phase: "copying", rows: 45_000, totalRows: 90_000, ...step },
      "[3/12] app.orders: copying 45,000/90,000 rows (50%)",
    ],
    [{ phase: "merging", rows: 90_000, ...step }, "[3/12] app.orders: merging 90,000 rows"],
    [
      { phase: "loaded", mode: "new table", written: 90_000, unchanged: 0, ...step },
      "[3/12] app.orders: 90,000 rows copied into a new table",
    ],
    [
      { phase: "loaded", mode: "upsert", written: 10, unchanged: 89_990, ...step },
      "[3/12] app.orders: 10 rows written, 89,990 unchanged",
    ],
    [{ phase: "backfilling", ...step }, "restoring deferred references [3/12]: app.orders"],
    [{ phase: "analyzing", ...step }, "updating planner statistics [3/12]: app.orders"],
  ] as const)("%o", (event, text) => {
    expect(describeProgress(event).text).toBe(text);
  });

  test("every event of one table's load is one step; other phases are one step each", () => {
    const keys = [
      describeProgress({ phase: "copying", rows: 0, totalRows: 1, ...step }).step,
      describeProgress({ phase: "merging", rows: 1, ...step }).step,
      describeProgress({ phase: "loaded", mode: "upsert", written: 1, unchanged: 0, ...step }).step,
    ];
    expect(new Set(keys).size).toBe(1);
    expect(
      describeProgress({ phase: "copying", rows: 0, totalRows: 1, ...step, table: "app.other" })
        .step,
    ).not.toBe(keys[0]);
    expect(describeProgress({ phase: "analyzing", ...step }).step).toBe(
      describeProgress({ phase: "analyzing", ...step, table: "app.other", index: 4 }).step,
    );
  });
});
