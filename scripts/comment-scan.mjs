import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.java', '.kt', '.kts', '.scala', '.groovy', '.rs', '.py',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1',
  '.gradle', '.css', '.scss', '.html', '.htm', '.xml',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.bat', '.cmd',
]);

const SCANNED_DIRECTORIES = ['src', 'tests', 'fixtures', 'scripts', '.github'];
const SCANNED_ROOT_FILES = new Set([
  'package.json',
  'tsconfig.json',
  '.gitignore',
  '.npmignore',
  '.editorconfig',
  'build.gradle',
  'settings.gradle',
  'gradle.properties',
]);

const MARKER_RULES = [
  { id: 'block-comment', test: (text) => text.includes('/*') },
  { id: 'html-comment', test: (text) => text.includes('<!--') },
  { id: 'todo-marker', test: (text) => /\b(?:TODO|FIXME|XXX|HACK)\b/.test(text) },
];

function isCommentBearing(filePath) {
  if (filePath.endsWith('.json')) return false;
  if (filePath.endsWith('.md')) return false;
  return SOURCE_EXTENSIONS.has(path.extname(filePath)) || filePath.endsWith('.jsonc');
}

function collectFiles() {
  const files = [];
  for (const directory of SCANNED_DIRECTORIES) {
    const absolute = path.join(root, directory);
    if (!fs.existsSync(absolute)) continue;
    collectRecursive(absolute, files);
  }
  for (const relative of SCANNED_ROOT_FILES) {
    const absolute = path.join(root, relative);
    if (fs.existsSync(absolute)) files.push(absolute);
  }
  return files;
}

function collectRecursive(directory, files) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'types', '.jmc-build'].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectRecursive(absolute, files);
      continue;
    }
    if (entry.isFile() && isCommentBearing(absolute)) files.push(absolute);
  }
}

function stripLiterals(line) {
  let out = '';
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === '/' && line[index + 1] === '/') break;
    if (char === '/' && line[index + 1] === '*') {
      const end = line.indexOf('*/', index + 2);
      if (end === -1) break;
      index = end + 2;
      out += ' ';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      index += 1;
      while (index < line.length) {
        if (line[index] === '\\') {
          index += 2;
          continue;
        }
        if (line[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      out += 'literal';
      continue;
    }
    if (char === '/') {
      let end = index + 1;
      let depth = 0;
      let isRegex = false;
      while (end < line.length) {
        const current = line[end];
        if (current === '\\') {
          end += 2;
          continue;
        }
        if (current === '[') depth += 1;
        else if (current === ']') depth -= 1;
        else if (current === '/' && depth === 0) {
          isRegex = true;
          break;
        } else if (current === '\n') break;
        end += 1;
      }
      const previous = lastMeaningful(out);
      if (isRegex && (previous === '' || '(,=:[!&|?{};+-*%~^<>'.includes(previous))) {
        index = end + 1;
        out += 'regex';
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
}

function lastMeaningful(text) {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (/\s/.test(char)) continue;
    return char;
  }
  return '';
}

const files = collectFiles();
const violations = [];

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const relative = path.relative(root, file);
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const code = stripLiterals(raw);
    if (path.extname(file) === '.jsonc' && /^\s*\/\//.test(code)) {
      violations.push({ file: relative, line: index + 1, rule: 'line-comment', text: raw.trim().slice(0, 120) });
    }
    for (const rule of MARKER_RULES) {
      if (rule.test(code)) {
        violations.push({ file: relative, line: index + 1, rule: rule.id, text: raw.trim().slice(0, 120) });
      }
    }
  }
}

if (violations.length === 0) {
  process.stdout.write(`zero-comment scan passed: ${files.length} JMC-authored files inspected\n`);
  process.exit(0);
}

process.stderr.write(`zero-comment scan found ${violations.length} comments or markers in JMC-authored sources\n`);
for (const violation of violations.slice(0, 300)) {
  process.stderr.write(`  ${violation.file}:${violation.line} [${violation.rule}] ${violation.text}\n`);
}
process.exit(1);