import { spawnSync } from 'node:child_process';
import { loadConfig, THEME_NAMES, type ThemeName } from '../config/config.js';
import {
  OPENCODE_THEMES,
  OPENCODE_THEME_NAMES,
  type OpenCodeThemeJson,
  type OpenCodeThemeName,
} from './opencodeThemes.generated.js';

/**
 * Semantic color tokens, modeled after opencode's theme system.
 * - "opencode" and the bundled opencode theme names: resolved from the real
 *   opencode theme assets. Each asset carries `{dark, light}` variants; which
 *   one is used follows the terminal's color scheme, exactly like opencode
 *   (its terminalMode() reads the terminal's default background).
 * - "system": terminal-aware adaptation. Background/panels/text are derived
 *   from the terminal's actual colors (OSC queries, falling back to the
 *   COLORFGBG env var that Windows terminals set), while accents keep the
 *   pastel palette. The whole screen is filled - no transparent rows.
 */
export interface Theme {
  primary: string | undefined;
  secondary: string | undefined;
  accent: string | undefined;
  success: string | undefined;
  error: string | undefined;
  warning: string | undefined;
  info: string | undefined;
  text: string | undefined;
  textMuted: string | undefined;
  border: string | undefined;
  borderActive: string | undefined;
  borderSubtle: string | undefined;
  background: string | undefined;
  backgroundPanel: string | undefined;
  backgroundElement: string | undefined;
}

export interface TerminalColors {
  defaultBackground?: string;
  defaultForeground?: string;
  palette: Array<string | undefined>;
}

// Classic 16-color ANSI palette (same table opencode uses for terminals
// that do not report their palette via OSC).
const CLASSIC_PALETTE: string[] = [
  '#000000', // black
  '#800000', // red
  '#008000', // green
  '#808000', // yellow
  '#000080', // blue
  '#800080', // magenta
  '#008080', // cyan
  '#c0c0c0', // white
  '#808080', // bright black
  '#ff0000', // bright red
  '#00ff00', // bright green
  '#ffff00', // bright yellow
  '#0000ff', // bright blue
  '#ff00ff', // bright magenta
  '#00ffff', // bright cyan
  '#ffffff', // bright white
];

// What opencode uses when a terminal provides no colors at all.
const DEFAULT_BG = '#0d0d0f';
// Light Windows system theme: the light gray with a hint of blue that
// Windows light terminals use for their default background.
const DEFAULT_BG_LIGHT = '#eff1f4';
const DEFAULT_FG_DARK = '#f0f0f0';
const DEFAULT_FG_LIGHT = '#16181d';

/**
 * Last-resort background guess for terminals that report nothing (no
 * COLORFGBG, no OSC reply): follow the Windows system UI theme, which
 * Windows "auto" mode flips with day/night. Non-Windows or unreadable
 * falls back to dark.
 */
export function systemBgFallback(): string {
  if (process.platform !== 'win32') return DEFAULT_BG;
  try {
    const out = spawnSync(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
        '/v',
        'AppsUseLightTheme',
      ],
      { encoding: 'utf8', timeout: 3000, windowsHide: true },
    );
    const m = /0x([0-9a-fA-F]+)/.exec(out.stdout ?? '');
    if (!m) return DEFAULT_BG;
    return Number.parseInt(m[1], 16) !== 0 ? DEFAULT_BG_LIGHT : DEFAULT_BG;
  } catch {
    return DEFAULT_BG;
  }
}

// The pastel accent palette (shared with the opencode theme). The system
// theme keeps these so status colors stay vivid on dark backgrounds.
const PASTELS = {
  primary: '#8b5cf6',
  secondary: '#60a5fa',
  accent: '#a78bfa',
  success: '#4ade80',
  error: '#f87171',
  warning: '#fbbf24',
  info: '#60a5fa',
};

