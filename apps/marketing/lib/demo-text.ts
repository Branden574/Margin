/** Literal matching avoids interpreting search text as executable regular expressions. */
export function splitMatches(text: string, query: string): { text: string; matched: boolean }[] {
  if (!query) return [{ text, matched: false }];
  const output: { text: string; matched: boolean }[] = [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  let cursor = 0;
  let found = haystack.indexOf(needle, cursor);
  while (found >= 0) {
    if (found > cursor) output.push({ text: text.slice(cursor, found), matched: false });
    output.push({ text: text.slice(found, found + query.length), matched: true });
    cursor = found + query.length;
    found = haystack.indexOf(needle, cursor);
  }
  if (cursor < text.length) output.push({ text: text.slice(cursor), matched: false });
  return output;
}
