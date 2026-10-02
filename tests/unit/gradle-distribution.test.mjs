import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createApi, tempDir, write, zip } from '../helpers/harness.mjs';

const api = createApi();

function zipBytes(marker) {
  return zip([
    { name: 'gradle-1.0.0/bin/gradle', data: Buffer.from('#!/bin/sh\necho gradle\n', 'utf8') },
    { name: 'gradle-1.0.0/bin/gradle.bat', data: Buffer.from('@echo off\r\necho gradle\r\n', 'utf8') },
    { name: 'gradle-1.0.0/README', data: Buffer.from(`fake gradle distribution ${marker}`, 'utf8') },
  ]);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function startServer(archive, { publishChecksum = true, checksumOverride = null } = {}) {
  const archiveBuffer = typeof archive === 'string' ? Buffer.from(archive, 'utf8') : archive;
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    const url = request.url ?? '';
    if (url.endsWith('.sha256')) {
      if (publishChecksum === false) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`${checksumOverride ?? sha256(archiveBuffer)}  gradle-1.0.0-bin.zip\n`);
      return;
    }
    if (url.endsWith('.zip')) {
      response.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(archiveBuffer.length) });
      response.end(archiveBuffer);
      return;
    }
    response.writeHead(404);
    response.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    requests,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('a matching published checksum passes and the distribution is installed', async () => {
  const archive = zipBytes('match');
  const server = await startServer(archive);
  try {
    const home = tempDir('gradle-checksum-match');
    const manager = await api.createGradleManager({ home, offline: false });
    const url = `${server.origin}/distributions/gradle-1.0.0-bin.zip`;
    const install = await manager.ensureDistribution('1.0.0', { distributionUrl: url });
    assert.equal(install.version, '1.0.0');
    assert.ok(server.requests.some((entry) => entry.endsWith('.sha256')), 'the published checksum must be fetched');
  } finally {
    await server.close();
  }
});

test('a checksum mismatch fails and the partial archive is deleted', async () => {
  const archive = zipBytes('mismatch');
  const server = await startServer(archive, { checksumOverride: 'a'.repeat(64) });
  const home = tempDir('gradle-checksum-mismatch');
  try {
    const manager = await api.createGradleManager({ home, offline: false });
    const url = `${server.origin}/distributions/gradle-1.0.0-bin.zip`;
    await assert.rejects(
      () => manager.ensureDistribution('1.0.0', { distributionUrl: url }),
      (error) => {
        assert.match(error.name, /GradleDistributionVerificationError|ChecksumMismatch|Verification/);
        return true;
      },
    );
    const cache = path.join(home, 'cache', 'gradle');
    const leftovers = fs.existsSync(cache) ? fs.readdirSync(cache).filter((entry) => entry.includes('.part-') || entry.endsWith('.zip')) : [];
    assert.deepEqual(leftovers, [], 'a failed verification must not leave a partial archive behind');
  } finally {
    await server.close();
  }
});

