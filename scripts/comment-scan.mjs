import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.java', '.kt', '.kts', '.scala', '.groovy', '.rs', '.py',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1',
  '.gradle', '.kts', '.css', '.scss', '.html', '.htm', '.xml',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.bat', '.cmd', '.properties',
]);

const SCANNED_DIRECTORIES = ['src', 'tests', 'fixtures', 'scripts', 'docs', '.github'];
const SCANNED_ROOT_FILES = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  '.gitignore',
  '.npmignore',
  'build.gradle',
  'settings.gradle',
  'gradle.properties',
  '.editorconfig',
  'LICENSE',
]);

const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-release',
  'types',
  '.jmc-build',
  '.jmc-test-tmp',
  '.gradle',
  'build',
  'buildSrc',
  'run',
  'out',
  'target',
]);

const HASH_COMMENT_EXTENSIONS = new Set([
  '.sh', '.bash', '.zsh', '.fish', '.gradle', '.kts', '.toml', '.ini', '.cfg', '.properties', '.yaml', '.yml', '.bat', '.cmd',
]);

const MARKER_RULES = [
  { id: 'block-comment', test: (text) => text.includes('/*') },
  { id: 'html-comment', test: (text) => text.includes('<!--') },
  { id: 'todo-marker', test: (text) => /\b(?:TODO|FIXME|XXX|HACK)\b/.test(text) },
];

const GENERATED_FILE_NAMES = new Set(['gradlew', 'gradlew.bat', 'gradle-wrapper.jar', 'gradle-wrapper.properties']);

function isGeneratedWrapperFile(filePath) {
  return GENERATED_FILE_NAMES.has(path.basename(filePath));
}

function isCommentBearing(filePath) {
  const base = path.basename(filePath);
  if (base === 'package-lock.json') return false;
  if (isGeneratedWrapperFile(filePath)) return false;
  if (filePath.endsWith('.json') && !filePath.endsWith('.jsonc')) return false;
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
    if (fs.existsSync(absolute) && isCommentBearing(absolute)) files.push(absolute);
  }
  return files;
}

function collectRecursive(directory, files) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
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
  let lineComment = false;
  while (index < line.length) {
    const char = line[index];
    if (char === '/' && line[index + 1] === '/') {
      lineComment = true;
      break;
    }
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
  return { code: out, lineComment };
}

function lastMeaningful(text) {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (/\s/.test(char)) continue;
    return char;
  }
  return '';
}

function hasHashComment(code) {
  return /(^|\s)#/.test(code);
}

const files = collectFiles();
const violations = [];

const SLASH_COMMENT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.java', '.kt', '.kts', '.scala', '.groovy', '.rs', '.py', '.css', '.scss',
]);

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const relative = path.relative(root, file);
  const extension = path.extname(file);
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (index === 0 && /^#!/.test(raw.trim())) continue;
    if (raw.trim().length === 0) continue;
    const { code, lineComment } = stripLiterals(raw);
    if (lineComment && SLASH_COMMENT_EXTENSIONS.has(extension)) {
      violations.push({ file: relative, line: index + 1, rule: 'line-comment', text: raw.trim().slice(0, 120) });
    }
    if (HASH_COMMENT_EXTENSIONS.has(extension) && hasHashComment(code)) {
      violations.push({ file: relative, line: index + 1, rule: 'hash-comment', text: raw.trim().slice(0, 120) });
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