// Muted, darker accents for light backgrounds: the same hue families as
// the pastels, but toned down so text stays readable on light gray.
const MUTED_LIGHT = {
  primary: '#6d4fa1',
  secondary: '#4a6ea8',
  accent: '#8b7cc9',
  success: '#2f9e44',
  error: '#b34242',
  warning: '#c98a1c',
  info: '#3f6fae',
};

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace(/^#/, '');
  const n = parseInt(value, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function toHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const two = (v: number) => clamp(v).toString(16).padStart(2, '0');
  return `#${two(r)}${two(g)}${two(b)}`;
}

function parseColorValue(value: string): string | undefined {
  const v = value.trim();
  let m = /^rgb:([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})$/.exec(v);
  if (m) return `#${m[1].slice(0, 2)}${m[2].slice(0, 2)}${m[3].slice(0, 2)}`.toLowerCase();
  m = /^#([0-9a-fA-F]{6})$/.exec(v);
  if (m) return `#${m[1]}`.toLowerCase();
  m = /^([0-9a-fA-F]{6})$/.exec(v);
  if (m) return `#${m[1]}`.toLowerCase();
  return undefined;
}

/**
 * Ask the terminal for its default background/foreground and 16-color
 * palette via OSC 10/11/4 queries. The replies arrive asynchronously on
 * stdin; anything not answered within ~200ms falls back to the classic
 * ANSI table (or the process default colors).
 */
export async function queryTerminalColors(): Promise<TerminalColors> {
  const result: TerminalColors = { palette: [] };
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || !stdout.isTTY) return result;

  return new Promise((resolve) => {
    const timer = setTimeout(finish, 350);
    let done = false;
    stdin.on('data', onData);

    function onData(chunk: Buffer): void {
      if (done) return;
      const text = chunk.toString('utf8');
      for (const m of text.matchAll(/\x1b](10|11);([^\x1b\x07]*?)(?:\x1b\\|\x07)/g)) {
        const value = parseColorValue(m[2]);
        if (!value) continue;
        if (m[1] === '10') result.defaultForeground = value;
        else result.defaultBackground = value;
      }
      for (const m of text.matchAll(/\x1b]4;(\d+);([^\x1b\x07]*?)(?:\x1b\\|\x07)/g)) {
        const index = Number(m[1]);
        const value = parseColorValue(m[2]);
        if (index >= 0 && index < 16 && value) result.palette[index] = value;
      }
      if (
        result.defaultBackground &&
        result.defaultForeground &&
        result.palette.filter(Boolean).length === 16
      ) {
        finish();
      }
    }

    function finish(): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
      // Keep draining stdin for a moment so any straggling OSC replies
      // don't get consumed as fake keypresses by ink after render starts.
      setTimeout(() => stdin.off('data', onData), 300);
    }

    stdout.write('\x1b]10;?\x07');
    stdout.write('\x1b]11;?\x07');
    for (let i = 0; i < 16; i++) {
      stdout.write(`\x1b]4;${i};?\x07`);
    }
  });
}

/**
 * Windows terminals export the active color scheme as COLORFGBG="fg;bg"
 * (ANSI 0-15 indices). Instant signal that needs no OSC round-trip.
 */
export function envTerminalColors(): TerminalColors {
  const raw = process.env.COLORFGBG;
  if (!raw) return { palette: [] };
  const m = /^(\d+);(\d+)/.exec(raw);
  if (!m) return { palette: [] };
  const fg = CLASSIC_PALETTE[Number(m[1])];
  const bg = CLASSIC_PALETTE[Number(m[2])];
  if (!fg || !bg) return { palette: [] };
  return { defaultBackground: bg, defaultForeground: fg, palette: [] };
}

/**
 * Terminal-aware adaptation of the opencode theme:
 * - background: the terminal's reported background (always filled)
 * - panels: grays scaled from the background's luminance (lighter than bg
 *   on dark terminals, darker than bg on light terminals)
 * - text: the terminal's foreground (falling back to a mode-appropriate
 *   default), muted text scaled the same way
 * - accents: the pastel palette, unchanged in both modes
 */
export function buildSystemTheme(colors: TerminalColors, fallbackBg = DEFAULT_BG): Theme {
  const bgHex = colors.defaultBackground ?? colors.palette[0] ?? fallbackBg;
  const isDark = luminance(bgHex) < 127.5;
  const fgHex = colors.defaultForeground ?? (isDark ? DEFAULT_FG_DARK : DEFAULT_FG_LIGHT);
  const bg = hexToRgb(bgHex);
  const bgLum = luminance(bgHex);

  const grays: Record<number, string> = {};
  for (let i = 1; i <= 12; i++) {
    const factor = i / 12;
    let newR: number;
    let newG: number;
    let newB: number;
    if (isDark) {
      if (bgLum < 10) {
        newR = newG = newB = Math.floor(factor * 0.4 * 255);
      } else {
        const newLum = bgLum + (255 - bgLum) * factor * 0.4;
        const ratio = newLum / bgLum;
        newR = Math.min(bg.r * ratio, 255);
        newG = Math.min(bg.g * ratio, 255);
        newB = Math.min(bg.b * ratio, 255);
      }
    } else if (bgLum > 245) {
      newR = newG = newB = Math.floor(255 - factor * 0.4 * 255);
    } else {
      const newLum = bgLum * (1 - factor * 0.4);
      const ratio = newLum / bgLum;
      newR = Math.max(bg.r * ratio, 0);
      newG = Math.max(bg.g * ratio, 0);
      newB = Math.max(bg.b * ratio, 0);
    }
    grays[i] = toHex(newR, newG, newB);
  }

  let muted: number;
  if (isDark) {
    muted = bgLum < 10 ? 180 : Math.min(Math.floor(160 + bgLum * 0.3), 200);
  } else {
    muted = bgLum > 245 ? 75 : Math.max(Math.floor(100 - (255 - bgLum) * 0.2), 60);
  }

  return {
    ...(isDark ? PASTELS : MUTED_LIGHT),
    text: fgHex,
    textMuted: toHex(muted, muted, muted),
    border: grays[7],
    borderActive: grays[8],
    borderSubtle: grays[6],
    background: bgHex,
    backgroundPanel: grays[2],
    backgroundElement: grays[3],
  };
}

