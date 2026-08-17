import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { createClientFromConfig, hasSupabaseConfig, signOutFromConfig } from '../telemetry/supabase.js';

function openBrowser(url: string): void {
  // Windows: cmd would parse the & and % characters in OAuth URLs and
  // break the command ("Windows cannot find '\\'"). rundll32 hands the
  // URL to the default handler verbatim, no shell parsing.
  const [cmd, args] =
    process.platform === 'win32'
      ? (['rundll32', ['url.dll,FileProtocolHandler', url]] as const)
      : process.platform === 'darwin'
        ? (['open', [url]] as const)
        : (['xdg-open', [url]] as const);
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {
    console.log(`  Could not open a browser automatically. Visit:\n  ${url}`);
  });
}

function usernameFromUser(user: {
  email?: string;
  user_metadata?: Record<string, unknown>;
  id: string;
}): string {
  const meta = user.user_metadata ?? {};
  const candidate = String(
    meta.user_name ?? meta.username ?? meta.name ?? meta.preferred_username ?? '',
  ).trim();
  if (candidate) return candidate;
  const emailName = user.email?.split('@')[0] ?? '';
  if (emailName) return emailName;
  return 'dev' + user.id.slice(0, 6);
}

export const loginCommand = new Command('login')
  .description('Authenticate with Supabase for streaks, telemetry & custom rules')
  .option('-p, --provider <provider>', 'OAuth provider: github | gitlab | google', 'github')
  .option('--logout', 'clear the stored Supabase session')
  .option('--print-url', 'print the auth URL instead of opening the browser')
  .action(async (options: { provider: string; logout?: boolean; printUrl?: boolean }) => {
    if (options.logout) {
      signOutFromConfig();
      console.log('  Signed out.');
      return;
    }
    if (!hasSupabaseConfig()) {
      console.error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY env vars,');
      console.error('or add a "supabase" block to ~/.config/redgreen/config.json.');
      process.exit(1);
    }

    const provider = options.provider;
    if (!['github', 'gitlab', 'google'].includes(provider)) {
      console.error(`Unknown provider "${provider}". Choose: github | gitlab | google`);
      process.exit(1);
    }

    const client = createClientFromConfig();
    if (!client) {
      console.error('Supabase client could not be created.');
      process.exit(1);
    }

    const server = createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 54321);
      });
    });
    let link = `http://127.0.0.1:${port}/callback`;

    const timeout = setTimeout(() => {
      console.error('  Auth flow timed out after 2 minutes. Try again.');
      server.close();
      process.exit(1);
    }, 120_000);

    const { data, error } = await client.auth.signInWithOAuth({
      provider: provider as 'github',
      options: {
        redirectTo: link,
        skipBrowserRedirect: true,
        queryParams: { prompt: 'consent' },
      },
    });
    if (error || !data.url) {
      clearTimeout(timeout);
      server.close();
      console.error(`  Failed to start auth: ${error?.message ?? 'no auth URL'}`);
      process.exit(1);
    }

    console.log(`  Opening browser to verify auth code (${provider})...`);
    if (options.printUrl) {
      console.log(`  ${data.url}`);
    } else {
      openBrowser(data.url);
    }

    server.on('request', async (req, res) => {
      const target = new URL(req.url ?? '/', link);
      const masked = target.search.replace(
        /(access_token|provider_token|provider_refresh_token|refresh_token)=[^&]+/g,
        '$1=<redacted>',
      );
      console.error(`  [callback] ${target.pathname}${masked}${target.hash}`);
      if (target.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }

      const code = target.searchParams.get('code');
      const state = target.searchParams.get('state');
      const err = target.searchParams.get('error');
      const accessToken = target.searchParams.get('access_token');
      const refreshToken = target.searchParams.get('refresh_token');
      if ((!code && !accessToken) || err) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          '<html><body style="font-family:sans-serif;background:#0e1117;color:#e6edf3;display:grid;place-items:center;height:100vh">' +
            `<div style="text-align:center"><h1>RedGreen</h1><p style="color:#f85149">Auth pending: ${err ?? 'no code yet'}.</p><p>Waiting for the redirect to finish - don't close this tab.</p></div>` +
            '<script>if (location.hash) { location.href = location.pathname + location.hash.replace(/^#/, \'?\'); }</script></body></html>',
        );
        return;
      }

      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<html><body style="font-family:sans-serif;background:#0e1117;color:#e6edf3;display:grid;place-items:center;height:100vh">' +
          '<div style="text-align:center"><h1>RedGreen</h1><p>Auth complete - return to your terminal.</p></div></body></html>',
      );
      console.error(`  [callback] state=${state ?? '(none)'}`);

      try {
        const res = accessToken
          ? await client.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken ?? '',
            })
          : await client.auth.exchangeCodeForSession(code!);
        if (res.error) throw res.error;
        const user = res.data.session?.user;
        if (!user) throw new Error('no user in session');

        const { data: profile, error: profileError } = await client.rpc('ensure_profile', {
          p_username: usernameFromUser(user),
        });
        if (profileError) throw profileError;

        const p = (profile ?? {}) as {
          username?: string;
          current_streak?: number;
          longest_streak?: number;
          total_green_tests?: number;
        };
        console.log(`  Authenticated as @${p.username ?? user.email ?? 'developer'}!`);
        if (p.current_streak && p.current_streak > 0) {
          const flames = p.current_streak >= 7 ? ' 🔥' : '';
          console.log(`  Current streak: ${p.current_streak} days${flames}`);
        }
        console.log(`  Longest streak: ${p.longest_streak ?? 0} days · Green tests: ${p.total_green_tests ?? 0}`);
      } catch (err) {
        console.error(`  Auth failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      } finally {
        clearTimeout(timeout);
        server.close();
      }
    });
  });