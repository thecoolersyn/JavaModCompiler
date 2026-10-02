import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createApi, tempDir, zip } from '../helpers/harness.mjs';

const api = createApi();

function distributionBytes(marker) {
  return zip([
    { name: 'gradle-1.0.0/bin/gradle', data: Buffer.from('#!/bin/sh\necho gradle\n', 'utf8') },
    { name: 'gradle-1.0.0/bin/gradle.bat', data: Buffer.from('@echo off\r\necho gradle\r\n', 'utf8') },
    { name: 'gradle-1.0.0/README', data: Buffer.from(`distribution ${marker}`, 'utf8') },
  ]);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function startChecksumServer(archive, { publishChecksum, servedArchive, publishedArchive } = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if ((request.url ?? '').endsWith('.sha256')) {
      if (publishChecksum === false) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`${sha256(publishedArchive ?? archive)}  gradle-1.0.0-bin.zip\n`);
      return;
    }
    const body = servedArchive ?? archive;
    response.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(body.length) });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function seedCache(home, archive, { markerChecksum, installStateChecksum } = {}) {
  const cache = path.join(home, 'cache', 'gradle');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'gradle-1.0.0-bin.zip'), archive);
  if (markerChecksum !== null) {
    fs.writeFileSync(path.join(cache, 'gradle-1.0.0-bin.zip.sha256'), `${markerChecksum ?? sha256(archive)}\n`);
  }
  const binDirectory = path.join(cache, 'gradle-1.0.0', 'gradle-1.0.0', 'bin');
  fs.mkdirSync(binDirectory, { recursive: true });
  fs.writeFileSync(path.join(binDirectory, process.platform === 'win32' ? 'gradle.bat' : 'gradle'), 'echo gradle\n');
  if (installStateChecksum !== null) {
    fs.writeFileSync(
      path.join(cache, 'gradle-1.0.0.install.json'),
      JSON.stringify({ version: '1.0.0', archiveChecksum: installStateChecksum ?? sha256(archive), algorithm: 'sha256', recordedAt: 1 }, null, 2),
    );
  }
  return cache;
}

test('a valid cache is used without contacting the checksum server', async () => {
  const archive = distributionBytes('cache-first');
  const server = await startChecksumServer(archive, { publishChecksum: false });
  const home = tempDir('gradle-cache-before-network');
  try {
    seedCache(home, archive);
    const manager = await api.createGradleManager({ home, offline: false });
    const install = await manager.ensureDistribution('1.0.0', {
      distributionUrl: `${server.origin}/distributions/gradle-1.0.0-bin.zip`,
    });
    assert.equal(install.version, '1.0.0');
    assert.deepEqual(server.requests, [], 'a verified cache entry must be used before any network request');
  } finally {
    await server.close();
  }
});

test('a valid cache is used with the network entirely unreachable', async () => {
  const archive = distributionBytes('offline-valid');
  const home = tempDir('gradle-cache-offline-valid');
  seedCache(home, archive);
  const offline = await api.createGradleManager({ home, offline: true });
  const install = await offline.ensureDistribution('1.0.0', {
    distributionUrl: 'http://127.0.0.1:1/distributions/gradle-1.0.0-bin.zip',
  });
  assert.equal(install.version, '1.0.0');
  assert.match(install.gradleHome, /gradle-1\.0\.0/);
});

test('a cache written by an older JMC version is reinstalled from its verified archive', async () => {
  const archive = distributionBytes('old-format');
  const home = tempDir('gradle-cache-old-format');
  const cache = seedCache(home, archive, { installStateChecksum: null });
  const offline = await api.createGradleManager({ home, offline: true });
  const install = await offline.ensureDistribution('1.0.0', {
    distributionUrl: 'http://127.0.0.1:1/distributions/gradle-1.0.0-bin.zip',
  });
  assert.equal(install.version, '1.0.0');
  const statePath = path.join(cache, 'gradle-1.0.0.install.json');
  assert.equal(fs.existsSync(statePath), true, 'an installation record must be created for a reused old-format cache');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.archiveChecksum, sha256(archive));
  assert.equal(state.algorithm, 'sha256');
});

test('an installation whose record does not match the verified archive is recreated', async () => {
  const archive = distributionBytes('install-mismatch');
  const home = tempDir('gradle-cache-install-mismatch');
  const cache = seedCache(home, archive, { installStateChecksum: 'b'.repeat(64) });
  const offline = await api.createGradleManager({ home, offline: true });
  const install = await offline.ensureDistribution('1.0.0', {
    distributionUrl: 'http://127.0.0.1:1/distributions/gradle-1.0.0-bin.zip',
  });
  assert.equal(install.version, '1.0.0');
  const state = JSON.parse(fs.readFileSync(path.join(cache, 'gradle-1.0.0.install.json'), 'utf8'));
  assert.equal(state.archiveChecksum, sha256(archive), 'the installation record must be rewritten to the verified archive');
});

