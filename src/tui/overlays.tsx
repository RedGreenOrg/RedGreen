import React, { useMemo, useState } from 'react';
import fs from 'node:fs';
import { Text, useInput } from 'ink';
import { THEME_NAMES, type ThemeName } from '../config/config.js';
import { PHASES, type PhaseId } from '../phase/state.js';
import type { HintTier, Hints, RefactorSuggestions } from '../prompts/prompts.js';
import type { Theme } from './theme.js';
import { SENT } from './screen.js';


export interface TutorialStep {
  /** One-line what-is-happening headline, shown in the header banner. */
  what: string;
  /** Why this phase matters (shown in the phase guide overlay). */
  why: string;
  /** What the user is supposed to do right now (guide overlay). */
  do: string;
  /** Relevant keys while in this phase (guide overlay). */
  keys: string;
}

export interface TutorialConfig {
  /** Per-phase guidance shown in the header banner and the phase guide overlay. */
  steps: Record<PhaseId, TutorialStep>;
}

// n layout cells (sentinel fill).
function pad(n: number): string {
  return SENT.repeat(Math.max(0, n));
}

// A single trailing layout cell that also keeps the row from being trimmed.
function Block({ color }: { color: string | undefined }): React.ReactElement {
  return <Text color={color}>{SENT}</Text>;
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s;
}

const HELP_LINES: Array<[string, string]> = [
  ['enter / space', 'approve current prompt'],
  ['i', 'open command input'],
  ['n', 'new feature (when finished)'],
  ['h', 'hints (small / medium / big)'],
  ['S', 'reference solution (after green)'],
  ['v', 'view tests (RED review) / refactor suggestions'],
  ['a', 'auto-apply refactor (test-verified)'],
  ['x', 'expand / collapse latest test run'],
  ['t', 'switch theme'],
  ['j / k', 'scroll timeline'],
  ['G', 'jump to bottom'],
  ['s', 'skip current wait'],
  ['r', 'retry failed AI step (when paused)'],
  ['q', 'quit'],
  ['?', 'close this help'],
];

const COMMANDS = ['/help', '/quit', '/skip', '/approve', '/retry', '/expand', '/themes', '/hints', '/solution', '/refactor', '/apply', '/new'];

export function PhaseGuideOverlay({
  step,
  label,
  idx,
  theme,
  maxCols,
  onClose,
}: {
  step: TutorialStep;
  label: string;
  idx: number;
  theme: Theme;
  maxCols: number;
  onClose: () => void;
}): React.ReactElement {
  useInput((input) => {
    if (input === '\r' || input === ' ' || input === '\u001b' || input === 'q' || input === 'g') onClose();
  });
  const fill = theme.backgroundElement;
  const title = `TUTORIAL · STEP ${idx}/${PHASES.length} · ${label.toUpperCase()}`;
  const rows: Array<[string, string]> = [
    ['WHAT', step.what],
    ['WHY', step.why],
    ['YOU', step.do],
    ['KEYS', step.keys],
  ];
  const dismiss = 'press enter / space / esc to continue';
  // The modal must always fit the terminal (ink wraps by default, which makes
  // a too-wide overlay wrap mid-word on narrow windows). Cap the box width
  // and truncate every line to it so it renders as single lines everywhere.
  const MAX = Math.max(28, maxCols - 6);
  const cw = Math.min(
    MAX,
    Math.max(
      0,
      2 + title.length,
      ...rows.map(([k, v]) => 2 + k.length + 1 + v.length),
      2 + dismiss.length,
    ),
  ) + 1;
  const tail = (contentLen: number): React.ReactElement => (
    <>
      {pad(cw - contentLen - 1)}
      <Block color={fill} />
    </>
  );
  return (
    <Text backgroundColor={fill}>
      {tail(0)}
      {'\n'}
      <Text bold color={theme.info}>
        {pad(2)}
        {truncate(title, cw - 4)}
      </Text>
      {tail(2 + truncate(title, cw - 4).length)}
      {'\n'}
      {rows.map(([k, v], i) => {
        const vlen = truncate(v, cw - 2 - k.length - 1 - 2);
        return (
          <React.Fragment key={i}>
            <Text bold color={theme.primary}>{pad(2)}{k}</Text>
            <Text color={theme.text}>{' '}{vlen}</Text>
            {tail(2 + k.length + 1 + vlen.length)}
            {i === rows.length - 1 ? '' : '\n'}
          </React.Fragment>
        );
      })}
      {'\n'}
      <Text color={theme.textMuted}>{pad(2)}{truncate(dismiss, cw - 4)}</Text>
      {tail(2 + truncate(dismiss, cw - 4).length)}
      {'\n'}
    </Text>
  );
}
export function HelpOverlay({ onClose, theme }: { onClose: () => void; theme: Theme }): React.ReactElement {
  useInput((input) => {
    if (input === '?' || input === '\u001b' || input === '\r') onClose();
  });
  const fill = theme.backgroundElement;
  const commandsLine = `commands: ${COMMANDS.join(' ')}`;
  const contentLens = [
    0,
    2 + 19,
    ...HELP_LINES.map(([k, d]) => 2 + k.length + d.length),
    2 + commandsLine.length,
  ];
  const cw = Math.max(...contentLens) + 1;
  const tail = (contentLen: number): React.ReactElement => (
    <>
      {pad(cw - contentLen - 1)}
      <Block color={fill} />
    </>
  );
  return (
    <Text backgroundColor={fill}>
      {tail(0)}
      {'\n'}
      <Text bold color={theme.primary}>
        {pad(2)}
        redgreen dev - keys
      </Text>
      {tail(2 + 19)}
      {'\n'}
      {HELP_LINES.map(([k, d]) => (
        <Text key={k}>
          {pad(2)}
          <Text color={theme.warning}>{k}</Text>
          {pad(cw - 2 - k.length - d.length)}
          <Text color={theme.textMuted}>{d}</Text>
          {'\n'}
        </Text>
      ))}
      <Text color={theme.textMuted}>
        {pad(2)}
        {commandsLine}
      </Text>
      {tail(2 + commandsLine.length)}
      {'\n'}
      {tail(0)}
    </Text>
  );
}

