import React, { useEffect, useMemo, useRef, useState } from 'react';
import fs from 'node:fs';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { render } from 'ink';
import { DevSession, type SessionEvent } from '../core/session.js';
import type { SessionSnapshot } from '../core/session.js';
import type { ChatFn } from '../llm/client.js';
import { PHASES, currentPhase, type PhaseId, type PhaseStatus } from '../phase/state.js';
import type { TestRunner } from '../runners/types.js';
import { THEME_NAMES, updateTheme, type ThemeName } from '../config/config.js';
import { THEMES, installSystemTheme, resolveThemeName, type Theme } from './theme.js';
import { createCleanStdout } from './screen.js';
import { windowBlocks } from './window.js';
import {
  Block,
  HelpOverlay,
  HintsOverlay,
  PhaseGuideOverlay,
  RefactorOverlay,
  SolutionOverlay,
  TestReviewOverlay,
  ThemesOverlay,
  pad,
  truncate,
  type TutorialConfig,
} from './overlays.js';
export type { TutorialConfig } from './overlays.js';

export interface PhaseTuiProps {
  feature: string;
  runner: TestRunner;
  chat: ChatFn;
  cwd?: string;
  provider?: string;
  stubComments?: boolean;
  /** When set, renders a phase-by-phase teaching banner instead of the plain UI. */
  tutorial?: TutorialConfig;
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
  const label = verdict === 'green' ? '✓' : verdict === 'red' ? '✗' : '·';
  const detail =
    verdict === 'green'
      ? `${ev.label} - all ${r.total} pass · ${r.durationMs}ms`
      : verdict === 'red'
        ? `${ev.label} - ${r.failed} failed, ${r.passed} passed · ${r.durationMs}ms`
        : `${ev.label} - no tests`;
  return { verdict, label, detail };
}

function StatusPill({ statuses, theme }: { statuses: Record<PhaseId, PhaseStatus>; theme: Theme }): React.ReactElement {
  const phase = currentPhase(statuses);
  const st = statuses[phase];
  const marker = st === 'active' ? '▸' : st === 'done' ? '✓' : st === 'error' ? '✗' : ' ';
  const color =
    st === 'active' ? theme.primary : st === 'done' ? theme.success : st === 'error' ? theme.error : theme.textMuted;
  const label = PHASES.find((p) => p.id === phase)!.label;
  return (
    <Text bold color={color}>
      [{marker} {label.toUpperCase()}]
    </Text>
  );
}

// Visible length of the rendered pill (ASCII), for manual line padding.
// Every marker ('▸', '✓', '✗', ' ') is a single cell, so the pill is always
// '[' + marker + ' ' + label + ']' = label.length + 4.
function pillLen(statuses: Record<PhaseId, PhaseStatus>): number {
  const phase = currentPhase(statuses);
  const label = PHASES.find((p) => p.id === phase)!.label;
  return label.length + 4;
}


