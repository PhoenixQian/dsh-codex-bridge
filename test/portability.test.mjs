import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdCompressSync } from 'node:zlib';

const server = new URL('../server/', import.meta.url);
async function temporary(t) { const root = await realpath(await mkdtemp(join(tmpdir(), 'tongzhou-portability-'))); t.after(() => rm(root, {recursive:true,force:true})); return root; }
async function executable(path) { await writeFile(path, '#!/bin/sh\nexit 0\n'); await chmod(path, 0o700); return path; }

test('CLI discovery honors an explicit executable and rejects missing overrides', async t => {
  const {resolveCodexCli} = await import(new URL('runtime-config.mjs', server));
  const root = await temporary(t); const cli = await executable(join(root, 'custom-codex'));
  assert.equal(resolveCodexCli({env:{TONGZHOU_CODEX_CLI:cli,PATH:''}}),cli);
  assert.throws(() => resolveCodexCli({env:{TONGZHOU_CODEX_CLI:join(root,'missing'),PATH:''}}), {code:'CODEX_CLI_UNAVAILABLE'});
});

test('CLI discovery works from an isolated PATH without the developer app location', async t => {
  const {resolveCodexCli} = await import(new URL('runtime-config.mjs', server));
  const root = await temporary(t); const cli = await executable(join(root, 'codex'));
  assert.equal(resolveCodexCli({env:{PATH:root}}),cli);
});

test('runtime data follows an explicit override or DSH home outside the package', async () => {
  const {resolveDataRoot,CODE_ROOT} = await import(new URL('runtime-config.mjs', server));
  assert.equal(resolveDataRoot({TONGZHOU_DATA_DIR:'/tmp/community-user-data'}),'/tmp/community-user-data');
  assert.equal(resolveDataRoot({DSH_HOME:'/tmp/custom-dsh'}),'/tmp/custom-dsh/tongzhou');
  assert.notEqual(resolveDataRoot({}),CODE_ROOT);
});

test('Python stays disabled until explicitly configured and never admits the macOS stub', async t => {
  const {getPythonConfig} = await import(new URL('runtime-config.mjs', server));
  assert.equal(getPythonConfig({env:{}}).enabled,false);
  assert.equal(getPythonConfig({env:{TONGZHOU_PYTHON_CODEX:'/usr/bin/python3'}}).enabled,false);
  const root = await temporary(t); await mkdir(join(root,'bin')); const python = await executable(join(root,'bin','python3'));
  const config = getPythonConfig({env:{TONGZHOU_PYTHON_CODEX:python}});
  assert.equal(config.enabled,true); assert.equal(config.executable,python); assert.equal(config.prefix,root);
});

test('task tools can be created without a developer Conda environment and explain disabled Python', async t => {
  const {TaskFiles} = await import(new URL('execution/files.mjs', server));
  const root = await temporary(t); const files = await new TaskFiles({workspace:root,pythonPrefix:null}).init();
  await files.write('result.md','community artifact');
  assert.equal((await files.read('output/result.md')).content,'community artifact');
  await assert.rejects(files.run({program:'python3'}), /Python.*(?:disabled|not configured|未启用)/i);
});

test('native reading resolves its codec inside the distributable package', async () => {
  const {createNativeReading} = await import(new URL('native-reading.mjs', server));
  assert.equal(typeof createNativeReading,'function');
});

test('native codec reads both header and event frames instead of silently losing public messages', async () => {
  const {decodeNativeLog} = await import(new URL('session-codec.mjs', server));
  const compressed = Buffer.concat([zstdCompressSync(Buffer.from('header\n')),zstdCompressSync(Buffer.from('public-event\n'))]);
  assert.equal(decodeNativeLog(compressed).toString(),'header\npublic-event\n');
});

test('owned task workspaces under DSH data can read artifacts without exposing sibling account files', async t => {
  const {TaskFiles} = await import(new URL('execution/files.mjs', server));
  const root = await temporary(t); const workspace = join(root,'.dsh','tongzhou','tasks','task','workspace');
  const files = await new TaskFiles({workspace,pythonPrefix:null}).init();
  await files.write('result.md','owned public result');
  assert.equal((await files.read('output/result.md')).content,'owned public result');
  await assert.rejects(files.read('../../../../auth.json'), /scope|path|traversal/i);
});

