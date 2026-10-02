import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../helpers/harness.mjs';

const api = createApi();

test('Forge 1.16.5 targeting Java 8 on Gradle 6.9 keeps Java 8 selectable', async () => {
  const requirement = await api.resolveJavaRequirement({
    ruleJava: undefined,
    javaTarget: 8,
    gradleVersion: '6.9.4',
    minecraftVersion: '1.16.5',
  });
  assert.equal(requirement.minMajor, 8, 'a project targeting Java 8 must be able to run on Java 8');
  assert.equal(requirement.maxMajor, undefined, 'no cap may be applied when the rule does not demand one');
});

test('the Java requirement never demands a version below the project target', async () => {
  const cases = [
    { ruleJava: 17, javaTarget: 21, gradleVersion: '8.10.2', minecraftVersion: '1.20.1' },
    { ruleJava: 21, javaTarget: 17, gradleVersion: '9.0.0', minecraftVersion: '1.21' },
    { ruleJava: 17, javaTarget: 17, gradleVersion: '8.10.2', minecraftVersion: '1.20.1' },
    { ruleJava: undefined, javaTarget: 8, gradleVersion: '4.10.3', minecraftVersion: '1.12.2' },
  ];
  for (const entry of cases) {
    const requirement = await api.resolveJavaRequirement(entry);
    assert.ok(
      requirement.minMajor >= (entry.javaTarget ?? 0),
      `minMajor ${requirement.minMajor} must be at least the project target ${entry.javaTarget}`,
    );
    if (requirement.maxMajor !== undefined) {
      assert.ok(
        requirement.maxMajor >= requirement.minMajor,
        `maxMajor ${requirement.maxMajor} must never be below minMajor ${requirement.minMajor}`,
      );
    }
  }
});

test('a ForgeGradle 2 rule pins the build to Java 8', async () => {
  const requirement = await api.resolveJavaRequirement({
    ruleJava: 8,
    javaTarget: 8,
    gradleVersion: '4.10.3',
    minecraftVersion: '1.12.2',
  });
  assert.equal(requirement.minMajor, 8);
  assert.equal(requirement.maxMajor, 8, 'a legacy rule that requires Java 8 must cap the runtime at 8');
});

test('a legacy rule does not cap a project that genuinely needs a newer Java', async () => {
  const requirement = await api.resolveJavaRequirement({
    ruleJava: 8,
    javaTarget: 21,
    gradleVersion: '8.10.2',
    minecraftVersion: '1.20.1',
  });
  assert.equal(requirement.minMajor, 21);
  assert.equal(requirement.maxMajor, undefined, 'a cap below the project target must be dropped, not applied');
});

test('Gradle 9 raises the Java floor to 17', async () => {
  const requirement = await api.resolveJavaRequirement({ gradleVersion: '9.0.0', minecraftVersion: '1.21' });
  assert.ok(requirement.minMajor >= 17);
});

test('Gradle 4 through 8 keep a Java 8 floor', async () => {
  for (const version of ['4.10.3', '5.6.4', '6.9.4', '7.6.4', '8.10.2']) {
    const requirement = await api.resolveJavaRequirement({ gradleVersion: version, minecraftVersion: '1.12.2' });
    assert.ok(
      requirement.minMajor <= 8,
      `${version} must not force a Java version above 8 for a 1.12.2 project, got ${requirement.minMajor}`,
    );
  }
});

test('an explicit --java override wins and applies no cap', async () => {
  const requirement = await api.resolveJavaRequirement({
    ruleJava: 8,
    javaTarget: 8,
    gradleVersion: '4.10.3',
    minecraftVersion: '1.12.2',
    javaOverride: 21,
  });
  assert.deepEqual(requirement, { minMajor: 21 });
});

test('a project with no declared information still gets a usable floor', async () => {
  const requirement = await api.resolveJavaRequirement({});
  assert.ok(requirement.minMajor >= 8);
  assert.ok(requirement.minMajor <= 21);
});
