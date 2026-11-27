export function normalizeRecognitionTerms(values) {
  if (!Array.isArray(values)) return [];
  const terms = new Set();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const term = value.trim().replace(/\s+/gu, ' ');
    if (term && term.length <= 100) terms.add(term);
    if (terms.size >= 100) break;
  }
  return [...terms];
}