test('model child environments exclude unrelated provider secrets', async () => {
  const {childEnvironment} = await import(new URL('runtime-config.mjs', server));
  const result = childEnvironment({env:{HOME:'/tmp/example-home',PATH:'/usr/bin',OPENAI_API_KEY:'synthetic-private',OTHER_TOKEN:'synthetic-private'}});
  assert.equal(result.HOME,'/tmp/example-home');
  assert.equal(Object.hasOwn(result,'OPENAI_API_KEY'),false); assert.equal(Object.hasOwn(result,'OTHER_TOKEN'),false);
});

test('DSH discovery follows an explicit custom application executable', async t => {
  const {dshResources} = await import(new URL('runtime-config.mjs', server));
  const root = await temporary(t); const contents = join(root,'DSH Custom.app','Contents');
  await mkdir(join(contents,'MacOS'),{recursive:true}); await mkdir(join(contents,'Resources'));
  await writeFile(join(contents,'Resources','app.asar'),'synthetic archive');
  const binary = await executable(join(contents,'MacOS','DeepSeek Harness'));
  assert.equal(dshResources({env:{TONGZHOU_DSH_EXECUTABLE:binary}}),join(contents,'Resources'));
});

test('service startup refuses a different installation using the requested local port', async t => {
  const {startService} = await import(new URL('start-service.mjs', server));
  const root = await temporary(t);
  const request = async () => new Response(JSON.stringify({app:'codex-dsh-bridge',directory:'/another-user-runtime',installationRoot:'/another-installation'}));
  const result = await startService({directory:root,request});
  assert.equal(result.ok,false); assert.equal(result.status,'occupied');
});

function configuredEnvironment(t, values) {
  for (const [key,value] of Object.entries(values)) { const previous=process.env[key]; process.env[key]=value; t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;}); }
}

test('Python rejects a prefix that differs from the actual dedicated interpreter environment', async t => {
  const {getPythonConfig} = await import(new URL('runtime-config.mjs', server));
  const root=await temporary(t),environment=join(root,'managed-env'); await mkdir(join(environment,'bin'),{recursive:true});
  const python=await executable(join(environment,'bin','python3'));
  assert.equal(getPythonConfig({env:{TONGZHOU_PYTHON_CODEX:python,TONGZHOU_PYTHON_PREFIX:root}}).enabled,false);
  assert.equal(getPythonConfig({env:{TONGZHOU_PYTHON_CODEX:python,TONGZHOU_PYTHON_PREFIX:environment}}).enabled,true);
});

test('custom Codex and DSH credential homes are rejected as task inputs and omitted from parent snapshots', async t => {
  const {snapshotInputs} = await import(new URL('execution/files.mjs', server));
  const {TaskRuntime} = await import(new URL('execution/runtime.mjs', server));
  const root=await temporary(t),materials=join(root,'materials'),codex=join(materials,'custom-codex'),dsh=join(materials,'custom-dsh');
  await mkdir(codex,{recursive:true}); await mkdir(dsh); await writeFile(join(codex,'config.toml'),'synthetic private config'); await writeFile(join(dsh,'settings.yaml'),'synthetic private config'); await writeFile(join(materials,'public.md'),'public input');
  configuredEnvironment(t,{CODEX_HOME:codex,DSH_HOME:dsh});
  const runtime=new TaskRuntime({directory:join(root,'runtime'),capabilityLoader:async()=>{throw Error('CAPABILITY_QUERY_MUST_NOT_RUN');}});
  for(const input of [codex,dsh]) {
    await assert.rejects(runtime.createTask({title:'test',goal:'test',inputs:[input],autoStart:false}),/Credential|permitted task scope/i);
    await assert.rejects(snapshotInputs([input],join(root,'rejected-'+input.split('/').at(-1))),/Credential/i);
  }
  const manifest=await snapshotInputs([materials],join(root,'snapshot'));
  assert.deepEqual(manifest.files.map(file=>file.path),['0/materials/public.md']);
});

