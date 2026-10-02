export interface Token {
  type: 'word' | 'string' | 'number' | 'symbol';
  value: string;
  start: number;
  end: number;
}

const WORD_PATTERN = /[A-Za-z0-9_.$\-]/;
const SYMBOL_PATTERN = /[(){}[\],;=:<>+*/@|&?!]/;

export interface LexedBlock {
  tokens: Token[];
  text: string;
}

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const length = source.length;
  while (index < length) {
    const char = source[index] as string;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      while (index < length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    if (char === '#' && index === 0) {
      while (index < length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      const start = index;
      let triple = false;
      if (source[index + 1] === quote && source[index + 2] === quote) {
        triple = true;
        index += 3;
        while (index < length) {
          if (source[index] === '\\') {
            index += 2;
            continue;
          }
          if (source[index] === quote && source[index + 1] === quote && source[index + 2] === quote) {
            index += 3;
            break;
          }
          index += 1;
        }
      } else {
        index += 1;
        while (index < length) {
          if (source[index] === '\\') {
            index += 2;
            continue;
          }
          if (source[index] === quote) {
            index += 1;
            break;
          }
          if (source[index] === '\n') break;
          index += 1;
        }
      }
      tokens.push({ type: 'string', value: unescape(source.slice(start, index)), start, end: index });
      continue;
    }
    if (char === '`') {
      const start = index;
      index += 1;
      while (index < length && source[index] !== '`') {
        if (source[index] === '\\') index += 1;
        index += 1;
      }
      index += 1;
      tokens.push({ type: 'string', value: source.slice(start + 1, Math.max(start + 1, index - 1)), start, end: index });
      continue;
    }
    if (/[0-9]/.test(char)) {
      const start = index;
      while (index < length && /[0-9._]/.test(source[index] as string)) index += 1;
      tokens.push({ type: 'number', value: source.slice(start, index), start, end: index });
      continue;
    }
    if (WORD_PATTERN.test(char)) {
      const start = index;
      while (index < length && WORD_PATTERN.test(source[index] as string)) index += 1;
      tokens.push({ type: 'word', value: source.slice(start, index), start, end: index });
      continue;
    }
    if (SYMBOL_PATTERN.test(char)) {
      tokens.push({ type: 'symbol', value: char, start: index, end: index + 1 });
      index += 1;
      continue;
    }
    index += 1;
  }
  return tokens;
}

function unescape(raw: string): string {
  return raw
    .slice(1, -1)
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\');
}

export class TokenStream {
  private readonly tokens: Token[];
  private position = 0;

  constructor(tokens: Token[], start = 0) {
    this.tokens = tokens;
    this.position = start;
  }

  peek(offset = 0): Token | undefined {
    return this.tokens[this.position + offset];
  }

  next(): Token | undefined {
    return this.tokens[this.position++];
  }

  get offset(): number {
    return this.position;
  }

  set offset(value: number) {
    this.position = value;
  }

  get done(): boolean {
    return this.position >= this.tokens.length;
  }

  expectSymbol(symbol: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.type === 'symbol' && token.value === symbol) {
      this.position += 1;
      return true;
    }
    return false;
  }

  skipBalanced(openSymbol: string, closeSymbol: string): Token[] {
    const collected: Token[] = [];
    if (!this.expectSymbol(openSymbol)) return collected;
    let depth = 1;
    while (!this.done) {
      const token = this.next() as Token;
      if (token.type === 'symbol') {
        if (token.value === openSymbol) depth += 1;
        if (token.value === closeSymbol) {
          depth -= 1;
          if (depth === 0) return collected;
        }
      }
      collected.push(token);
    }
    return collected;
  }
}

function tokenNeedsSeparator(previous: Token, token: Token): boolean {
  const previousKind = String(previous.type) as Token['type'];
  const tokenKind = String(token.type) as Token['type'];
  if (previousKind === 'word' || previousKind === 'number') return true;
  if (previousKind === 'string') return tokenKind === 'word' || tokenKind === 'string' || tokenKind === 'number';
  return false;
}

export function joinTokens(tokens: Token[]): string {
  let out = '';
  let previous: Token | undefined;
  for (const token of tokens) {
    if (previous !== undefined) {
      const needsSpace = tokenNeedsSeparator(previous, token);
      if (needsSpace) out += ' ';
    }
    out += token.value;
    previous = token;
  }
  return out;
}

export function isKotlinBuild(source: string): boolean {
  return /\bplugins\s*\{[^}]*\}\s*$/m.test(source) === false && /\bimport\s+org\.gradle/.test(source);
}

export function containsKotlinOnlySyntax(source: string): boolean {
  return /\bfun\s+\w+\s*\(/.test(source) || /\bval\s+\w+\s*[:=]/.test(source) || /\bvar\s+\w+\s*[:=]/.test(source);
}