test('a missing checksum fails closed', async () => {
  const archive = zipBytes('missing');
  const server = await startServer(archive, { publishChecksum: false });
  const home = tempDir('gradle-checksum-missing');
  try {
    const manager = await api.createGradleManager({ home, offline: false });
    const url = `${server.origin}/distributions/gradle-1.0.0-bin.zip`;
    await assert.rejects(
      () => manager.ensureDistribution('1.0.0', { distributionUrl: url }),
      (error) => {
        assert.match(error.message, /checksum/i);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test('a declared distributionSha256Sum is used as an additional check', async () => {
  const archive = zipBytes('declared');
  const server = await startServer(archive, { checksumOverride: 'b'.repeat(64) });
  const home = tempDir('gradle-checksum-declared');
  const project = tempDir('gradle-checksum-project');
  write(
    project,
    'gradle/wrapper/gradle-wrapper.properties',
    'distributionUrl=https\\://services.gradle.org/distributions/gradle-1.0.0-bin.zip\ndistributionSha256Sum=b2f5e1c1e1a7d4a2f7cbbf59c1f9e4a1d3a0a6f0b8d1c2e3f4a5b6c7d8e9f0a1b\n',
  );
  try {
    const manager = await api.createGradleManager({ home, offline: false });
    const url = `${server.origin}/distributions/gradle-1.0.0-bin.zip`;
    await assert.rejects(() => manager.ensureDistribution('1.0.0', { projectRoot: project, distributionUrl: url }), /checksum|does not match/i);
  } finally {
    await server.close();
  }
});

test('a corrupt cached archive is discarded and re-verified on reuse', async () => {
  const archive = zipBytes('cached');
  const server = await startServer(archive);
  const home = tempDir('gradle-checksum-cache');
  const cache = path.join(home, 'cache', 'gradle');
  fs.mkdirSync(cache, { recursive: true });
  const archivePath = path.join(cache, 'gradle-1.0.0-bin.zip');
  fs.writeFileSync(archivePath, 'corrupt archive');
  fs.writeFileSync(`${archivePath}.sha256`, `${'0'.repeat(64)}\n`);
  const installRoot = path.join(cache, 'gradle-1.0.0', process.platform === 'win32' ? 'bin' : 'bin');
  fs.mkdirSync(installRoot, { recursive: true });
  const launcher = path.join(installRoot, process.platform === 'win32' ? 'gradle.bat' : 'gradle');
  fs.writeFileSync(launcher, 'echo gradle\n');
  try {
    const manager = await api.createGradleManager({ home, offline: false });
    const url = `${server.origin}/distributions/gradle-1.0.0-bin.zip`;
    const install = await manager.ensureDistribution('1.0.0', { distributionUrl: url });
    assert.equal(install.version, '1.0.0');
    assert.equal(sha256(fs.readFileSync(archivePath)), sha256(archive), 'the corrupt archive must be replaced by a verified download');
  } finally {
    await server.close();
  }
});

test('a verified distribution is reused instead of downloaded again', async () => {  const archive = zipBytes('reuse');
  const server = await startServer(archive);
  const home = tempDir('gradle-checksum-reuse');
  const cache = path.join(home, 'cache', 'gradle');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'gradle-1.0.0-bin.zip'), archive);
  fs.writeFileSync(path.join(cache, 'gradle-1.0.0-bin.zip.sha256'), `${sha256(archive)}\n`);
  fs.mkdirSync(path.join(cache, 'gradle-1.0.0', 'gradle-1.0.0', 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(cache, 'gradle-1.0.0', 'gradle-1.0.0', 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle'),
    'echo gradle\n',
  );
  try {
    const manager = await api.createGradleManager({ home, offline: false });
    const url = `${server.origin}/distributions/gradle-1.0.0-bin.zip`;
    const install = await manager.ensureDistribution('1.0.0', { distributionUrl: url });
    assert.equal(install.version, '1.0.0');
    assert.equal(
      install.gradleHome.includes(`${path.sep}gradle-1.0.0${path.sep}gradle-1.0.0`),
      true,
      `the nested distribution layout must be resolved, got ${install.gradleHome}`,
    );
    assert.equal(server.requests.filter((entry) => entry.endsWith('.zip')).length, 0, 'the archive must not be downloaded again');
  } finally {
    await server.close();
  }
});

test('offline mode reuses a previously verified distribution', async () => {
  const archive = zipBytes('offline');
  const server = await startServer(archive);
  const home = tempDir('gradle-checksum-offline');
  const cache = path.join(home, 'cache', 'gradle');
  fs.mkdirSync(cache, { recursive: true });
  const archivePath = path.join(cache, 'gradle-1.0.0-bin.zip');
  fs.writeFileSync(archivePath, archive);
  fs.writeFileSync(`${archivePath}.sha256`, `${sha256(archive)}\n`);
  const binDirectory = path.join(cache, 'gradle-1.0.0', 'bin');
  fs.mkdirSync(binDirectory, { recursive: true });
  fs.writeFileSync(path.join(binDirectory, process.platform === 'win32' ? 'gradle.bat' : 'gradle'), 'echo gradle\n');
  try {
    const online = await api.createGradleManager({ home, offline: false });
    const url = `${server.origin}/distributions/gradle-1.0.0-bin.zip`;
    const onlineInstall = await online.ensureDistribution('1.0.0', { distributionUrl: url });
    assert.equal(onlineInstall.version, '1.0.0');
    const before = server.requests.length;
    const offline = await api.createGradleManager({ home, offline: true });
    const offlineInstall = await offline.ensureDistribution('1.0.0', { distributionUrl: url });
    assert.equal(offlineInstall.version, '1.0.0');
    assert.equal(server.requests.length, before, 'offline mode must not perform any request');
  } finally {
    await server.close();
  }
});
