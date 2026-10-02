import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createApi, tempDir, zip } from '../helpers/harness.mjs';

const api = createApi();

const LOCAL_REPOSITORY_PORT = 8731;
const ARTIFACT_CONTENT = Buffer.from('library-jar-content-for-tests');

function startRepository(files, options = {}) {
  const repositoryId = options.id ?? `repo-${randomUUID()}`;
  const server = options.server ?? http.createServer();
  let requestLog = [];
  server.on('request', (request, response) => {
    const url = request.url ?? '/';
    requestLog.push(url);
    const failure = options.failureFor?.(url);
    if (failure !== undefined) {
      response.writeHead(failure.status, { 'content-type': 'text/plain' });
      response.end(failure.body ?? 'error');
      return;
    }
    const entry = files[url];
    if (entry === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    const body = Buffer.isBuffer(entry) ? entry : Buffer.from(entry, 'utf8');
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) });
    response.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : LOCAL_REPOSITORY_PORT;
      resolve({
        id: repositoryId,
        url: `http://127.0.0.1:${port}`,
        port,
        server,
        requests: () => requestLog,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function pomFor(group, artifact, version, dependencies = []) {
  const entries = dependencies
    .map(
      (dependency) =>
        `    <dependency><groupId>${dependency.group}</groupId><artifactId>${dependency.artifact}</artifactId><version>${dependency.version}</version><scope>${dependency.scope ?? 'compile'}</scope></dependency>`,
    )
    .join('\n');
  return [
    '<project>',
    `  <groupId>${group}</groupId>`,
    `  <artifactId>${artifact}</artifactId>`,
    `  <version>${version}</version>`,
    '  <dependencies>',
    entries,
    '  </dependencies>',
    '</project>',
  ].join('\n');
}

test('dependency resolution downloads an artifact and its pom', async () => {
  const home = tempDir('deps-basic');
  const repository = await startRepository({ id: `repo-${randomUUID()}`,
    '/com/example/lib/1.0.0/lib-1.0.0.jar': ARTIFACT_CONTENT,
    '/com/example/lib/1.0.0/lib-1.0.0.pom': pomFor('com.example', 'lib', '1.0.0'),
  });
  try {
    const result = await api.resolveDependencies({
      repositories: [{ id: repository.id, url: repository.url, kind: 'maven', priority: 10, source: 'test' }],
      dependencies: [{ coordinate: { groupId: 'com.example', artifactId: 'lib', version: '1.0.0', extension: 'jar' } }],
      transitive: true,
    });
    assert.equal(result.totalResolved, 1);
    assert.equal(result.unresolved.length, 0);
    const root = result.roots[0];
    assert.equal(root.status, 'resolved');
    assert.equal(root.resolvedFile.endsWith('lib-1.0.0.jar'), true);
    assert.equal(fs.readFileSync(root.resolvedFile).equals(ARTIFACT_CONTENT), true);
  } finally {
    await repository.close();
    void home;
  }
});

test('dependency resolution follows transitive dependencies', async () => {
  const repository = await startRepository({ id: `repo-${randomUUID()}`,
    '/com/example/parent/2.0.0/parent-2.0.0.jar': Buffer.from('parent'),
    '/com/example/parent/2.0.0/parent-2.0.0.pom': pomFor('com.example', 'parent', '2.0.0', [
      { group: 'com.example', artifact: 'child', version: '2.1.0' },
    ]),
    '/com/example/child/2.1.0/child-2.1.0.jar': Buffer.from('child'),
    '/com/example/child/2.1.0/child-2.1.0.pom': pomFor('com.example', 'child', '2.1.0'),
  });
  try {
    const result = await api.resolveDependencies({
      repositories: [{ id: repository.id, url: repository.url, kind: 'maven', priority: 10, source: 'test' }],
      dependencies: [{ coordinate: { groupId: 'com.example', artifactId: 'parent', version: '2.0.0', extension: 'jar' } }],
      transitive: true,
    });
    assert.equal(result.totalResolved, 2);
    const root = result.roots[0];
    assert.equal(root.children.length, 1);
    assert.equal(root.children[0].coordinate.artifactId, 'child');
    assert.equal(root.children[0].coordinate.version, '2.1.0');
  } finally {
    await repository.close();
  }
});

test('dependency resolution honours exclusions', async () => {
  const repository = await startRepository({ id: `repo-${randomUUID()}`,
    '/com/example/with-exclusion/1.0.0/with-exclusion-1.0.0.jar': Buffer.from('parent'),
    '/com/example/with-exclusion/1.0.0/with-exclusion-1.0.0.pom': [
      '<project>',
      '  <groupId>com.example</groupId>',
      '  <artifactId>with-exclusion</artifactId>',
      '  <version>1.0.0</version>',
      '  <dependencies>',
      '    <dependency><groupId>com.example</groupId><artifactId>excluded</artifactId><version>1.0.0</version></dependency>',
      '    <dependency><groupId>com.example</groupId><artifactId>kept</artifactId><version>1.0.0</version></dependency>',
      '  </dependencies>',
      '</project>',
    ].join('\n'),
    '/com/example/kept/1.0.0/kept-1.0.0.jar': Buffer.from('kept'),
    '/com/example/kept/1.0.0/kept-1.0.0.pom': pomFor('com.example', 'kept', '1.0.0'),
  });
  try {
    const result = await api.resolveDependencies({
      repositories: [{ id: repository.id, url: repository.url, kind: 'maven', priority: 10, source: 'test' }],
      dependencies: [{ coordinate: { groupId: 'com.example', artifactId: 'with-exclusion', version: '1.0.0', extension: 'jar' } }],
      transitive: true,
      exclusions: [{ groupId: 'com.example', artifactId: 'excluded' }],
    });
    const root = result.roots[0];
    assert.equal(root.children.length, 1);
    assert.equal(root.children[0].coordinate.artifactId, 'kept');
  } finally {
    await repository.close();
  }
});

test('unresolved dependencies report coordinate, requester and repositories', async () => {
  const repository = await startRepository({}, { id: `missing-${randomUUID()}` });
  try {
    const result = await api.resolveDependencies({
      repositories: [{ id: repository.id, url: repository.url, kind: 'maven', priority: 10, source: 'test' }],
      dependencies: [{ coordinate: { groupId: 'com.example', artifactId: 'absent', version: '9.9.9', extension: 'jar' } }],
      transitive: true,
    });
    assert.equal(result.totalResolved, 0);
    assert.equal(result.unresolved.length, 1);
    const entry = result.unresolved[0];
    assert.equal(entry.coordinate.groupId, 'com.example');
    assert.equal(entry.coordinate.version, '9.9.9');
    assert.ok(entry.requestedBy.length > 0);
    assert.ok(entry.repositoriesChecked.some((label) => label.startsWith(repository.id)));
    assert.match(entry.cause, /not found/i);
  } finally {
    await repository.close();
  }
});

test('an HTTP 403 is surfaced rather than treated as success', async () => {
  const repository = await startRepository(
    {},
    {
      id: `forbidden-${randomUUID()}`,
      failureFor: (url) => (url.endsWith('.jar') ? { status: 403, body: 'forbidden' } : undefined),
    },
  );
  try {
    const result = await api.resolveDependencies({
      repositories: [{ id: repository.id, url: repository.url, kind: 'maven', priority: 10, source: 'test' }],
      dependencies: [{ coordinate: { groupId: 'com.example', artifactId: 'forbidden', version: '1.0.0', extension: 'jar' } }],
      transitive: false,
    });
    assert.equal(result.unresolved.length, 1);
    assert.equal(result.totalResolved, 0);
  } finally {
    await repository.close();
  }
});

test('a cached artifact is reused without a second download', async () => {
  const repository = await startRepository(
    {
      '/com/example/cached/1.0.0/cached-1.0.0.jar': ARTIFACT_CONTENT,
      '/com/example/cached/1.0.0/cached-1.0.0.pom': pomFor('com.example', 'cached', '1.0.0'),
    },
    { id: `offline-${randomUUID()}` },
  );
  try {
    const resolveWith = (repositoryId) =>
      api.resolveDependencies({
        repositories: [{ id: repositoryId, url: repository.url, kind: 'maven', priority: 10, source: 'test' }],
        dependencies: [{ coordinate: { groupId: 'com.example', artifactId: 'cached', version: '1.0.0', extension: 'jar' } }],
        transitive: true,
      });

    const repositoryId = `offline-${randomUUID()}`;
    const first = await resolveWith(repositoryId);
    assert.equal(first.totalResolved, 1);
    const requestsAfterFirst = repository.requests().length;
    assert.ok(requestsAfterFirst >= 2);

    const second = await resolveWith(repositoryId);
    assert.equal(second.totalResolved, 1);
    assert.equal(second.roots[0].resolvedFile, first.roots[0].resolvedFile);
    assert.equal(repository.requests().length, requestsAfterFirst, 'a cached artifact must not be downloaded again');
  } finally {
    await repository.close();
  }
});

test('a version catalog alias resolves through the gradle model', async () => {
  const root = tempDir('deps-version-catalog');
  fs.mkdirSync(path.join(root, 'gradle'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'build.gradle'),
    ['plugins { id "java" }', 'dependencies {', '    implementation libs.gson', '}'].join('\n'),
  );
  fs.writeFileSync(
    path.join(root, 'gradle', 'libs.versions.toml'),
    [
      '[versions]',
      'gson = "2.10.1"',
      '',
      '[libraries]',
      'gson = { module = "com.google.code.gson:gson", version.ref = "gson" }',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(root, 'gradle.properties'), 'minecraft_version=1.20.1\n');
  fs.mkdirSync(path.join(root, 'src', 'main', 'java'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'main', 'java', 'A.java'), 'class A {}\n');
  const project = await api.detectProject(root);
  assert.deepEqual(project.gradle.dependencies.dependencies, ['libs.gson']);
  assert.equal(project.gradle.properties['libs.gson'], 'com.google.code.gson:gson:2.10.1');
});

test('local jars are reported with their loader metadata', async () => {
  const root = tempDir('deps-local-jar');
  fs.mkdirSync(path.join(root, 'libs'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'libs', 'helper-1.0.jar'),
    zip([
      { name: 'META-INF/MANIFEST.MF', data: Buffer.from('Manifest-Version: 1.0\n') },
      { name: 'fabric.mod.json', data: Buffer.from(JSON.stringify({ schemaVersion: 1, id: 'helper', version: '1.0' }), 'utf8') },
      { name: 'META-INF/jar/nested-1.0.jar', data: Buffer.from('nested') },
    ]),
  );
  fs.writeFileSync(path.join(root, 'build.gradle'), 'plugins { id "java" }\n');
  fs.writeFileSync(path.join(root, 'gradle.properties'), 'minecraft_version=1.20.1\n');
  fs.mkdirSync(path.join(root, 'src', 'main', 'java'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'main', 'java', 'A.java'), 'class A {}\n');
  const project = await api.detectProject(root);
  assert.deepEqual(project.localJars, ['libs/helper-1.0.jar']);
  const inspection = await api.inspectJar(path.join(root, 'libs', 'helper-1.0.jar'));
  assert.ok(inspection.resources.includes('fabric.mod.json'));
  assert.ok(inspection.resources.some((entry) => entry.startsWith('META-INF/jar/')));
});