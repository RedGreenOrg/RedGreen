import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { watch } from 'chokidar';
import type { ChatFn } from '../llm/client.js';
import { completeStructured } from '../llm/structured.js';
import {
  ATTACK_SCHEMA,
  RED_SCHEMA,
  SCAFFOLD_SCHEMA,
  buildAttackPrompt,
  buildRedPrompt,
  buildScaffoldPrompt,
} from '../prompts/prompts.js';
import { runTests } from '../runners/execute.js';
import { isGreen } from '../runners/types.js';
import type { TestRunResult, TestRunner } from '../runners/types.js';
import type { PhaseId, PhaseStatus } from '../phase/state.js';
import { syncSessionTelemetry } from '../telemetry/sync.js';
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
  prompt: string | null;
  moduleName: string | null;
  files: SessionFiles;
  attackRoundsSurvived: number;
  finished: boolean;
  finalGreen: boolean;
}

export interface DevSessionOptions {
  feature: string;
  runner: TestRunner;
  chat: ChatFn;
  cwd?: string;
  execute?: TestExecutor;
  headless?: boolean;
  greenTimeoutMs?: number | null;
}

const MAX_ATTACK_ROUNDS = 3;

export class DevSession extends EventEmitter {
  private readonly feature: string;
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
  };
  private result: TestRunResult | null = null;
  private logs: string[] = [];
  private prompt: string | null = null;
  private moduleName: string | null = null;
  private files: SessionFiles = { types: null, impl: null, tests: null, attacks: [] };
  private attackRoundsSurvived = 0;
  private finished = false;
  private finalGreen = false;
  private quitting = false;
  private redEndedAt: number | null = null;
  private greenReachedAt: number | null = null;

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
  }

  snapshot(): SessionSnapshot {
    return {
      statuses: { ...this.statuses },
      result: this.result,
      logs: [...this.logs],
      prompt: this.prompt,
      moduleName: this.moduleName,
      files: { ...this.files, attacks: [...this.files.attacks] },
      attackRoundsSurvived: this.attackRoundsSurvived,
      finished: this.finished,
      finalGreen: this.finalGreen,
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
        .filter((d) => /^(@types\/|typescript|vitest|jest|tsx|zod)/.test(d))
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

  private async runTestsOn(files: string[]): Promise<TestRunResult> {
    const r = await this.execute(this.runner, { files, cwd: this.cwd });
    this.result = r;
    this.emitUpdate();
    return r;
  }

  async start(): Promise<void> {
    try {
      await this.runScaffold();
      if (this.quitting) return this.finish(false);

      if (!this.headless) {
        this.setPrompt('Press Enter to approve the contract, q to quit');
        const choice = await this.wait(null);
        if (choice === 'quit') return this.finish(false);
        if (choice !== 'approve') this.log('Contract approved without review');
      }

      const redOk = await this.runRed();
      if (this.quitting) return this.finish(false);
      if (!redOk) this.log('Warning: could not establish RED - tests passed against the stub');

      await this.runGreen('Implement the module', [this.files.tests!]);
      if (this.quitting) return this.finish(false);

      for (let round = 1; round <= MAX_ATTACK_ROUNDS; round++) {
        if (this.quitting) break;
        await this.runAttackRound(round);
        if (this.quitting) break;

        const outcome = await this.watchUntilGreen([this.files.tests!, ...this.files.attacks]);
        if (this.quitting) break;
        if (!isGreen(outcome.result)) {
          this.log(`Attack round ${round} aborted - suite not green (${outcome.result.passed}/${outcome.result.total} passing)`);
          break;
        }

        this.attackRoundsSurvived = round;
        this.log(`Attack round ${round} survived`);
        this.emitUpdate();

        if (round < MAX_ATTACK_ROUNDS) {
          this.setPrompt('Press Enter for another attack round, s to stop, q to quit');
          const choice = await this.wait(this.headless ? this.greenTimeoutMs : null);
          if (choice !== 'approve') break;
        }
      }

      this.finish(this.finalStatusWasGreen());
    } catch (err) {
      this.log(`Error: ${err instanceof Error ? err.message : String(err)}`);
      this.finish(false);
    }
  }

  private finalStatusWasGreen(): boolean {
    return Boolean(this.result && isGreen(this.result));
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
    });
    this.emit('finish', finalGreen);
    this.syncTelemetry();
  }

  private syncTelemetry(): void {
    const testsPassed = this.result?.failed === 0 ? (this.result?.passed ?? 0) : 0;
    const timeToGreenSeconds =
      this.redEndedAt !== null && this.greenReachedAt !== null
        ? Math.max(0, Math.round((this.greenReachedAt - this.redEndedAt) / 1000))
        : 0;
    void syncSessionTelemetry({
      feature: this.feature,
      runner: this.runner,
      testsPassed,
      attackRoundsSurvived: this.attackRoundsSurvived,
      timeToGreenSeconds,
    }).then((result) => {
      if (result.synced) {
        this.log(
          `Telemetry synced - current streak: ${result.currentStreak ?? 0} days, ` +
            `total green tests: ${result.totalGreenTests ?? 0}`,
        );
      } else if (result.reason && result.reason !== 'no-supabase-config') {
        this.log(`Telemetry skipped (${result.reason})`);
      }
    }).catch(() => {
      // never let telemetry failures surface
    });
  }

  private async runScaffold(): Promise<void> {
    this.setPrompt('Scaffolding contracts...');
    const srcDir = path.join(this.cwd, 'src');
    const nameFromDisk = this.findExistingModule(srcDir);

    if (nameFromDisk) {
      this.moduleName = nameFromDisk;
      const typesPath = path.join(srcDir, `${nameFromDisk}.types.ts`);
      const implPath = path.join(srcDir, `${nameFromDisk}.ts`);
      this.files = {
        types: fs.existsSync(typesPath) ? typesPath : null,
        impl: fs.existsSync(implPath) ? implPath : null,
        tests: null,
        attacks: [],
      };
      this.log(`Reusing existing module "src/${nameFromDisk}.ts" - skipping scaffold generation`);
      this.setStatuses({ scaffold: 'done' });
      return;
    }

    const { value } = await completeStructured({
      chat: this.chat,
      debugTag: 'scaffold',
      schema: SCAFFOLD_SCHEMA,
      ...buildScaffoldPrompt({
        feature: this.feature,
        runner: this.runner,
        projectContext: this.projectContext(),
      }),
    });

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
      const { value } = await completeStructured({
        chat: this.chat,
        debugTag: 'red-tests',
        schema: RED_SCHEMA,
        ...buildRedPrompt({ ...base, alreadyPassingNote }),
      });

      if (testPath) {
        fs.writeFileSync(testPath, value.testFile.trimEnd() + '\n');
      } else {
        testPath = this.pickTestFilePath();
        fs.writeFileSync(testPath, value.testFile.trimEnd() + '\n');
      }
      this.files.tests = testPath;
      this.log(`Tests written: ${this.relative(testPath)}`);

      const r = await this.runTestsOn([testPath]);
      this.log(`${r.total} tests run: ${r.passed} passed, ${r.failed} failed`);
      if (r.failed > 0) {
        this.redEndedAt = Date.now();
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
    const outcome = await this.watchUntilGreen(files);
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
  ): Promise<{ result: TestRunResult; choice: WaitChoice }> {
    return new Promise((resolve) => {
      const targets = [this.files.impl!, ...(this.files.types ? [this.files.types!] : [])].filter(
        Boolean,
      );
      const watcher = watch(targets, { ignoreInitial: true });
      this.activeWatcher = watcher;
      let debounce: NodeJS.Timeout | null = null;
      let settled = false;

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
          const r = await this.runTestsOn(files);
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
    const { value } = await completeStructured({
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
      }),
    });

    const testsDir = path.join(this.cwd, 'tests');
    fs.mkdirSync(testsDir, { recursive: true });
    const attackPath = path.join(testsDir, `${moduleName}.attack.${round}.test.ts`);
    fs.writeFileSync(attackPath, value.testFile.trimEnd() + '\n');
    this.files.attacks.push(attackPath);
    this.log(`Attack tests written: ${this.relative(attackPath)}`);

    const r = await this.runTestsOn([this.files.tests!, ...this.files.attacks]);
    this.log(`Attack round ${round} result: ${r.passed}/${r.total} passing`);
  }
}