test('an account directory nested inside an owned workspace remains private to task reads', async t => {
  const {TaskFiles} = await import(new URL('execution/files.mjs', server));
  const root=await temporary(t),workspace=join(root,'workspace'),account=join(workspace,'account-state');
  await mkdir(account,{recursive:true});await writeFile(join(account,'config.toml'),'synthetic private config');
  configuredEnvironment(t,{CODEX_HOME:account});
  const files=await new TaskFiles({workspace,pythonPrefix:null}).init();
  await assert.rejects(files.read('account-state/config.toml'),/Credential/i);
});

test('sandbox permits owned output but blocks custom credential homes even through a broad read root', {skip:process.platform!=='darwin'}, async t => {
  const {TaskFiles} = await import(new URL('execution/files.mjs', server));
  const root=await temporary(t),dsh=join(root,'custom-dsh'),codex=join(root,'custom-codex'),workspace=join(dsh,'tongzhou','tasks','owned','workspace');
  await mkdir(codex);await mkdir(dsh);await writeFile(join(codex,'config.toml'),'synthetic private config');await writeFile(join(dsh,'settings.yaml'),'synthetic private config');await writeFile(join(root,'public.md'),'public input');
  configuredEnvironment(t,{CODEX_HOME:codex,DSH_HOME:dsh});
  const files=await new TaskFiles({workspace,readRoots:[root],pythonPrefix:null}).init();
  const script=`const fs=require('node:fs');let leaked=false;for(const path of ${JSON.stringify([join(codex,'config.toml'),join(dsh,'settings.yaml')])})try{fs.readFileSync(path);leaked=true;}catch{}fs.writeFileSync('output/result.md','owned');console.log(JSON.stringify({public:fs.readFileSync(${JSON.stringify(join(root,'public.md'))},'utf8')==='public input',leaked,owned:fs.readFileSync('output/result.md','utf8')==='owned'}));`;
  const result=await files.run({program:'node',args:['-e',script]});
  assert.equal(result.exitCode,0,result.stderr); assert.deepEqual(JSON.parse(result.stdout),{public:true,leaked:false,owned:true});
  const nested=join(workspace,'account-state');await mkdir(nested);await writeFile(join(nested,'config.toml'),'synthetic private config');process.env.CODEX_HOME=nested;
  const nestedScript=`const fs=require('node:fs');let leaked=false;try{fs.readFileSync(${JSON.stringify(join(nested,'config.toml'))});leaked=true;}catch{}fs.writeFileSync('output/result.md','still owned');console.log(JSON.stringify({leaked,owned:fs.readFileSync('output/result.md','utf8')==='still owned'}));`;
  const checked=await files.run({program:'node',args:['-e',nestedScript]});
  assert.equal(checked.exitCode,0,checked.stderr);assert.deepEqual(JSON.parse(checked.stdout),{leaked:false,owned:true});
});

test('OpenRouter remains selectable for Host discussions while isolated DSH task workers reject it', async t => {
  const {dshCapabilitiesFromMetadata,DshTaskWorker} = await import(new URL('execution/dsh-worker.mjs', server));
  const catalog=dshCapabilitiesFromMetadata({providers:{openrouter:{models:[{id:'example/model',name:'Example'}]}}});
  const model=catalog.models.find(model=>model.id==='openrouter:example/model');
  assert.ok(model);assert.equal(model.taskExecution,false);assert.equal(model.availability,'host-only');
  const root=await temporary(t);
  assert.throws(()=>new DshTaskWorker({directory:root,cwd:root,model:'openrouter:example/model'}),{code:'DSH_HOST_ONLY_PROVIDER'});
});

test('task creation rejects a Host-only route instead of starting an unauthenticated worker', async t => {
  const {TaskRuntime} = await import(new URL('execution/runtime.mjs', server));
  const root=await temporary(t),directory=join(root,'runtime');await mkdir(join(directory,'tasks'),{recursive:true});
  const runtime=new TaskRuntime({directory,capabilityLoader:async()=>({Codex:{models:[{id:'codex-model',default:true}]},DSH:{models:[{id:'openrouter:example/model',taskExecution:false,availability:'host-only'}]}})});
  await assert.rejects(runtime.createTask({title:'test',goal:'test',models:{Codex:'codex-model',DSH:'openrouter:example/model'},autoStart:false}),/Host|host-only|不可用于任务/);
  assert.equal((await runtime.store.list()).length,0);
});
