/**
 * Compiled-in defaults for the shared RedGreen leaderboard instance.
 *
 * Once the public Supabase project exists (see specsheet), put its
 * project URL and ANON key here. The anon key is safe to publish:
 * RLS protects all rows; it is a public identifier by design.
 *
 * Users who want their own backend override via env vars
 * (SUPABASE_URL / SUPABASE_ANON_KEY) or ~/.config/redgreen/config.json.
 * An empty value here means "no built-in default" — telemetry stays inert
 * until one of the override paths is configured.
 */
export const DEFAULT_SUPABASE_URL = 'https://nbgycmaojfdyazwumhou.supabase.co';
export const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_hGJSVdEUaYuJUqsVK_RnHQ_zGUPmDxK';