export function ThemesOverlay({
  sel,
  setSel,
  themeName,
  theme,
  onSelect,
  onClose,
  maxRows,
  maxCols,
}: {
  sel: number;
  setSel: React.Dispatch<React.SetStateAction<number>>;
  themeName: ThemeName;
  theme: Theme;
  onSelect: (name: ThemeName) => void;
  onClose: () => void;
  maxRows: number;
  maxCols: number;
}): React.ReactElement {
  useInput((input, key) => {
    if (key.escape) return onClose();
    if (input === '\r' || input === ' ') {
      onSelect(THEME_NAMES[sel]);
      return onClose();
    }
    if (input === 'j' || key.downArrow) setSel((v) => Math.min(THEME_NAMES.length - 1, v + 1));
    if (input === 'k' || key.upArrow) setSel((v) => Math.max(0, v - 1));
  });
  const count = THEME_NAMES.length;
  const viewHeight = Math.min(count, Math.max(2, maxRows - 10));
  const viewStart = Math.max(0, Math.min(sel - Math.floor(viewHeight / 2), count - viewHeight));
  const visible = THEME_NAMES.slice(viewStart, viewStart + viewHeight);
  const scrollable = count > viewHeight;
  const hintLine = `enter apply · esc close${scrollable ? ` · ${sel + 1}/${count}` : ''}`;
  const fill = theme.backgroundElement;
  // Panel width: fits "> name *" plus the hint line, clamped to the terminal.
  const cw = Math.min(
    Math.max(8, ...THEME_NAMES.map((n) => 4 + n.length + 2), 2 + hintLine.length) + 1,
    maxCols - 2,
  );
  const tail = (contentLen: number): React.ReactElement => (
    <>
      {pad(cw - contentLen - 1)}
      <Block color={fill} />
    </>
  );
  return (
    <Text backgroundColor={fill}>
      {tail(0)}
      {'\n'}
      <Text bold color={theme.primary}>
        {pad(2)}themes
      </Text>
      {tail(8)}
      {'\n'}
      {visible.map((name, i) => {
        const index = viewStart + i;
        const current = name === themeName;
        return (
          <Text key={name}>
            {pad(2)}
            <Text bold color={index === sel ? theme.primary : theme.textMuted}>
              {index === sel ? '›' : ' '} {name}
            </Text>
            {current ? <Text color={theme.success}>*</Text> : null}
            {tail(4 + name.length + (current ? 1 : 0))}
            {'\n'}
          </Text>
        );
      })}
      <Text color={theme.textMuted}>
        {pad(2)}
        {hintLine}
      </Text>
      {tail(2 + hintLine.length)}
      {'\n'}
      {tail(0)}
    </Text>
  );
}