test('a tampered extracted launcher is not silently trusted', async () => {
  const archive = distributionBytes('tamper');
  const home = tempDir('gradle-cache-tampered');
  const cache = seedCache(home, archive);
  fs.writeFileSync(
    path.join(cache, 'gradle-1.0.0', 'gradle-1.0.0', 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle'),
    'echo tampered\n',
  );
  const statePath = path.join(cache, 'gradle-1.0.0.install.json');
  fs.rmSync(statePath);
  const offline = await api.createGradleManager({ home, offline: true });
  const install = await offline.ensureDistribution('1.0.0', {
    distributionUrl: 'http://127.0.0.1:1/distributions/gradle-1.0.0-bin.zip',
  });
  assert.equal(install.version, '1.0.0');
  const launcher = path.join(install.gradleHome, 'bin', process.platform === 'win32' ? 'gradle.bat' : 'gradle');
  assert.equal(fs.readFileSync(launcher, 'utf8').includes('tampered'), false, 'the tampered launcher must be replaced by a fresh extraction');
});

test('a downloaded archive whose checksum mismatches is discarded and never installed', async () => {
  const archive = distributionBytes('honest');
  const tampered = distributionBytes('tampered');
  const server = await startChecksumServer(archive, { publishChecksum: true, servedArchive: tampered });
  const home = tempDir('gradle-cache-download-mismatch');
  try {
    const manager = await api.createGradleManager({ home, offline: false });
    await assert.rejects(
      () => manager.ensureDistribution('1.0.0', { distributionUrl: `${server.origin}/distributions/gradle-1.0.0-bin.zip` }),
      (error) => {
        assert.equal(error.name, 'GradleDistributionVerificationError');
        assert.equal(error.expected, sha256(archive));
        return true;
      },
    );
  } finally {
    await server.close();
  }
  const cache = path.join(home, 'cache', 'gradle');
  const leftovers = fs.existsSync(cache) ? fs.readdirSync(cache) : [];
  assert.equal(leftovers.includes('gradle-1.0.0-bin.zip'), false, 'the mismatching archive must not be kept');
  assert.equal(
    leftovers.some((entry) => entry.includes('.part')),
    false,
    'no partial download may be left behind',
  );
  assert.equal(leftovers.includes('gradle-1.0.0.install.json'), false, 'no installation record may be written for a rejected download');
  assert.equal(leftovers.includes('gradle-1.0.0-bin.zip.sha256'), false, 'no marker may be written for a rejected download');
});

test('a marker is written only after the archive verifies', async () => {
  const archive = distributionBytes('marker-order');
  const server = await startChecksumServer(archive, { publishChecksum: true });
  const home = tempDir('gradle-cache-marker-order');
  const cache = path.join(home, 'cache', 'gradle');
  try {
    const manager = await api.createGradleManager({ home, offline: false });
    await manager.ensureDistribution('1.0.0', { distributionUrl: `${server.origin}/distributions/gradle-1.0.0-bin.zip` });
    const marker = fs.readFileSync(path.join(cache, 'gradle-1.0.0-bin.zip.sha256'), 'utf8').trim();
    assert.equal(marker, sha256(archive));
    const recorded = fs.readFileSync(path.join(cache, 'gradle-1.0.0-bin.zip'));
    assert.equal(sha256(recorded), marker, 'the marker must describe the archive that is actually on disk');
  } finally {
    await server.close();
  }
});

test('an unreachable network with a corrupt cache fails closed rather than installing', async () => {
  const archive = distributionBytes('corrupt');
  const home = tempDir('gradle-cache-corrupt-offline');
  seedCache(home, archive, { markerChecksum: 'c'.repeat(64) });
  const offline = await api.createGradleManager({ home, offline: true });
  await assert.rejects(
    () => offline.ensureDistribution('1.0.0', { distributionUrl: 'http://127.0.0.1:1/distributions/gradle-1.0.0-bin.zip' }),
    /offline|corrupt|not present/i,
  );
  const cache = path.join(home, 'cache', 'gradle');
  assert.equal(fs.existsSync(path.join(cache, 'gradle-1.0.0-bin.zip')), false, 'a corrupt cache entry must be discarded');
});
