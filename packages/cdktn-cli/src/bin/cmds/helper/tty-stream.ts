// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import ansiEscapes from "ansi-escapes";
import cliCursor from "cli-cursor";
import cliSpinners from "cli-spinners";
import isCI from "is-ci";
import stripAnsi from "strip-ansi";
import { formatLogLine } from "./format";

type Signal = "SIGINT" | "SIGTERM" | "SIGQUIT";
const signals: Signal[] = ["SIGINT", "SIGTERM", "SIGQUIT"];

/** A single line of output to render above the status bar. */
export type LogEntry = { stackName: string; content: string };

/**
 * Renders a stream of historical log lines above a pinned, repaintable status bar at the bottom of the terminal.
 *
 * In TTY mode, log lines scroll into permanent scrollback while the bar is erased and repainted in place via ANSI
 * escapes. In non-TTY mode (CI, pipes), the bar is suppressed entirely and logs stream as plain text.
 *
 * Bar lifecycle: `start()` to install cursor/signal handlers, `setBar()` / `appendLog()` during work, `stop()` to tear
 * down. While `pause()`d (e.g. during an interactive prompt that takes over stdin), log writes are buffered and
 * flushed on `resume()` so the prompt's UI is never scribbled over.
 */
export class StreamRenderer {
  private readonly tty: boolean;
  private bar = "";
  private barLines = 0;
  private paused = false;
  private bufferedLogs: LogEntry[] = [];
  private cursorRestore?: () => void;
  private spinnerFrame = 0;
  private spinnerInterval?: NodeJS.Timeout;
  private hasEmittedLog = false;

  /**
   * @param out - Stream to write to. Defaults to process.stdout. The renderer paints only when this stream reports
   * `isTTY === true` and no CI environment is detected.
   */
  constructor(private readonly out: NodeJS.WriteStream = process.stdout) {
    this.tty = Boolean(out.isTTY) && !isCI;
  }

  /**
   * Begin a rendering session. Writes a leading blank line so output is separated from prior content. In TTY mode
   * also hides the cursor and registers signal handlers to restore it on SIGINT/SIGTERM/SIGQUIT.
   */
  start(): void {
    this.out.write("\n");
    if (!this.tty) return;
    cliCursor.hide(this.out);
    this.cursorRestore = () => cliCursor.show(this.out);
    for (const sig of signals) process.once(sig, this.cursorRestore);
  }

  /**
   * End the rendering session. Stops any spinner, erases the bar, restores the cursor, and removes the signal handlers
   * installed by `start()`. Safe to call multiple times; safe to call without a prior `start()`.
   */
  stop(): void {
    this.stopSpinner();
    if (!this.tty) return;
    this.eraseBar();
    if (this.cursorRestore) {
      this.cursorRestore();
      for (const sig of signals)
        process.removeListener(sig, this.cursorRestore);
      this.cursorRestore = undefined;
    }
  }

  /**
   * Emit a log line into scrollback above the bar. In TTY mode the bar is erased, the formatted log is written, then
   * the bar is repainted. While `pause()`d, the entry is buffered and flushed in order on `resume()` so the entry
   * never collides with a running interactive prompt.
   *
   * @param entry - Log to format and print. `stackName` selects a colour for the prefix; `content` is trimmed.
   */
  appendLog(entry: LogEntry): void {
    if (this.paused) {
      this.bufferedLogs.push(entry);
      return;
    }
    const line = formatLogLine(entry);
    if (!this.tty) {
      this.out.write(line + "\n");
      return;
    }
    this.eraseBar();
    this.out.write(line + "\n");
    this.hasEmittedLog = true;
    this.paintBar();
  }

  /**
   * Replace the pinned status bar with new text. In non-TTY mode this only stores the text (no terminal write) so
   * spinner state and resume() know what would have been painted.
   *
   * @param text - Bar text to display. Empty string clears the bar.
   * @param opts.spinner - If true, a dots spinner ticks at ~80 ms in front of the text. Reset to false (or omitted) on
   *                       subsequent calls to stop it.
   */
  setBar(text: string, opts: { spinner?: boolean } = {}): void {
    this.bar = text;
    if (opts.spinner && text) this.startSpinner();
    else this.stopSpinner();
    if (!this.tty || this.paused) return;
    this.eraseBar();
    this.paintBar();
  }

