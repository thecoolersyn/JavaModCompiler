import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function fileUriForPath(target: string): string {
  return pathToFileURL(path.resolve(target)).href;
}

export function isValidFileUri(value: string): boolean {
  if (/^file:\/\/\//i.test(value) === false) return false;
  try {
    return new URL(value).protocol === 'file:';
  } catch {
    return false;
  }
}
