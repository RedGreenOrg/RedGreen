import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { render } from 'ink';
import { DevSession, type SessionEvent } from '../core/session.js';
import type { SessionSnapshot } from '../core/session.js';
import type { ChatFn } from '../llm/client.js';
import { PHASES, type PhaseId, type PhaseStatus } from '../phase/state.js';
import type { TestRunner } from '../runners/types.js';
import { THEME_NAMES, updateTheme, type ThemeName } from '../config/config.js';
import { THEMES, installSystemTheme, resolveThemeName, type Theme } from './theme.js';
import { SENT, createCleanStdout } from './screen.js';

export interface PhaseTuiProps {
  feature: string;
  runner: TestRunner;
  chat: ChatFn;
  cwd?: string;
  provider?: string;
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatResult(ev: SessionEvent & { type: 'result' }): {
  verdict: 'green' | 'red' | 'none';
  label: string;
  detail: string;
} {
  const r = ev.result;
  const verdict = r.total === 0 ? 'none' : r.failed === 0 ? 'green' : 'red';
  const label = verdict === 'green' ? 'ok' : verdict === 'red' ? 'x' : '?';
  const detail =
    verdict === 'green'
      ? `${ev.label} - all ${r.total} pass · ${r.durationMs}ms`
      : verdict === 'red'
        ? `${ev.label} - ${r.failed} failed, ${r.passed} passed · ${r.durationMs}ms`
        : `${ev.label} - no tests`;
  return { verdict, label, detail };
}

function StatusPill({ statuses, theme }: { statuses: Record<PhaseId, PhaseStatus>; theme: Theme }): React.ReactElement {
  const active = PHASES.find((p) => statuses[p.id] === 'active');
  const current = active ?? [...PHASES].reverse().find((p) => statuses[p.id] !== 'pending') ?? PHASES[0];
  const st = statuses[current.id];
  const marker = st === 'active' ? '>' : st === 'done' ? 'ok' : st === 'error' ? '!' : ' ';
  const color =
    st === 'active' ? theme.primary : st === 'done' ? theme.success : st === 'error' ? theme.error : theme.textMuted;
  return (
    <Text bold color={color}>
      [{marker} {current.label.toUpperCase()}]
    </Text>
  );
}

// Visible length of the rendered pill (ASCII), for manual line padding.
function pillLen(statuses: Record<PhaseId, PhaseStatus>): number {
  const active = PHASES.find((p) => statuses[p.id] === 'active');
  const current = active ?? [...PHASES].reverse().find((p) => statuses[p.id] !== 'pending') ?? PHASES[0];
  return current.label.length + 4 + (statuses[current.id] === 'done' ? 1 : 0);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s;
}

// One full-width filled line. `base` fills the row like the app background so
// no terminal pixels show through; without it (system theme) the row is plain.
function EventLine({
  ev,
  isLast,
  expanded,
  theme,
  w,
}: {
  ev: SessionEvent;
  isLast: boolean;
  expanded: boolean;
  theme: Theme;
  w: number;
}): React.ReactElement {
  const base = theme.background;
  // `last` suppresses the trailing '\n'; a lone single-line event line that
  // ends with '\n' leaves a dangling unstyled empty row (bright terminal
  // background peeks through). Events stack as separate Text nodes, so a
  // trailing newline is only needed BETWEEN lines inside one Text.
  // `offset` is the content's column; everything else on the row is painted
  // with base-colored spaces so no glyph shapes are selectable. The last cell
  // is a base-colored block that prevents ink's trailing-trim from shrinking
  // the row.
  const tail = (offset: number, contentLen: number, last = false): React.ReactNode => (
    <>
      {base ? (
        <>
          {pad(w - offset - contentLen - 1)}
          <Block color={base} />
        </>
      ) : null}
      {last ? null : '\n'}
    </>
  );
  switch (ev.type) {
    case 'write':
      return (
        <Text backgroundColor={base}>
          {base ? pad(5) : null}
          <Text bold color={theme.success}>
            [+]
          </Text>
          <Text color={theme.textMuted}> {ev.message}</Text>
          {tail(5, 3 + 1 + ev.message.length, true)}
        </Text>
      );
    case 'info':
      return (
        <Text backgroundColor={base}>
          {base ? pad(5) : null}
          <Text bold color={theme.textMuted}>
            [i]
          </Text>
          <Text color={theme.textMuted}> {ev.message}</Text>
          {tail(5, 3 + 1 + ev.message.length, true)}
        </Text>
      );
    case 'telemetry':
      return (
        <Text backgroundColor={base}>
          {base ? pad(5) : null}
          <Text bold color={theme.info}>
            [^]
          </Text>
          <Text color={theme.info}> {ev.message}</Text>
          {tail(5, 3 + 1 + ev.message.length, true)}
        </Text>
      );
    case 'attack': {
      const msg = ` attack round ${ev.round}/${ev.total} - ${ev.survived ? 'survived' : 'failed'}`;
      return (
        <Text backgroundColor={base}>
          {base ? pad(5) : null}
          <Text bold color={ev.survived ? theme.success : theme.error}>
            [{ev.survived ? 'ok' : 'x'}]
          </Text>
          <Text color={ev.survived ? theme.success : theme.error}>{msg}</Text>
          {tail(5, (ev.survived ? 4 : 3) + msg.length, true)}
        </Text>
      );
    }
    case 'result': {
      const { verdict, label, detail } = formatResult(ev);
      const color = verdict === 'green' ? theme.success : verdict === 'red' ? theme.error : theme.textMuted;
      const expandedAny = expanded && isLast && ev.result.failures.length > 0;
      const failures = ev.result.failures.slice(0, 4);
      return (
        <Text backgroundColor={base}>
          {base ? pad(5) : null}
          <Text bold color={color}>
            [{label}{expandedAny ? '-' : ''}]
          </Text>
          <Text color={color}>
            {' '}
            {detail}
          </Text>
          {tail(5, 3 + (expandedAny ? 1 : 0) + 1 + detail.length, failures.length === 0 || !expandedAny)}
          {expandedAny &&
            failures.map((f, i) => {
              const lastF = i === failures.length - 1;
              const msg = f.message ? f.message.split('\n')[0] : '';
              return (
                <Text key={f.title + f.file}>
                  {base ? pad(9) : null}
                  <Text color={theme.error}>
                    [x] {truncate(f.title, w - 16)}
                  </Text>
                  {tail(9, 4 + truncate(f.title, w - 16).length, lastF && msg.length === 0)}
                  {msg.length > 0 && (
                    <>
                      {base ? pad(13) : null}
                      <Text color={theme.warning}>{truncate(msg, w - 16)}</Text>
                      {tail(13, truncate(msg, w - 16).length, lastF)}
                    </>
                  )}
                </Text>
              );
            })}
        </Text>
      );
    }
    default:
      return <React.Fragment />;
  }
}

const HELP_LINES: Array<[string, string]> = [
  ['enter / space', 'approve current prompt'],
  ['i', 'open command input'],
  ['x', 'expand / collapse latest test run'],
  ['t', 'switch theme'],
  ['j / k', 'scroll timeline'],
  ['G', 'jump to bottom'],
  ['s', 'skip current wait'],
  ['q', 'quit'],
  ['?', 'close this help'],
];

const COMMANDS = ['/help', '/quit', '/skip', '/approve', '/expand', '/themes'];

// Layout cells are marked with a private-use sentinel (SENT) instead of
// spaces: the clean stdout writer (screen.ts) recognizes sentinel runs as
// pure layout and re-emits them as color-erases (CSI K) and cursor moves,
// so nothing in the margins or padding is selectable or copied. Content
// strings keep their real space characters. M = margin cells each side of a
// panel; P = inner padding before content; T = tail filling the right edge.
const M = 2;
const P = 3;
const T = 2;

// n layout cells (sentinel fill).
function pad(n: number): string {
  return SENT.repeat(Math.max(0, n));
}

// A single trailing layout cell that also keeps the row from being trimmed.
function Block({ color }: { color: string | undefined }): React.ReactElement {
  return <Text color={color}>{SENT}</Text>;
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
  themeName,
  theme,
  onSelect,
  onClose,
}: {
  themeName: ThemeName;
  theme: Theme;
  onSelect: (name: ThemeName) => void;
  onClose: () => void;
}): React.ReactElement {
  const [sel, setSel] = useState<number>(() => Math.max(0, THEME_NAMES.indexOf(themeName)));
  useInput((input, key) => {
    if (key.escape) return onClose();
    if (input === '\r') {
      onSelect(THEME_NAMES[sel]);
      return onClose();
    }
    if (input === 'j' || key.downArrow) setSel((v) => Math.min(THEME_NAMES.length - 1, v + 1));
    if (input === 'k' || key.upArrow) setSel((v) => Math.max(0, v - 1));
  });
  const fill = theme.backgroundElement;
  const hintLine = 'enter apply · esc close';
  const cw = Math.max(2 + 6, ...THEME_NAMES.map((n) => 2 + 2 + n.length + 2), 2 + hintLine.length) + 1;
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
        themes
      </Text>
      {tail(2 + 6)}
      {'\n'}
      {THEME_NAMES.map((name, i) => {
        const current = name === themeName;
        return (
          <Text key={name}>
            {pad(2)}
            <Text bold color={i === sel ? theme.primary : theme.textMuted}>
              {i === sel ? '>' : ' '} {name}
            </Text>
            {current ? <Text color={theme.success}> *</Text> : null}
            {tail(2 + 2 + name.length + (current ? 2 : 0))}
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

export function PhaseTui({ feature, runner, chat, cwd, provider }: PhaseTuiProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const [themeName, setThemeName] = useState<ThemeName>(() => resolveThemeName());
  const theme = THEMES[themeName];
  const sessionRef = useRef<DevSession | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = new DevSession({ feature, runner, chat, cwd });
  }
  const startedAtRef = useRef(Date.now());
  const [snap, setSnap] = useState<SessionSnapshot>(() => sessionRef.current!.snapshot());
  const [scroll, setScroll] = useState(0);
  const [expanded, setExpanded] = useState(true);
  const [inputMode, setInputMode] = useState(false);
  const [typed, setTyped] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [showThemes, setShowThemes] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [clock, setClock] = useState(() => new Date().toTimeString().slice(0, 8));
  const statusTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!sessionRef.current) return;
    const s = sessionRef.current;
    const onUpdate = (sn: SessionSnapshot) => {
      setSnap(sn);
      setScroll(0);
    };
    const onFinish = () => exit();
    s.on('update', onUpdate);
    s.on('finish', onFinish);
    void s.start();
    const timer = setInterval(() => {
      setElapsed(Date.now() - startedAtRef.current);
      setClock(new Date().toTimeString().slice(0, 8));
    }, 1000);
    return () => {
      s.removeAllListeners('update');
      s.removeAllListeners('finish');
      clearInterval(timer);
      if (statusTimer.current) clearTimeout(statusTimer.current);
      s.dispose();
    };
  }, [exit]);

  useInput(
    (input, key) => {
      const s = sessionRef.current;
      if (!s) return;
      if (showHelp || showThemes) return;
      if (inputMode) {
        if (key.escape) {
          setInputMode(false);
          setTyped('');
        } else if (key.return) {
          const cmd = typed.trim().toLowerCase();
          setTyped('');
          setInputMode(false);
          if (!cmd) return;
          if (cmd === '/quit') return s.quit();
          if (cmd === '/skip') return s.skip();
          if (cmd === '/approve') return s.approve();
          if (cmd === '/expand') {
            setExpanded((v) => !v);
            return;
          }
          if (cmd === '/help') {
            setShowHelp(true);
            return;
          }
          if (cmd === '/themes') {
            setShowThemes(true);
            return;
          }
          setStatusMsg(`unknown command: ${typed.trim()}`);
          if (statusTimer.current) clearTimeout(statusTimer.current);
          statusTimer.current = setTimeout(() => setStatusMsg(null), 2500);
        } else if (input === '\x7f' || key.backspace) {
          setTyped((t) => t.slice(0, -1));
        } else if (input.length === 1) {
          setTyped((t) => t + input);
        }
        return;
      }

      if (input === 'q') return s.quit();
      if (input === '\r' || input === ' ') return s.approve();
      if (input === 's') return s.skip();
      if (input === 'i') {
        setInputMode(true);
        return;
      }
      if (input === '?') {
        setShowHelp(true);
        return;
      }
      if (input === 't') {
        setShowThemes(true);
        return;
      }
      if (input === 'x' || input === 'X') {
        setExpanded((v) => !v);
        return;
      }
      if (input === 'G') {
        setScroll(0);
        return;
      }
      if (input === 'j' || key.downArrow) {
        setScroll((v) => v + 1);
        return;
      }
      if (input === 'k' || key.upArrow) {
        setScroll((v) => Math.max(0, v - 1));
        return;
      }
    },
    { isActive: !snap.finished || inputMode },
  );

  const { statuses, result, events, prompt, moduleName } = snap;
  const running = Object.values(statuses).includes('active');
  // Fixed chrome: top margin (1) + header (4: pad+title+feature+pad) +
  // header gap (1) + statusMsg row (1) + footer gap (1) + footer (4:
  // pad+keys/input+status+pad) + bottom status row (1) + bottom gap (1) = 14
  // rows reserve.
  // The prompt block (gap + 3-row bar) and any status message share the
  // timeline box's rows.
  const timelineHeight = Math.max(4, rows - 14);
  const cols = stdout?.columns ?? 80;
  const w = Math.max(40, cols);
  const panel = theme.backgroundPanel;
  const element = theme.backgroundElement;
  const base = theme.background;
  const maxEventsRows = timelineHeight - (prompt ? 4 : 0);
  const linesOf = (ev: SessionEvent): number => {
    if (ev.type !== 'result') return 1;
    const expandedAny = expanded && ev === events[events.length - 1] && ev.result.failures.length > 0;
    return expandedAny ? 1 + Math.min(4, ev.result.failures.length) * 2 : 1;
  };
  const endIdx = events.length - scroll;
  let lineCount = 0;
  const visible: SessionEvent[] = [];
  for (let i = endIdx - 1; i >= 0 && lineCount < maxEventsRows; i--) {
    lineCount += linesOf(events[i]);
    visible.push(events[i]);
  }
  visible.reverse();
  const slack = Math.max(0, maxEventsRows - lineCount);
  const statusLeft = `${provider ?? 'configured'} · ${runner} · ${formatElapsed(elapsed)} · attacks ${snap.attackRoundsSurvived}/3${
    result ? ` · last ${result.failed} failed, ${result.passed} passed` : ''
  }`;
  const statusRight = snap.finished ? (snap.finalGreen ? 'GREEN OK' : 'EXITED') : 'running';
  const statusColor = snap.finished
    ? snap.finalGreen
      ? theme.success
      : theme.error
    : running
      ? theme.primary
      : theme.textMuted;
const keysHint = 'enter approve · i input · t themes · j/k scroll · q quit · ? help';
  const featureContent =
    9 + feature.length + (moduleName ? 10 + moduleName.length : 0);
  const bottomCwd = truncate(cwd ?? '', w - 44);
  const bottomRight = `${provider ?? 'auto'} · ${clock}`;
  // Right-align the bottom row's clock with the footer's right-side status
  // (e.g. "running"): footer right text ends at w - M - T (1-based) — the
  // footer row is pad(M) + glyph + pad(2) + content ... + pad(T) + pad(M-1)
  // + guard block.
  const statusEnd = w - M - T;

return (
    <Box flexDirection="column" height={rows}>
      {base && (
        <Text key="top" backgroundColor={base}>
          {pad(w - 1)}
          <Block color={base} />
        </Text>
      )}

      <Box flexDirection="column">
        <Text backgroundColor={base}>
          {pad(M)}
          <Text backgroundColor={panel}>
            {pad(w - 2 * M)}
          </Text>
          {pad(M - 1)}
          <Block color={base} />
        </Text>
        <Text backgroundColor={base}>
          {pad(M)}
          <Text backgroundColor={panel}>
            {pad(P)}
            <Text bold color={theme.text}>redgreen </Text>
            <Text bold color={theme.success}>dev</Text>
            {pad(w - 2 * M - P - 12 - pillLen(statuses) - T)}
            <StatusPill statuses={statuses} theme={theme} />
            {pad(T)}
          </Text>
          {pad(M - 1)}
          <Block color={base} />
        </Text>
        <Text backgroundColor={base}>
          {pad(M)}
          <Text backgroundColor={panel}>
            {pad(P)}
            <Text color={theme.textMuted}>Feature:</Text>
            <Text color={theme.text}> {feature}</Text>
            {moduleName ? (
              <>
                <Text color={theme.textMuted}> · module </Text>
                <Text color={theme.info}>{moduleName}</Text>
              </>
            ) : null}
            {pad(w - 2 * M - P - featureContent - T)}
            {pad(T)}
          </Text>
          {pad(M - 1)}
          <Block color={base} />
        </Text>
        <Text backgroundColor={base}>
          {pad(M)}
          <Text backgroundColor={panel}>
            {pad(w - 2 * M)}
          </Text>
          {pad(M - 1)}
          <Block color={base} />
        </Text>
      </Box>

      {base && (
        <Text backgroundColor={base}>
          {pad(w - 1)}
          <Block color={base} />
        </Text>
      )}

      <Box flexDirection="column" height={timelineHeight}>
        {visible.map((ev, i) => (
          <EventLine
            key={i}
            ev={ev}
            isLast={ev === events[events.length - 1]}
            expanded={expanded}
            theme={theme}
            w={w}
          />
        ))}
        {prompt && (
          <>
            {base && (
              <Text backgroundColor={base}>
                {pad(w - 1)}
                <Block color={base} />
              </Text>
            )}
            <Text backgroundColor={base}>
              {pad(M)}
              <Text backgroundColor={element}>
                {pad(w - 2 * M)}
              </Text>
              {pad(M - 1)}
              <Block color={base} />
            </Text>
            <Text backgroundColor={base}>
              {pad(M)}
              <Text backgroundColor={element}>
                {pad(P)}
                <Text color={theme.warning}>{prompt}</Text>
                {pad(w - 2 * M - P - prompt.length - T)}
                {pad(T)}
              </Text>
              {pad(M - 1)}
              <Block color={base} />
            </Text>
            <Text backgroundColor={base}>
              {pad(M)}
              <Text backgroundColor={element}>
                {pad(w - 2 * M)}
              </Text>
              {pad(M - 1)}
              <Block color={base} />
            </Text>
          </>
        )}
        {base &&
          slack > 0 &&
          Array.from({ length: slack }, (_, i) => (
            <Text key={`slack${i}`} backgroundColor={base}>
              {pad(w - 1)}
              <Block color={base} />
            </Text>
          ))}
      </Box>

      {base ? (
        <Text backgroundColor={base}>
          {pad(5)}
          {statusMsg ? <Text color={theme.warning}>{statusMsg}</Text> : null}
          {pad(w - 5 - (statusMsg?.length ?? 0) - 1)}
          <Block color={base} />
        </Text>
      ) : statusMsg ? (
        <Text color={theme.warning}>{statusMsg}</Text>
      ) : null}

      {base && (
        <Text backgroundColor={base}>
          {pad(w - 1)}
          <Block color={base} />
        </Text>
      )}

      <Box flexDirection="column">
        <Text backgroundColor={base}>
          {pad(M)}
          <Text color={theme.info}>{'\u2503'}</Text>
          <Text backgroundColor={panel}>
            {pad(w - 2 * M - 1)}
          </Text>
          {pad(M - 1)}
          <Block color={base} />
        </Text>
        {inputMode ? (
          <Text backgroundColor={base}>
            {pad(M)}
            <Text color={theme.info}>{'\u2503'}</Text>
            <Text backgroundColor={panel}>
              {pad(2)}
              <Text bold color={theme.success}>{'> '}</Text>
              <Text color={theme.text}>{typed}</Text>
              <Text color={theme.textMuted}>|</Text>
              {pad(w - 2 * M - 1 - 2 - 2 - 1 - typed.length - T)}
              {pad(T)}
            </Text>
            {pad(M - 1)}
            <Block color={base} />
          </Text>
        ) : (
          <Text backgroundColor={base}>
            {pad(M)}
            <Text color={theme.info}>{'\u2503'}</Text>
            <Text backgroundColor={panel}>
              {pad(2)}
              <Text color={theme.textMuted}>{keysHint}</Text>
              {pad(w - 2 * M - 1 - 2 - keysHint.length - T)}
              {pad(T)}
            </Text>
            {pad(M - 1)}
            <Block color={base} />
          </Text>
        )}
        <Text backgroundColor={base}>
          {pad(M)}
          <Text color={theme.info}>{'\u2503'}</Text>
          <Text backgroundColor={panel}>
            {pad(2)}
            <Text color={theme.textMuted}>{statusLeft}</Text>
            {pad(w - 2 * M - 1 - 2 - statusLeft.length - statusRight.length - T)}
            <Text bold color={statusColor}>{statusRight}</Text>
            {pad(T)}
          </Text>
          {pad(M - 1)}
          <Block color={base} />
        </Text>
        <Text backgroundColor={base}>
          {pad(M)}
          <Text color={theme.info}>{'\u2503'}</Text>
          <Text backgroundColor={panel}>
            {pad(w - 2 * M - 1)}
          </Text>
          {pad(M - 1)}
          <Block color={base} />
        </Text>
      </Box>

      {base && (
        <Text backgroundColor={base}>
          {pad(5)}
          <Text color={theme.textMuted}>{bottomCwd}</Text>
          {pad(Math.max(1, statusEnd - 5 - bottomCwd.length - bottomRight.length))}
          <Text color={theme.textMuted}>{bottomRight}</Text>
          {pad(Math.max(1, w - statusEnd - 1))}
          <Block color={base} />
        </Text>
      )}
      {base && (
        <Text backgroundColor={base}>
          {pad(w - 1)}
          <Block color={base} />
        </Text>
      )}

      {showHelp && (
        <Box position="absolute" alignSelf="center" marginTop={3}>
          <HelpOverlay onClose={() => setShowHelp(false)} theme={theme} />
        </Box>
      )}

      {showThemes && (
        <Box position="absolute" alignSelf="center" marginTop={3}>
          <ThemesOverlay
            themeName={themeName}
            theme={theme}
            onSelect={(name) => {
              setThemeName(name);
              updateTheme(name);
            }}
            onClose={() => setShowThemes(false)}
          />
        </Box>
      )}
    </Box>
  );
}

export async function runPhaseTui(opts: PhaseTuiProps): Promise<void> {
  await installSystemTheme();
  render(<PhaseTui {...opts} />, {
    // ink duck-uses stdout (write / columns / rows); the clean writer only
    // has to be a WriteStream for ink's types.
    stdout: createCleanStdout(process.stdout) as unknown as NodeJS.WriteStream,
    exitOnCtrlC: true,
  });
}