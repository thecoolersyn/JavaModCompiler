import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, runCli, tempDir } from '../helpers/harness.mjs';

const api = createApi();

function release(body, overrides = {}) {
  return JSON.stringify({
    tag_name: 'v1.1.0',
    name: 'Release 1.1.0',
    html_url: 'https://github.com/thecoolersyn/JavaModCompiler/releases/tag/v1.1.0',
    published_at: '2026-01-02T03:04:05Z',
    prerelease: false,
    body,
    ...overrides,
  });
}

function checker(home, responder) {
  return api.createUpdateChecker(home, responder);
}

test('the current version equals the latest release', async () => {
  const home = tempDir('update-current');
  const service = await checker(home, async () => release('nothing new'));
  const check = await service.check({ currentVersion: '1.1.0', offline: false, force: true });
  assert.equal(check.latestVersion, '1.1.0');
  assert.equal(check.updateAvailable, false);
});

test('an older current version reports an available update', async () => {
  const home = tempDir('update-older');
  const service = await checker(home, async () => release('- Something fixed'));
  const check = await service.check({ currentVersion: '1.0.0', offline: false, force: true });
  assert.equal(check.updateAvailable, true);
  assert.equal(check.latestVersion, '1.1.0');
  assert.equal(check.releaseUrl, 'https://github.com/thecoolersyn/JavaModCompiler/releases/tag/v1.1.0');
});

test('a v-prefixed release tag is parsed', async () => {
  const parsed = await api.parseReleasePayload(release('body', { tag_name: 'v2.5.1' }));
  assert.equal(parsed.latestVersion, '2.5.1');
  const home = tempDir('update-vprefix');
  const service = await checker(home, async () => release('body', { tag_name: 'v2.5.1' }));
  const check = await service.check({ currentVersion: '2.5.0', offline: false, force: true });
  assert.equal(check.updateAvailable, true);
  assert.equal(check.latestVersion, '2.5.1');
});

test('prerelease handling prefers a stable release over a prerelease', async () => {
  assert.equal(await api.compareVersions('1.1.0', '1.1.0-beta.1') > 0, true);
  assert.equal(await api.compareVersions('1.1.0-beta.1', '1.1.0') < 0, true);
  assert.equal(await api.compareVersions('1.1.0-beta.1', '1.1.0-beta.2') < 0, true);
  assert.equal(await api.compareVersions('1.1.0-beta', '1.1.0-beta.1') < 0, true);
  assert.equal(await api.compareVersions('1.1.0-beta.1', '1.1.0-beta.1') === 0, true);
  assert.equal(await api.compareVersions('1.10.0', '1.9.0') > 0, true, 'versions must compare numerically, not lexicographically');
  assert.equal(await api.compareVersions('v2.0.0', '2.0.0') === 0, true);
  assert.equal(await api.isUpdateAvailable('1.0.0', '1.1.0-beta.1'), true);
  const home = tempDir('update-prerelease');
  const service = await checker(home, async () => release('- beta', { tag_name: 'v2.0.0-rc.1', prerelease: true }));
  const check = await service.check({ currentVersion: '1.9.9', offline: false, force: true });
  assert.equal(check.prerelease, true);
  assert.equal(check.latestVersion, '2.0.0-rc.1');
  assert.equal(check.updateAvailable, true);
});

test('a malformed release response never reports an update and never throws', async () => {
  assert.equal(await api.parseReleasePayload('not json at all'), undefined);
  assert.equal(await api.parseReleasePayload('{}'), undefined);
  assert.equal(await api.parseReleasePayload('{"tag_name":""}'), undefined);
  assert.equal(await api.parseReleasePayload('{"tag_name":"not-a-version"}'), undefined);
  assert.equal(await api.parseReleasePayload('[]'), undefined);
  const home = tempDir('update-malformed');
  const service = await checker(home, async () => 'this is not json');
  const check = await service.check({ currentVersion: '1.0.0', offline: false, force: true });
  assert.equal(check.updateAvailable, false);
  assert.equal(check.latestVersion, undefined);
  assert.match(check.failure ?? '', /could not be understood/);
});

