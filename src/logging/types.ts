export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'result';

export type StatusTag = 'pass' | 'failed' | 'warning' | 'info' | 'download' | 'debug' | 'result' | 'detail';

export interface LogRecord {
  level: LogLevel;
  status: StatusTag;
  message: string;
  detail?: string;
  stage?: string;
  timestamp: number;
  elapsedMs: number;
}

export interface LogSink {
  emit(record: LogRecord): void;
  flush?(): void | Promise<void>;
}

export type LogSinkFactory = () => LogSink;

export interface LoggerOptions {
  verbose: boolean;
  quiet: boolean;
  debug: boolean;
  json: boolean;
  sinks: LogSink[];
}

export interface StatusDescriptor {
  status: StatusTag;
  label: string;
}