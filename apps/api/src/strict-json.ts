/** Callers bound the input bytes before parsing. Duplicate keys include escaped spellings. */
export function strictJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  const scopes: Array<Set<string> | null> = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '{' || character === '[') {
      scopes.push(character === '{' ? new Set() : null);
      if (scopes.length > 16) throw new Error('JSON nesting exceeds its bound.');
    } else if (character === '}' || character === ']') scopes.pop();
    else if (character === '"') {
      const start = index++;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\') index++;
        index++;
      }
      let after = index + 1;
      while (/\s/.test(text[after] ?? '') && after < text.length) after++;
      if (text[after] === ':') {
        const key = JSON.parse(text.slice(start, index + 1)) as string,
          keys = scopes.at(-1);
        if (!keys || keys.has(key)) throw new Error('JSON object keys must be unique.');
        keys.add(key);
      }
    }
  }
  return parsed;
}
