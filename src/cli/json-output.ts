import type { Logger } from '../logging/logger.js';
import type { LogRecord, LogSink } from '../logging/types.js';
import { statusLabel } from '../logging/logger.js';

export interface JsonSinkState {
  result: Record<string, unknown>;
  completed: boolean;
}

export class JsonSink implements LogSink {
  readonly state: JsonSinkState = { result: {}, completed: false };

  emit(record: LogRecord): void {
    void record;
  }

  finalize(result: Record<string, unknown>): void {
    this.state.result = result;
    this.state.completed = true;
  }
}

export function jsonLine(value: unknown): string {
  return JSON.stringify(value);
}

export function statusToOutcome(status: 'pass' | 'failed' | 'warning'): string {
  return status;
}

export function stageRecordToJson(record: LogRecord): Record<string, unknown> {
  return {
    level: record.level,
    status: record.status,
    label: statusLabel(record.status),
    message: record.message,
    stage: record.stage,
    timestamp: new Date(record.timestamp).toISOString(),
  };
}

export function writeJson(stream: NodeJS.WriteStream, value: unknown): void {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function silentSink(): LogSink {
  return { emit: (): void => undefined };
}

export type { Logger };