const STOP_WORDS = new Set([
  'build',
  'create',
  'construct',
  'make',
  'implement',
  'write',
  'add',
  'support',
  'start',
  'set',
  'up',
  'for',
  'of',
  'with',
  'to',
  'in',
  'on',
  'using',
  'use',
  'and',
  'the',
  'a',
  'an',
  'that',
  'this',
  'which',
  'middleware',
  'service',
]);

export function moduleNameFromFeature(feature: string): string {
  const words = feature
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length > 0);

  const purposeIndex = words.lastIndexOf('for');
  const scope = purposeIndex === -1 ? words : words.slice(0, purposeIndex);

  const significant = scope.filter((w) => !STOP_WORDS.has(w));
  if (significant.length === 0) return 'feature';

  let names = significant;
  if (names.length > 2) names = names.slice(names.length - 2);

  const camel = names
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
  return camel || 'feature';
}