// One row of the timeline log. Every event paints one full-width panel line so
// the region reads as a single gray console (not patchy per-line stripes).
// Long messages are truncated to the row width; nothing wraps or overflows.
function EventLine({
  ev,
  isLast,
  expanded,
  theme,
  w,
  slice,
}: {
  ev: SessionEvent;
  isLast: boolean;
  expanded: boolean;
  theme: Theme;
  w: number;
  slice?: [number, number];
}): React.ReactElement {
  // The timeline is a plain log: rows sit on the base background (no gray
  // panel), each event contributing one line per entry (failures expand into
  // their own inline rows). Every row is its own <Text> so the visible window
  // can cut a block mid-way for smooth line-based scrolling.
  const base = theme.background;
  const row = (children: React.ReactNode, len: number): React.ReactElement => (
    <Text backgroundColor={base}>
      {children}
      {pad(w - len)}
    </Text>
  );
  const msg = (m: string): string => truncate(m.split('\n')[0].trim(), w - 5);
  const failRow = (f: { title: string; file: string; message?: string }): React.ReactElement => {
    const mline = f.message ? f.message.split('\n')[0].trim() : '';
    const title = truncate(f.title, w - 3 - 2);
    const both = title + (mline.length > 0 ? ` · ${truncate(mline, Math.max(4, w - 3 - 2 - title.length - 3))}` : '');
    const t = truncate(both, w - 3 - 1 - 2);
    return row(
      <>
        {pad(6)}
        <Text color={theme.error}>✗</Text>
        <Text color={theme.textMuted}> {t}</Text>
      </>,
      6 + 1 + 1 + t.length,
    );
  };
  let rows: React.ReactElement[] = [];
  switch (ev.type) {
    case 'write': {
      const m = msg(ev.message);
      rows = [row(
        <>
          {pad(3)}
          <Text bold color={theme.success}>[+]</Text>
          <Text color={theme.text}> {m}</Text>
        </>,
        3 + 3 + 1 + m.length,
      )];
      break;
    }
    case 'info': {
      const m = msg(ev.message);
      rows = [row(
        <>
          {pad(3)}
          <Text bold color={theme.textMuted}>[i]</Text>
          <Text color={theme.textMuted}> {m}</Text>
        </>,
        3 + 3 + 1 + m.length,
      )];
      break;
    }
    case 'error': {
      const m = msg(ev.message);
      rows = [row(
        <>
          {pad(3)}
          <Text bold color={theme.error}>[!]</Text>
          <Text color={theme.error}> {m}</Text>
        </>,
        3 + 3 + 1 + m.length,
      )];
      break;
    }
    case 'summary': {
      const m = msg(ev.message);
      const color = ev.green ? theme.success : theme.error;
      rows = [row(
        <>
          {pad(3)}
          <Text bold color={color}>[■]</Text>
          <Text bold color={color}> {m}</Text>
        </>,
        3 + 3 + 1 + m.length,
      )];
      break;
    }
    case 'attack': {
      const m = ` attack round ${ev.round}/${ev.total} - ${ev.survived ? 'survived' : 'failed'}`;
      const m2 = truncate(m, w - 5);
      const color = ev.survived ? theme.success : theme.error;
      rows = [row(
        <>
          {pad(3)}
          <Text bold color={color}>[{ev.survived ? '✓' : '✗'}]</Text>
          <Text color={color}>{m2}</Text>
        </>,
        3 + 3 + m2.length,
      )];
      break;
    }
    case 'refactor': {
      const m = msg(ev.message);
      rows = [row(
        <>
          {pad(3)}
          <Text bold color={theme.info}>[R]</Text>
          <Text color={theme.info}> {m}</Text>
        </>,
        3 + 3 + 1 + m.length,
      )];
      break;
    }
    case 'result': {
      const { verdict, label, detail } = formatResult(ev);
      const color = verdict === 'green' ? theme.success : verdict === 'red' ? theme.error : theme.textMuted;
      const expandedAny = expanded && isLast && ev.result.failures.length > 0;
      const failures = ev.result.failures.slice(0, 4);
      const d = truncate(detail, w - 5);
      rows = [row(
        <>
          {pad(3)}
          <Text bold color={color}>[{label}{expandedAny ? '-' : ''}]</Text>
          <Text color={color}> {d}</Text>
        </>,
        3 + 3 + (expandedAny ? 1 : 0) + 1 + d.length,
      )];
      if (expandedAny) rows = rows.concat(failures.map(failRow));
      break;
    }
    default:
      break;
  }
  const f = Math.max(0, slice?.[0] ?? 0);
  const t = Math.min(rows.length, slice?.[1] ?? rows.length);
  return <React.Fragment>{rows.slice(f, t).map((r, i) => <React.Fragment key={f + i}>{r}</React.Fragment>)}</React.Fragment>;
}

// Layout cells are marked with a private-use sentinel (SENT) instead of
// spaces: the clean stdout writer (screen.ts) recognizes sentinel runs as
// pure layout and re-emits them as color-erases (CSI K) and cursor moves,
// so nothing in the margins or padding is selectable or copied. Content
// strings keep their real space characters. M = margin cells each side of a
// panel; P = inner padding before content; T = tail filling the right edge.
const M = 2;
const P = 3;
const T = 2;


