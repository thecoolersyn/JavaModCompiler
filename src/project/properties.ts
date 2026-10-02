export interface PropertyEntry {
  key: string;
  value: string;
  raw: string;
  line: number;
}

export function parsePropertiesFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of parsePropertiesEntries(content)) {
    result[entry.key] = entry.value;
  }
  return result;
}

export function parsePropertiesEntries(content: string): PropertyEntry[] {
  const entries: PropertyEntry[] = [];
  const lines = content.split(/\r?\n/);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as string;
    index += 1;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const separator = findSeparator(trimmed);
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    let lookahead = index;
    while (needsContinuation(value) && lookahead < lines.length) {
      const continuation = (lines[lookahead] as string).trim();
      value += continuation;
      lookahead += 1;
    }
    index = lookahead;
    entries.push({ key, value: unescapeProperties(value), raw: line, line: entries.length + 1 });
  }
  return entries;
}

function findSeparator(line: string): number {
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '\\') continue;
    if (char === '=' || char === ':') return index;
  }
  return -1;
}

function needsContinuation(value: string): boolean {
  let backslashes = 0;
  for (let index = value.length - 1; index >= 0 && value[index] === '\\'; index -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function unescapeProperties(value: string): string {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\f/g, '\f')
    .replace(/\\([\\:= ])/g, '$1');
}

export function lookupProperty(properties: Record<string, string>, key: string): string | undefined {
  if (properties[key] !== undefined) return properties[key];
  const lower = key.toLowerCase();
  for (const [candidate, value] of Object.entries(properties)) {
    if (candidate.toLowerCase() === lower) return value;
  }
  return undefined;
}

export function lookupPropertyWithFallback(properties: Record<string, string>, keys: string[]): { key: string; value: string } | undefined {
  for (const key of keys) {
    const value = lookupProperty(properties, key);
    if (value !== undefined) return { key, value };
  }
  return undefined;
}