// OpenCode-style screen writer.
//
// ink's output model is a full-width character grid: every cell is written as
// a real character (space padding included), so layout fills are selectable
// and copies drag in walls of whitespace. OpenCode/OpenTUI instead writes
// only content characters, paints layout regions by ERASING them with a
// background color (CSI K, erase-in-line: the terminal fills the cells with
// the active background but stores no characters), and moves the cursor
// across gaps without writing anything. Erased / never-written cells are not
// selectable and are excluded from copies, even on Windows Terminal.
//
// This module sits between ink and the real stdout: it parses ink's paint
// bytes into a cell grid, then re-emits every frame opencode-style.
//
// Layout cells are marked in the frame with a private-use sentinel
// (`SENT`) instead of spaces so the emitter can distinguish "layout fill"
// from real text spaces. The sentinel never reaches the terminal.

import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';

export const SENT = '\uE001';

interface Cell {
  ch: string;
  fg?: string;
  bg?: string;
  bold: boolean;
}

const PAINT = '\x1b[2J\x1b[3J\x1b[H';

/** CSI: \x1b[ params final */
const CSI = /^\x1b\[([0-9;?]*)([A-Za-z])/;
/** OSC: \x1b] payload \x07 (or ST) */
const OSC = /^\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)/;

function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}

export interface BlankOut {
  write(chunk: Buffer | string, cb?: () => void): boolean;
  end(): void;
  destroy(): void;
  columns: number;
  rows: number;
  isTTY: boolean;
}

/**
 * Wrap the stdout passed to ink's `render` with a writer that parses ink's
 * paint bytes and re-emits every frame without layout characters: cursor
 * positioning + styled content + color-erase fills instead of space padding.
 *
 * ink sends full repaints of the form `\x1b[2J\x1b[3J\x1b[H` + newline-
 * delimited styled rows; non-SGR control sequences (`\x1b[?25h`, OSC, ...)
 * terminate a paint. Frames are re-emitted at paint boundaries.
 */
