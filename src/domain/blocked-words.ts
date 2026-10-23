const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
const normalize = (text: string) => text.normalize('NFKC').toLowerCase();

export function matchingBlockedWords(text: string, words: string[]): string[] {
  const normalized = normalize(text);
  return [...new Set(words.filter(word => word && normalized.includes(normalize(word))))];
}

export function maskBlockedWords(text: string, words: string[]): string {
  const normalized = normalize(text);
  const masked = new Uint8Array(normalized.length);
  for (const word of matchingBlockedWords(text, words)) {
    const needle = normalize(word);
    for (let start = normalized.indexOf(needle); start !== -1; start = normalized.indexOf(needle, start + 1))
      masked.fill(1, start, start + needle.length);
  }
  let offset = 0;
  return [...segmenter.segment(text)].map(({ segment }) => {
    const start = offset;
    offset += normalize(segment).length;
    return masked.subarray(start, offset).some(value => value !== 0) ? '＊' : segment;
  }).join('');
}
