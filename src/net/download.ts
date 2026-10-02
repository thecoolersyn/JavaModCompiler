import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { PassThrough, Readable } from 'node:stream';
import { defaultFileSystem } from '../platform/fs.js';

export class DownloadError extends Error {
  readonly status: number | undefined;
  readonly url: string;
  readonly kind:
    | 'dns'
    | 'timeout'
    | 'tls'
    | 'http-404'
    | 'http-403'
    | 'http-error'
    | 'connection-reset'
    | 'partial'
    | 'offline'
    | 'checksum';

  constructor(kind: DownloadError['kind'], url: string, message: string, status?: number) {
    super(message);
    this.name = 'DownloadError';
    this.kind = kind;
    this.url = url;
    this.status = status;
  }
}

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
export const PROBE_TIMEOUT_MS = 60_000;
export const STALL_TIMEOUT_MS = 120_000;

export interface DownloadOptions {
  logger?: { download(message: string, stage?: string): void; debug(message: string, stage?: string): void };
  offline?: boolean;
  expectedSha256?: string;
  expectedSha1?: string;
  expectedSize?: number;
  stage?: string;
  retries?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  onProgress?: (received: number, total: number | undefined) => void;
  allowMissing?: boolean;
}

export function classifyFetchError(error: unknown, url: string): DownloadError {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | undefined)?.code ?? '';
  const cause = String((error as { cause?: unknown } | undefined)?.cause ?? '');
  const combined = `${message} ${code} ${cause}`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|ENODATA/i.test(combined)) {
    return new DownloadError('dns', url, `DNS resolution failed for ${hostOf(url)}: ${message}`);
  }
  if (/certificate|TLS|SSL|EEXIST.*cert|UNABLE_TO_VERIFY|self.signed|CERT_/i.test(combined)) {
    return new DownloadError('tls', url, `TLS verification failed for ${hostOf(url)}: ${message}`);
  }
  if (/ECONNRESET|EPIPE|socket hang up|ECONNABORTED/i.test(combined)) {
    return new DownloadError('connection-reset', url, `Connection reset while downloading ${url}: ${message}`);
  }
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|timeout|Timeout/i.test(combined)) {
    return new DownloadError('timeout', url, `Request to ${url} timed out: ${message}`);
  }
  return new DownloadError('connection-reset', url, `Failed to reach ${url}: ${message}`);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export async function fetchWithDiagnostics(url: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw classifyFetchError(error, url);
  }
  if (response.status === 404) {
    throw new DownloadError('http-404', url, `HTTP 404 Not Found for ${url}`, 404);
  }
  if (response.status === 403) {
    throw new DownloadError('http-403', url, `HTTP 403 Forbidden for ${url}`, 403);
  }
  if (!response.ok) {
    throw new DownloadError('http-error', url, `HTTP ${response.status} ${response.statusText} for ${url}`, response.status);
  }
  return response;
}

