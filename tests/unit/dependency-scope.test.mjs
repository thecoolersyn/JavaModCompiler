import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, tempDir, write } from '../helpers/harness.mjs';

const api = createApi();

function managedFor(build, name) {
  const root = tempDir(name);
  write(root, 'build.gradle', build);
  write(root, 'settings.gradle', "rootProject.name = 'fixture'\n");
  write(root, 'gradle.properties', 'minecraft_version=1.20.1\n');
  return api.toolchainManagedDependenciesFor(root);
}

test('a NeoForge loader artifact is treated as toolchain managed', async () => {
  const managed = await managedFor(
    [
      'plugins { id "net.neoforged.moddev" version "2.0.148" }',
      '',
      'dependencies {',
      '    implementation("net.neoforged:neoforge:21.1.72")',
      '    implementation("com.example.user:my-own-mod-lib:1.0.0")',
      '}',
      '',
    ].join('\n'),
    'neoforge-managed',
  );
  assert.ok(managed.includes('net.neoforged:neoforge'), `expected the loader artifact to be managed, got ${managed.join(', ')}`);
  assert.equal(
    managed.includes('com.example.user:my-own-mod-lib'),
    false,
    'an ordinary user dependency must never be treated as toolchain managed',
  );
});

test('a user dependency sharing the loader group is still resolved normally', async () => {
  const managed = await managedFor(
    [
      'plugins { id "net.neoforged.moddev" version "2.0.148" }',
      '',
      'dependencies {',
      '    implementation("net.neoforged:some-user-published-library:1.2.3")',
      '    implementation("net.minecraftforge:not-a-loader-artifact:4.5.6")',
      '}',
      '',
    ].join('\n'),
    'neoforge-user-group',
  );
  assert.equal(
    managed.includes('net.neoforged:some-user-published-library'),
    false,
    'an arbitrary artifact in a loader group must not be classified as loader owned',
  );
  assert.equal(
    managed.includes('net.minecraftforge:not-a-loader-artifact'),
    false,
    'an arbitrary artifact in a loader group must not be classified as loader owned',
  );
});

test('a user dependency in an annotation processor configuration is always resolved', async () => {
  const managed = await managedFor(
    [
      'plugins { id "net.neoforged.moddev" version "2.0.148" }',
      '',
      'dependencies {',
      '    annotationProcessor("net.neoforged:some-processor:1.0.0")',
      '    annotationProcessor("net.neoforged:neoforge:21.1.72")',
      '    testImplementation("net.neoforged:some-test-lib:1.0.0")',
      '}',
      '',
    ].join('\n'),
    'neoforge-annotation-processor',
  );
  assert.equal(
    managed.includes('net.neoforged:some-processor'),
    false,
    'a user processor in a non-toolchain configuration must be resolved by JMC',
  );
  assert.equal(
    managed.includes('net.neoforged:some-test-lib'),
    false,
    'a user test dependency must be resolved by JMC',
  );
  assert.ok(managed.includes('net.neoforged:neoforge'), 'a loader artifact is still managed regardless of configuration');
});

test('ForgeGradle 1.12.2 style buildscript and compile dependencies are managed', async () => {
  const managed = await managedFor(
    [
      'buildscript {',
      "    repositories { maven { url = 'https://maven.minecraftforge.net' } }",
      "    dependencies { classpath 'net.minecraftforge.gradle:ForgeGradle:2.3-SNAPSHOT' }",
      '}',
      '',
      "apply plugin: 'net.minecraftforge.gradle'",
      '',
      'dependencies {',
      "    compile 'net.minecraftforge:forge:1.12.2-14.23.5.2859'",
      "    implementation 'com.example.user:helper:1.0.0'",
      '}',
      '',
    ].join('\n'),
    'forge-legacy-managed',
  );
  assert.ok(managed.includes('net.minecraftforge.gradle:ForgeGradle'), 'a build plugin must be resolved by the delegated build');
  assert.ok(managed.includes('net.minecraftforge:forge'), 'the Forge toolchain artifact must be managed');
  assert.equal(managed.includes('com.example.user:helper'), false, 'an ordinary user dependency must be resolved');
});

test('a Loom mappings artifact is managed but a user library is not', async () => {
  const managed = await managedFor(
    [
      "plugins { id 'fabric-loom' version '1.6.12' }",
      '',
      'dependencies {',
      '    minecraft("com.mojang:minecraft:1.20.1")',
      '    mappings("net.fabricmc:yarn:1.20.1+build.10:v2")',
      '    modImplementation("net.fabricmc:fabric-loader:0.15.11")',
      '    implementation("com.example.user:library:1.0.0")',
      '}',
      '',
    ].join('\n'),
    'loom-managed',
  );
  assert.ok(managed.includes('com.mojang:minecraft'), 'the Minecraft artifact must be managed');
  assert.ok(managed.includes('net.fabricmc:yarn'), 'a mappings artifact must be managed');
  assert.equal(managed.includes('com.example.user:library'), false, 'an ordinary user dependency must be resolved');
});

test('a project with no loader plugin has no managed dependencies', async () => {
  const managed = await managedFor(
    ['dependencies {', '    implementation("net.neoforged:neoforge:21.1.72")', '    implementation("com.example:thing:1.0")', '}', ''].join('\n'),
    'no-loader-plugin',
  );
  assert.deepEqual(managed, [], 'without a loader plugin nothing may be silently skipped');
});