test('GitHub being unavailable never throws and never reports an update', async () => {
  const home = tempDir('update-unreachable');
  const service = await checker(home, async () => {
    throw new Error('getaddrinfo ENOTFOUND api.github.com');
  });
  const check = await service.check({ currentVersion: '1.0.0', offline: false, force: true });
  assert.equal(check.updateAvailable, false);
  assert.match(check.failure ?? '', /ENOTFOUND/);
});

test('GitHub rate limiting is handled without throwing', async () => {
  const home = tempDir('update-rate-limited');
  const service = await checker(home, async () => {
    throw new Error('the GitHub API rate limited the update check (HTTP 403)');
  });
  const check = await service.check({ currentVersion: '1.0.0', offline: false, force: true });
  assert.equal(check.updateAvailable, false);
  assert.match(check.failure ?? '', /rate limited/);
});

test('a fresh cache is reused without a second request', async () => {
  const home = tempDir('update-fresh-cache');
  let calls = 0;
  const service = await checker(home, async () => {
    calls += 1;
    return release('- fixed');
  });
  const first = await service.check({ currentVersion: '1.0.0', offline: false, force: true, now: 1_000_000 });
  assert.equal(calls, 1);
  const second = await service.check({ currentVersion: '1.0.0', offline: false, force: false, now: 1_000_000 + 60_000 });
  assert.equal(calls, 1, 'a fresh cache must not trigger another network request');
  assert.equal(second.fromCache, true);
  assert.equal(second.updateAvailable, true);
  assert.equal(first.updateAvailable, second.updateAvailable);
});

test('a stale cache triggers a fresh request', async () => {
  const home = tempDir('update-stale-cache');
  let calls = 0;
  const service = await checker(home, async () => {
    calls += 1;
    return release('- fixed');
  });
  await service.check({ currentVersion: '1.0.0', offline: false, force: true, now: 1_000_000 });
  const afterTtl = await service.check({
    currentVersion: '1.0.0',
    offline: false,
    force: false,
    now: 1_000_000 + 7 * 60 * 60 * 1000,
  });
  assert.equal(calls, 2, 'a cache older than six hours must be refreshed');
  assert.equal(afterTtl.fromCache, false);
});

test('offline mode never performs a request and never reports an update', async () => {
  const home = tempDir('update-offline');
  let calls = 0;
  const service = await checker(home, async () => {
    calls += 1;
    return release('- fixed');
  });
  const check = await service.check({ currentVersion: '1.0.0', offline: true, force: true });
  assert.equal(calls, 0, 'offline mode must not contact GitHub');
  assert.equal(check.updateAvailable, false);
  assert.match(check.failure ?? '', /offline/);
});

test('release body headings are extracted with a bounded number of lines', async () => {
  const body = [
    '## Fixed',
    '- Fixed Fabric/Loom production artifact detection',
    '- Fixed Windows paths containing spaces',
    '',
    '## Added',
    '- Added verified Gradle cache reuse',
    '',
    '## Changed',
    '- Fixed Java toolchain selection',
    '- another change',
    '- a third change',
    '- a fourth change',
    '- a fifth change',
  ].join('\n');
  const summary = await api.extractReleaseSummary(body);
  assert.ok(summary.length <= 6, `the summary must stay bounded, got ${summary.length} lines`);
  assert.deepEqual(summary[0], { heading: 'Fixed', text: 'Fixed' });
  assert.ok(
    summary.some((entry) => entry.text === 'Fixed Fabric/Loom production artifact detection'),
    'a bullet under a heading must appear in the summary',
  );
  assert.ok(summary.some((entry) => entry.heading === 'Added'));
  assert.equal(
    summary.some((entry) => entry.text.includes('a fifth change')),
    false,
    'the summary must not dump the whole release body',
  );
});

test('a release body without headings is still summarized', async () => {
  const summary = await api.extractReleaseSummary('- one\n- two\n- three');
  assert.deepEqual(summary.map((entry) => entry.text), ['one', 'two', 'three']);
  assert.equal(summary.every((entry) => entry.heading === undefined), true);
});