const HINT_TIER_LABELS: HintTier[] = ['small', 'medium', 'big'];

const HINT_LOCK_MSG: Record<HintTier, string> = {
  small: 'no hint available',
  medium: 'locked · make 1 more failing edit',
  big: 'locked · make 2 failing edits (last resort)',
};

function wrapHint(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    if (raw.length <= width) {
      out.push(raw);
      continue;
    }
    const words = raw.split(/\s+/).filter(Boolean);
    let cur = '';
    for (const wd of words) {
      if (cur === '') cur = wd;
      else if ((cur + ' ' + wd).length <= width) cur += ' ' + wd;
      else {
        out.push(cur);
        cur = wd;
      }
    }
    if (cur) out.push(cur);
  }
  return out.length > 0 ? out : [''];
}

// Overlays (hints / solution) hold prose and code, so they need a wide panel:
// a fraction of the terminal width, with a floor for readability and capped so
// they never spill past the right edge.
function overlayWidth(maxCols: number, ratio: number, minWidth: number): number {
  return Math.min(Math.max(minWidth, Math.floor(maxCols * ratio)), maxCols - 2);
}
export function HintsOverlay({
  sel,
  setSel,
  hints,
  unlocks,
  onClose,
  theme,
  maxCols,
  maxRows,
}: {
  sel: number;
  setSel: React.Dispatch<React.SetStateAction<number>>;
  hints: Hints;
  unlocks: Record<HintTier, boolean>;
  onClose: () => void;
  theme: Theme;
  maxCols: number;
  maxRows: number;
}): React.ReactElement {
  const [bodyScroll, setBodyScroll] = useState(0);
  useInput((input, key) => {
    if (key.escape || input === 'q' || input === 'h') return onClose();
    if (input === 'j' || key.downArrow) {
      setSel((v) => Math.min(HINT_TIER_LABELS.length - 1, v + 1));
      setBodyScroll(0);
    }
    if (input === 'k' || key.upArrow) {
      setSel((v) => Math.max(0, v - 1));
      setBodyScroll(0);
    }
    if (input === 'G') setBodyScroll((v) => v + 8);
    if (input === 'g') setBodyScroll(0);
  });

  const tier = HINT_TIER_LABELS[sel];
  const fill = theme.backgroundElement;
  const bodyText = unlocks[tier] ? hints[tier] : HINT_LOCK_MSG[tier];

  const cw = overlayWidth(maxCols, 0.8, 44);
  const bodyW = cw - 3;
  const bodyLines = wrapHint(bodyText, bodyW);
  const bodyViewport = Math.max(2, maxRows - 8);
  const maxScroll = Math.max(0, bodyLines.length - bodyViewport);
  const scrolled = Math.min(bodyScroll, maxScroll);
  const shown = bodyLines.slice(scrolled, scrolled + bodyViewport);
  const footer = `j/k tier · G/g scroll${maxScroll > 0 ? ` · ${scrolled + 1}/${bodyLines.length}` : ''} · esc close`;

  const tail = (contentLen: number): React.ReactElement => (
    <>
      {pad(cw - contentLen - 1)}
      <Block color={fill} />
    </>
  );

  return (
    <Text backgroundColor={fill}>
      {tail(0)}
      {'\n'}
      <Text bold color={theme.primary}>
        {pad(2)}hints
      </Text>
      {tail(7)}
      {'\n'}
      {HINT_TIER_LABELS.map((t, i) => {
        const unlocked = unlocks[t];
        const marker = i === sel ? '›' : ' ';
        return (
          <Text key={t}>
            {pad(2)}
            <Text bold color={i === sel ? theme.primary : theme.textMuted}>
              {marker} {t}
            </Text>
            <Text color={unlocked ? theme.textMuted : theme.warning}>
              {unlocked ? '' : ' · locked'}
            </Text>
            {tail(4 + t.length + (unlocked ? 0 : 8))}
            {'\n'}
          </Text>
        );
      })}
      <Text color={theme.textMuted}>
        {pad(2)}
        {'─'.repeat(Math.max(0, cw - 2))}
      </Text>
      {'\n'}
      {shown.map((line, i) => (
        <Text key={i}>
          {pad(2)}
          <Text color={unlocks[tier] ? theme.text : theme.warning}>{line}</Text>
          {tail(2 + line.length)}
          {'\n'}
        </Text>
      ))}
      <Text color={theme.textMuted}>
        {pad(2)}
        {footer}
      </Text>
      {tail(2 + footer.length)}
      {'\n'}
      {tail(0)}
    </Text>
  );
}
export function SolutionOverlay({
  explanation,
  solution,
  solutionError,
  onClose,
  theme,
  maxCols,
  maxRows,
}: {
  explanation: string | null;
  solution: string | null;
  solutionError?: string | null;
  onClose: () => void;
  theme: Theme;
  maxCols: number;
  maxRows: number;
}): React.ReactElement {
  const [scroll, setScroll] = useState(0);
  useInput((input, key) => {
    if (key.escape || input === 'q' || input === 'S') return onClose();
    if (input === 'j' || key.downArrow) setScroll((v) => v + 1);
    if (input === 'k' || key.upArrow) setScroll((v) => Math.max(0, v - 1));
    if (input === 'G') setScroll((v) => v + 8);
    if (input === 'g') setScroll(0);
  });

  const fill = theme.backgroundElement;
  const cw = overlayWidth(maxCols, 0.9, 56);
  const bodyW = cw - 3;
  const allLines: Array<{ text: string; color: string | undefined }> = solution
    ? [
        ...wrapHint(explanation ?? '', bodyW).map((t) => ({ text: t, color: theme.warning })),
        { text: '', color: theme.text },
        ...wrapHint(solution, bodyW).map((t) => ({ text: t, color: theme.text })),
      ]
    : solutionError
      ? wrapHint(`Generation failed: ${solutionError}`, bodyW).map((t) => ({
          text: t,
          color: theme.error,
        }))
      : [{ text: 'Generating reference solution…', color: theme.warning }];

  const bodyViewport = Math.max(2, maxRows - 6);
  const maxScroll = Math.max(0, allLines.length - bodyViewport);
  const scrolled = Math.min(scroll, maxScroll);
  const shown = allLines.slice(scrolled, scrolled + bodyViewport);
  const footer = `j/k scroll${maxScroll > 0 ? ` · ${scrolled + 1}/${allLines.length}` : ''} · esc close${
    !solution && solutionError ? ' · S retries' : ''
  }`;

  const tail = (contentLen: number): React.ReactElement => (
    <>
      {pad(cw - contentLen - 1)}
      <Block color={fill} />
    </>
  );

  return (
    <Text backgroundColor={fill}>
      {tail(0)}
      {'\n'}
      <Text bold color={theme.primary}>
        {pad(2)}reference solution
      </Text>
      {tail(2 + 18)}
      {'\n'}
      <Text color={theme.textMuted}>
        {pad(2)}
        {'─'.repeat(Math.max(0, cw - 2))}
      </Text>
      {'\n'}
      {shown.map((line, i) => (
        <Text key={i}>
          {pad(2)}
          <Text color={line.color}>{line.text}</Text>
          {tail(2 + line.text.length)}
          {'\n'}
        </Text>
      ))}
      <Text color={theme.textMuted}>
        {pad(2)}
        {footer}
      </Text>
      {tail(2 + footer.length)}
      {'\n'}
      {tail(0)}
    </Text>
  );
}
export function TestReviewOverlay({
  testsPath,
  onClose,
  theme,
  maxCols,
  maxRows,
}: {
  testsPath: string | null;
  onClose: () => void;
  theme: Theme;
  maxCols: number;
  maxRows: number;
}): React.ReactElement {
  const [scroll, setScroll] = useState(0);
  useInput((input, key) => {
    if (key.escape || input === 'q' || input === 'v') return onClose();
    if (input === 'j' || key.downArrow) setScroll((v) => v + 1);
    if (input === 'k' || key.upArrow) setScroll((v) => Math.max(0, v - 1));
    if (input === 'G') setScroll((v) => v + 8);
    if (input === 'g') setScroll(0);
  });

  const content = useMemo(() => {
    if (!testsPath) return 'No test file yet.';
    try {
      return fs.readFileSync(testsPath, 'utf8');
    } catch {
      return `Could not read ${testsPath}`;
    }
  }, [testsPath]);

  const fill = theme.backgroundElement;
  const cw = overlayWidth(maxCols, 0.9, 56);
  const bodyW = cw - 3;
  const lines = wrapHint(content, bodyW);

  const bodyViewport = Math.max(2, maxRows - 6);
  const maxScroll = Math.max(0, lines.length - bodyViewport);
  const scrolled = Math.min(scroll, maxScroll);
  const shown = lines.slice(scrolled, scrolled + bodyViewport);
  const name = testsPath ? testsPath.split(/[\\/]/).pop() ?? testsPath : '';
  const footer = `${name} · j/k scroll${maxScroll > 0 ? ` · ${scrolled + 1}/${lines.length}` : ''} · esc close`;

  const tail = (contentLen: number): React.ReactElement => (
    <>
      {pad(cw - contentLen - 1)}
      <Block color={fill} />
    </>
  );

  return (
    <Text backgroundColor={fill}>
      {tail(0)}
      {'\n'}
      <Text bold color={theme.primary}>
        {pad(2)}
        RED tests - your intent
      </Text>
      {tail(2 + 21)}
      {'\n'}
      <Text color={theme.textMuted}>
        {pad(2)}
        {'─'.repeat(Math.max(0, cw - 2))}
      </Text>
      {'\n'}
      {shown.map((line, i) => (
        <Text key={i}>
          {pad(2)}
          <Text color={theme.text}>{line}</Text>
          {tail(2 + line.length)}
          {'\n'}
        </Text>
      ))}
      <Text color={theme.textMuted}>
        {pad(2)}
        {footer}
      </Text>
      {tail(2 + footer.length)}
      {'\n'}
      {tail(0)}
    </Text>
  );
}
export function RefactorOverlay({
  data,
  onClose,
  onApply,
  onReject,
  theme,
  maxCols,
  maxRows,
}: {
  data: RefactorSuggestions;
  onClose: () => void;
  onApply: () => void;
  onReject: () => void;
  theme: Theme;
  maxCols: number;
  maxRows: number;
}): React.ReactElement {
  const [scroll, setScroll] = useState(0);
  useInput((input, key) => {
    if (key.escape || input === 'q' || input === 'v') return onClose();
    if (input === 'a') {
      onApply();
      return onClose();
    }
    if (input === 'r') {
      onReject();
      return onClose();
    }
    if (input === 'j' || key.downArrow) setScroll((v) => v + 1);
    if (input === 'k' || key.upArrow) setScroll((v) => Math.max(0, v - 1));
    if (input === 'G') setScroll((v) => v + 8);
    if (input === 'g') setScroll(0);
  });

  const fill = theme.backgroundElement;
  const cw = overlayWidth(maxCols, 0.9, 56);
  const bodyW = cw - 3;
  const lines: Array<{ text: string; color: string | undefined }> = [];
  for (const raw of wrapHint(data.note, bodyW)) {
    lines.push({ text: raw, color: theme.warning });
  }
  lines.push({ text: '', color: theme.text });
  for (const s of data.suggestions) {
    lines.push({ text: `▸ ${s.title}`, color: theme.primary });
    lines.push({
      text: `  [${s.category}] ${s.what}`,
      color: theme.text,
    });
    for (const raw of wrapHint(`  why: ${s.why}`, bodyW)) {
      lines.push({ text: raw, color: theme.textMuted });
    }
    lines.push({ text: '', color: theme.text });
  }
  lines.push({ text: 'press a to auto-apply the next suggestion (suite-verified first) · esc close', color: theme.warning });

  const bodyViewport = Math.max(2, maxRows - 6);
  const maxScroll = Math.max(0, lines.length - bodyViewport);
  const scrolled = Math.min(scroll, maxScroll);
  const shown = lines.slice(scrolled, scrolled + bodyViewport);
  const footer = `j/k scroll${maxScroll > 0 ? ` · ${scrolled + 1}/${lines.length}` : ''} · esc close`;

  const tail = (contentLen: number): React.ReactElement => (
    <>
      {pad(cw - contentLen - 1)}
      <Block color={fill} />
    </>
  );

  return (
    <Text backgroundColor={fill}>
      {tail(0)}
      {'\n'}
      <Text bold color={theme.primary}>
        {pad(2)}
        refactor suggestions
      </Text>
      {tail(2 + 19)}
      {'\n'}
      <Text color={theme.textMuted}>
        {pad(2)}
        {'─'.repeat(Math.max(0, cw - 2))}
      </Text>
      {'\n'}
      {shown.map((line, i) => (
        <Text key={i}>
          {pad(2)}
          <Text color={line.color}>{line.text}</Text>
          {tail(2 + line.text.length)}
          {'\n'}
        </Text>
      ))}
      <Text color={theme.textMuted}>
        {pad(2)}
        {footer}
      </Text>
      {tail(2 + footer.length)}
      {'\n'}
      {tail(0)}
    </Text>
  );
}

export { pad, Block, truncate };
