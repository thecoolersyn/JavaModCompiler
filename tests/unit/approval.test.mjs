import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createApi, tempDir, write } from '../helpers/harness.mjs';

const api = createApi();

function gradleProject(name) {
  const root = tempDir(name);
  write(root, 'build.gradle', "plugins { id 'java' }\n");
  write(root, 'settings.gradle', "rootProject.name = 'fixture'\n");
  write(root, 'gradle.properties', 'minecraft_version=1.20.1\n');
  write(root, 'src/main/java/com/example/A.java', 'package com.example;\npublic class A {}\n');
  return root;
}

function pathsOf(descriptors) {
  return descriptors.map((descriptor) => descriptor.path);
}

test('build script digests are taken from file contents, not size and mtime', async () => {
  const root = gradleProject('approval-content-digest');
  const before = await api.collectBuildScripts(root);
  const target = path.join(root, 'build.gradle');
  const stat = fs.statSync(target);
  const original = "plugins { id 'java' }\n";
  const mutated = "plugins { id 'java' } ";
  assert.equal(original.length, mutated.length, 'the mutation must keep the file size identical');
  fs.writeFileSync(target, mutated, 'utf8');
  fs.utimesSync(target, stat.atime, stat.mtime);
  const after = await api.collectBuildScripts(root);
  assert.deepEqual(pathsOf(before), pathsOf(after));
  assert.notDeepEqual(before.map((entry) => entry.digest), after.map((entry) => entry.digest));
  assert.notEqual(await api.digestOfScripts(before), await api.digestOfScripts(after));
});

test('touching a build script does not invalidate the digest', async () => {
  const root = gradleProject('approval-touch');
  const before = await api.collectBuildScripts(root);
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(root, 'build.gradle'), future, future);
  const after = await api.collectBuildScripts(root);
  assert.deepEqual(before, after);
  assert.equal(await api.digestOfScripts(before), await api.digestOfScripts(after));
});

test('the digest covers subproject, buildSrc, wrapper and maven configuration', async () => {
  const root = gradleProject('approval-coverage');
  write(root, 'core/build.gradle', "plugins { id 'java' }\n");
  write(root, 'core/settings.gradle', "rootProject.name = 'core'\n");
  write(root, 'core/gradle.properties', 'core_version=1\n');
  write(root, 'buildSrc/build.gradle', "plugins { id 'groovy' }\n");
  write(root, 'buildSrc/src/main/groovy/Helper.groovy', 'class Helper {}\n');
  write(root, 'gradle/libs.versions.toml', '[versions]\nloom = "1.6.12"\n');
  write(root, 'gradle/check.gradle', 'tasks.register("noop") {}\n');
  write(root, 'gradle/wrapper/gradle-wrapper.properties', 'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.10.2-bin.zip\n');
  fs.mkdirSync(path.join(root, 'gradle', 'wrapper'), { recursive: true });
  write(root, 'gradle/wrapper/gradle-wrapper.jar', 'wrapper-bytes');
  write(root, 'gradlew', '#!/bin/sh\n');
  write(root, 'gradlew.bat', '@echo off\n');
  write(root, '.mvn/extensions.xml', '<extensions/>\n');
  write(root, '.mvn/jvm.config', '-Xmx1g\n');
  write(root, 'mvnw', '#!/bin/sh\n');
  write(root, 'pom.xml', '<project><artifactId>root</artifactId></project>\n');
  write(root, 'module-a/pom.xml', '<project><artifactId>a</artifactId></project>\n');
  write(root, 'build/generated.gradle', 'tasks.register("generated") {}\n');
  write(root, 'node_modules/evil/build.gradle', 'throw new Error("never")\n');

  const paths = pathsOf(await api.collectBuildScripts(root));
  for (const expected of [
    'build.gradle',
    'settings.gradle',
    'gradle.properties',
    'core/build.gradle',
    'core/settings.gradle',
    'core/gradle.properties',
    'buildSrc/build.gradle',
    'buildSrc/src/main/groovy/Helper.groovy',
    'gradle/libs.versions.toml',
    'gradle/check.gradle',
    'gradle/wrapper/gradle-wrapper.properties',
    'gradle/wrapper/gradle-wrapper.jar',
    'gradlew',
    'gradlew.bat',
    '.mvn/extensions.xml',
    '.mvn/jvm.config',
    'mvnw',
    'pom.xml',
    'module-a/pom.xml',
  ]) {
    assert.ok(paths.includes(expected), `the digest must cover ${expected}; got ${paths.join(', ')}`);
  }
  assert.equal(paths.includes('build/generated.gradle'), false, 'build output directories must be skipped');
  assert.equal(paths.includes('node_modules/evil/build.gradle'), false, 'node_modules must be skipped');
  assert.equal(paths.includes('package.json'), false, 'JMC never executes package.json for a project build');
  assert.deepEqual(paths, [...paths].sort(), 'descriptors must be returned in sorted order');
  assert.equal(
    paths.every((entry) => entry.includes('\\')),
    false,
    'relative paths must use forward slashes on every platform',
  );
});