test('an empty or missing release body produces no summary', async () => {
  assert.deepEqual(await api.extractReleaseSummary(undefined), []);
  assert.deepEqual(await api.extractReleaseSummary(''), []);
  assert.deepEqual(await api.extractReleaseSummary('   \n\n  '), []);
});

test('no notice is produced when JMC is already current', async () => {
  const notice = await api.updateNoticeFor({
    currentVersion: '1.1.0',
    latestVersion: '1.1.0',
    updateAvailable: false,
    summary: [],
  });
  assert.deepEqual(notice, [], 'a current installation must produce no notice');
});

test('the notice reports the transition, the release and the changes', async () => {
  const notice = await api.updateNoticeFor({
    currentVersion: '1.0.0',
    latestVersion: '1.1.0',
    updateAvailable: true,
    releaseTitle: 'Release 1.1.0',
    releaseUrl: 'https://github.com/thecoolersyn/JavaModCompiler/releases/tag/v1.1.0',
    summary: [
      { heading: 'Fixed', text: 'Fixed' },
      { heading: 'Fixed', text: 'Fixed Fabric/Loom production artifact detection' },
      { heading: 'Added', text: 'Added' },
    ],
  });
  assert.equal(notice[0], 'JMC update available: 1.0.0 → 1.1.0');
  assert.ok(notice.includes('Release: Release 1.1.0'));
  assert.ok(notice.includes('Latest changes:'));
  assert.ok(notice.includes('- Fixed'));
  assert.ok(notice.includes('- Fixed Fabric/Loom production artifact detection'));
  assert.ok(notice.includes('- Added'));
  assert.equal(
    notice[notice.length - 1],
    'GitHub: https://github.com/thecoolersyn/JavaModCompiler/releases/tag/v1.1.0',
  );
});

test('an available update does not change the exit code of a command', async () => {
  const home = tempDir('update-exit-code');
  const service = await checker(home, async () => release('- fixed'));
  const check = await service.check({ currentVersion: '1.0.0', offline: false, force: true });
  assert.equal(check.updateAvailable, true);
  for (const args of [['--version'], ['detect', '.'], ['--help']]) {
    const result = await runCli(args, {
      env: { JMC_HOME: home, JMC_DISABLE_UPDATE_CHECK: '1' },
      stdin: { isTTY: false },
    });
    assert.equal(result.code, 0, `jmc ${args.join(' ')} must still exit 0 with an update available`);
  }
});

test('an unreachable GitHub never fails the primary command', async () => {
  const home = tempDir('update-command-resilience');
  const result = await runCli(['--version'], {
    env: { JMC_HOME: home },
    stdin: { isTTY: false },
  });
  assert.equal(result.code, 0, 'the version command must succeed even when the update check cannot reach GitHub');
  assert.match(result.stdout, /jmc \d+\.\d+\.\d+/);
});

test('jmc update reports the installed version and never installs anything', async () => {
  const home = tempDir('update-command');
  const result = await runCli(['update', '--offline'], { env: { JMC_HOME: home }, stdin: { isTTY: false } });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Installed version:/);
  assert.match(result.stdout, /offline/);
  const online = await runCli(['update', '--json'], { env: { JMC_HOME: home }, stdin: { isTTY: false } });
  assert.equal(online.code, 0, 'jmc update must never fail the command');
  const parsed = JSON.parse(online.stdout);
  assert.equal(parsed.command, 'update');
  assert.equal(typeof parsed.currentVersion, 'string');
  assert.equal(typeof parsed.updateAvailable, 'boolean');
  assert.equal(typeof parsed.offline, 'boolean');
});

test('the update check adds no output in json mode', async () => {
  const home = tempDir('update-json-quiet');
  const result = await runCli(['--version', '--json'], { env: { JMC_HOME: home }, stdin: { isTTY: false } });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(typeof parsed.version, 'string');
  assert.equal(
    JSON.stringify(parsed).includes('update available'),
    false,
    'json mode must not print an update notice',
  );
});
