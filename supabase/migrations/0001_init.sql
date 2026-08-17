-- RedGreen - initial schema, RLS policies and RPC helpers
-- Run via: supabase db push / supabase migration up
-- Uses gen_random_uuid() (built into Postgres 13+/Supabase) - no extension needed.

-- 1. Users profile (synced with Supabase Auth)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  current_streak INT DEFAULT 0,
  longest_streak INT DEFAULT 0,
  total_green_tests INT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Session telemetry (gamification & local progress sync)
CREATE TABLE IF NOT EXISTS public.sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  feature_name TEXT NOT NULL,
  test_runner TEXT NOT NULL,
  tests_passed INT NOT NULL,
  attack_rounds_survived INT DEFAULT 0,
  time_to_green_seconds INT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. User / team custom prompt rules
CREATE TABLE IF NOT EXISTS public.custom_rules (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  rule_name TEXT NOT NULL,
  prompt_instructions TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_rules ENABLE ROW LEVEL SECURITY;

-- DROP IF EXISTS makes the file re-runnable after partial apply (CREATE POLICY has no IF NOT EXISTS)
DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Leaderboard public read" ON public.profiles;
DROP POLICY IF EXISTS "Users can read/write own sessions" ON public.sessions;
DROP POLICY IF EXISTS "Users can read/write own rules" ON public.custom_rules;

-- Own row: fully managed by the owner
CREATE POLICY "Users can read own profile" ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- Leaderboard: expose only public streak/green-test aggregates to everyone
CREATE POLICY "Leaderboard public read" ON public.profiles
  FOR SELECT USING (true);

CREATE POLICY "Users can read/write own sessions" ON public.sessions FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can read/write own rules" ON public.custom_rules FOR ALL USING (auth.uid() = user_id);

-- 5. RPC: idempotent profile bootstrap for the CLI login flow
CREATE OR REPLACE FUNCTION public.ensure_profile(p_username text)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.profiles;
BEGIN
  INSERT INTO public.profiles (id, username)
  VALUES (auth.uid(), p_username)
  ON CONFLICT (id) DO NOTHING;

  SELECT * INTO v_row FROM public.profiles WHERE id = auth.uid();
  RETURN v_row;
END;
$$;

-- 6. RPC: record a finished session, update streaks and totals atomically
CREATE OR REPLACE FUNCTION public.record_session_v1(
  p_feature_name text,
  p_test_runner text,
  p_tests_passed integer,
  p_attack_rounds_survived integer DEFAULT 0,
  p_time_to_green_seconds integer DEFAULT 0
)
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_streak integer;
  v_row public.profiles;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  INSERT INTO public.sessions (user_id, feature_name, test_runner, tests_passed, attack_rounds_survived, time_to_green_seconds)
  VALUES (v_user_id, p_feature_name, p_test_runner, p_tests_passed, p_attack_rounds_survived, p_time_to_green_seconds);

  -- Consecutive-day streak: rank distinct session dates desc; a day contributes
  -- when it equals (today - rank + 1), i.e. an unbroken chain ending today.
  WITH days AS (
    SELECT DISTINCT created_at::date AS d
    FROM public.sessions
    WHERE user_id = v_user_id
  ),
  ranked AS (
    SELECT d, row_number() OVER (ORDER BY d DESC) AS rn
    FROM days
  )
  SELECT count(*) INTO v_streak
  FROM ranked
  WHERE d = CURRENT_DATE - (rn - 1);

  IF v_streak = 0 THEN
    v_streak := 1;
  END IF;

  UPDATE public.profiles
  SET current_streak = v_streak,
      longest_streak = GREATEST(longest_streak, v_streak),
      total_green_tests = total_green_tests + p_tests_passed
  WHERE id = v_user_id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;