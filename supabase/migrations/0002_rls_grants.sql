-- RedGreen - role privileges for RLS-protected tables
-- RLS policies control row visibility; GRANTs control table access.
-- Without these, anon/authenticated get "permission denied" (SQLSTATE 42501).

-- anon: public leaderboard reads only
GRANT SELECT ON public.profiles TO anon;

-- authenticated: own rows (policies enforce ownership)
GRANT SELECT, UPDATE ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_rules TO authenticated;

-- service_role: admin access for dashboard/edge functions (bypasses RLS)
GRANT ALL ON public.profiles TO service_role;
GRANT ALL ON public.sessions TO service_role;
GRANT ALL ON public.custom_rules TO service_role;