// ---------------------------------------------------------------------------
// opencode theme assets -> redgreen Theme
// ---------------------------------------------------------------------------

type OpenCodeColor = string | { dark?: string; light?: string } | undefined;

// Which `{dark, light}` variant branch of the opencode assets to use.
// opencode decides this from the terminal's color scheme (its terminalMode()
// reads the terminal's default background); redgreen mirrors that with the
// same signals used for the system theme (COLORFGBG, falling back to the OS
// theme). installSystemTheme re-refines the choice once the OSC-reported
// background is known. REDGREEN_THEME_MODE=dark|light overrides it for
// deterministic setups.
let opencodeMode: 'dark' | 'light' = 'dark';

function detectOpenCodeMode(): 'dark' | 'light' {
  const override = process.env.REDGREEN_THEME_MODE;
  if (override === 'dark' || override === 'light') return override;
  const bg = envTerminalColors().defaultBackground ?? systemBgFallback();
  return luminance(bg) < 127.5 ? 'dark' : 'light';
}

// Evaluated before THEMES below: the map at module init calls
// resolveOpenCodeTheme, whose body reads OT_KEYS.
const OT_KEYS: Array<keyof Theme> = [
  'primary',
  'secondary',
  'accent',
  'success',
  'error',
  'warning',
  'info',
  'text',
  'textMuted',
  'border',
  'borderActive',
  'borderSubtle',
  'background',
  'backgroundPanel',
  'backgroundElement',
];

opencodeMode = detectOpenCodeMode();

export const THEMES: Record<ThemeName, Theme> = {
  // All of opencode's bundled TUI themes (assets + `defs` refs + dark/light
  // variants resolved like opencode's own resolveTheme). "opencode" here is
  // the real opencode default theme from their repo, not a local sketch.
  ...Object.fromEntries(
    OPENCODE_THEME_NAMES.map((name) => [
      name,
      resolveOpenCodeTheme(OPENCODE_THEMES[name], opencodeMode),
    ]),
  ) as Record<OpenCodeThemeName, Theme>,
};

/**
 * Blend an 8-digit `#RRGGBBAA` color over an opaque background (terminals
 * have no alpha channel; opencode keeps the RGBA and composites it against
 * the panel it sits on). A fully opaque color is returned as-is.
 */
function blendAlpha(hex8: string, bgHex: string): string {
  const alpha = parseInt(hex8.slice(7, 9), 16) / 255;
  if (alpha >= 1) return `#${hex8.slice(1, 7).toLowerCase()}`;
  const f = [hex8.slice(1, 3), hex8.slice(3, 5), hex8.slice(5, 7)].map((x) => parseInt(x, 16));
  const b = [bgHex.slice(1, 3), bgHex.slice(3, 5), bgHex.slice(5, 7)].map((x) => parseInt(x, 16));
  const mix = (fi: number, bi: number): string =>
    Math.round(fi * alpha + bi * (1 - alpha)).toString(16).padStart(2, '0');
  return `#${mix(f[0], b[0])}${mix(f[1], b[1])}${mix(f[2], b[2])}`;
}

/**
 * Convert one of opencode's theme JSON assets into a redgreen Theme.
 * Hex values, `defs`/cross-key references and `{dark, light}` variants are
 * resolved like opencode's own resolveTheme; the variant branch is chosen by
 * the terminal's color scheme (see opencodeMode above), which is exactly how
 * opencode decides (its terminalMode() reads the terminal's default
 * background). `mode` defaults to 'dark' so the function stays total; the
 * caller (THEMES init / installSystemTheme) always passes the detected mode.
 */