  /**
   * Erase the bar and forget its text. Used at end-of-command so any final console output isn't drawn underneath
   * leftover bar content.
   */
  clearBar(): void {
    this.stopSpinner();
    this.bar = "";
    if (!this.tty) return;
    this.eraseBar();
  }

  /**
   * Suspend bar painting and log flushing — e.g. while an interactive prompt (inquirer) owns stdin. Erases the
   * currently-painted bar so the prompt starts on a clean row. Logs received during the pause are buffered, not
   * dropped.
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.eraseBar();
  }

  /**
   * Resume bar painting after `pause()`. Flushes any buffered logs into scrollback (in order) and repaints the bar
   * with whatever text was set most recently via `setBar()`.
   */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const buffered = this.bufferedLogs;
    this.bufferedLogs = [];
    for (const entry of buffered) this.appendLog(entry);
    this.paintBar();
  }

  /**
   * Write the bar (with spinner prefix if active) followed by a trailing newline, so the cursor parks on the row below
   * the bar. The trailing newline is load-bearing: it makes `eraseLines(barLines + 1)` align deterministically with
   * the bar's wrapped rows. When at least one log has been emitted, a leading blank row separates the bar from the
   * scrollback above; for spinner-only commands the single top-of-output blank from `start()` does the same job and
   * we skip the leading blank here.
   */
  private paintBar(): void {
    if (!this.tty) return;
    if (!this.bar) {
      this.barLines = 0;
      return;
    }
    const prefix = this.spinnerInterval ? this.currentSpinnerFrame() + " " : "";
    const painted = prefix + this.bar;
    const leadingBlank = this.hasEmittedLog ? "\n" : "";
    this.out.write(leadingBlank + painted + "\n");
    this.barLines =
      visualRowCount(painted, this.out.columns) + (leadingBlank ? 1 : 0);
  }

  /**
   * @returns The current dots-spinner frame character.
   */
  private currentSpinnerFrame(): string {
    const frames = cliSpinners.dots.frames;
    return frames[this.spinnerFrame % frames.length];
  }

  /**
   * Start a recurring interval that advances the spinner frame and repaints the bar in place. The interval is
   * `unref()`'d so it does not keep the Node event loop alive on its own.
   */
  private startSpinner(): void {
    if (this.spinnerInterval || !this.tty) return;
    this.spinnerInterval = setInterval(() => {
      this.spinnerFrame++;
      if (this.paused || !this.bar) return;
      this.eraseBar();
      this.paintBar();
    }, cliSpinners.dots.interval);
    this.spinnerInterval.unref?.();
  }

  /**
   * Cancel the spinner interval if running. Safe to call when no spinner is active.
   */
  private stopSpinner(): void {
    if (!this.spinnerInterval) return;
    clearInterval(this.spinnerInterval);
    this.spinnerInterval = undefined;
  }

  /**
   * Walk the cursor backwards over the rows the current bar occupies (plus the trailing-newline row) and clear them.
   * After this call the cursor is back at the column-0 row where the bar's first character was.
   */
  private eraseBar(): void {
    if (this.barLines === 0) return;
    this.out.write(ansiEscapes.eraseLines(this.barLines + 1));
    this.barLines = 0;
  }
}

/**
 * Count the number of terminal rows that `text` will occupy when written to a terminal of the given width, accounting
 * for line wrap and ANSI escape sequences (which take no visible columns).
 *
 * @param text - Pre-rendered bar text. May contain `\n` (explicit line breaks) and chalk-style ANSI colour codes.
 * @param columns - Current terminal width. Falls back to 80 if undefined or non-positive (e.g. during a terminal
 *                  resize race).
 * @returns Total number of rows occupied, with each `\n`-separated segment contributing at least 1 row plus extra rows
 *          for each wrap.
 */
function visualRowCount(text: string, columns: number | undefined): number {
  if (!text) return 0;
  const width = columns && columns > 0 ? columns : 80;
  return text.split("\n").reduce((sum, line) => {
    const visible = stripAnsi(line).length;
    return sum + Math.max(1, Math.ceil(visible / width));
  }, 0);
}
