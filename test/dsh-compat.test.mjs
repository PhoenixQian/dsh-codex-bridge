import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as runtime from '../server/runtime-config.mjs';

const run = promisify(execFile);
const metadataHelper = fileURLToPath(new URL('../server/execution/dsh-metadata.mjs', import.meta.url));
const taskLauncher = fileURLToPath(new URL('../server/execution/dsh-task-launch.mjs', import.meta.url));
const workerModule = new URL('../server/execution/dsh-worker.mjs', import.meta.url).href;
const nativeExecutable = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
async function fixture(t, version) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tongzhou-dsh-compat-')));
  t.after(() => rm(root, {recursive:true, force:true}));
  const resources = join(root, 'Resources');
  const metadataDirectory = join(resources, 'app.asar/dsh/node_modules/@deepseek-ai/dsh');
  await mkdir(metadataDirectory, {recursive:true});
  await writeFile(join(metadataDirectory, 'package.json'), JSON.stringify({version}));
  const profile = join(root, 'desktop.patch.yml');
  await writeFile(profile, '[]\n');
  return {root, resources, profile};
}
function environment({root, resources}) {
  return {PATH:process.env.PATH, HOME:root, TONGZHOU_DATA_DIR:root, TONGZHOU_DSH_RESOURCES:resources,
    ELECTRON_RUN_AS_NODE:'1', DSH_TELEMETRY_DISABLED:'1'};
}

test('only verified rc.1 and rc.3 versions pass the pure DSH compatibility gate', () => {
  assert.equal(typeof runtime.assertSupportedDshVersion, 'function');
  for (const version of ['0.2.2-rc.1', '0.2.2-rc.3']) {
    assert.deepEqual(runtime.assertSupportedDshVersion(version), {version});
  }
  for (const version of ['0.2.2-rc.2', '0.2.2-rc.4', '0.2.2', '0.3.0']) {
    assert.throws(() => runtime.assertSupportedDshVersion(version), error => {
      assert.equal(error.code, 'UNSUPPORTED_DSH_VERSION');
      assert.equal(error.runtimeVersion, version);
      assert.deepEqual(error.supportedRuntimeVersions, ['0.2.2-rc.1', '0.2.2-rc.3']);
      assert.ok(error.message.includes(version));
      return true;
    });
  }
});

test('malformed host version metadata cannot leak arbitrary text in compatibility errors', () => {
  assert.equal(typeof runtime.assertSupportedDshVersion, 'function');
  for (const version of [undefined, {}, 'secret-config\nprivate-value']) {
    assert.throws(() => runtime.assertSupportedDshVersion(version), error => {
      assert.equal(error.code, 'UNSUPPORTED_DSH_VERSION');
      assert.equal(error.runtimeVersion, null);
      assert.equal(error.message.includes('secret-config'), false);
      return true;
    });
  }
});

test('DSH package inspection accepts an explicit rc.3 runtime and reports its actual version', {skip:process.platform!=='darwin'}, async t => {
  const f = await fixture(t, '0.2.2-rc.3');
  assert.deepEqual(await runtime.assertSupportedDsh({resourcesPath:f.resources, env:{}}), {version:'0.2.2-rc.3'});
});

test('unsupported helper reports a structured installed version without exposing profile contents', {skip:process.platform!=='darwin'}, async t => {
  const f = await fixture(t, '0.2.2-rc.99');
  await writeFile(f.profile, 'private-marker-do-not-expose: [');
  let result;
  try { await run(process.execPath, ['--expose-internals', metadataHelper, f.profile], {env:environment(f)}); }
  catch (error) { result = error; }
  assert.ok(result, 'an unverified runtime must fail before loading provider metadata');
  const line = result.stdout.split('\n').find(value => value.startsWith('DSH_METADATA_ERROR '));
  assert.ok(line, 'the diagnostic protocol must retain the original version failure');
  const diagnostic = JSON.parse(line.slice('DSH_METADATA_ERROR '.length));
  assert.equal(diagnostic.code, 'UNSUPPORTED_DSH_VERSION');
  assert.equal(diagnostic.runtimeVersion, '0.2.2-rc.99');
  assert.deepEqual(diagnostic.supportedRuntimeVersions, ['0.2.2-rc.1', '0.2.2-rc.3']);
  assert.equal((result.stdout + result.stderr).includes('private-marker-do-not-expose'), false);
});

