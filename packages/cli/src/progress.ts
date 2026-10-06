import type { SubsetProgress } from "@bhuneshvar-k/tributary-core";
import pc from "picocolors";

/** "250ms", "4.2s", "1m 05s". */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

const count = (n: number) => n.toLocaleString("en-US");
const rows = (n: number) => `${count(n)} ${n === 1 ? "row" : "rows"}`;

/**
 * What an event says, and which step it belongs to: events of one step
 * update one live line, and a new step closes the previous one as done.
 */
export function describeProgress(event: SubsetProgress): { text: string; step: string } {
  switch (event.phase) {
    case "inspecting":
      return { step: "inspect", text: "reading the source schema" };
    case "collecting":
      return {
        step: "collect",
        text: `collecting the subset: ${rows(event.rows)} across ${event.tables} tables`,
      };
    case "preparing":
      return { step: "prepare", text: "checking target tables, creating missing ones" };
    case "deleting":
      return {
        step: "delete",
        text: `deleting the subset's rows from ${event.tables} target tables (--fresh)`,
      };
    case "copying": {
      const percent = event.totalRows ? Math.floor((event.rows / event.totalRows) * 100) : 100;
      return {
        step: `load:${event.table}`,
        text: `[${event.index}/${event.total}] ${event.table}: copying ${count(event.rows)}/${rows(event.totalRows)} (${percent}%)`,
      };
    }
    case "merging":
      return {
        step: `load:${event.table}`,
        text: `[${event.index}/${event.total}] ${event.table}: merging ${rows(event.rows)}`,
      };
    case "loaded":
      return {
        step: `load:${event.table}`,
        text: `[${event.index}/${event.total}] ${event.table}: ${
          event.mode === "new table"
            ? `${rows(event.written)} copied into a new table`
            : `${rows(event.written)} written, ${count(event.unchanged)} unchanged`
        }`,
      };
    case "backfilling":
      return {
        step: "backfill",
        text: `restoring deferred references [${event.index}/${event.total}]: ${event.table}`,
      };
    case "analyzing":
      return {
        step: "analyze",
        text: `updating planner statistics [${event.index}/${event.total}]: ${event.table}`,
      };
  }
}

export interface LiveProgress {
  /**
   * Shows `text` as what's happening now. A `step` other than the current
   * one first closes the current step as done (default: the text itself).
   */
  update(text: string, step?: string): void;
  /** Closes the current step as done; the next update starts a new one. */
  finish(): void;
  /** Closes the current step as failed. */
  fail(): void;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Progress on a terminal: finished steps stay on screen as "✓ text 1.2s",
 * and the step in progress is one line redrawn every `tickMs` with its
 * own elapsed time and the total since the renderer was created.
 * `tickMs: 0` draws on every update instead (for tests).
 */
export function liveProgress(
  out: { write(s: string): unknown; columns?: number },
  { now = () => performance.now(), tickMs = 100 }: { now?: () => number; tickMs?: number } = {},
): LiveProgress {
  const started = now();
  let current: { step: string; text: string; since: number } | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  let drawn = false;

  const erase = () => {
    if (drawn) out.write("\r\x1b[2K");
    drawn = false;
  };
  const draw = () => {
    if (!current) return;
    const t = now();
    const timing = `${formatDuration(t - current.since)} · ${formatDuration(t - started)} total`;
    // One line only: a wrapped line can't be redrawn in place.
    const room = (out.columns || 80) - timing.length - 4;
    const text =
      current.text.length > room
        ? `${current.text.slice(0, Math.max(0, room - 1))}…`
        : current.text;
    erase();
    out.write(`${pc.cyan(FRAMES[frame++ % FRAMES.length]!)} ${text}  ${pc.dim(timing)}`);
    drawn = true;
  };
  const close = (done: boolean) => {
    if (!current) return;
    if (timer) clearInterval(timer);
    timer = undefined;
    erase();
    const mark = done ? pc.green("✓") : pc.red("✗");
    out.write(`${mark} ${current.text} ${pc.dim(formatDuration(now() - current.since))}\n`);
    current = undefined;
  };

  return {
    update(text, step = text) {
      if (current && current.step !== step) close(true);
      const starting = !current;
      if (current) current.text = text;
      else current = { step, text, since: now() };
      if (starting && tickMs > 0) {
        timer = setInterval(draw, tickMs);
        timer.unref();
      }
      // Rows stream in faster than a terminal needs redrawing: the timer
      // redraws a step in progress.
      if (starting || tickMs === 0) draw();
    },
    finish: () => close(true),
    fail: () => close(false),
  };
}
