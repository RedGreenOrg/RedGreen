/**
 * Line-based windowing for the event timeline. Each event renders as a block
 * of N lines (failures expand the last event into several). Scrolling counts
 * lines, not events, so j/k slide the log one row at a time instead of
 * popping whole event blocks in and out.
 */

export interface BlockSlice {
  /** Index of the block (an event). */
  block: number;
  /** First visible line of that block (0-based within the block). */
  from: number;
  /** One past the last visible line of that block. */
  to: number;
}

export interface WindowResult {
  /** Total lines across all blocks. */
  total: number;
  /** Scroll offset, clamped to [0, max(0, total - maxRows)]. */
  scrolled: number;
  /** First visible line across the whole timeline (0-based). */
  top: number;
  /** One past the last visible line (<= total). */
  bottom: number;
  /** Every block that intersects the window, with its clipped line range. */
  slices: BlockSlice[];
  /** Empty rows left to fill at the bottom when content is shorter. */
  slack: number;
}

export function windowBlocks(
  blockLines: readonly number[],
  scroll: number,
  maxRows: number,
): WindowResult {
  const starts: number[] = [0];
  for (let i = 0; i < blockLines.length; i++) starts.push(starts[i] + blockLines[i]);
  const total = starts[starts.length - 1];
  const scrolled = Math.max(0, Math.min(scroll, Math.max(0, total - maxRows)));
  const bottom = total - scrolled;
  const top = Math.max(0, bottom - maxRows);
  const slices: BlockSlice[] = [];
  for (let i = 0; i < blockLines.length; i++) {
    const s = starts[i];
    const e = starts[i + 1];
    if (e <= top) continue;
    if (s >= bottom) break;
    slices.push({ block: i, from: Math.max(0, top - s), to: Math.min(blockLines[i], bottom - s) });
  }
  const slack = Math.max(0, maxRows - (bottom - top));
  return { total, scrolled, top, bottom, slices, slack };
}