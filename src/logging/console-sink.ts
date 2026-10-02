import type { LogRecord, LogSink } from './types.js';
import { statusLabel } from './logger.js';

const ESC = '[';

const COLOR_ENABLED = process.env.NO_COLOR === undefined && process.env.JMC_NO_COLOR === undefined;

const CODES = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  gray: `${ESC}90m`,
} as const;

export type ColorName = keyof typeof CODES;

export function paint(text: string, ...colors: ColorName[]): string {
  if (!COLOR_ENABLED || colors.length === 0) return text;
  let prefix = '';
  for (const color of colors) prefix += CODES[color];
  return `${prefix}${text}${CODES.reset}`;
}

export function paintTag(label: string, status: LogRecord['status']): string {
  switch (status) {
    case 'pass':
      return paint(`[${label}]`, 'green');
    case 'failed':
      return paint(`[${label}]`, 'red', 'bold');
    case 'warning':
      return paint(`[${label}]`, 'yellow');
    case 'download':
      return paint(`[${label}]`, 'blue');
    case 'debug':
      return paint(`[${label}]`, 'gray');
    case 'result':
      return paint(label, 'bold');
    case 'detail':
      return label;
    default:
      return paint(`[${label}]`, 'cyan');
  }
}

export interface ConsoleSinkOptions {
  stream: NodeJS.WriteStream;
  errorStream: NodeJS.WriteStream;
  verbose: boolean;
  quiet: boolean;
  debug: boolean;
}

export class ConsoleSink implements LogSink {
  private readonly options: ConsoleSinkOptions;

  constructor(options: ConsoleSinkOptions) {
    this.options = options;
  }

  emit(record: LogRecord): void {
    if (record.status === 'debug' && !this.options.debug && !this.options.verbose) return;
    if (this.options.quiet && record.status !== 'failed' && record.status !== 'result') return;
    const isFailure = record.level === 'error' || record.status === 'failed';
    const target = isFailure ? this.options.errorStream : this.options.stream;
    const label = statusLabel(record.status);
    const head = record.status === 'detail' ? '' : label.length > 0 ? `${paintTag(label, record.status)} ` : '';
    const body = record.status === 'result' ? paint(record.message, 'bold') : record.message;
    const stage = record.stage ? paint(` (${record.stage})`, 'gray') : '';
    target.write(`${head}${body}${stage}\n`);
    if (record.detail !== undefined && record.detail.length > 0) {
      for (const line of record.detail.split('\n')) {
        target.write(`${paint('  | ', 'gray')}${line}\n`);
      }
    }
  }
}

export function writeLine(stream: NodeJS.WriteStream, text: string): void {
  stream.write(`${text}\n`);
}