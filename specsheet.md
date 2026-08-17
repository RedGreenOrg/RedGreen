# Product Requirement Document & Technical Specification: RedGreen

**Project Name:** RedGreen (`npx redgreen`)  
**Tagline:** Reclaim your coding flow state with Type-First Ping-Pong TDD  
**Target Platform:** Terminal CLI (Node.js/Ink) + Supabase + Vercel  
**Architecture:** 100% Client-Side LLM Execution (BYOK / Zero-Proxy)

---

## 1. Executive Summary & Vision

Current AI coding assistants (e.g., Devin, Cursor agent, Claude Engineer) treat software development as an autonomous task where human developers act merely as passive code reviewers reading hundreds of lines of synthetic diffs. This strips away the problem-solving craft, deep flow state, and dopamine hit of hands-on programming.

**RedGreen** is an open-source, interactive CLI tool designed to invert this paradigm. Instead of writing implementation logic, RedGreen acts as a **Socratic Architect** and **Adversarial Test Driver**:

1. **AI Scaffolds Architecture:** Generates strict TypeScript interfaces, domain data models, and empty function stubs.
2. **AI Drives TDD (Red Phase):** Generates failing unit tests based on the agreed type contracts.
3. **Human Crafts Logic (Green Phase):** The developer hand-crafts implementation code until all tests pass.
4. **AI Attacks Code (Attack Phase):** Once green, the AI analyzes the implementation and generates devious edge-case tests to challenge the developer.

By automating setup and testing while leaving 100% of implementation logic to the human, RedGreen accelerates development speed without sacrificing the joy of coding.

---

## 2. Name Candidates & Branding

* **RedGreen (`npx redgreen`)** — *[Selected]* Direct homage to the classic TDD cycle (Red -> Green -> Refactor). Clear, memorable, developer-focused.
* **Duel (`npx duel-cli`)** — Emphasizes the gamified AI vs. Human TDD challenge loop.
* **Katana (`npx katana-cli`)** — Represents precision, hand-crafted craftsmanship, and sharp code.
* **TypeFight (`npx typefight`)** — Highlights type-driven development and adversarial test suites.

---

## 3. Core Product Architecture & Flow

```
+-------------------------------------------------------------------------+
|                            USER TERMINAL                                |
|                                                                         |
|  $ npx redgreen dev "Build a rate limiter middleware for Supabase"      |
+------------------------------------+------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|                         PHASE 1: SCAFFOLD TYPES                         |
|  - AI generates interfaces, types, & stubs (`src/rateLimiter.types.ts`)  |
|  - User reviews & approves architectural contract                       |
+------------------------------------+------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|                         PHASE 2: RED PHASE (AI)                         |
|  - AI generates 3-5 failing tests in `tests/rateLimiter.test.ts`        |
|  - Local test runner executes: 0/4 Passing (RED)                        |
+------------------------------------+------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|                        PHASE 3: GREEN PHASE (HUMAN)                     |
|  - File watcher tracks edits in `src/rateLimiter.ts`                    |
|  - Human writes code line-by-line                                       |
|  - Tests auto-run on save until: 4/4 Passing (GREEN)                    |
+------------------------------------+------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|                        PHASE 4: ATTACK PHASE (AI)                       |
|  - AI inspects passing implementation                                   |
|  - Generates 2-3 devious edge cases (race conditions, clock drift)      |
|  - Human fixes implementation to achieve ultimate GREEN status          |
+------------------------------------+------------------------------------+
                                     |
                                     v
+-------------------------------------------------------------------------+
|                       TELEMETRY & GAMIFICATION                          |
|  - Sync streak stats & completion metrics to Supabase                   |
+-------------------------------------------------------------------------+
```

---

## 4. Technical Stack & Environment

### CLI Engine (Local)
* **Runtime:** Node.js (v18+) / TypeScript
* **TUI Interface:** Ink (React for CLI interactive interfaces)
* **CLI Parser:** Commander.js
* **File Watcher:** Chokidar
* **Test Runner Drivers:** Auto-detection for `Vitest`, `Jest`, `PyTest`, `Cargo Test`, `Go Test`
* **Local LLM Engine:** Direct client SDK calls via `@ai-sdk/openai`, `@ai-sdk/anthropic`, or Ollama HTTP REST API.

### Backend Infrastructure (Supabase & Vercel)
* **Database & Auth:** Supabase (PostgreSQL, Row Level Security, Supabase Auth CLI flow)
* **Deployment & Web Portal:** Vercel (Next.js dashboard for leaderboards, user streaks, team prompt rules)
* **Vector Store (Optional):** Supabase `pgvector` for project-specific context and style guide retrieval.

---

## 5. Security & BYOK Architecture

* **Bring Your Own Key (BYOK):** API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) are read directly from local environment variables or encrypted local storage (`~/.config/redgreen/config.json`).
* **Zero-Proxy Execution:** All LLM prompts and code analysis occur locally from the user's terminal to the LLM provider. No source code or secrets are ever proxied through RedGreen servers.
* **Minimal Telemetry:** Only anonymized session metrics (duration, tests passed, attack rounds survived) and user IDs are sent to Supabase.

---

## 6. Supabase Database Schema

```sql
-- Enable Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users Profile (Synced with Supabase Auth)
CREATE TABLE public.profiles (
  id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  current_streak INT DEFAULT 0,
  longest_streak INT DEFAULT 0,
  total_green_tests INT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Session Telemetry (Gamification & Local Progress Sync)
CREATE TABLE public.sessions (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  feature_name TEXT NOT NULL,
  test_runner TEXT NOT NULL,
  tests_passed INT NOT NULL,
  attack_rounds_survived INT DEFAULT 0,
  time_to_green_seconds INT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- User Custom Prompt Rules
CREATE TABLE public.custom_rules (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  rule_name TEXT NOT NULL,
  prompt_instructions TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- RLS Policies
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own profile" ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can read/write own sessions" ON public.sessions ALL USING (auth.uid() = user_id);
```

---

## 7. CLI Command Specification

### `redgreen init`
Initializes RedGreen in the current directory, detects test framework, and configures BYOK keys.
```bash
$ npx redgreen init
? Select LLM Provider: OpenAI (gpt-4o) / Anthropic (claude-3-5-sonnet) / Ollama
? Enter API Key: ************************************
✔ Config saved to ~/.config/redgreen/config.json
✔ Detected Vitest runner in package.json
```

### `redgreen dev <feature-description>`
Starts the 4-phase interactive TDD loop.
```bash
$ npx redgreen dev "Create a sliding window rate limiter"
```

### `redgreen login`
Authenticates CLI with Supabase for cloud telemetry, streaks, and custom rules.
```bash
$ npx redgreen login
Opening browser to verify auth code...
✔ Authenticated as @alexdev! Current streak: 7 days 🔥
```

---

## 8. Development Roadmap

### Phase 1: Core CLI & TUI (Weeks 1-2)
* Build Ink TUI wrapper and Commander CLI setup.
* Implement BYOK credential management.
* Implement test runner executor and output parser for Vitest and Jest.

### Phase 2: AI TDD Loop (Weeks 3-4)
* Build Type Scaffolder prompt driver.
* Build Red Phase unit test generator.
* Implement real-time local file watcher (`chokidar`).
* Implement Attack Phase edge-case analyzer.

### Phase 3: Supabase & Gamification (Weeks 5-6)
* Connect CLI with Supabase Auth CLI PKCE flow.
* Deploy Vercel Next.js dashboard with streak leaderboards and session stats.
* Community release on Hacker News, Reddit, and X.