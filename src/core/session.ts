import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { watch } from 'chokidar';
import type { ChatFn } from '../llm/client.js';
import { completeStructured } from '../llm/structured.js';
import {
  ATTACK_SCHEMA,
  HINTS_SCHEMA,
  RED_SCHEMA,
  REFACTOR_APPLY_SCHEMA,
  REFACTOR_SCHEMA,
  SCAFFOLD_SCHEMA,
  SOLUTION_SCHEMA,
  buildAttackPrompt,
  buildNudgePrompt,
  buildRedPrompt,
  buildRefactorApplyPrompt,
  buildRefactorPrompt,
  buildScaffoldPrompt,
  buildSolutionPrompt,
  type Hints,
  type HintTier,
  type RefactorSuggestions,
} from '../prompts/prompts.js';
import { runTests } from '../runners/execute.js';
import { isGreen } from '../runners/types.js';
import type { TestRunResult, TestRunner } from '../runners/types.js';
import type { PhaseId, PhaseStatus } from '../phase/state.js';
import { loadCustomRules } from '../config/rules.js';
import { SessionMemory } from './memory.js';
import { moduleNameFromFeature } from './naming.js';

export type TestExecutor = (
  runner: TestRunner,
  opts: { files?: string[]; cwd?: string },
) => Promise<TestRunResult>;

export type WaitChoice = 'approve' | 'skip' | 'quit' | 'timeout' | 'green';

export interface SessionFiles {
  types: string | null;
  impl: string | null;
  tests: string | null;
  attacks: string[];
}

export interface SessionSnapshot {
  statuses: Record<PhaseId, PhaseStatus>;
  result: TestRunResult | null;
  logs: string[];
  events: SessionEvent[];
  prompt: string | null;
  moduleName: string | null;
  files: SessionFiles;
  attackRoundsSurvived: number;
  finished: boolean;
  finalGreen: boolean;
  hints: Hints | null;
  hintUnlocks: Record<HintTier, boolean>;
  /** How many times the hint tiers were re-derived for a new failing assertion. */
  nudgesRegenerated: number;
  greenFailures: number;
  greenReached: boolean;
  solution: string | null;
  solutionExplanation: string | null;
  /** Refactor suggestions proposed by the AI during the refactor phase. */
  refactor: RefactorSuggestions | null;
  /** Whether the refactor phase ran to completion. */
  refactorDone: boolean;
  /** A test-verified refactor is on disk, awaiting accept (`a`) or reject (`r`). */
  refactorPending: boolean;
  /** Number of auto-apply refactors the developer accepted. */
  refactorAccepted: number;
  /** Non-null while an AI step failed and the session is paused awaiting retry. */
  recoverableError: string | null;
  /** Last failure of reference-solution generation (independent of the pipeline). */
  solutionError: string | null;
}

export type SessionEvent =
  | { type: 'write'; message: string }
  | { type: 'info'; message: string }
  | { type: 'error'; message: string }
  | { type: 'result'; label: string; result: TestRunResult }
  | { type: 'attack'; round: number; total: number; survived: boolean }
  | { type: 'refactor'; message: string }
  | { type: 'summary'; green: boolean; message: string };

export interface DevSessionOptions {
  feature: string;
  runner: TestRunner;
  chat: ChatFn;
  cwd?: string;
  execute?: TestExecutor;
  headless?: boolean;
  greenTimeoutMs?: number | null;
  /** Extra attempts after the first failure of an AI call (default: REDGREEN_LLM_RETRIES or 2). */
  retryAttempts?: number;
  /** Base delay for exponential backoff between AI retries, in ms (default 1500). */
  retryBaseDelayMs?: number;
  /**
   * Run the refactor phase without approval and auto-accept every suite-verified
   * suggestion (default: REDGREEN_REFACTOR env var, off unless set to 1/true).
   */
  refactorEnabled?: boolean;
  /** Include contract-explaining JSDoc on stub functions (default: true). */
  stubComments?: boolean;
}

const MAX_ATTACK_ROUNDS = 3;
const MAX_REFACTOR_ROUNDS = 1;
// 0 scaffold · 1 review gate · 2 red · 3 green watch · 4..6 attack rounds ·
// 7..8 refactor rounds
const PIPELINE_STEPS = 3 + MAX_ATTACK_ROUNDS + MAX_REFACTOR_ROUNDS;
const REFACTOR_STEP = 3 + MAX_ATTACK_ROUNDS;

type StepOutcome =
  | 'continue' // move on to the next pipeline step
  | 'finish-failed' // user quit before GREEN: end the session as not-green
  | 'finish-current' // user quit mid-attack chain: end with whatever the suite says
  | 'paused'; // recoverable AI error: keep the session alive, wait for retry

function resolveRetryAttempts(): number {
  const parsed = Number(process.env.REDGREEN_LLM_RETRIES);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(5, Math.floor(parsed)) : 2;
}

