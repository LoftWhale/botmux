import { MAX_RENDER_COLS, MAX_RENDER_ROWS } from './render-dimensions.js';

export const WEB_TERMINAL_RESIZE_MIN_INTERVAL_MS = 75;

export type WebTerminalResize = {
  cols: number;
  rows: number;
  acceptedAt: number;
};

export function resolveWebTerminalResize(input: {
  hasWrite: boolean;
  cols: unknown;
  rows: unknown;
  now: number;
  lastAcceptedAt: number | null;
}): WebTerminalResize | null {
  if (!input.hasWrite || !Number.isFinite(input.cols) || !Number.isFinite(input.rows)) return null;
  const cols = Math.floor(input.cols as number);
  const rows = Math.floor(input.rows as number);
  if (cols <= 0 || rows <= 0) return null;
  if (
    input.lastAcceptedAt !== null &&
    input.now - input.lastAcceptedAt < WEB_TERMINAL_RESIZE_MIN_INTERVAL_MS
  ) {
    return null;
  }
  // Cap only the UPPER bound (snapshot/PNG memory protection). Do NOT raise
  // small grids to MIN_RENDER_*: those minimums exist for screenshot canvases,
  // while a phone-width owner viewport legitimately fits fewer than 80 cols —
  // inflating it desyncs the PTY grid from the xterm grid and garbles TUIs.
  return {
    cols: Math.min(cols, MAX_RENDER_COLS),
    rows: Math.min(rows, MAX_RENDER_ROWS),
    acceptedAt: input.now,
  };
}
