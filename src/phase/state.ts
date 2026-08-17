export const PHASES = [
  { id: 'scaffold', label: '1. Scaffold Types', blurb: 'AI generates interfaces, types & stubs' },
  { id: 'red', label: '2. Red Phase', blurb: 'AI generates failing tests - watch them fail' },
  { id: 'green', label: '3. Green Phase', blurb: 'You write the implementation until tests pass' },
  { id: 'attack', label: '4. Attack Phase', blurb: 'AI attacks your code with devious edge cases' },
] as const;

export type PhaseId = (typeof PHASES)[number]['id'];

export type PhaseStatus = 'pending' | 'active' | 'done' | 'error' | 'soon';

export function initialStatuses(startAt: PhaseId): Record<PhaseId, PhaseStatus> {
  const st: Record<PhaseId, PhaseStatus> = {
    scaffold: 'pending',
    red: 'pending',
    green: 'pending',
    attack: 'pending',
  };
  let began = false;
  for (const phase of PHASES) {
    if (phase.id === startAt) began = true;
    if (!began) continue;
    st[phase.id] = phase.id === startAt ? 'active' : 'pending';
    break;
  }
  return st;
}