# RedGreen

**Stop reviewing AI hallucinations. Start loving code again.**

RedGreen is an interactive terminal coach that runs a **test-first** red → green → attack → refactor loop with an AI partner — while keeping **you** in the driver's seat.

Normal AI copilots write implementation code and turn you into a full-time reviewer. You read 50 lines of plausible-looking but unverified output, hunt subtle edge-case failures, and fix hallucinations that should never have been written. That silent cost is real: empirical studies of generative-AI workflows describe an *oversight labor* tax — time spent auditing stochastic outputs instead of actively engineering.

RedGreen inverts the deal:

- The **AI** formalizes intent: types, contracts, stubs, and a failing test suite.
- **You** write the implementation — with the tests as a deterministic oracle.
- The **AI** attacks your logic, then proposes behavior-preserving refactors — every change is checked against the very suite that proves the code.

## The loop

**Type-First TDD** — five gated phases, each verified by running your actual test runner:

1. **Type-first scaffold** — you describe a feature; RedGreen generates module + test types via AI.
2. **RED** — it writes failing tests for the types and verifies they fail on your runner. You review the contract before anything else happens.
3. **GREEN** — the watcher detects your implementation; the loop passes only when the suite turns green. Stuck? Ask for a **Nudge** (no full solutions — just escalating hints).
4. **Attack rounds** — the AI attacks your implementation with edge cases. Survive three rounds for a verified module.
5. **Refactor** — the AI proposes behavior-preserving cleanups; RedGreen re-runs the full suite on every save so a regression goes red the moment you type it. Press `a` to have the AI apply the next cleanup *itself* — RedGreen runs the suite against the candidate first and only offers it if every test still passes; you keep it or reject it.

```bash
$ npx redgreen init
$ npx redgreen dev "Create a sliding-window rate limiter"
```

