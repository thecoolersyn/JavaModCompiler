import type { LogLevel, LogRecord, LogSink, LoggerOptions, StatusDescriptor, StatusTag } from './types.js';

const STATUS_TABLE: Record<StatusTag, StatusDescriptor> = {
  pass: { status: 'pass', label: 'PASS' },
  failed: { status: 'failed', label: 'FAILED' },
  warning: { status: 'warning', label: 'WARNING' },
  info: { status: 'info', label: 'INFO' },
  download: { status: 'download', label: 'DOWNLOAD' },
  debug: { status: 'debug', label: 'DEBUG' },
  result: { status: 'result', label: '' },
  detail: { status: 'detail', label: '' },
};

export function statusLabel(status: StatusTag): string {
  return STATUS_TABLE[status].label;
}

export class Logger {
  private readonly options: LoggerOptions;
  private readonly sinks: LogSink[];
  private readonly startedAt = Date.now();
  private records: LogRecord[] = [];
  private pendingRaw = '';

  constructor(options: LoggerOptions) {
    this.options = options;
    this.sinks = options.sinks;
  }

  pass(message: string, stage?: string): void {
    this.emit('info', 'pass', message, undefined, stage);
  }

  failed(message: string, stage?: string): void {
    this.emit('error', 'failed', message, undefined, stage);
  }

  warn(message: string, stage?: string): void {
    this.emit('warn', 'warning', message, undefined, stage);
  }

  info(message: string, stage?: string): void {
    this.emit('info', 'info', message, undefined, stage);
  }

  download(message: string, stage?: string): void {
    this.emit('info', 'download', message, undefined, stage);
  }

  debug(message: string, stage?: string): void {
    this.emit('debug', 'debug', message, undefined, stage);
  }

  raw(chunk: string): void {
    this.pendingRaw += chunk;
    this.flushRaw();
  }

  detail(message: string): void {
    if (this.options.quiet) return;
    for (const line of message.split('\n')) {
      const record = this.build('info', 'detail', line);
      this.records.push(record);
      for (const sink of this.sinks) sink.emit(record);
    }
  }

  blank(): void {
    for (const sink of this.sinks) sink.emit(this.build('info', 'result', ''));
  }

  private emit(level: LogLevel, status: StatusTag, message: string, detail?: string, stage?: string): void {
    if (this.options.quiet && status !== 'failed' && status !== 'result') return;
    if (level === 'debug' && !this.options.debug && !this.options.verbose) return;
    if (level === 'info' && status === 'info' && !this.options.verbose && this.options.quiet) return;
    const record = this.build(level, status, message, detail, stage);
    this.records.push(record);
    for (const sink of this.sinks) sink.emit(record);
  }

  private build(level: LogLevel, status: StatusTag, message: string, detail?: string, stage?: string): LogRecord {
    return {
      level,
      status,
      message,
      detail,
      stage,
      timestamp: Date.now(),
      elapsedMs: Date.now() - this.startedAt,
    };
  }

  private flushRaw(): void {
    if (this.pendingRaw.length === 0) return;
    const chunks = this.pendingRaw.split(/\r?\n/);
    this.pendingRaw = chunks.pop() ?? '';
    if (this.options.quiet && !this.options.debug && !this.options.verbose) return;
    for (const line of chunks) {
      const record = this.build('debug', 'debug', line);
      this.records.push(record);
      for (const sink of this.sinks) sink.emit(record);
    }
  }

  async flush(): Promise<void> {
    this.flushRaw();
    for (const sink of this.sinks) {
      if (sink.flush) await sink.flush();
    }
  }

  collected(): LogRecord[] {
    return this.records.slice();
  }
}