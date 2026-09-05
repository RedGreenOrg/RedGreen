# RedGreen

Reclaim your coding flow state with **Type-First Ping-Pong TDD**.

RedGreen is an interactive terminal coach that pairs with your editor and test runner to run a red-green-attack TDD loop with an AI partner:

1. **Type-first scaffold** — you describe a feature; RedGreen generates module + test types via AI.
2. **RED** — it writes failing tests for the types and verifies they fail on your runner.
3. **GREEN** — the watcher detects your implementation; the loop passes when tests go green.
4. **Attack rounds** — the AI attacks your implementation with edge cases; survive three rounds for a verified module.

```bash
$ npx redgreen init
$ npx redgreen dev "Create a sliding-window rate limiter"
```

![loop](https://img.shields.io/badge/flow-red%20%E2%86%92%20green%20%E2%86%92%20attack-3fb950)

## Install

Requires **Node.js 18+** with either Vitest or Jest available in the target project.

```bash
npx redgreen init          # one-time setup: pick your LLM provider & keys
# or, globally:
npm install -g redgreen    # then `redgreen init`
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

### Stub comments

Scaffolded stubs get contract-explaining JSDoc by default (describing *what* each function should do, never *how*). To generate bare signatures instead, set `"stubComments": false` in `~/.config/redgreen/config.json`, or choose "No" when the init wizard asks.

### The TDD loop

- Target module is never overwritten; RedGreen only writes the scaffold and the test file.
- Module names are inferred from the feature description (e.g. `"Create a sliding window rate limiter"` → `src/rateLimiter.ts`).
- `REDGREEN_GREEN_TIMEOUT` (default `30`s) controls how long the watcher waits for your implementation.
- Non-TTY terminals get a headless mode with the same state machine — CI-friendly.

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

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test suite
npm run build       # tsc -> dist/
```

Tests run against temp dirs and never touch your real config.

## Roadmap

- [ ] Public npm release (`npm publish`)
- [x] Custom prompt rules via `.redgreen.json`
- [x] Local session memory for longer, multi-feature context
- [x] More runner support (vitest, jest, mocha, node:test)

## License

MIT