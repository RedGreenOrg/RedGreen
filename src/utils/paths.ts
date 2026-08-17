import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function getConfigDir(): string {
  const dir =
    process.env.REDGREEN_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'redgreen');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}