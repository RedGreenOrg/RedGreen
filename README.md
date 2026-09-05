# RedGreen

A terminal-based TDD loop with an AI partner: **red → green → attack → refactor**. The AI writes the types, tests, and edge cases; you write the implementation; your test runner decides what counts as done.

Most Copilot-style tools generate implementation and hand it to you for review. RedGreen does the opposite: the AI does the scaffolding and the verification work, and you do the engineering.

- The AI formalizes the intent: types, contracts, stubs, and a failing test suite.
- You write the implementation, with the tests as the ground truth.
- The AI digs for edge cases, then proposes refactors that must pass the suite.

## The loop

Five phases, each verified against your actual test runner:

1. **Type-first scaffold** — describe a feature; RedGreen generates module and test types.
2. **RED** — it writes failing tests for the types and checks they really fail. Review the contract before anything else runs.
3. **GREEN** — the watcher detects your implementation; the loop only advances when the suite is green. Stuck on a red assertion? Ask for a **Nudge** — escalating hints, never full solutions.
4. **Attack rounds** — the AI throws edge cases at the implementation. Survive three rounds and the module is verified.
5. **Refactor** — the AI proposes behavior-preserving cleanup. The suite re-runs on every save, so a regression turns red the moment it happens. Press `a` to have the AI apply a candidate itself — RedGreen runs the suite against it first and only offers it if everything still passes. You keep it or reject it.

```bash
$ npx redgreen init
$ npx redgreen dev "Create a sliding-window rate limiter"
```

## How it compares to a copilot

| | Inline copilot | RedGreen |
| --- | --- | --- |
| **Proposes** | lines and blocks, open-ended | types, tests, contracts, edge cases, verified refactors |
| **Validation** | none — manual review | runs your real test runner |
| **Writes the core logic** | the AI | **you** |
| **Your role** | reviewing generated code | deciding what to build and how |

## Install

Requires **Node.js 18+**, a TypeScript project, and one of [Vitest](https://vitest.dev), [Jest](https://jestjs.io), [Mocha](https://mochajs.org), or [Node's built-in test runner](https://nodejs.org/api/test.html).

```bash
npx redgreen init        # one-time setup: provider, model, key
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
| `stub` | — | deterministic responses for CI and demos; hidden from the init wizard |

Config precedence: **env var > `~/.config/redgreen/config.json`**. Keys never leave your machine (BYOK, no proxy).

### In the loop

- `enter` — approve a contract / move to the next phase
- `h` — reveal the next Nudge hint (points, never solutions)
- `s` / `S` — reveal / hide the reference solution
- `v` — view refactor suggestions
- `a` — auto-apply the next refactor (suite-verified first; you approve the result)
- `q` — quit

Hints escalate as you put in effort: **small** (where to look) is always available, **medium** (the approach) after your first failed run, **big** (pseudocode) after your second. Once you're green, all tiers are open. Hints re-derive against the current failing assertion each time you press `h`, so they track the problem you're actually fighting.

### Stub comments

Scaffolds get contract-explaining JSDoc by default (what a function does, not how). Set `"stubComments": false` in `~/.config/redgreen/config.json`, or answer "No" in the init wizard, for bare signatures.

### Project rules

Put a `.redgreen.json` in the project root to steer generation:

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

Finished features are recorded to `.redgreen/history.jsonl` in your project. Future scaffolds include relevant past work ("Previously built in this project") so naming stays consistent. Add `.redgreen/` to your `.gitignore` if you don't want history committed.

## Notes

- The target module is **never overwritten** by the pipeline — RedGreen writes only the scaffold and the test file; the implementation is yours. The one exception: the refactor phase's `a` temporarily swaps in a suite-verified candidate you must approve.
- Module names are inferred from the feature description (`"Create a sliding-window rate limiter"` → `src/rateLimiter.ts`).
- `REDGREEN_GREEN_TIMEOUT` (default `30`s) sets how long GREEN waits for your implementation.
- Non-TTY terminals get a **headless mode** with the same state machine — CI-friendly. The refactor phase is interactive, so headless runs skip it and report `refactor: -`; set `REDGREEN_REFACTOR=1` to run refactoring unattended (suggestions are suite-verified, and one that breaks a test is reverted automatically).

## Related research

The workflow is based on published research on test-anchored AI generation:

- **TiCoder** (Fakhoury et al., 2024, [arXiv:2404.10100](https://arxiv.org/abs/2404.10100)) — interactive test-driven generation. In a study of 15 professional programmers, test-validated generation reached **84% task correctness vs 40%** for a Copilot-style assistant, with lower mental demand and no completion-time penalty.
- **CodeT** (Chen et al., 2022, [arXiv:2207.10397](https://arxiv.org/abs/2207.10397)) — filtering candidate solutions through generated tests gained **+18.8% pass@1 on HumanEval** and **+10.1% on MBPP**.
- **Goal-driven AI pair programmers / EDD** (Hassan et al., 2024, [arXiv:2404.10225](https://arxiv.org/abs/2404.10225)) — continuous test execution paired with a human architect.

On the human side, [_Where, Why, and How Developers Want AI Support in Daily Work_](https://arxiv.org/abs/2510.00762) and [_At What Cost? Software Developers' Well-Being in the Age of GenAI_](https://arxiv.org/abs/2605.22349) describe the cost of passive review roles — the role RedGreen tries to avoid.

These are studies of the workflow RedGreen enforces, not product benchmarks. Results vary with model, codebase, and feature.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test suite
npm run build       # tsc -> dist/
```

Tests run against temp dirs and never touch your real config.

## Roadmap

- [x] Public npm release — [npmjs.com/package/redgreen](https://www.npmjs.com/package/redgreen)
- [x] Custom prompt rules via `.redgreen.json`
- [x] Local session memory for longer, multi-feature context
- [x] More runner support (vitest, jest, mocha, node:test)
- [x] Attack phase: edge-case verification rounds
- [x] Refactor phase: behavior-preserving, suite-verified cleanup

## License

MIT