export async function downloadFile(url: string, destination: string, options: DownloadOptions = {}): Promise<void> {
  if (options.offline === true) {
    throw new DownloadError('offline', url, `Offline mode is enabled, refusing to download ${url}`);
  }
  const fs = defaultFileSystem;
  await fs.ensureDirAsync(path.dirname(destination));
  const retries = options.retries ?? 3;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  let lastError: DownloadError | undefined;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const temporary = `${destination}.part-${process.pid}-${attempt}`;
    const controller = new AbortController();
    const abortTimer = setTimeout(() => {
      controller.abort(new Error(`transfer exceeded ${timeoutMs} ms`));
    }, timeoutMs);
    try {
      const response = await fetchWithDiagnostics(url, {
        redirect: 'follow',
        headers: { 'user-agent': 'jmc/1.0 (+java-mod-compiler)', ...options.headers },
        signal: controller.signal,
      });
      if (response.body === null) {
        throw new DownloadError('partial', url, `Empty response body for ${url}`);
      }
      const declaredLength = Number(response.headers.get('content-length') ?? '');
      const total = Number.isFinite(declaredLength) && declaredLength > 0 ? declaredLength : options.expectedSize;
      let received = 0;
      const hashed = crypto.createHash('sha256');
      const sha1 = crypto.createHash('sha1');
      let lastChunkAt = Date.now();
      const source = Readable.fromWeb(response.body as never);
      const stallGuard = setInterval(() => {
        if (Date.now() - lastChunkAt > STALL_TIMEOUT_MS) {
          controller.abort(new Error(`transfer stalled for ${STALL_TIMEOUT_MS} ms`));
          source.destroy(new Error(`transfer stalled for ${STALL_TIMEOUT_MS} ms`));
        }
      }, 5_000);
      const counter = new PassThrough({
        transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
          received += chunk.length;
          lastChunkAt = Date.now();
          options.onProgress?.(received, total);
          hashed.update(chunk);
          if (options.expectedSha1 !== undefined) sha1.update(chunk);
          callback(null, chunk);
        },
      });
      const writeStream = createWriteStream(temporary);
      try {
        await pipeline(source, counter, writeStream);
      } finally {
        clearInterval(stallGuard);
        source.destroy();
        await response.body.cancel().catch(() => undefined);
      }
      const actualSha256 = hashed.digest('hex');
      const actualSha1 = sha1.digest('hex');
      if (options.expectedSha256 !== undefined && !equalsIgnoreCase(options.expectedSha256, actualSha256)) {
        await fsp.rm(temporary, { force: true });
        throw new DownloadError(
          'checksum',
          url,
          `Checksum mismatch for ${url}: expected ${options.expectedSha256}, received ${actualSha256}`,
        );
      }
      if (options.expectedSha1 !== undefined && !equalsIgnoreCase(options.expectedSha1, actualSha1)) {
        await fsp.rm(temporary, { force: true });
        throw new DownloadError(
          'checksum',
          url,
          `Checksum mismatch for ${url}: expected ${options.expectedSha1}, received ${actualSha1}`,
        );
      }
      if (options.expectedSize !== undefined) {
        const size = fs.stat(temporary).size;
        if (size !== options.expectedSize) {
          await fsp.rm(temporary, { force: true });
          throw new DownloadError('partial', url, `Size mismatch for ${url}: expected ${options.expectedSize}, received ${size}`);
        }
      }
      if (total !== undefined && received !== total) {
        await fsp.rm(temporary, { force: true });
        throw new DownloadError('partial', url, `Truncated download of ${url}: expected ${total} bytes, received ${received}`);
      }
      await fsp.rename(temporary, destination);
      clearTimeout(abortTimer);
      return;
    } catch (error) {
      clearTimeout(abortTimer);
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
      const classified =
        error instanceof DownloadError
          ? error
          : classifyFetchError(error, url);
      lastError = classified;
      const retriable =
        classified.kind === 'timeout' ||
        classified.kind === 'connection-reset' ||
        classified.kind === 'dns' ||
        classified.kind === 'partial';
      if (!retriable || attempt === retries) break;
      const backoff = Math.min(30_000, 500 * 2 ** (attempt - 1));
      options.logger?.debug(`Retrying ${url} in ${backoff}ms (attempt ${attempt}/${retries}): ${classified.message}`, options.stage);
      await delay(backoff);
    }
  }
  throw lastError ?? new DownloadError('http-error', url, `Failed to download ${url}`);
}

export function equalsIgnoreCase(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sha256File(target: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(target));
  return hash.digest('hex');
}

export function sha256Buffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function sha1File(target: string): string {
  const hash = crypto.createHash('sha1');
  hash.update(fs.readFileSync(target));
  return hash.digest('hex');
}

export async function fetchText(url: string, options: DownloadOptions = {}): Promise<string> {
  const response = await fetchWithDiagnostics(url, {
    headers: { 'user-agent': 'jmc/1.0 (+java-mod-compiler)', ...options.headers },
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  return response.text();
}

export async function fetchJson<T>(url: string, options: DownloadOptions = {}): Promise<T> {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new DownloadError('partial', url, `Malformed JSON from ${url}: ${(error as Error).message}`);
  }
}

export async function gunzip(buffer: Buffer): Promise<Buffer> {
  return promisify(zlib.gunzip)(buffer);
}

export function isProbablyGzip(buffer: Buffer): boolean {
  return buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

export function fileExists(target: string): boolean {
  return fs.existsSync(target);
}