test('capabilities retain unsupported runtime details instead of a generic metadata failure', {skip:process.platform!=='darwin'}, async t => {
  const f = await fixture(t, '0.2.2-rc.99');
  const source = `import {getDshCapabilities} from ${JSON.stringify(workerModule)};
    const value=await getDshCapabilities({desktopProfilePath:process.argv[1],metadataExecutablePath:process.execPath});
    console.log(JSON.stringify(value));`;
  const {stdout} = await run(process.execPath, ['--input-type=module', '-e', source, f.profile], {env:environment(f)});
  const value = JSON.parse(stdout);
  assert.deepEqual(value.models, []);
  assert.equal(value.errorCode, 'UNSUPPORTED_DSH_VERSION');
  assert.equal(value.runtimeVersion, '0.2.2-rc.99');
  assert.deepEqual(value.supportedRuntimeVersions, ['0.2.2-rc.1', '0.2.2-rc.3']);
  assert.ok(value.error.includes('0.2.2-rc.99'));
  assert.equal(value.authentication, 'not-checked');
});

test('task launch rejects an unverified runtime with a structured fatal result before profile boot', {skip:process.platform!=='darwin'}, async t => {
  const f = await fixture(t, '0.2.2-rc.99');
  let result;
  try { await run(process.execPath, ['--expose-internals', taskLauncher, f.root], {env:environment(f)}); }
  catch (error) { result = error; }
  assert.ok(result);
  const line = result.stdout.split('\n').find(value => value.startsWith('DSH_TASK '));
  assert.ok(line, 'startup guards must reach the controller instead of discarded stderr');
  const diagnostic = JSON.parse(line.slice('DSH_TASK '.length));
  assert.equal(diagnostic.type, 'fatal');
  assert.equal(diagnostic.code, 'UNSUPPORTED_DSH_VERSION');
  assert.equal(diagnostic.runtimeVersion, '0.2.2-rc.99');
});

test('missing Desktop profile has a distinct capability error and no assumed account model', {skip:process.platform!=='darwin'}, async t => {
  const f = await fixture(t, '0.2.2-rc.3');
  const source = `import {getDshCapabilities} from ${JSON.stringify(workerModule)};
    console.log(JSON.stringify(await getDshCapabilities({desktopProfilePath:process.argv[1],metadataExecutablePath:process.execPath})));`;
  const {stdout} = await run(process.execPath, ['--input-type=module', '-e', source, join(f.root, 'missing-profile.yml')], {env:environment(f)});
  const value = JSON.parse(stdout);
  assert.deepEqual(value.models, []);
  assert.equal(value.errorCode, 'DSH_PROFILE_UNAVAILABLE');
  assert.equal(value.authentication, 'not-checked');
});

test('installed DSH can inspect a synthetic profile without account access or Agent boot', {skip:process.platform!=='darwin'||!existsSync(nativeExecutable)}, async t => {
  const f = await fixture(t, 'unused');
  const {stdout} = await run(nativeExecutable, ['--expose-internals', metadataHelper, f.profile], {
    env:{...environment({...f, resources:'/Applications/DeepSeek Harness.app/Contents/Resources'}), ELECTRON_RUN_AS_NODE:'1', DSH_TELEMETRY_DISABLED:'1'},
  });
  const line = stdout.split('\n').find(value => value.startsWith('DSH_METADATA '));
  assert.ok(line);
  const value = JSON.parse(line.slice('DSH_METADATA '.length));
  assert.ok(['0.2.2-rc.1', '0.2.2-rc.3'].includes(value.runtimeVersion));
  assert.deepEqual(value.providers, {});
  assert.ok(value.accountReasoning?.efforts?.length);
  assert.equal(value.reasoningSource, '@deepseek-ai/dsh-llm-deepseek:DeepSeekAdapter.resolveModel');
});

test('invalid metadata retains the installed runtime version and cannot expose profile text', {skip:process.platform!=='darwin'||!existsSync(nativeExecutable)}, async t => {
  const f = await fixture(t, 'unused');
  await writeFile(f.profile, 'private-config-marker: [');
  let result;
  try {
    await run(nativeExecutable, ['--expose-internals', metadataHelper, f.profile], {
      env:{...environment({...f, resources:'/Applications/DeepSeek Harness.app/Contents/Resources'}), ELECTRON_RUN_AS_NODE:'1', DSH_TELEMETRY_DISABLED:'1'},
    });
  } catch (error) { result = error; }
  assert.ok(result);
  const line = result.stdout.split('\n').find(value => value.startsWith('DSH_METADATA_ERROR '));
  assert.ok(line);
  const diagnostic = JSON.parse(line.slice('DSH_METADATA_ERROR '.length));
  assert.equal(diagnostic.code, 'DSH_METADATA_INVALID');
  assert.ok(['0.2.2-rc.1', '0.2.2-rc.3'].includes(diagnostic.runtimeVersion));
  assert.equal((result.stdout + result.stderr).includes('private-config-marker'), false);
});
