import { createClientFromConfig } from './supabase.js';

export interface TelemetryRecord {
  feature: string;
  runner: 'vitest' | 'jest';
  testsPassed: number;
  attackRoundsSurvived: number;
  timeToGreenSeconds: number;
}

export interface SyncResult {
  synced: boolean;
  reason?: string;
  currentStreak?: number;
  totalGreenTests?: number;
}

/**
 * Fire-and-forget telemetry sync. Never throws, never blocks the CLI:
 * without Supabase credentials or an active session it simply reports back.
 */
export async function syncSessionTelemetry(record: TelemetryRecord): Promise<SyncResult> {
  const client = createClientFromConfig();
  if (!client) {
    return { synced: false, reason: 'no-supabase-config' };
  }

  const {
    data: { session },
  } = await client.auth.getSession();
  if (!session) {
    return { synced: false, reason: 'not-authenticated' };
  }

  try {
    const { data, error } = await client.rpc('record_session_v1', {
      p_feature_name: record.feature.slice(0, 200),
      p_test_runner: record.runner,
      p_tests_passed: record.testsPassed,
      p_attack_rounds_survived: record.attackRoundsSurvived,
      p_time_to_green_seconds: record.timeToGreenSeconds,
    });
    if (error) return { synced: false, reason: `rpc: ${error.message}` };

    const profile = (data ?? null) as {
      current_streak?: number;
      total_green_tests?: number;
    } | null;
    return {
      synced: true,
      currentStreak: profile?.current_streak,
      totalGreenTests: profile?.total_green_tests,
    };
  } catch (err) {
    return { synced: false, reason: err instanceof Error ? err.message : String(err) };
  }
}