// REDGREEN_REFACTOR=1 runs the refactor phase (and auto-applies every
// suite-verified suggestion) without human approval - the CI-friendly path.
function resolveRefactorEnabled(): boolean {
  const raw = process.env.REDGREEN_REFACTOR;
  return raw === '1' || raw?.toLowerCase() === 'true';
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export class DevSession extends EventEmitter {
  private feature: string;
  private readonly runner: TestRunner;
  private readonly chat: ChatFn;
  private readonly cwd: string;
  private readonly execute: TestExecutor;
  private readonly headless: boolean;
  private readonly greenTimeoutMs: number | null;

  private statuses: Record<PhaseId, PhaseStatus> = {
    scaffold: 'active',
    red: 'pending',
    green: 'pending',
    attack: 'pending',
    refactor: 'pending',
  };
  private result: TestRunResult | null = null;
  private logs: string[] = [];
  private events: SessionEvent[] = [];
  private prompt: string | null = null;
  private moduleName: string | null = null;
  private files: SessionFiles = { types: null, impl: null, tests: null, attacks: [] };
  private attackRoundsSurvived = 0;
  private finished = false;
  private finalGreen = false;
  private quitting = false;
  private redEndedAt: number | null = null;
  private greenReachedAt: number | null = null;
  private hints: Hints | null = null;
  // The failing-assertion signature the current hints were minted against.
  private hintsTarget: string | null = null;
  private nudgesRegenerated = 0;
  private nugging = false;
  private solution: string | null = null;
  private solutionExplanation: string | null = null;
  private greenFailures = 0;
  private forceFreshScaffold = false;
  private generation = 0;
  private refactor: RefactorSuggestions | null = null;
  private refactorDone = false;
  private refactorProposal: { filePath: string; original: string; proposed: string; result: TestRunResult } | null = null;
  private refactorAccepted = 0;
  private busyRefactor = false;

  private readonly retryAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly refactorEnabled: boolean;
  private recoverableError: string | null = null;
  private solutionError: string | null = null;
  private pipelineStep = 0;
  private driving = false;
  private attackChainDone = false;
  // Set when an interrupted session is resumed and both module + tests
  // already exist on disk - the pipeline then jumps straight to GREEN.
  private resumedWithTests = false;
  private startedAtMs = Date.now();
  // Per-project generation rules from .redgreen.json, loaded once per run.
  private customRules: string[] = [];
  private rulesLoadError: string | null = null;
  private rulesAnnounced = false;
  // Project-local history of finished features (.redgreen/history.jsonl).
  private readonly memory: SessionMemory;
  // Include JSDoc comments on stub functions (from config.stubComments).
  private readonly stubComments: boolean;

  private pendingWaitResolve: ((choice: WaitChoice) => void) | null = null;
  private waitTimer: NodeJS.Timeout | null = null;
  private activeWatcher: ReturnType<typeof watch> | null = null;

  constructor(opts: DevSessionOptions) {
    super();
    this.feature = opts.feature;
    this.runner = opts.runner;
    this.chat = opts.chat;
    this.cwd = opts.cwd ?? process.cwd();
    this.execute = opts.execute ?? runTests;
    this.headless = opts.headless ?? false;
    this.greenTimeoutMs = opts.greenTimeoutMs ?? null;
    this.retryAttempts = opts.retryAttempts ?? resolveRetryAttempts();
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? 1500;
    this.refactorEnabled = opts.refactorEnabled ?? resolveRefactorEnabled();
    this.stubComments = opts.stubComments ?? true;
    this.memory = new SessionMemory(this.cwd);
    this.loadRules();
  }

  private loadRules(): void {
    const loaded = loadCustomRules(this.cwd);
    if (loaded.error) {
      // Surface via the announce step once listeners are attached; never
      // block generation because of a malformed rules file.
      this.customRules = [];
      this.rulesLoadError = loaded.error;
    } else {
      this.customRules = loaded.rules;
      this.rulesLoadError = null;
    }
    this.rulesAnnounced = false;
  }

  private announceRules(): void {
    if (this.rulesAnnounced) return;
    this.rulesAnnounced = true;
    if (this.rulesLoadError) {
      this.log(`Ignoring .redgreen.json: ${this.rulesLoadError}`);
      this.pushEvent({ type: 'error', message: `Ignoring .redgreen.json - ${this.rulesLoadError}` });
    } else if (this.customRules.length > 0) {
      const n = this.customRules.length;
      const msg = `Loaded ${n} project rule${n === 1 ? '' : 's'} from .redgreen.json`;
      this.log(msg);
      this.pushEvent({ type: 'info', message: msg });
    }
  }

  snapshot(): SessionSnapshot {
    return {
      statuses: { ...this.statuses },
      result: this.result,
      logs: [...this.logs],
      events: [...this.events],
      prompt: this.prompt,
      moduleName: this.moduleName,
      files: { ...this.files, attacks: [...this.files.attacks] },
      attackRoundsSurvived: this.attackRoundsSurvived,
      finished: this.finished,
      finalGreen: this.finalGreen,
      hints: this.hints,
      hintUnlocks: {
        small: this.hintUnlocked('small'),
        medium: this.hintUnlocked('medium'),
        big: this.hintUnlocked('big'),
      },
      nudgesRegenerated: this.nudgesRegenerated,
      greenFailures: this.greenFailures,
      greenReached: this.greenReachedAt !== null,
      solution: this.solution,
      solutionExplanation: this.solutionExplanation,
      refactor: this.refactor,
      refactorDone: this.refactorDone,
      refactorPending: this.refactorProposal !== null,
      refactorAccepted: this.refactorAccepted,
      recoverableError: this.recoverableError,
      solutionError: this.solutionError,
    };
  }

  private emitUpdate(): void {
    this.emit('update', this.snapshot());
  }

  private log(line: string): void {
    this.logs.push(line);
    if (this.logs.length > 30) this.logs.shift();
    this.emit('log', line);
    this.emitUpdate();
  }

  private pushEvent(ev: SessionEvent): void {
    this.events.push(ev);
    if (this.events.length > 40) this.events.shift();
    this.emitUpdate();
  }

  private setPrompt(prompt: string | null): void {
    this.prompt = prompt;
    this.emitUpdate();
  }

  private setStatuses(patch: Partial<Record<PhaseId, PhaseStatus>>): void {
    this.statuses = { ...this.statuses, ...patch };
    this.emitUpdate();
  }

  dispose(): void {
    this.resolveWait('quit');
    if (this.activeWatcher) {
      void this.activeWatcher.close();
      this.activeWatcher = null;
    }
    this.removeAllListeners();
  }

  approve(): void {
    this.resolveWait('approve');
  }

  skip(): void {
    this.resolveWait('skip');
  }

  quit(): void {
    this.quitting = true;
    this.resolveWait('quit');
  }

  hintUnlocked(tier: HintTier): boolean {
    if (!this.hints) return false;
    if (this.greenReachedAt !== null) return true;
    if (tier === 'small') return true;
    if (tier === 'medium') return this.greenFailures >= 1;
    return this.greenFailures >= 2;
  }

  async revealHint(tier: HintTier): Promise<string | null> {
    if (!this.hints) return null;
    if (!this.hintUnlocked(tier)) return null;
    if (this.greenReachedAt === null) {
      await this.refreshNudges();
    }
    const hint = this.hints?.[tier];
    if (!hint) return null;
    this.log(`Hint (${tier}) revealed`);
    this.pushEvent({ type: 'info', message: `Hint (${tier}) revealed` });
    return hint;
  }

  /**
   * Re-derives the small/medium/big nudge tiers against the CURRENT failing
   * assertion when the developer is still stuck on GREEN and the failure
   * surface has changed since the hints were minted (or last regenerated).
   * No-op when GREEN is reached, the failure is unchanged, or a regeneration
   * is already in flight.
   */
  async refreshNudges(): Promise<boolean> {
    if (this.nugging) return false;
    if (this.greenReachedAt !== null) return false;
    const current = this.failureSignature();
    if (!current || current === this.hintsTarget) return false;

    this.nugging = true;
    this.log('Failure changed - regenerating nudges for the current assertion...');
    this.emitUpdate();
    try {
      const { value } = await this.chatWithBackoff('Nudge', () =>
        completeStructured({
          chat: this.chat,
          debugTag: 'nudge',
          schema: HINTS_SCHEMA,
          ...buildNudgePrompt({
            feature: this.feature,
            runner: this.runner,
            moduleName: this.moduleName ?? moduleNameFromFeature(this.feature),
            typesPath: this.relative(this.files.types),
            implPath: this.relative(this.files.impl),
            typesContent: this.readFileSafe(this.files.types ?? ''),
            implContent: this.readFileSafe(this.files.impl ?? ''),
            failingAssertions: this.describeFailures(),
            customRules: this.customRules,
          }),
        }),
      );
      this.hints = value;
      this.hintsTarget = current;
      this.nudgesRegenerated += 1;
      this.log('Nudges regenerated - now targeting the current failure');
      this.pushEvent({
        type: 'info',
        message: 'Nudges regenerated - hints now target the current failure',
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`Nudge regeneration failed: ${msg}`);
      this.pushEvent({ type: 'error', message: 'Nudge regeneration failed' });
      return false;
    } finally {
      this.nugging = false;
      this.emitUpdate();
    }
  }

  private failureSignature(): string {
    const r = this.result;
    if (!r || r.failures.length === 0) return '';
    return r.failures
      .map((f) => `${f.title}\u0000${f.message}`)
      .sort()
      .join('\n');
  }

  private describeFailures(): string {
    const r = this.result;
    if (!r || r.failures.length === 0) return '(suite currently green or no result)';
    return r.failures.map((f, i) => `${i + 1}. ${f.title}\n   ${f.message}`).join('\n');
  }

  async requestSolution(): Promise<void> {
    if (this.solution !== null) return;
    if (this.greenReachedAt === null) {
      this.log('Solution locked - reach GREEN first');
      this.pushEvent({ type: 'info', message: 'Solution locked - reach GREEN first' });
      return;
    }
    this.log('Generating reference solution...');
    this.pushEvent({ type: 'info', message: 'Generating reference solution...' });
    this.solutionError = null;
    this.emitUpdate();
    try {
      const { value } = await this.chatWithBackoff('Solution', () =>
        completeStructured({
          chat: this.chat,
          debugTag: 'solution',
          schema: SOLUTION_SCHEMA,
          ...buildSolutionPrompt({
            feature: this.feature,
            runner: this.runner,
            moduleName: this.moduleName ?? moduleNameFromFeature(this.feature),
            typesPath: this.relative(this.files.types),
            implPath: this.relative(this.files.impl),
            typesContent: this.readFileSafe(this.files.types ?? ''),
            implContent: this.readFileSafe(this.files.impl ?? ''),
            testsContent: this.readFileSafe(this.files.tests ?? ''),
            customRules: this.customRules,
          }),
        }),
      );
      this.solution = value.solutionFile;
      this.solutionExplanation = value.explanation;
      this.log('Reference solution ready');
      this.pushEvent({ type: 'info', message: 'Reference solution ready - press S to view' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.solutionError = msg;
      this.log(`Reference solution failed: ${msg}`);
      this.pushEvent({ type: 'error', message: 'Solution generation failed - press S to retry' });
    }
    this.emitUpdate();
  }

  async restart(newFeature: string): Promise<void> {
    if (!this.finished) {
      this.log('Current feature still running - finish it first');
      return;
    }
    this.feature = newFeature;
    this.forceFreshScaffold = true;
    this.generation += 1;
    this.resetState();
    this.emitUpdate();
    await this.start();
  }

  private resetState(): void {
    this.statuses = { scaffold: 'active', red: 'pending', green: 'pending', attack: 'pending', refactor: 'pending' };
    this.result = null;
    this.logs = [];
    this.events = [];
    this.prompt = null;
    this.moduleName = null;
    this.files = { types: null, impl: null, tests: null, attacks: [] };
    this.attackRoundsSurvived = 0;
    this.finished = false;
    this.finalGreen = false;
    this.quitting = false;
    this.redEndedAt = null;
    this.greenReachedAt = null;
    this.hints = null;
    this.hintsTarget = null;
    this.nudgesRegenerated = 0;
    this.nugging = false;
    this.solution = null;
    this.solutionExplanation = null;
    this.greenFailures = 0;
    this.refactor = null;
    this.refactorDone = false;
    this.refactorProposal = null;
    this.refactorAccepted = 0;
    this.busyRefactor = false;
    // NOTE: forceFreshScaffold is intentionally NOT reset here - restart()
    // sets it before calling resetState so the next scaffold skips reuse.
    this.recoverableError = null;
    this.solutionError = null;
    this.pipelineStep = 0;
    this.driving = false;
    this.attackChainDone = false;
    this.resumedWithTests = false;
    this.startedAtMs = Date.now();
    this.loadRules();
    this.pendingWaitResolve = null;
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
    if (this.activeWatcher) {
      void this.activeWatcher.close();
      this.activeWatcher = null;
    }
  }

  private resolveWait(choice: WaitChoice): void {
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
    if (this.pendingWaitResolve) {
      const resolve = this.pendingWaitResolve;
      this.pendingWaitResolve = null;
      resolve(choice);
    }
  }

  private wait(timeoutMs: number | null): Promise<WaitChoice> {
    return new Promise((resolve) => {
      this.pendingWaitResolve = resolve;
      if (timeoutMs !== null) {
        this.waitTimer = setTimeout(() => {
          this.resolveWait('timeout');
        }, timeoutMs);
      }
    });
  }

  private projectContext(): string {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(this.cwd, 'package.json'), 'utf8')) as {
        type?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const keyDeps = Object.keys(deps)
        .filter((d) => /^(@types\/|typescript|vitest|jest|mocha|tsx|zod)/.test(d))
        .sort()
        .join(', ');
      return `package.json type="${pkg.type ?? 'commonjs'}"\nRelevant deps: ${keyDeps || '(none)'}`;
    } catch {
      return '(no package.json)';
    }
  }

  private readFileSafe(file: string): string {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  }

  private async runTestsOn(files: string[], label = 'run'): Promise<TestRunResult> {
    const r = await this.execute(this.runner, { files, cwd: this.cwd });
    this.result = r;
    this.pushEvent({ type: 'result', label, result: r });
    this.emitUpdate();
    return r;
  }

  async start(): Promise<void> {
    await this.drive(0);
  }

  /**
   * Re-runs the pipeline step that failed with a recoverable AI error.
   * No-op when nothing is paused, a drive loop is already active, or the
   * session already finished.
   */
  async retryFailedStep(): Promise<void> {
    if (!this.recoverableError || this.driving || this.finished) return;
    const label = this.currentStepLabel();
    this.recoverableError = null;
    this.log(`Retrying ${label}...`);
    await this.drive(this.pipelineStep);
  }

  private currentStepLabel(): string {
    switch (this.pipelineStep) {
      case 0: return 'scaffold';
      case 1: return 'review';
      case 2: return 'red phase';
      case 3: return 'green phase';
      default:
        if (this.pipelineStep < REFACTOR_STEP) return `attack round ${this.pipelineStep - 3}`;
        return `refactor round ${this.pipelineStep - REFACTOR_STEP + 1}`;
    }
  }

  private async drive(fromStep: number): Promise<void> {
    if (this.driving) return;
    this.driving = true;
    this.announceRules();
    const gen = this.generation;
    try {
      for (let step = fromStep; step < PIPELINE_STEPS; step++) {
        this.pipelineStep = step;
        const outcome = await this.runStep(step);
        if (gen !== this.generation) return; // superseded by restart()
        if (outcome === 'paused') return;
        if (outcome === 'finish-failed') return this.finish(false);
        if (outcome === 'finish-current') return this.finish(this.finalStatusWasGreen());
      }
      this.finish(this.finalStatusWasGreen());
    } finally {
      this.driving = false;
    }
  }

  private runStep(step: number): Promise<StepOutcome> {
    switch (step) {
      case 0: return this.stepScaffold();
      case 1: return this.stepReviewGate();
      case 2: return this.stepRed();
      case 3: return this.stepGreenWatch();
      case REFACTOR_STEP: return this.stepRefactor();
      default: return this.stepAttack(step - 3);
    }
  }

  /**
   * Records a failed-but-recoverable state: the session stays alive and the
   * UI offers `r` to retry. Unlike the old catch-all this never kills the
   * session for provider hiccups (quota blips, network flake, bad schema).
   */
  private pauseWithError(label: string, err: unknown): void {
    if (this.finished) return;
    const msg = err instanceof Error ? err.message : String(err);
    this.recoverableError = msg;
    this.setPrompt(null);
    this.log(`${label} failed: ${msg}`);
    this.pushEvent({ type: 'error', message: `${label} failed - press r to retry` });
    this.emitUpdate();
  }

  /** Runs an AI call with bounded exponential backoff before giving up. */
  private async chatWithBackoff<T>(label: string, run: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retryAttempts; attempt++) {
      if (attempt > 0) {
        const delayMs = Math.min(30_000, this.retryBaseDelayMs * 2 ** (attempt - 1));
        this.log(
          `${label} failed - retrying in ${Math.round((delayMs / 100) * 10) / 10}s` +
            ` (attempt ${attempt + 1}/${this.retryAttempts + 1})`,
        );
        await this.sleepInterruptible(delayMs);
      }
      if (this.quitting && attempt > 0) throw lastError ?? new Error('cancelled');
      try {
        return await run();
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  private async sleepInterruptible(ms: number): Promise<void> {
    const slice = 200;
    let waited = 0;
    while (waited < ms && !this.quitting) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(slice, ms - waited)));
      waited += slice;
    }
  }

  private async stepScaffold(): Promise<StepOutcome> {
    try {
      await this.runScaffold();
    } catch (err) {
      this.pauseWithError('Scaffold', err);
      return 'paused';
    }
    if (this.quitting) return 'finish-failed';
    return 'continue';
  }

  private async stepReviewGate(): Promise<StepOutcome> {
    if (this.headless || this.resumedWithTests) return 'continue';
    this.setPrompt('Press Enter to approve the contract, q to quit');
    const choice = await this.wait(null);
    if (choice === 'quit') return 'finish-failed';
    if (choice !== 'approve') this.log('Contract approved without review');
    return 'continue';
  }

  private async stepRed(): Promise<StepOutcome> {
    if (this.resumedWithTests) {
      this.setStatuses({ red: 'done' });
      return 'continue';
    }
    let redOk: boolean;
    try {
      redOk = await this.runRed();
    } catch (err) {
      this.pauseWithError('Red phase', err);
      return 'paused';
    }
    if (this.quitting) return 'finish-failed';
    if (!redOk) this.log('Warning: could not establish RED - tests passed against the stub');
    return this.stepTestReview(redOk);
  }

  /**
   * TiCoder-style intent gate: once the suite is confirmed RED, pause and let
   * the developer review (or adjust) the generated tests before any
   * implementation exists. The tests ARE the formalized intent - validating
   * them here prevents a full implementation cycle built on a misread.
   */
  private async stepTestReview(redOk: boolean): Promise<StepOutcome> {
    if (this.headless || this.resumedWithTests || !redOk || !this.files.tests) return 'continue';
    this.setPrompt(
      'Tests are RED - they encode your intent · v to view them · enter to start GREEN · q quit',
    );
    const choice = await this.wait(null);
    if (choice === 'quit') return 'finish-failed';
    if (choice !== 'approve') {
      this.log('Proceeding without reviewing the RED tests');
      return 'continue';
    }
    // The developer may have edited the tests while reviewing - re-establish RED.
    const r = await this.runTestsOn([this.files.tests!], 'RED re-verify');
    if (r.failed > 0) {
      this.log(`${r.total} tests run: ${r.passed} passed - still RED as expected`);
    } else {
      this.log('Warning: the suite no longer starts RED after your test edits');
    }
    return 'continue';
  }

  private async stepGreenWatch(): Promise<StepOutcome> {
    try {
      await this.runGreen('Implement the module', [this.files.tests!]);
    } catch (err) {
      this.pauseWithError('Green phase', err);
      return 'paused';
    }
    if (this.quitting) return 'finish-failed';
    return 'continue';
  }

  private async stepAttack(round: number): Promise<StepOutcome> {
    // Rounds are explicit pipeline steps; once the chain is stopped (user
    // skip / suite not green after a round) later rounds become no-ops.
    if (this.attackChainDone) return 'continue';
    try {
      await this.runAttackRound(round);
    } catch (err) {
      this.pauseWithError(`Attack round ${round}`, err);
      return 'paused';
    }
    if (this.quitting) return 'finish-current';

    const outcome = await this.watchUntilGreen([this.files.tests!, ...this.files.attacks]);
    if (this.quitting) return 'finish-current';
    if (!isGreen(outcome.result)) {
      this.log(`Attack round ${round} aborted - suite not green (${outcome.result.passed}/${outcome.result.total} passing)`);
      this.pushEvent({ type: 'attack', round, total: MAX_ATTACK_ROUNDS, survived: false });
      this.attackChainDone = true;
      return 'continue';
    }

    this.attackRoundsSurvived = round;
    this.log(`Attack round ${round} survived`);
    this.pushEvent({ type: 'attack', round, total: MAX_ATTACK_ROUNDS, survived: true });
    this.emitUpdate();

    if (round < MAX_ATTACK_ROUNDS) {
      this.setPrompt('Press Enter for another attack round, s to stop, q to quit');
      const choice = await this.wait(this.headless ? this.greenTimeoutMs : null);
      if (choice === 'quit') return 'finish-current';
      if (choice !== 'approve') this.attackChainDone = true;
    }
    return 'continue';
  }

  private finalStatusWasGreen(): boolean {
    return Boolean(this.result && isGreen(this.result));
  }

  private async stepRefactor(): Promise<StepOutcome> {
    // Interactive edit phase - pointless headlessly unless REDGREEN_REFACTOR opts in.
    if (this.headless && !this.refactorEnabled) return 'continue';
    if (!this.finalStatusWasGreen()) {
      this.log('Refactor phase skipped - suite is not green');
      this.pushEvent({ type: 'info', message: 'Refactor phase skipped (suite not green)' });
      return 'continue';
    }
    try {
      await this.runRefactorRound();
    } catch (err) {
      this.pauseWithError('Refactor phase', err);
      return 'paused';
    }
    if (this.quitting) return 'finish-current';

    if (this.refactorEnabled) {
      // Unattended mode: verify and auto-accept every suggestion, no approval.
      await this.runAutoRefactor();
      return 'continue';
    }

    const outcome = await this.watchRefactorEdits();
    if (outcome.choice === 'quit') return 'finish-current';

    this.refactorDone = true;
    const green = isGreen(outcome.result);
    this.log(
      green
        ? this.refactorAccepted > 0
          ? `Refactor complete - tests still green (${this.refactorAccepted} applied)`
          : 'Refactor complete - tests still green'
        : 'Refactor complete (tests not green)',
    );
    this.setStatuses({ refactor: green ? 'done' : 'error' });
    return 'continue';
  }

  /**
   * Unattended refactoring (REDGREEN_REFACTOR): walks every suggestion through
   * the suite-verified auto-apply and accepts it on GREEN. A suggestion that
   * breaks a test is rejected (file restored) and the loop moves on.
   */
  private async runAutoRefactor(): Promise<void> {
    const count = this.refactor?.suggestions.length ?? 0;
    while (this.refactorAccepted < count) {
      if (this.finished || this.quitting) return;
      await this.applyRefactor();
      // A pending proposal means GREEN - accept it; otherwise the apply was
      // rejected or failed and the file was already restored - move on.
      if (!this.refactorProposal) break;
      this.acceptRefactorProposal();
    }
    this.refactorDone = true;
    const green = isGreen(this.result ?? this.emptyResult());
    this.log(
      green
        ? this.refactorAccepted > 0
          ? `Refactor complete - tests still green (${this.refactorAccepted} applied)`
          : 'Refactor complete - tests still green'
        : 'Refactor complete (tests not green)',
    );
    this.setStatuses({ refactor: green ? 'done' : 'error' });
  }

  private async runRefactorRound(): Promise<void> {
    this.setStatuses({ refactor: 'active' });
    this.setPrompt('Analyzing your implementation for refactors...');

    const allTests = [this.files.tests, ...this.files.attacks]
      .filter((f): f is string => Boolean(f))
      .map((f) => this.readFileSafe(f))
      .join('\n\n');

    const { value } = await this.chatWithBackoff('Refactor', () =>
      completeStructured({
        chat: this.chat,
        debugTag: 'refactor',
        schema: REFACTOR_SCHEMA,
        ...buildRefactorPrompt({
          feature: this.feature,
          runner: this.runner,
          moduleName: this.moduleName ?? moduleNameFromFeature(this.feature),
          typesPath: this.relative(this.files.types),
          implPath: this.relative(this.files.impl),
          typesContent: this.readFileSafe(this.files.types ?? ''),
          implContent: this.readFileSafe(this.files.impl ?? ''),
          testsContent: allTests,
          customRules: this.customRules,
        }),
      }),
    );

    this.refactor = value;
    const n = value.suggestions.length;
    this.log(`Refactor: ${n} suggestion${n === 1 ? '' : 's'} ready - press v to view`);
    this.pushEvent({ type: 'refactor', message: `${n} refactor suggestion${n === 1 ? '' : 's'} ready - press v to view` });
    this.emitUpdate();
  }

  private refactorWatchPrompt(): string {
    return 'Refactor freely - re-runs on save · a auto-apply · enter done · q quit';
  }

  /**
   * Auto-applies a refactor suggestion the safe way: the AI produces the full
   * candidate implementation, RedGreen runs the test suite against it, and the
   * candidate only enters the workspace on GREEN. A red (or failed) attempt is
   * reverted automatically. The developer still keeps final say: a verified
   * proposal awaits `a` (accept) or `r` (reject).
   */
  async applyRefactor(): Promise<void> {
    if (this.refactorProposal) {
      this.acceptRefactorProposal();
      return;
    }
    if (!this.refactor || this.refactor.suggestions.length === 0 || this.finished || this.busyRefactor) return;

    const idx = Math.min(this.refactorAccepted, this.refactor.suggestions.length - 1);
    const suggestion = this.refactor.suggestions[idx];
    this.busyRefactor = true;
    this.setPrompt(`Applying "${suggestion.title}" - verifying against the suite...`);
    try {
      const implPath = this.files.impl;
      if (!implPath) return;
      const original = this.readFileSafe(implPath);

      const { value } = await this.chatWithBackoff('Refactor apply', () =>
        completeStructured({
          chat: this.chat,
          debugTag: 'refactor-apply',
          schema: REFACTOR_APPLY_SCHEMA,
          ...buildRefactorApplyPrompt({
            feature: this.feature,
            runner: this.runner,
            moduleName: this.moduleName ?? moduleNameFromFeature(this.feature),
            typesPath: this.relative(this.files.types),
            implPath: this.relative(implPath),
            typesContent: this.readFileSafe(this.files.types ?? ''),
            implContent: original,
            testsContent: [this.files.tests, ...this.files.attacks]
              .filter((f): f is string => Boolean(f))
              .map((f) => this.readFileSafe(f))
              .join('\n\n'),
            customRules: this.customRules,
            suggestion,
          }),
        }),
      );

      fs.writeFileSync(implPath, value.code.trimEnd() + '\n');
      const cascadeFiles = [this.files.tests, ...this.files.attacks].filter(
        (f): f is string => Boolean(f),
      );
      const r = await this.runTestsOn(cascadeFiles, `refactor "${suggestion.title}"`);

      if (isGreen(r)) {
        this.refactorProposal = { filePath: implPath, original, proposed: value.code, result: r };
        this.log(`Refactor applied & verified GREEN (${r.passed}/${r.total}) - press a to accept, r to reject`);
        this.pushEvent({ type: 'refactor', message: `"${suggestion.title}" verified green - a accept · r reject` });
        this.setPrompt('Refactor verified GREEN · a accept · r reject');
      } else {
        fs.writeFileSync(implPath, original);
        this.log(`Refactor rejected - suite went red (${r.failed} failing), restoring your file`);
        this.pushEvent({ type: 'refactor', message: `"${suggestion.title}" rejected - broke ${r.failed} test(s), reverted` });
        const revert = await this.runTestsOn(cascadeFiles, 'refactor revert');
        this.log(isGreen(revert) ? 'Restored implementation confirmed GREEN' : `Restored suite left red (${revert.passed}/${revert.total})`);
        this.setPrompt(this.refactorWatchPrompt());
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`Refactor apply failed: ${msg} - your file was not touched`);
      this.pushEvent({ type: 'error', message: 'Refactor apply failed - your file was not touched' });
      this.setPrompt(this.refactorWatchPrompt());
    } finally {
      this.busyRefactor = false;
      this.emitUpdate();
    }
  }

  /** Keeps the verified proposal on disk and counts it as an applied refactor. */
  acceptRefactorProposal(): boolean {
    if (!this.refactorProposal || this.finished) return false;
    this.refactorProposal = null;
    this.refactorAccepted += 1;
    this.log(`Refactor accepted (${this.refactorAccepted} applied) - suite stayed green`);
    this.pushEvent({ type: 'refactor', message: `Refactor accepted - ${this.refactorAccepted} applied` });
    this.setPrompt(this.refactorWatchPrompt());
    this.emitUpdate();
    return true;
  }

  /** Reverts the proposal, restores the original file, and re-verifies GREEN. */
  async rejectRefactorProposal(): Promise<boolean> {
    const p = this.refactorProposal;
    if (!p || this.finished) return false;
    fs.writeFileSync(p.filePath, p.original);
    this.refactorProposal = null;
    this.log('Refactor rejected - restoring your implementation and re-verifying');
    this.pushEvent({ type: 'refactor', message: 'Refactor rejected - restored your implementation' });
    this.setPrompt(this.refactorWatchPrompt());
    this.emitUpdate();
    this.busyRefactor = true;
    try {
      const r = await this.runTestsOn(
        [this.files.tests, ...this.files.attacks].filter((f): f is string => Boolean(f)),
        'refactor revert',
      );
      this.log(isGreen(r) ? 'Restored implementation confirmed GREEN' : `Restored suite left red (${r.passed}/${r.total})`);
    } finally {
      this.busyRefactor = false;
    }
    return true;
  }

  private watchRefactorEdits(): Promise<{ result: TestRunResult; choice: WaitChoice }> {
    return new Promise((resolve) => {
      const targets = [this.files.impl!, ...(this.files.types ? [this.files.types!] : [])].filter(
        Boolean,
      );
      const watcher = watch(targets, { ignoreInitial: true });
      this.activeWatcher = watcher;
      let debounce: NodeJS.Timeout | null = null;
      let settled = false;
      const files = [this.files.tests!, ...this.files.attacks];

      const finish = (choice: WaitChoice): void => {
        if (settled) return;
        settled = true;
        if (debounce) clearTimeout(debounce);
        this.activeWatcher = null;
        void watcher.close();
        resolve({ result: this.result ?? this.emptyResult(), choice });
      };

      const run = async (): Promise<void> => {
        if (this.busyRefactor) return;
        try {
          const r = await this.runTestsOn(files, 'refactor');
          if (isGreen(r)) {
            this.log(`GREEN - tests still pass (${r.passed}/${r.total}) after your edits`);
          } else {
            this.log(`Tests went red (${r.passed}/${r.total} passing) - keep refactoring or undo`);
          }
        } catch (err) {
          this.log(`Test run failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      watcher.on('change', () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void run(), 300);
      });

      this.setPrompt(this.refactorWatchPrompt());
      void this.wait(null).then((choice) => finish(choice));
    });
  }

  private finish(finalGreen: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.finalGreen = finalGreen;
    this.setPrompt(null);
    this.setStatuses({
      scaffold: 'done',
      red: 'done',
      green: finalGreen ? 'done' : 'error',
      attack: this.attackRoundsSurvived > 0 ? 'done' : 'pending',
      refactor: this.refactorDone ? (finalGreen ? 'done' : 'error') : 'pending',
    });
    this.pushSummaryEvent(finalGreen);
    this.emit('finish', finalGreen);
    if (this.moduleName) {
      this.memory.record({
        feature: this.feature,
        moduleName: this.moduleName,
        outcome: finalGreen ? 'green' : 'red',
        attacksSurvived: this.attackRoundsSurvived,
      });
    }
  }

  private timeToGreenSeconds(): number | null {
    if (this.redEndedAt === null || this.greenReachedAt === null) return null;
    return Math.max(0, Math.round((this.greenReachedAt - this.redEndedAt) / 1000));
  }

  private pushSummaryEvent(finalGreen: boolean): void {
    const r = this.result;
    const bits = [
      finalGreen ? 'GREEN' : 'not green',
      r ? `${r.passed}/${r.total} passing` : 'no test run',
      `attacks ${this.attackRoundsSurvived}/${MAX_ATTACK_ROUNDS}`,
      `refactor ${this.refactorDone ? (this.refactorAccepted > 0 ? `done, ${this.refactorAccepted} applied` : 'done') : '-'}`,
    ];
    const ttg = this.timeToGreenSeconds();
    if (ttg !== null) bits.push(`green in ${formatDuration(ttg * 1000)}`);
    bits.push(`total ${formatDuration(Date.now() - this.startedAtMs)}`);
    this.pushEvent({ type: 'summary', green: finalGreen, message: bits.join(' · ') });
  }

  private async runScaffold(): Promise<void> {
    this.setPrompt('Scaffolding contracts...');
    const srcDir = path.join(this.cwd, 'src');
    const nameFromDisk = this.forceFreshScaffold ? null : this.findExistingModule(srcDir);

    if (nameFromDisk) {
      this.moduleName = nameFromDisk;
      const typesPath = path.join(srcDir, `${nameFromDisk}.types.ts`);
      const implPath = path.join(srcDir, `${nameFromDisk}.ts`);
      // Resume support: if the RED tests from a previous session are still on
      // disk, reuse them and skip both scaffold and red generation entirely.
      const testsDir = path.join(this.cwd, 'tests');
      const testCandidates = [
        path.join(testsDir, `${nameFromDisk}.test.ts`),
        path.join(testsDir, `${nameFromDisk}.red.test.ts`),
      ];
      const existingTest = testCandidates.find((t) => fs.existsSync(t)) ?? null;
      this.files = {
        types: fs.existsSync(typesPath) ? typesPath : null,
        impl: fs.existsSync(implPath) ? implPath : null,
        tests: existingTest,
        attacks: [],
      };
      if (existingTest) {
        this.resumedWithTests = true;
        this.log(
          `Resuming - reusing ${this.relative(this.files.impl)} + ${this.relative(existingTest)}, jumping to GREEN`,
        );
        this.pushEvent({
          type: 'info',
          message: `Resuming: reusing ${this.relative(this.files.impl)} + ${this.relative(existingTest)}`,
        });
        this.setStatuses({ scaffold: 'done', red: 'done' });
      } else {
        this.log(`Reusing existing module "src/${nameFromDisk}.ts" - skipping scaffold generation`);
        this.pushEvent({ type: 'info', message: `Reusing existing module src/${nameFromDisk}.ts` });
        this.setStatuses({ scaffold: 'done' });
      }
      return;
    }

    const pastFeatures = this.memory
      .relevant(this.feature, 3)
      .map((rec) => `${rec.moduleName} - ${rec.feature}`);
    const { value } = await this.chatWithBackoff('Scaffold', () =>
      completeStructured({
        chat: this.chat,
        debugTag: 'scaffold',
        schema: SCAFFOLD_SCHEMA,
        ...buildScaffoldPrompt({
          feature: this.feature,
          runner: this.runner,
          projectContext: this.projectContext(),
          customRules: this.customRules,
          pastFeatures,
          stubComments: this.stubComments,
        }),
      }),
    );

    this.moduleName = value.moduleName;
    fs.mkdirSync(srcDir, { recursive: true });

    const typesPath = path.join(srcDir, `${value.moduleName}.types.ts`);
    const implPath = path.join(srcDir, `${value.moduleName}.ts`);

    this.writeIfAbsent(typesPath, value.typesFile);
    this.writeIfAbsent(implPath, value.implFile);

    this.files = {
      types: fs.existsSync(typesPath) ? typesPath : null,
      impl: fs.existsSync(implPath) ? implPath : null,
      tests: null,
      attacks: [],
    };
    this.log(`Contract written: ${this.relative(this.files.types)}, ${this.relative(this.files.impl)}`);
    this.pushEvent({
      type: 'write',
      message: `Contract written: ${this.relative(this.files.types)}, ${this.relative(this.files.impl)}`,
    });
    this.setStatuses({ scaffold: 'done' });
  }

  private findExistingModule(srcDir: string): string | null {
    if (!fs.existsSync(srcDir)) return null;
    const candidates = fs
      .readdirSync(srcDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.types.ts') && !f.endsWith('.test.ts'));
    if (candidates.length === 0) return null;
    const preferred = moduleNameFromFeature(this.feature) + '.ts';
    if (candidates.includes(preferred)) return preferred.slice(0, -3);
    return candidates[0].slice(0, -3);
  }

  private writeIfAbsent(file: string, content: string): void {
    if (fs.existsSync(file)) {
      this.log(`Keeping existing file ${this.relative(file)}`);
      return;
    }
    fs.writeFileSync(file, content.trimEnd() + '\n');
  }

  private relative(file: string | null): string {
    return file ? path.relative(this.cwd, file) : '';
  }

  private async runRed(): Promise<boolean> {
    this.setStatuses({ red: 'active' });
    this.setPrompt('Generating failing tests...');

    const base = {
      feature: this.feature,
      runner: this.runner,
      moduleName: this.moduleName ?? moduleNameFromFeature(this.feature),
      typesPath: this.relative(this.files.types),
      implPath: this.relative(this.files.impl),
      typesContent: this.readFileSafe(this.files.types ?? ''),
      implContent: this.readFileSafe(this.files.impl ?? ''),
    };

    let alreadyPassingNote: string | undefined;
    let testPath: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { value } = await this.chatWithBackoff('Red tests', () =>
        completeStructured({
          chat: this.chat,
          debugTag: 'red-tests',
          schema: RED_SCHEMA,
          ...buildRedPrompt({ ...base, alreadyPassingNote, customRules: this.customRules }),
        }),
      );

      if (value.hints) this.hints = value.hints;

      if (testPath) {
        fs.writeFileSync(testPath, value.testFile.trimEnd() + '\n');
      } else {
        testPath = this.pickTestFilePath();
        fs.writeFileSync(testPath, value.testFile.trimEnd() + '\n');
      }
      this.files.tests = testPath;
      this.log(`Tests written: ${this.relative(testPath)}`);
      this.pushEvent({ type: 'write', message: `Tests written: ${this.relative(testPath)}` });

      const r = await this.runTestsOn([testPath], 'RED verify');
      this.log(`${r.total} tests run: ${r.passed} passed, ${r.failed} failed`);
      if (r.failed > 0) {
        this.redEndedAt = Date.now();
        this.hintsTarget = this.failureSignature();
        this.log(`RED confirmed - suite is failing as expected`);
        this.setStatuses({ red: 'done' });
        return true;
      }
      alreadyPassingNote = `Current suite has ${r.passed} passing / ${r.failed} failing.`;
    }

    this.log('Could not make the suite fail - continuing with GREEN suite');
    this.setStatuses({ red: 'done' });
    return false;
  }

  private pickTestFilePath(): string {
    const testsDir = path.join(this.cwd, 'tests');
    fs.mkdirSync(testsDir, { recursive: true });
    const moduleName = this.moduleName ?? moduleNameFromFeature(this.feature);
    const existing = path.join(testsDir, `${moduleName}.test.ts`);
    return fs.existsSync(existing)
      ? path.join(testsDir, `${moduleName}.red.test.ts`)
      : existing;
  }

  private async runGreen(label: string, files: string[]): Promise<TestRunResult> {
    this.setStatuses({ green: 'active' });
    this.log(`Watching for edits on src/${this.moduleName}.ts`);
    const outcome = await this.watchUntilGreen(files, { trackFailures: true });
    if (outcome.choice !== 'quit') {
      const green = isGreen(outcome.result);
      this.log(
        green
          ? `GREEN - all tests pass (${outcome.result.passed}/${outcome.result.total})`
          : `Leaving phase ${label} without GREEN (${outcome.result.passed}/${outcome.result.total} passing)`,
      );
      this.setStatuses({ green: green ? 'done' : 'active' });
    }
    return outcome.result;
  }

  private watchUntilGreen(
    files: string[],
    opts: { trackFailures?: boolean } = {},
  ): Promise<{ result: TestRunResult; choice: WaitChoice }> {
    return new Promise((resolve) => {
      const targets = [this.files.impl!, ...(this.files.types ? [this.files.types!] : [])].filter(
        Boolean,
      );
      const watcher = watch(targets, { ignoreInitial: true });
      this.activeWatcher = watcher;
      let debounce: NodeJS.Timeout | null = null;
      let settled = false;
      // The first run is the RED baseline; only user edits after it count as
      // failed attempts toward unlocking higher hint tiers.
      let firstRun = true;

      const finish = (result: TestRunResult, choice: WaitChoice): void => {
        if (settled) return;
        settled = true;
        if (debounce) clearTimeout(debounce);
        this.activeWatcher = null;
        void watcher.close();
        resolve({ result, choice });
      };

      const run = async (): Promise<void> => {
        try {
          const r = await this.runTestsOn(files, 'watch');
          if (opts.trackFailures && !firstRun && !isGreen(r)) {
            this.greenFailures += 1;
          }
          firstRun = false;
          if (isGreen(r)) {
            if (this.greenReachedAt === null) this.greenReachedAt = Date.now();
            finish(r, 'green');
          } else if (this.quitting) {
            finish(r, 'quit');
          } else {
            this.setPrompt(null);
          }
        } catch (err) {
          finish(
            {
              runner: this.runner,
              passed: 0,
              failed: 0,
              skipped: 0,
              total: 0,
              failures: [],
              durationMs: 0,
              rawOutput: err instanceof Error ? err.message : String(err),
            },
            'quit',
          );
        }
      };

      watcher.on('change', () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void run(), 300);
      });

      void run();
      void this.wait(this.greenTimeoutMs).then((choice) => {
        if (!settled) {
          finish(this.result ?? this.emptyResult(), choice);
        }
      });
    });
  }

  private emptyResult(): TestRunResult {
    return {
      runner: this.runner,
      passed: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      failures: [],
      durationMs: 0,
      rawOutput: '',
    };
  }

  private async runAttackRound(round: number): Promise<void> {
    this.setStatuses({ attack: 'active', green: 'active' });
    this.setPrompt(`Generating attack tests (round ${round})...`);

    const moduleName = this.moduleName ?? moduleNameFromFeature(this.feature);
    const { value } = await this.chatWithBackoff(`Attack round ${round}`, () =>
      completeStructured({
        chat: this.chat,
        debugTag: 'attack-tests',
        schema: ATTACK_SCHEMA,
        ...buildAttackPrompt({
          feature: this.feature,
          runner: this.runner,
          moduleName,
          implPath: this.relative(this.files.impl),
          implContent: this.readFileSafe(this.files.impl ?? ''),
          existingTests: this.readFileSafe(this.files.tests ?? ''),
          round,
          customRules: this.customRules,
        }),
      }),
    );

    const testsDir = path.join(this.cwd, 'tests');
    fs.mkdirSync(testsDir, { recursive: true });
    const attackPath = path.join(testsDir, `${moduleName}.attack.${round}.test.ts`);
    fs.writeFileSync(attackPath, value.testFile.trimEnd() + '\n');
    this.files.attacks.push(attackPath);
    this.log(`Attack tests written: ${this.relative(attackPath)}`);
    this.pushEvent({ type: 'write', message: `Attack tests written: ${this.relative(attackPath)}` });

    const r = await this.runTestsOn([this.files.tests!, ...this.files.attacks], `attack ${round}/${MAX_ATTACK_ROUNDS}`);
    this.log(`Attack round ${round} result: ${r.passed}/${r.total} passing`);
  }
}