export function PhaseTui({
  feature,
  runner,
  chat,
  cwd,
  provider,
  stubComments,
  tutorial,
}: PhaseTuiProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const [themeName, setThemeName] = useState<ThemeName>(() => resolveThemeName());
  // Picker selection index; defaults to the current theme so the picker opens
  // on it (not the top of the list).
  const [themesSel, setThemesSel] = useState<number>(0);
  const sessionRef = useRef<DevSession | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = new DevSession({ feature, runner, chat, cwd, stubComments });
  }
  const startedAtRef = useRef(Date.now());
  const [snap, setSnap] = useState<SessionSnapshot>(() => sessionRef.current!.snapshot());
  const [scroll, setScroll] = useState(0);
  const [expanded, setExpanded] = useState(true);
  const [inputMode, setInputMode] = useState(false);
  const [typed, setTyped] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [showThemes, setShowThemes] = useState(false);
  const [showHints, setShowHints] = useState(false);
  const [hintSel, setHintSel] = useState<number>(0);
  const [showSolution, setShowSolution] = useState(false);
  const [showRefactor, setShowRefactor] = useState(false);
  const [showTestReview, setShowTestReview] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [clock, setClock] = useState(() => new Date().toTimeString().slice(0, 8));
  const statusTimer = useRef<NodeJS.Timeout | null>(null);
  // Tutorial coach modals auto-show once per phase (in order), then stay seen.
  const seenGuideRef = useRef<Set<PhaseId>>(new Set());
  // While the picker is up, render the whole screen with the hovered theme
  // so moving the selection (j/k) live-previews each theme.
  const theme = THEMES[showThemes ? THEME_NAMES[themesSel] : themeName];
  // While an overlay (help/themes/guide) is up, freeze background churn (clock
  // tick, session updates): each setState there repaints the whole frame,
  // which is what flickers/lags when browsing a large list.
  const overlayRef = useRef(false);
  overlayRef.current =
    showHelp || showThemes || showHints || showSolution || showRefactor || showTestReview || showGuide;

  useEffect(() => {
    if (!sessionRef.current) return;
    const s = sessionRef.current;
    const onUpdate = (sn: SessionSnapshot) => {
      if (overlayRef.current) return;
      setSnap(sn);
      // Keep the scroll anchor across updates: at the bottom (0) events follow
      // live; when the user scrolled up, hold their position instead of
      // snapping them back down on every new line.
    };
    s.on('update', onUpdate);
    void s.start();
    const timer = setInterval(() => {
      if (overlayRef.current) return;
      setElapsed(Date.now() - startedAtRef.current);
      setClock(new Date().toTimeString().slice(0, 8));
    }, 1000);
    return () => {
      s.removeAllListeners('update');
      clearInterval(timer);
      if (statusTimer.current) clearTimeout(statusTimer.current);
      s.dispose();
    };
  }, [exit]);

  // Show the tutorial coach once per phase, as soon as the session enters it.
  const guidePhase = currentPhase(snap.statuses);
  useEffect(() => {
    if (!tutorial) return;
    if (showHelp || showThemes || showHints || showSolution || showRefactor || showTestReview || inputMode) return;
    if (seenGuideRef.current.has(guidePhase)) return;
    seenGuideRef.current.add(guidePhase);
    setShowGuide(true);
  }, [guidePhase, tutorial, showHelp, showThemes, showHints, showSolution, showRefactor, showTestReview, inputMode]);

  const startNewFeature = (feat: string): void => {
    const s = sessionRef.current;
    if (!s) return;
    setShowSolution(false);
    setShowHints(false);
    setShowHelp(false);
    setShowThemes(false);
    setShowRefactor(false);
    setShowTestReview(false);
    setShowGuide(false);
    seenGuideRef.current = new Set();
    setExpanded(true);
    setScroll(0);
    setStatusMsg(null);
    startedAtRef.current = Date.now();
    void s.restart(feat);
  };

  useInput(
    (input, key) => {
      const s = sessionRef.current;
      if (!s) return;
      if (showHelp || showThemes || showHints || showSolution || showRefactor) return;
      if (showGuide) {
        // The coach itself closes on enter/space; forward the same press as an
        // approve so advancing the phase never needs a second keypress.
        if (input === '\r' || input === ' ') {
          setShowGuide(false);
          return s.approve();
        }
        return;
      }
      if (inputMode) {
        if (key.escape) {
          setInputMode(false);
          setTyped('');
        } else if (key.return) {
          const cmd = typed.trim().toLowerCase();
          setTyped('');
          setInputMode(false);
          if (!cmd) return;
          if (cmd === '/quit') return exit();
          if (cmd === '/skip') return s.skip();
          if (cmd === '/approve') return s.approve();
          if (cmd === '/retry') {
            void s.retryFailedStep();
            return;
          }
          if (cmd === '/expand') {
            setExpanded((v) => !v);
            return;
          }
          if (cmd === '/help') {
            setShowHelp(true);
            return;
          }
          if (cmd === '/themes') {
            setThemesSel(Math.max(0, THEME_NAMES.indexOf(themeName)));
            setShowThemes(true);
            return;
          }
          if (cmd === '/hints') {
            if (snap.hints) setShowHints(true);
            return;
          }
          if (cmd === '/solution') {
            if (snap.greenReached) {
              setShowSolution(true);
              void s.requestSolution();
            } else {
              setStatusMsg('solution locked - reach GREEN first');
              if (statusTimer.current) clearTimeout(statusTimer.current);
              statusTimer.current = setTimeout(() => setStatusMsg(null), 2500);
            }
            return;
          }
          if (cmd === '/refactor') {
            if (snap.refactor && snap.refactor.suggestions.length > 0) {
              setShowRefactor(true);
            } else {
              setStatusMsg('no refactor suggestions yet');
              if (statusTimer.current) clearTimeout(statusTimer.current);
              statusTimer.current = setTimeout(() => setStatusMsg(null), 2500);
            }
            return;
          }
          if (cmd === '/apply') {
            if (snap.refactorPending) {
              s.acceptRefactorProposal();
            } else if (snap.refactor && snap.refactor.suggestions.length > 0) {
              void s.applyRefactor();
            } else {
              setStatusMsg('no refactor suggestions yet');
              if (statusTimer.current) clearTimeout(statusTimer.current);
              statusTimer.current = setTimeout(() => setStatusMsg(null), 2500);
            }
            return;
          }
          if (cmd === '/new' || cmd.startsWith('/new ')) {
            const feat = typed.trim().slice(4).trim();
            if (!feat) {
              setStatusMsg('usage: /new <feature description>');
            } else if (snap.finished) {
              startNewFeature(feat);
            } else {
              setStatusMsg('finish the current feature first (q to quit)');
            }
            if (statusTimer.current) clearTimeout(statusTimer.current);
            statusTimer.current = setTimeout(() => setStatusMsg(null), 2500);
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

      if (input === 'q') return exit();
      if (input === '\r' || input === ' ') return s.approve();
      if (input === 's') return s.skip();
      if (input === 'r') {
        if (snap.refactorPending) {
          void s.rejectRefactorProposal();
        } else if (snap.recoverableError && !snap.finished) {
          void s.retryFailedStep();
        } else {
          setStatusMsg('nothing to retry');
          if (statusTimer.current) clearTimeout(statusTimer.current);
          statusTimer.current = setTimeout(() => setStatusMsg(null), 2000);
        }
        return;
      }
      if (input === 'a') {
        if (snap.refactorPending) {
          s.acceptRefactorProposal();
        } else if (snap.refactor && snap.refactor.suggestions.length > 0) {
          void s.applyRefactor();
        } else {
          setStatusMsg('no refactor suggestions yet');
          if (statusTimer.current) clearTimeout(statusTimer.current);
          statusTimer.current = setTimeout(() => setStatusMsg(null), 2500);
        }
        return;
      }
      if (input === 'n') {
        if (snap.finished) {
          setInputMode(true);
          setTyped('/new ');
        } else {
          setStatusMsg('finish the current feature first (q to quit)');
          if (statusTimer.current) clearTimeout(statusTimer.current);
          statusTimer.current = setTimeout(() => setStatusMsg(null), 2500);
        }
        return;
      }
      if (input === 'i') {
        setInputMode(true);
        return;
      }
      if (input === 'h') {
        if (snap.hints) {
          // Nudges re-aim at the current failing assertion when it has changed.
          void s.refreshNudges();
          setHintSel(0);
          setShowHints(true);
        }
        return;
      }
      if (input === 'S') {
        if (snap.greenReached) {
          setShowSolution(true);
          void s.requestSolution();
        } else {
          setStatusMsg('solution locked - reach GREEN first');
          if (statusTimer.current) clearTimeout(statusTimer.current);
          statusTimer.current = setTimeout(() => setStatusMsg(null), 2500);
        }
        return;
      }
      if (input === 'v') {
        if ((snap.prompt ?? '').includes('Tests are RED')) {
          setShowTestReview(true);
        } else if (snap.refactor && snap.refactor.suggestions.length > 0) {
          setShowRefactor(true);
        } else {
          setStatusMsg('no refactor suggestions yet');
          if (statusTimer.current) clearTimeout(statusTimer.current);
          statusTimer.current = setTimeout(() => setStatusMsg(null), 2000);
        }
        return;
      }
      if (input === '?') {
        setShowHelp(true);
        return;
      }
      if (input === 't') {
        setThemesSel(Math.max(0, THEME_NAMES.indexOf(themeName)));
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
        setScroll((v) => Math.min(Math.max(0, total - maxEventsRows), v + 1));
        return;
      }
      if (input === 'k' || key.upArrow) {
        setScroll((v) => Math.max(0, v - 1));
        return;
      }
    },
    { isActive: true },
  );

  const { statuses, result, events, prompt, moduleName } = snap;
  const running = Object.values(statuses).includes('active');
  // Fixed chrome: top margin (1) + header (4: pad+title+feature+pad) +
  // header gap (1) + statusMsg row (1) + footer gap (1) + footer (4:
  // pad+keys/input+status+pad) + bottom status row (1) + bottom gap (1) = 14
  // rows reserve. The prompt now lives in the footer command box, so the
  // timeline gets all of its rows back. The tutorial hint adds 1 more line.
  const tutorialRows = tutorial ? 1 : 0;
  const timelineHeight = Math.max(4, rows - 14 - tutorialRows);
  const cols = stdout?.columns ?? 80;
  const w = Math.max(40, cols);
  const panel = theme.backgroundPanel;
  const base = theme.background;
  const maxEventsRows = timelineHeight;
  const linesOf = (ev: SessionEvent): number => {
    if (ev.type !== 'result') return 1;
    const expandedAny = expanded && ev === events[events.length - 1] && ev.result.failures.length > 0;
    return expandedAny ? 1 + Math.min(4, ev.result.failures.length) : 1;
  };
  // Line-based windowing: scroll counts lines, not events, so j/k slide the
  // log one row at a time instead of popping whole event blocks in/out.
  const lens = events.map(linesOf);
  const win = windowBlocks(lens, scroll, maxEventsRows);
  const { total, scrolled, bottom, slack } = win;
  const visible: SessionEvent[] = [];
  const slices: Array<[number, number]> = [];
  for (const { block, from, to } of win.slices) {
    visible.push(events[block]);
    slices.push([from, to]);
  }
  // Tutorial hint line (shown in the header box) + the coach modal state.
  const guideIdx = PHASES.findIndex((p) => p.id === guidePhase) + 1;
  const guideStep = tutorial ? tutorial.steps[guidePhase] : undefined;
  const bannerWhat =
    guideStep && tutorial
      ? truncate(` · ${guideIdx}/${PHASES.length} · ${guideStep.what}`, w - 2 * M - P - 8 - T)
      : '';
  const scrolledUp = scrolled > 0;
  const statusMsgLeft = scrolledUp
    ? `▲ ${scrolled} older · G to go live`
    : statusMsg;
  const statusMsgLen = statusMsgLeft?.length ?? 0;
  const statusLeft = `${provider ?? 'configured'} · ${runner} · ${formatElapsed(elapsed)} · attacks ${snap.attackRoundsSurvived}/3${
    result ? ` · last ${result.failed} failed, ${result.passed} passed` : ''
  }`;
  const statusRight = snap.finished
    ? snap.finalGreen
      ? 'GREEN OK'
      : 'STOPPED'
    : snap.recoverableError
      ? 'PAUSED · r RETRY'
      : running
        ? 'running'
        : 'idle';
  const statusColor = snap.finished
    ? snap.finalGreen
      ? theme.success
      : theme.error
    : snap.recoverableError
      ? theme.error
      : running
        ? theme.primary
        : theme.textMuted;
  const keysHint = snap.finished
    ? 'n new feature · S solution · t theme · j/k scroll · q quit · ? help'
    : snap.recoverableError
      ? 'r retry · enter approve · h hints · i cmd · t theme · j/k scroll · q quit · ? help'
      : 'enter approve · h hints · i cmd · t theme · j/k scroll · q quit · ? help';
  // The prompt (e.g. "Press Enter to approve the contract") is shown in the
  // footer command box instead of a floating bar, so it stays in one place
  // while the timeline scrolls independently.
  const footerText = prompt ?? keysHint;
  const footerColor = prompt ? theme.warning : theme.textMuted;
  const footerMax = w - 2 * M - 2 - 2 - T;
  const footerDisplay = truncate(footerText, footerMax);
  const featureContent =
    9 + feature.length + (moduleName ? 10 + moduleName.length : 0);
  const bottomCwd = truncate(cwd ?? '', w - 44);
  const bottomRight = `${provider ?? 'auto'} · ${clock}`;
  // Right-align the bottom row's clock with the footer's right-side status
  // (e.g. "running"): footer right text ends at w - M - T (1-based) — the
  // footer row is pad(M) + glyph + pad(2) + content ... + pad(T) + pad(M-1)
  // + guard block.
  const statusEnd = w - M - T;

const mainScreen = (
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
          <Text color={theme.info}>{'\u2503'}</Text>
          <Text backgroundColor={panel}>
            {pad(w - 2 * M - 2)}
          </Text>
          <Text color={theme.info}>{'\u2503'}</Text>
          {pad(M - 1)}
          <Block color={base} />
        </Text>
        <Text backgroundColor={base}>
          {pad(M)}
          <Text color={theme.info}>{'\u2503'}</Text>
          <Text backgroundColor={panel}>
            {pad(P)}
            <Text bold color={theme.text}>redgreen </Text>
            <Text bold color={theme.success}>{tutorial ? 'tutorial' : 'dev'}</Text>
            {pad(w - 2 * M - 2 - P - (tutorial ? 17 : 12) - pillLen(statuses) - T)}
            <StatusPill statuses={statuses} theme={theme} />
            {pad(T)}
          </Text>
          <Text color={theme.info}>{'\u2503'}</Text>
          {pad(M - 1)}
          <Block color={base} />
        </Text>
        <Text backgroundColor={base}>
          {pad(M)}
          <Text color={theme.info}>{'\u2503'}</Text>
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
            {pad(w - 2 * M - 2 - P - featureContent - T)}
            {pad(T)}
          </Text>
          <Text color={theme.info}>{'\u2503'}</Text>
          {pad(M - 1)}
          <Block color={base} />
        </Text>
        {tutorial && bannerWhat && (
          <Text backgroundColor={base}>
            {pad(M)}
            <Text color={theme.info}>{'\u2503'}</Text>
            <Text backgroundColor={panel}>
              {pad(P)}
              <Text bold color={theme.info}>tutorial</Text>
              <Text color={theme.text}> {bannerWhat}</Text>
              {pad(w - 2 * M - 2 - P - 8 - 1 - bannerWhat.length - T)}
              {pad(T)}
            </Text>
            <Text color={theme.info}>{'\u2503'}</Text>
            {pad(M - 1)}
            <Block color={base} />
          </Text>
        )}
        <Text backgroundColor={base}>
          {pad(M)}
          <Text color={theme.info}>{'\u2503'}</Text>
          <Text backgroundColor={panel}>
            {pad(w - 2 * M - 2)}
          </Text>
          <Text color={theme.info}>{'\u2503'}</Text>
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
            slice={slices[i] as [number, number]}
          />
        ))}
        {slack > 0 &&
          Array.from({ length: slack }, (_, i) => (
            <Text key={`slack${i}`} backgroundColor={base}>
              {pad(w)}
            </Text>
          ))}
      </Box>

      {base ? (
        <Text backgroundColor={base}>
          {pad(5)}
          {statusMsgLeft ? (
            <Text color={scrolledUp ? theme.info : theme.warning}>{statusMsgLeft}</Text>
          ) : null}
          {pad(w - 5 - statusMsgLen - 1)}
          <Block color={base} />
        </Text>
      ) : statusMsgLeft ? (
        <Text color={scrolledUp ? theme.info : theme.warning}>{statusMsgLeft}</Text>
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
            {pad(w - 2 * M - 2)}
          </Text>
          <Text color={theme.info}>{'\u2503'}</Text>
          {pad(M - 1)}
          <Block color={base} />
        </Text>
        {inputMode ? (
          <Text backgroundColor={base}>
            {pad(M)}
            <Text color={theme.info}>{'\u2503'}</Text>
            <Text backgroundColor={panel}>
              {pad(2)}
              <Text bold color={theme.success}>{'› '}</Text>
              <Text color={theme.text}>{typed}</Text>
              <Text color={theme.textMuted}>▌</Text>
              {pad(w - 2 * M - 2 - 2 - 2 - 1 - typed.length - T)}
              {pad(T)}
            </Text>
            <Text color={theme.info}>{'\u2503'}</Text>
            {pad(M - 1)}
            <Block color={base} />
          </Text>
        ) : (
          <Text backgroundColor={base}>
            {pad(M)}
            <Text color={theme.info}>{'\u2503'}</Text>
            <Text backgroundColor={panel}>
              {pad(2)}
              <Text color={footerColor}>{footerDisplay}</Text>
              {pad(w - 2 * M - 2 - 2 - footerDisplay.length - T)}
              {pad(T)}
            </Text>
            <Text color={theme.info}>{'\u2503'}</Text>
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
            {pad(w - 2 * M - 2 - 2 - statusLeft.length - statusRight.length - T)}
            <Text bold color={statusColor}>{statusRight}</Text>
            {pad(T)}
          </Text>
          <Text color={theme.info}>{'\u2503'}</Text>
          {pad(M - 1)}
          <Block color={base} />
        </Text>
        <Text backgroundColor={base}>
          {pad(M)}
          <Text color={theme.info}>{'\u2503'}</Text>
          <Text backgroundColor={panel}>
            {pad(w - 2 * M - 2)}
          </Text>
          <Text color={theme.info}>{'\u2503'}</Text>
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
            sel={themesSel}
            setSel={setThemesSel}
            themeName={themeName}
            theme={theme}
            maxRows={rows}
            maxCols={w}
            onSelect={(name) => {
              setThemeName(name);
              updateTheme(name);
            }}
            onClose={() => setShowThemes(false)}
          />
        </Box>
      )}
      {showHints && snap.hints && (
        <Box position="absolute" alignSelf="center" marginTop={3}>
          <HintsOverlay
            sel={hintSel}
            setSel={setHintSel}
            hints={snap.hints}
            unlocks={snap.hintUnlocks}
            theme={theme}
            maxRows={rows}
            maxCols={w}
            onClose={() => setShowHints(false)}
          />
        </Box>
      )}
      {showSolution && (
        <Box position="absolute" alignSelf="center" marginTop={3}>
          <SolutionOverlay
            explanation={snap.solutionExplanation}
            solution={snap.solution}
            solutionError={snap.solutionError}
            theme={theme}
            maxRows={rows}
            maxCols={w}
            onClose={() => setShowSolution(false)}
          />
        </Box>
      )}
      {showRefactor && snap.refactor && (
        <Box position="absolute" alignSelf="center" marginTop={3}>
          <RefactorOverlay
            data={snap.refactor}
            theme={theme}
            maxRows={rows}
            maxCols={w}
            onClose={() => setShowRefactor(false)}
            onApply={() => {
              if (snap.refactorPending) {
                sessionRef.current!.acceptRefactorProposal();
              } else {
                void sessionRef.current!.applyRefactor();
              }
            }}
            onReject={() => {
              if (snap.refactorPending) void sessionRef.current!.rejectRefactorProposal();
            }}
          />
        </Box>
      )}
      {showTestReview && (
        <Box position="absolute" alignSelf="center" marginTop={3}>
          <TestReviewOverlay
            testsPath={snap.files.tests}
            theme={theme}
            maxRows={rows}
            maxCols={w}
            onClose={() => setShowTestReview(false)}
          />
        </Box>
      )}
      {showGuide && tutorial && guideStep && (
        <Box position="absolute" alignSelf="center" marginTop={3}>
          <PhaseGuideOverlay
            step={guideStep}
            label={PHASES.find((p) => p.id === guidePhase)!.label}
            idx={guideIdx}
            theme={theme}
            maxCols={w}
            onClose={() => setShowGuide(false)}
          />
        </Box>
      )}
    </Box>
  );

  return mainScreen;
}

export async function runPhaseTui(opts: PhaseTuiProps): Promise<void> {
  await installSystemTheme();
  const instance = render(<PhaseTui {...opts} />, {
    // ink duck-uses stdout (write / columns / rows); the clean writer only
    // has to be a WriteStream for ink's types.
    stdout: createCleanStdout(process.stdout) as unknown as NodeJS.WriteStream,
    exitOnCtrlC: true,
  });
  await instance.waitUntilExit();
  // ink repaints the last frame on unmount but never clears the screen, so
  // the TUI's final frame stays painted after quit. Erase it so the shell
  // prompt gets a blank terminal.
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}