test('scripts pulled in through apply from are covered', async () => {
  const root = gradleProject('approval-apply-from');
  write(root, 'gradle/conventions.gradle', "tasks.register('conventions') {}\n");
  write(root, 'gradle/nested/extra.gradle', "tasks.register('extra') {}\n");
  write(root, 'build.gradle', "apply from: 'gradle/conventions.gradle'\napply from: 'gradle/nested/extra.gradle'\n");
  const paths = pathsOf(await api.collectBuildScripts(root));
  assert.ok(paths.includes('gradle/conventions.gradle'));
  assert.ok(paths.includes('gradle/nested/extra.gradle'));
});

test('includeBuild directories are covered', async () => {
  const root = gradleProject('approval-include-build');
  write(root, 'settings.gradle', "rootProject.name = 'fixture'\nincludeBuild('build-logic')\n");
  write(root, 'build-logic/settings.gradle', "rootProject.name = 'build-logic'\n");
  write(root, 'build-logic/build.gradle', "plugins { id 'java-gradle-plugin' }\n");
  const paths = pathsOf(await api.collectBuildScripts(root));
  assert.ok(paths.includes('build-logic/build.gradle'));
  assert.ok(paths.includes('build-logic/settings.gradle'));
});

test('changing a subproject, buildSrc, wrapper jar or .mvn script forces re-approval', async () => {
  const mutations = [
    ['subproject script', 'core/build.gradle'],
    ['buildSrc script', 'buildSrc/build.gradle'],
    ['wrapper jar', 'gradle/wrapper/gradle-wrapper.jar'],
    ['maven extensions', '.mvn/extensions.xml'],
  ];
  for (const [label, relative] of mutations) {
    const root = gradleProject(`approval-force-${label.replace(/\s+/g, '-')}`);
    write(root, 'settings.gradle', "rootProject.name = 'fixture'\ninclude 'core'\n");
    write(root, 'core/build.gradle', "plugins { id 'java' }\n");
    write(root, 'buildSrc/build.gradle', "plugins { id 'groovy' }\n");
    write(root, 'gradle/wrapper/gradle-wrapper.jar', 'wrapper-bytes-one');
    write(root, '.mvn/extensions.xml', '<extensions><extension/></extensions>\n');
    const before = await api.collectBuildScripts(root);
    fs.appendFileSync(path.join(root, relative.split('/').join(path.sep)), 'x');
    const after = await api.collectBuildScripts(root);
    assert.notEqual(
      await api.digestOfScripts(before),
      await api.digestOfScripts(after),
      `a change to ${relative} must invalidate the approval`,
    );
  }
});

async function approvalsFor(name, options) {
  const home = tempDir(name);
  const service = await api.createApprovalService({
    home,
    assumeYes: false,
    isCi: false,
    interactive: false,
    ...options,
  });
  return { home, service };
}

function storePath(home) {
  return path.join(home, 'approvals', 'project-approvals.json');
}

test('a non-interactive session without authorization is denied and explains what would run', async () => {
  const root = gradleProject('approval-non-interactive');
  const scripts = await api.collectBuildScripts(root);
  const { service } = await approvalsFor('approval-non-interactive-home');
  const decision = await service.requireAuthorization({
    projectRoot: root,
    buildSystem: 'Gradle',
    scripts,
    warningText: ['A project build can execute build-system code on this machine.'],
  });
  assert.equal(decision.allowed, false);
  assert.ok(decision.warnings.some((line) => /build-system code/.test(line)));
  assert.ok(decision.warnings.some((line) => line.trim() === 'build.gradle'));
  assert.ok(decision.warnings.some((line) => /build scripts would run/.test(line)));
});