![loop](https://img.shields.io/badge/flow-red%20%E2%86%92%20green%20%E2%86%92%20attack-3fb950)

## Why it's different from a copilot

| | Inline copilots | RedGreen |
| --- | --- | --- |
| **Proposes** | lines and blocks, open-ended | types, tests, contracts, edge cases, verified refactors |
| **Validation** | none — manual review | deterministic execution of your real test runner |
| **Writes the core logic** | the AI | **you** |
| **Your role** | passive code auditor | active architect and problem-solver |
| **Mental load** | continuous oversight | gated feedback: red → green in real time |

## Install

Requires **Node.js 18+**, TypeScript project, and [Vitest](https://vitest.dev), [Jest](https://jestjs.io), [Mocha](https://mochajs.org), or [Node's built-in test runner](https://nodejs.org/api/test.html).

```bash
npx redgreen init        # one-time setup: pick your LLM provider & keys
# or, globally:
npm install -g redgreen  # then `redgreen init`
```

Works with `npm`, `yarn`, `pnpm`, and `bun` (`bunx redgreen`).

## Usage

| Command | Description |
| --- | --- |
| `redgreen init` | Interactive wizard: provider, model, API key (stored base64-obfuscated in `~/.config/redgreen/config.json`) |
| `redgreen dev "<feature>"` | Run the TDD loop in the current project (auto-detects vitest, jest, mocha, or node:test) |

### LLM providers

| Provider | Env var | Notes |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `gpt-4o` default |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-3-5-sonnet` default |
| Gemini | `GEMINI_API_KEY` | `gemini-1.5-pro` default |
| Ollama | — | local HTTP, any model, key-free |
| `stub` | — | deterministic scenario for CI/demos; hidden from the init wizard |

Config precedence: **env var > `~/.config/redgreen/config.json`**. Key files never leave your machine (zero-proxy BYOK).

### In the loop

- `enter` — approve a contract / move to the next phase
- `h` — reveal the next Nudge hint (points, never solutions)
- `s` / `S` — reveal / hide the reference solution
- `v` — view refactor suggestions
- `a` — auto-apply the next refactor (suite-verified first; you approve the result)
- `q` — quit

The hint engine escalates with your effort rather than spoon-feeding: **small** (where to look) is always available, **medium** (the approach) unlocks after your first failed run, **big** (pseudocode) after your second. All hints unlock fully once you reach green. And they don't go stale: if the failure you're fighting changes (you fixed the first assertion and hit a new edge case), the hint engine re-derives all three tiers against that *current* assertion the next time you press `h`.

### Stub comments

Scaffolded stubs get contract-explaining JSDoc by default (describing *what* each function should do, never *how*). To generate bare signatures instead, set `"stubComments": false` in `~/.config/redgreen/config.json`, or choose "No" when the init wizard asks.

### Project rules

Drop a `.redgreen.json` in the project root to steer code generation:

```jsonc
// .redgreen.json
{
  "rules": [
    "Always add explicit return types",
    "Use vitest expect-style assertions",
    "Never throw strings; use Error objects"
  ]
}
```

Rules are injected into every AI prompt (scaffold, red tests, attack rounds, reference solution). Keep them short and directive — max 10 rules.

### Session memory

Finished features are recorded to `.redgreen/history.jsonl` in your project. Future scaffolds include the most relevant past work ("Previously built in this project") so naming and conventions stay consistent across features. Add `.redgreen/` to your `.gitignore` if you don't want history committed.

## How the pieces work

- The **target module is never overwritten** by the pipeline — RedGreen only writes the scaffold and the test file. The implementation is yours. (The only exception: in the refactor phase, `a` temporarily swaps in a suite-verified candidate you must approve.)
- Module names are inferred from the feature description (e.g. `"Create a sliding-window rate limiter"` → `src/rateLimiter.ts`).
- `REDGREEN_GREEN_TIMEOUT` (default `30`s) controls how long the watcher waits for your implementation in the GREEN phase.
- Non-TTY terminals get a **headless mode** with the same state machine — CI-friendly. The refactor phase is interactive, so headless runs skip it and report `refactor: -`; set `REDGREEN_REFACTOR=1` to run refactoring unattended instead (every suggestion is suite-verified and auto-applied — a suggestion that breaks a test never lands and is reverted automatically).

## The evidence behind the workflow

RedGreen isn't an opinionated guess — it operationalizes published research on test-anchored AI generation:

- **TiCoder** (Fakhoury et al., 2024, [arXiv:2404.10100](https://arxiv.org/abs/2404.10100)) — an interactive test-driven generator. In a study of 15 professional programmers, test-validated generation reached **84% task correctness vs 40%** for a standard copilot-style assistant, with significantly lower mental demand and **no completion-time penalty**. Tests gave developers a concrete contract to reason against.
- **CodeT** (Chen et al., 2022, [arXiv:2207.10397](https://arxiv.org/abs/2207.10397)) — filtered candidate solutions through generated tests for a **+18.8% pass@1 gain on HumanEval** and **+10.1% on MBPP**.
- **Goal-driven AI pair programmers / EDD** (Hassan et al., 2024, [arXiv:2404.10225](https://arxiv.org/abs/2404.10225)) — the dual design of executing tests continuously while preserving a human architect, grounded in Bloom's 2 Sigma and Theory of Mind.

The software-psychology literature — [_Where, Why, and How Developers Want AI Support in Daily Work_](https://arxiv.org/abs/2510.00762), [_At What Cost? Software Developers' Well-Being in the Age of GenAI_](https://arxiv.org/abs/2605.22349) — documents the flow and well-being costs of passive AI-overview roles. RedGreen's design centers the opposite: the human stays the active problem-solver; the AI automates the periphery — scaffolding, tests, edge-case attacks, and verified cleanup.

> These are published studies of the workflow RedGreen enforces, not product benchmarks. Your results will vary with model, codebase, and feature.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test suite
npm run build       # tsc -> dist/
```

Tests run against temp dirs and never touch your real config.

## Roadmap

- [x] Public npm release — live at [npmjs.com/package/redgreen](https://www.npmjs.com/package/redgreen) (`redgreen@0.1.0`)
- [x] Custom prompt rules via `.redgreen.json`
- [x] Local session memory for longer, multi-feature context
- [x] More runner support (vitest, jest, mocha, node:test)
- [x] Attack phase: edge-case verification rounds
- [x] Refactor phase: behavior-preserving, suite-verified cleanup

## License

MIT