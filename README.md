# RedGreen

Reclaim your coding flow state with **Type-First Ping-Pong TDD**.

RedGreen is an interactive terminal coach that pairs with your editor and test runner to run the full red-green-refactor loop with an AI partner:

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
| `redgreen dev "<feature>"` | Run the TDD loop in the current project (auto-detects vitest/jest) |
| `redgreen login` | Sign in with GitHub for streaks & the public leaderboard (PKCE + localhost callback) |

### LLM providers

| Provider | Env var | Notes |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `gpt-4o` default |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-3-5-sonnet` default |
| Gemini | `GEMINI_API_KEY` | `gemini-1.5-pro` default |
| Ollama | — | local HTTP, any model, key-free |
| `stub` | — | deterministic scenario for CI/demos; hidden from the init wizard |

Config precedence: **env var > `~/.config/redgreen/config.json`**. Key files never leave your machine (zero-proxy BYOK).

### The TDD loop

- Target module is never overwritten; RedGreen only writes the scaffold and the test file.
- Module names are inferred from the feature description (e.g. `"Create a sliding window rate limiter"` → `src/rateLimiter.ts`).
- `REDGREEN_GREEN_TIMEOUT` (default `30`s) controls how long the watcher waits for your implementation.
- Non-TTY terminals get a headless mode with the same state machine — CI-friendly.

## Leaderboard & streaks

RedGreen syncs session telemetry (feature name, tests passed, attack rounds survived, time-to-green) to a shared Supabase instance. Streaks update daily; the top 25 developers show on the public leaderboard:

Instances are RLS-guarded: rows are only visible to their owner; the leaderboard exposes aggregate reads. **The anon key ships in the package by design** — it is a public identifier; all data protection comes from RLS. Deploy the dashboard from `web/` (Vercel/Next.js) with `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

### Bring your own Supabase

Set `SUPABASE_URL` / `SUPABASE_ANON_KEY` env vars (or a `supabase` block in the config file) to override the shared instance:

```jsonc
// ~/.config/redgreen/config.json
{
  "provider": "openai",
  "supabase": {
    "url": "https://your-project.supabase.co",
    "anonKey": "your-anon-key"
  }
}
```

Schema lives in [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) (`gen_random_uuid()`-based, idempotent, re-runnable).

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node:test suite (30 tests)
npm run build       # tsc -> dist/
```

Tests run against temp dirs and never touch your real config.

## Roadmap

- [ ] Public npm release (`npm publish`)
- [ ] Custom prompt rules UI (schema-ready: `custom_rules` table)
- [ ] pgvector-powered context store for longer sessions
- [ ] More runner support (mocha, node:test)

## License

MIT