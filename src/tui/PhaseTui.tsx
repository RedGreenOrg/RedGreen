import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { render } from 'ink';
import { DevSession } from '../core/session.js';
import type { SessionSnapshot } from '../core/session.js';
import type { ChatFn } from '../llm/client.js';
import { PHASES, type PhaseId, type PhaseStatus } from '../phase/state.js';
import type { TestRunner } from '../runners/types.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function Spinner(): React.ReactElement {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return <Text color="cyan">{FRAMES[i]}</Text>;
}

const STATUS_META: Record<
  PhaseStatus,
  { char: string; color: 'gray' | 'cyan' | 'green' | 'red' | 'yellow' }
> = {
  pending: { char: '○', color: 'gray' },
  active: { char: '▸', color: 'cyan' },
  done: { char: '✔', color: 'green' },
  error: { char: '✖', color: 'red' },
  soon: { char: '⧗', color: 'yellow' },
};

export interface PhaseTuiProps {
  feature: string;
  runner: TestRunner;
  chat: ChatFn;
  cwd?: string;
  provider?: string;
}

function displayPath(p: string): string {
  const abs = p.replace(/\\/g, '/');
  const cwd = process.cwd().replace(/\\/g, '/');
  return abs.startsWith(cwd) ? '.' + abs.slice(cwd.length) : abs;
}

function FilesPanel({ moduleName, snap }: { moduleName: string | null; snap: SessionSnapshot }): React.ReactElement {
  const rows: Array<{ path: string; tag: string }> = [];
  if (moduleName && snap.files.impl) {
    rows.push({ path: displayPath(snap.files.impl), tag: 'contract' });
  }
  if (moduleName && snap.files.tests) {
    rows.push({ path: displayPath(snap.files.tests), tag: 'tests' });
  }
  for (const attack of snap.files.attacks) {
    rows.push({ path: displayPath(attack), tag: 'attack' });
  }
  if (rows.length === 0) return <React.Fragment />;
  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.map((r) => (
        <Box key={r.path}>
          <Text color="magenta">{r.tag}</Text>
          <Text dimColor>{'  '}{r.path}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function PhaseTui({ feature, runner, chat, cwd, provider }: PhaseTuiProps): React.ReactElement {
  const { exit } = useApp();
  const sessionRef = useRef<DevSession | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = new DevSession({ feature, runner, chat, cwd });
  }

  const [snap, setSnap] = useState<SessionSnapshot>(() => sessionRef.current!.snapshot());

  useEffect(() => {
    const session = sessionRef.current!;
    const onUpdate = (s: SessionSnapshot) => setSnap(s);
    const onFinish = () => exit();
    session.on('update', onUpdate);
    session.on('finish', onFinish);
    void session.start();
    return () => {
      session.removeAllListeners('update');
      session.removeAllListeners('finish');
      session.dispose();
    };
  }, [exit]);

  useInput((input) => {
    const s = sessionRef.current;
    if (!s || s.snapshot().finished) return;
    if (input === 'q') s.quit();
    else if (input === '\r' || input === ' ') s.approve();
    else if (input === 's') s.skip();
  });

  const { statuses, result, logs, prompt, moduleName } = snap;
  const running = Object.values(statuses).includes('active');

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} paddingY={1} flexDirection="column">
        <Text bold color="cyan">
          redgreen dev
        </Text>
        <Text dimColor>Feature: {feature}</Text>
        <Text dimColor>
          Runner: {runner} · LLM: {provider ?? 'configured'}
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {PHASES.map((p) => {
          const st = statuses[p.id];
          const meta = STATUS_META[st];
          return (
            <Box key={p.id}>
              <Text color={meta.color}>{st === 'active' ? <Spinner /> : meta.char}</Text>
              <Text> {p.label}</Text>
              <Text dimColor>  - {p.blurb}</Text>
            </Box>
          );
        })}
      </Box>

      {moduleName && (
        <Box marginTop={1}>
          <Text bold>
            Module: <Text color="cyan">{moduleName}</Text>
          </Text>
        </Box>
      )}
      <FilesPanel moduleName={moduleName} snap={snap} />

      {result && result.total > 0 && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={result.failed === 0 ? 'green' : 'red'}
          paddingX={1}
          marginTop={1}
        >
          <Box>
            <Text bold color="cyan">
              {result.runner}
            </Text>
            <Text dimColor>
              {'  '}
              {result.durationMs}ms
            </Text>
            <Text bold>
              {'  '}
              {result.total} tests
            </Text>
            <Text color="green">
              {'  '}
              ✔ {result.passed} passed
            </Text>
            <Text color="red">
              {'  '}
              ✖ {result.failed} failed
            </Text>
            <Text color="gray">
              {'  '}
              – {result.skipped} skipped
            </Text>
          </Box>
          {result.failures.slice(0, 4).map((f) => (
            <Box key={f.title + f.file} flexDirection="column" marginTop={1}>
              <Text color="red">✖ {f.title}</Text>
              {f.message ? (
                <Text wrap="wrap" color="yellow">
                  {f.message.split('\n')[0]}
                </Text>
              ) : null}
            </Box>
          ))}
          <Box marginTop={1}>
            <Text bold color={result.failed === 0 ? 'green' : 'red'}>
              {result.failed === 0 ? 'GREEN - all tests pass.' : 'RED - suite is failing.'}
            </Text>
          </Box>
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        {logs.slice(-6).map((line, i) => (
          <Text key={i} dimColor>
            {line}
          </Text>
        ))}
      </Box>

      {prompt && (
        <Box marginTop={1}>
          <Text bold color="yellow">
            {running ? `▸ ${prompt}` : prompt}
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>q quit · Enter/space approve · s skip current wait</Text>
      </Box>
    </Box>
  );
}

export function runPhaseTui(opts: PhaseTuiProps): void {
  render(<PhaseTui {...opts} />, { exitOnCtrlC: true });
}