test('the interactive prompt lists the scripts before asking for confirmation', async () => {
  const root = gradleProject('approval-interactive');
  const scripts = await api.collectBuildScripts(root);
  const emitted = [];
  const { service } = await approvalsFor('approval-interactive-home', { interactive: true, answer: 'y', emitted });
  const decision = await service.requireAuthorization({
    projectRoot: root,
    buildSystem: 'Gradle',
    scripts,
    warningText: ['A project build can execute build-system code on this machine.'],
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.persisted, true);
  assert.equal(emitted.length > 0, true, 'the warning must be printed before the prompt');
  assert.match(emitted.join('\n'), /build-system code/);
  assert.match(emitted.join('\n'), /build scripts would run/);
  assert.match(emitted.join('\n'), /build\.gradle/);
});

test('the script list is truncated with an and N more summary', async () => {
  const root = gradleProject('approval-truncation');
  for (let index = 0; index < 30; index += 1) {
    write(root, `gradle/extra-${index}.gradle`, `tasks.register('task${index}') {}\n`);
  }
  const scripts = await api.collectBuildScripts(root);
  assert.ok(scripts.length > 20);
  const emitted = [];
  const { service } = await approvalsFor('approval-truncation-home', { interactive: true, answer: 'y', emitted });
  await service.requireAuthorization({
    projectRoot: root,
    buildSystem: 'Gradle',
    scripts,
    warningText: ['warning'],
  });
  assert.match(emitted.join('\n'), /and \d+ more/);
});

test('flag and environment authorization never persist a record', async () => {
  const root = gradleProject('approval-flag');
  const scripts = await api.collectBuildScripts(root);
  for (const [label, options] of [
    ['flag', { assumeYes: true }],
    ['environment', { trustEnvironmentVariable: '1' }],
  ]) {
    const home = tempDir(`approval-${label}-home`);
    const service = await api.createApprovalService({ home, isCi: false, interactive: false, ...options });
    const decision = await service.requireAuthorization({
      projectRoot: root,
      buildSystem: 'Gradle',
      scripts,
      warningText: ['warning'],
    });
    assert.equal(decision.allowed, true, `${label} must authorize the run`);
    assert.equal(decision.persisted, false, `${label} must not persist an approval`);
    assert.equal(fs.existsSync(storePath(home)), false, `${label} must leave no record in the approvals store`);
    assert.deepEqual(service.list(), []);
  }
});

test('an interactive yes persists and a later identical run reuses the record', async () => {
  const root = gradleProject('approval-persist');
  const scripts = await api.collectBuildScripts(root);
  const home = tempDir('approval-persist-home');
  const service = await api.createApprovalService({ home, isCi: false, interactive: true, answer: 'y' });
  const first = await service.requireAuthorization({
    projectRoot: root,
    buildSystem: 'Gradle',
    scripts,
    warningText: ['warning'],
  });
  assert.equal(first.persisted, true);
  const stored = JSON.parse(fs.readFileSync(storePath(home), 'utf8'));
  assert.equal(stored.records.length, 1);
  assert.equal(stored.records[0].approvedBy, 'interactive');

  const second = await service.requireAuthorization({
    projectRoot: root,
    buildSystem: 'Gradle',
    scripts,
    warningText: ['warning'],
  });
  assert.equal(second.allowed, true);
  assert.equal(second.persisted, true);
  assert.equal(second.source, 'interactive');
});

test('a persisted approval is revoked when the scripts change', async () => {
  const root = gradleProject('approval-revoke');
  const home = tempDir('approval-revoke-home');
  const interactive = await api.createApprovalService({ home, isCi: false, interactive: true, answer: 'y' });
  await interactive.requireAuthorization({
    projectRoot: root,
    buildSystem: 'Gradle',
    scripts: await api.collectBuildScripts(root),
    warningText: ['warning'],
  });
  assert.equal(interactive.list().length, 1);
  fs.appendFileSync(path.join(root, 'gradle.properties'), '\nchanged=true\n');
  const nonInteractive = await api.createApprovalService({ home, isCi: false, interactive: false });
  const denied = await nonInteractive.requireAuthorization({
    projectRoot: root,
    buildSystem: 'Gradle',
    scripts: await api.collectBuildScripts(root),
    warningText: ['warning'],
  });
  assert.equal(denied.allowed, false, 'a changed script set must require authorization again');
  assert.equal(nonInteractive.list().length, 0, 'the stale record must be revoked');
});

test('the digest is stable across path separator styles', async () => {
  const root = gradleProject('approval-separators');
  const scripts = await api.collectBuildScripts(root);
  const windowsStyle = scripts.map((entry) => ({ path: entry.path.split('/').join('\\'), digest: entry.digest }));
  const posixStyle = scripts.map((entry) => ({ path: entry.path.split('/').join('/'), digest: entry.digest }));
  assert.equal(await api.digestOfScripts(windowsStyle), await api.digestOfScripts(posixStyle));
  const renamed = scripts.map((entry) => ({ path: `nested/${entry.path}`, digest: entry.digest }));
  assert.notEqual(
    await api.digestOfScripts(renamed),
    await api.digestOfScripts(scripts),
    'the digest must include each relative path',
  );
});
