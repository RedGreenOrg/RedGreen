import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

export interface LeaderboardRow {
  username: string;
  current_streak: number;
  longest_streak: number;
  total_green_tests: number;
}

async function getLeaderboard(): Promise<LeaderboardRow[] | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  const supabase = createClient(url, key);
  const { data } = await supabase
    .from('profiles')
    .select('username,current_streak,longest_streak,total_green_tests')
    .order('total_green_tests', { ascending: false })
    .limit(25);
  return (data ?? null) as LeaderboardRow[] | null;
}

function rankMedal(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return String(rank);
}

export default async function Home() {
  const rows = await getLeaderboard();

  return (
    <main
      style={{
        minHeight: '100vh',
        background: '#0e1117',
        color: '#e6edf3',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        padding: '48px 24px',
      }}
    >
      <section style={{ textAlign: 'center', marginBottom: '40px' }}>
        <h1 style={{ margin: 0, color: '#3fb950' }}>
          redgreen <span style={{ color: '#f85149' }}>dev</span>
        </h1>
        <p style={{ color: '#8b949e', margin: '8px 0 4px' }}>
          Reclaim your coding flow state with Type-First Ping-Pong TDD
        </p>
        <code style={{ color: '#79c0ff', fontSize: '14px' }}>$ npx redgreen dev "your feature"</code>
      </section>

      <section style={{ maxWidth: 720, margin: '0 auto' }}>
        <h2 style={{ fontSize: 18, color: '#58a6ff' }}>Leaderboard</h2>
        {rows === null ? (
          <p style={{ color: '#8b949e' }}>
            No Supabase configured for this deployment. Set NEXT_PUBLIC_SUPABASE_URL and
            NEXT_PUBLIC_SUPABASE_ANON_KEY.
          </p>
        ) : rows.length === 0 ? (
          <p style={{ color: '#8b949e' }}>No developers yet. Be the first to go green!</p>
        ) : (
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              background: '#161b22',
              borderRadius: 8,
              overflow: 'hidden',
            }}
          >
            <thead>
              <tr style={{ color: '#8b949e', textAlign: 'left' }}>
                <th style={{ padding: '10px 14px' }}>#</th>
                <th style={{ padding: '10px 14px' }}>Developer</th>
                <th style={{ padding: '10px 14px' }}>Streak</th>
                <th style={{ padding: '10px 14px' }}>Longest</th>
                <th style={{ padding: '10px 14px' }}>Green tests</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.username} style={{ borderTop: '1px solid #21262d' }}>
                  <td style={{ padding: '10px 14px' }}>{rankMedal(i + 1)}</td>
                  <td style={{ padding: '10px 14px', color: '#79c0ff' }}>@{row.username}</td>
                  <td style={{ padding: '10px 14px' }}>
                    {row.current_streak > 0 ? `${row.current_streak}d 🔥` : '—'}
                  </td>
                  <td style={{ padding: '10px 14px' }}>{row.longest_streak}d</td>
                  <td style={{ padding: '10px 14px', color: '#3fb950' }}>
                    {row.total_green_tests}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p style={{ color: '#484f58', fontSize: 12, marginTop: 24 }}>
          RedGreen · open-source · AI scaffolds, you implement. Zero-proxy BYOK.
        </p>
      </section>
    </main>
  );
}