export function resolveOpenCodeTheme(json: OpenCodeThemeJson, mode: 'dark' | 'light' = 'dark'): Theme {
  const defs = json.defs ?? {};
  const theme = json.theme;
  // Border (and a few other) tokens use 8-digit alpha hex; those are blended
  // over the resolved background, so the background must be resolved first.
  const bgRef: { current: string } = { current: '#000000' };

  const resolveValue = (value: OpenCodeColor, mode: 'dark' | 'light', chain: string[]): string | undefined => {
    if (typeof value === 'object') {
      return resolveValue(value[mode], mode, chain);
    }
    if (typeof value !== 'string') return undefined;
    const v = value.trim();
    if (v === 'transparent' || v === 'none') return undefined;
    if (/^#[0-9a-fA-F]{8}$/.test(v)) return blendAlpha(v, bgRef.current);
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
    if (chain.includes(v)) return undefined;
    const ref = defs[v] ?? (theme[v] as OpenCodeColor | undefined);
    if (ref === undefined) return undefined;
    return resolveValue(ref, mode, [...chain, v]);
  };

  const resolveKey = (key: string, mode: 'dark' | 'light'): string | undefined =>
    resolveValue(theme[key] as OpenCodeColor, mode, []);

  bgRef.current = resolveKey('background', mode) ?? '#000000';

  const result: Partial<Theme> = {};
  for (const key of OT_KEYS) result[key] = resolveKey(key, mode);
  return result as Theme;
}

/**
 * Query the terminal and swap THEMES.system in place. Called once at TUI
 * startup; safe to call again (e.g. after the user re-triggers it).
 *
 * COLORFGBG (env) wins over the OSC query: it is the terminal's explicit
 * statement of the current color scheme, while OSC replies can be stale,
 * defaults, or absent. When nothing is reported, the Windows system theme
 * is used as a last resort. Set REDGREEN_THEME_MODE=dark|light to force the
 * opencode assets' variant branch. Set REDGREEN_QUERY_COLORS=1 to also run
 * the OSC color query where COLORFGBG is unavailable.
 */
export async function installSystemTheme(): Promise<void> {
  const env = envTerminalColors();
  // On Windows, COLORFGBG states the active color scheme outright; the OSC
  // round-trip has nothing to add and writes escape bytes straight to the
  // terminal before the TUI's clean writer is installed (they can be echoed
  // as raw garbage on startup). Only query when the terminal gave us nothing
  // AND the user explicitly asked (REDGREEN_QUERY_COLORS=1), so the default
  // startup never emits raw OSC bytes.
  const allowQuery = process.env.REDGREEN_SKIP_COLOR_QUERY !== '1';
  const requestQuery = process.env.REDGREEN_QUERY_COLORS === '1';
  const queried = allowQuery && requestQuery && !env.defaultBackground
    ? await queryTerminalColors()
    : { palette: [] };
  const colors: TerminalColors = {
    defaultBackground: env.defaultBackground ?? queried.defaultBackground,
    defaultForeground: env.defaultForeground ?? queried.defaultForeground,
    palette: queried.palette.map((c, i) => c ?? env.palette[i]),
  };
  const fallback = systemBgFallback();
  THEMES.system = buildSystemTheme(colors, fallback);
  // Re-pick the opencode assets' light/dark branch from the refined
  // background (OSC replies beat COLORFGBG emptiness, registry fallback).
  // REDGREEN_THEME_MODE stays authoritative when set.
  const finalBg = colors.defaultBackground ?? colors.palette[0] ?? fallback;
  const override = process.env.REDGREEN_THEME_MODE;
  opencodeMode =
    override === 'light' || override === 'dark'
      ? override
      : luminance(finalBg) < 127.5
        ? 'dark'
        : 'light';
  for (const name of OPENCODE_THEME_NAMES) {
    THEMES[name] = resolveOpenCodeTheme(OPENCODE_THEMES[name], opencodeMode);
  }
}

export function resolveThemeName(): ThemeName {
  const env = process.env.REDGREEN_THEME;
  if (env && THEME_NAMES.includes(env)) return env as ThemeName;
  const { config } = loadConfig();
  if (config?.theme && THEME_NAMES.includes(config.theme)) return config.theme;
  return 'opencode';
}

export function resolveTheme(): Theme {
  return THEMES[resolveThemeName()];
}