export function createCleanStdout(out: {
  write(chunk: Buffer | string, cb?: () => void): boolean;
  columns?: number;
  rows?: number;
  isTTY?: boolean;
}): BlankOut {
  const cols = out.columns ?? 80;
  const rows = out.rows ?? 24;

  let grid: Cell[][] = [];
  let curRow = 0;
  let curCol = 0;
  let fg: string | undefined;
  let bg: string | undefined;
  let bold = false;
  let pending = '';
  let dirty = false;

  const newRow = (): Cell[] => {
    const row: Cell[] = [];
    for (let c = 0; c < cols; c++) row.push({ ch: '', bold: false });
    return row;
  };

  const resetGrid = (): void => {
    grid = [];
    for (let r = 0; r < rows; r++) grid.push(newRow());
    curRow = 0;
    curCol = 0;
    fg = undefined;
    bg = undefined;
    bold = false;
    dirty = false;
  };

  // ink can emit a paint through its log path (erase-lines, cursor moves)
  // without ever sending the `\x1b[2J…` clear before it; make sure the grid
  // exists before any content lands so a partial frame can't index a null row.
  const ensureGrid = (): void => {
    if (grid.length === 0) resetGrid();
  };

  const put = (ch: string): void => {
    if (curRow < 0 || curRow >= rows || curCol < 0 || curCol >= cols) return;
    dirty = true;
    const cell = grid[curRow][curCol];
    cell.ch = ch;
    cell.fg = fg;
    cell.bg = bg;
    cell.bold = bold;
  };

  const sgr = (params: string): void => {
    if (process.env.REDGREEN_SCREEN_DEBUG) {
      appendFileSync(process.env.REDGREEN_SCREEN_DEBUG, `sgr(${JSON.stringify(params)})\n`);
    }
    if (params === '' || params === '0') {
      fg = undefined;
      bg = undefined;
      bold = false;
      return;
    }
    const p = params.split(';');
    for (let i = 0; i < p.length; i++) {
      const v = p[i];
      if (v === '1') bold = true;
      else if (v === '22') bold = false;
      else if (v === '39') fg = undefined;
      else if (v === '49') bg = undefined;
      else if (v === '38' && p[i + 1] === '2') {
        fg = `#${[p[i + 2], p[i + 3], p[i + 4]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')}`;
        i += 4;
      } else if (v === '48' && p[i + 1] === '2') {
        bg = `#${[p[i + 2], p[i + 3], p[i + 4]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')}`;
        i += 4;
        dirty = true;
      }
    }
  };

  /** One row, opencode-style: cursor-home, color-erase layout fills, content. */
  const rowLine = (r: number): string => {
    const row = grid[r];
    const segs: Array<{ start: number; text: string; fg?: string; bg?: string; bold: boolean }> = [];
    const runs: Array<{ start: number; bg?: string }> = [];
    let cur: { start: number; text: string; fg?: string; bg?: string; bold: boolean } | null = null;
    for (let c = 0; c < cols; c++) {
      const cell = row[c];
      const empty = cell.ch === '' || cell.ch === SENT;
      if (!empty) {
        if (!cur) cur = { start: c, text: '', fg: cell.fg, bg: cell.bg, bold: cell.bold };
        cur.text += cell.ch;
        continue;
      }
      if (cur) {
        segs.push(cur);
        cur = null;
      }
      const prev = c > 0 ? row[c - 1] : null;
      const prevEmpty = prev !== null && (prev.ch === '' || prev.ch === SENT);
      if (c === 0 || !prevEmpty || prev!.bg !== cell.bg) {
        runs.push({ start: c, bg: cell.bg });
      }
    }
    if (cur) segs.push(cur);

    let s = `\x1b[${r + 1};1H`;
    for (const run of runs) {
      s += `\x1b[${r + 1};${run.start + 1}H`;
      if (run.bg) s += `\x1b[48;2;${rgb(run.bg)}m`;
      s += '\x1b[K';
    }
    for (const seg of segs) {
      const style: string[] = [];
      if (seg.bold) style.push('1');
      if (seg.fg) style.push(`38;2;${rgb(seg.fg)}`);
      if (seg.bg) style.push(`48;2;${rgb(seg.bg)}`);
      s += `\x1b[${r + 1};${seg.start + 1}H`;
      if (style.length > 0) s += `\x1b[${style.join(';')}m`;
      s += seg.text;
    }
    if (runs.length > 0 || segs.length > 0) s += '\x1b[0m';
    return s;
  };

  // Differential emission: only rows that changed since the last emitted
  // frame are re-written. ink sends `\x1b[2J\x1b[3J\x1b[H` before every
  // render; forwarding that clear each time is a full-screen flash per
  // keystroke, which is what makes browsing a list (theme picker, help)
  // flicker and lag. The first frame clears once; every later frame is
  // emitted as cursor-move + color-erase + content for its changed rows only,
  // so a one-row selection movement costs one row of output.
  let prevGrid: Cell[][] | null = null;

  const rowChanged = (r: number): boolean => {
    const a = grid[r];
    const b = prevGrid![r];
    for (let c = 0; c < cols; c++) {
      const ca = a[c];
      const cb = b[c];
      if (ca.ch !== cb.ch || ca.fg !== cb.fg || ca.bg !== cb.bg || ca.bold !== cb.bold) return true;
    }
    return false;
  };

  // Emit the current grid as a frame, but only if a paint actually landed in
  // it since the last reset (ink sends cursor-hide and other control
  // sequences before/around paints; those must not produce empty frames).
  const emitFrame = (): string | null => {
    if (!dirty) return null;
    const clear =
      prevGrid === null || prevGrid.length !== grid.length || prevGrid[0].length !== grid[0].length;
    const parts: string[] = [];
    if (clear) {
      for (let r = 0; r < rows; r++) parts.push(rowLine(r));
    } else {
      for (let r = 0; r < rows; r++) if (rowChanged(r)) parts.push(rowLine(r));
    }
    if (parts.length === 0) return null;
    const f = (clear ? PAINT : '') + parts.join('\n');
    out.write(f);
    prevGrid = grid;
    return f;
  };

  // Parse one chunk of ink's stream; a frame is emitted whenever a complete
  // paint has been consumed (at the next paint header or a terminator like
  // `\x1b[?25h` / OSC).
  const consume = (): void => {
    ensureGrid();
    while (pending.length > 0) {
      if (pending.startsWith(PAINT)) {
        emitFrame();
        pending = pending.slice(PAINT.length);
        resetGrid();
        continue;
      }
      if (pending.startsWith('\x1b')) {
        let m = CSI.exec(pending);
        if (m) {
          if (m[2] === 'm') {
            sgr(m[1]);
            pending = pending.slice(m[0].length);
            continue;
          }
          // Paint terminator (cursor show/hide, CUP, ...): close the frame
          // and forward the control sequence so terminal state stays right.
          emitFrame();
          pending = pending.slice(m[0].length);
          continue;
        }
        m = OSC.exec(pending);
        if (m) {
          emitFrame();
          pending = pending.slice(m[0].length);
          continue;
        }
        if (pending === '\x1b' || pending.startsWith('\x1b[') || pending.startsWith('\x1b]')) break;
        emitFrame();
        pending = pending.slice(1);
        continue;
      }
      const esc = pending.indexOf('\x1b');
      const text = esc < 0 ? pending : pending.slice(0, esc);
      let col = curCol;
      for (const ch of text) {
        if (ch === '\n') {
          curRow++;
          curCol = 0;
          col = 0;
        } else if (ch === '\r') {
          curCol = 0;
          col = 0;
        } else {
          put(ch);
          col++;
          curCol = col;
        }
      }
      pending = pending.slice(text.length);
    }
  };

  const transport: BlankOut = {
    columns: cols,
    rows,
    isTTY: out.isTTY ?? true,
    write(chunk: Buffer | string, _cb?: () => void): boolean {
      pending += chunk.toString('utf8');
      consume();
      // ink's full-screen path writes the frame as `clearTerminal + content`
      // with no trailing control sequence, so no terminator ever fires. Flush
      // whatever was parsed once the chunk has been fully consumed, otherwise
      // the frame stays cached until the next render and the UI lags one
      // keystroke behind (theme picker appears only after an arrow key, Enter
      // visibly moves one extra time).
      if (pending.length === 0) emitFrame();
      return true;
    },
    end(): void {
      consume();
      emitFrame();
    },
    destroy(): void {
      consume();
      emitFrame();
    },
  };
  // ink also treats stdout as an EventEmitter ('resize' etc.); reuse Node's
  // real EventEmitter machinery via prototype so `.on/.off/...` behave.
  Object.setPrototypeOf(transport, EventEmitter.prototype);
  return transport;
}