// Downloads opencode's TUI theme assets from GitHub and regenerates
// src/tui/opencodeThemes.generated.ts. Run: node scripts/fetch-opencode-themes.mjs
// Source: https://github.com/anomalyco/opencode (packages/tui/src/theme/assets/)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRANCH = 'dev';
const BASE = `https://raw.githubusercontent.com/anomalyco/opencode/${BRANCH}/packages/tui/src/theme/assets`;
const NAMES = [
  'aura',
  'ayu',
  'carbonfox',
  'catppuccin-frappe',
  'catppuccin-macchiato',
  'catppuccin',
  'cobalt2',
  'cursor',
  'dracula',
  'everforest',
  'flexoki',
  'github',
  'gruvbox',
  'kanagawa',
  'lucent-orng',
  'material',
  'matrix',
  'mercury',
  'monokai',
  'nightowl',
  'nord',
  'one-dark',
  'opencode',
  'orng',
  'osaka-jade',
  'palenight',
  'rosepine',
  'solarized',
  'synthwave84',
  'tokyonight',
  'vercel',
  'vesper',
  'zenburn',
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'src', 'tui', 'opencodeThemes.generated.ts');

const themes = {};
for (const name of NAMES) {
  const res = await fetch(`${BASE}/${name}.json`);
  if (!res.ok) throw new Error(`fetch ${name}: ${res.status}`);
  themes[name] = await res.json();
}

const lines = [
  '// GENERATED FILE - do not edit by hand.',
  `// Regenerate with: node scripts/fetch-opencode-themes.mjs`,
  `// Source: https://github.com/anomalyco/opencode (${BRANCH}, packages/tui/src/theme/assets)`,
  '',
  'export interface OpenCodeThemeJson {',
  '  $schema?: string;',
  '  defs?: Record<string, string>;',
  '  theme: Record<string, unknown>;',
  '}',
  '',
  'export const OPENCODE_THEMES: Record<string, OpenCodeThemeJson> = {',
  ...Object.entries(themes).map(([name, json]) => `  ${JSON.stringify(name)}: ${JSON.stringify(json)},`),
  '};',
  '',
  'export const OPENCODE_THEME_NAMES: readonly string[] = Object.keys(OPENCODE_THEMES);',
  '',
  'export type OpenCodeThemeName = (typeof OPENCODE_THEME_NAMES)[number];',
  '',
];
fs.writeFileSync(outFile, lines.join('\n'));
console.log(`wrote ${outFile} (${Object.keys(themes).length} themes)`);