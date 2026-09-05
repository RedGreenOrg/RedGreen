import fs from 'node:fs';
import path from 'node:path';

export interface MemoryRecord {
  ts: string;
  feature: string;
  moduleName: string;
  outcome: 'green' | 'red';
  attacksSurvived: number;
}

const MEMORY_DIR = '.redgreen';
const MEMORY_FILE = 'history.jsonl';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'to', 'of', 'in', 'on',
  'build', 'create', 'make', 'implement', 'add', 'write', 'using', 'use',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

/**
 * Project-local session memory (.redgreen/history.jsonl). Records finished
 * features so future scaffolds can reuse naming/conventions from prior work.
 * All operations are best-effort: a missing or corrupt store degrades to
 * "no memory" without ever failing a session.
 */
export class SessionMemory {
  private readonly dir: string;
  private readonly file: string;

  constructor(cwd: string = process.cwd()) {
    this.dir = path.join(cwd, MEMORY_DIR);
    this.file = path.join(this.dir, MEMORY_FILE);
  }

  record(rec: Omit<MemoryRecord, 'ts'>): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const line = JSON.stringify({ ...rec, ts: new Date().toISOString() });
      fs.appendFileSync(this.file, line + '\n');
    } catch {
      // memory is a nice-to-have; never surface write failures
    }
  }

  readAll(): MemoryRecord[] {
    try {
      if (!fs.existsSync(this.file)) return [];
      const out: MemoryRecord[] = [];
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as MemoryRecord;
          if (rec.feature && rec.moduleName) out.push(rec);
        } catch {
          // skip corrupt lines
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Past features ranked by keyword overlap with the new description,
   * padded with the most recent entries when nothing overlaps.
   */
  relevant(feature: string, limit = 3): MemoryRecord[] {
    const all = this.readAll();
    if (all.length === 0) return [];
    const want = tokenize(feature);
    const scored = all
      .map((rec, i) => {
        let score = 0;
        for (const t of tokenize(rec.feature)) if (want.has(t)) score++;
        return { rec, i, score };
      })
      .sort((a, b) => b.score - a.score || b.i - a.i);
    // keep best-scoring first, drop zero-score entries unless we need padding
    const picked: typeof scored = [];
    for (const s of scored) {
      if (s.score > 0) picked.push(s);
      if (picked.length >= limit) return picked.map((p) => p.rec);
    }
    for (const s of scored) {
      if (picked.includes(s)) continue;
      picked.push(s);
      if (picked.length >= limit) break;
    }
    return picked.map((p) => p.rec);
  }
}
