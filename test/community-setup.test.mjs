import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommunitySetup } from '../server/community-setup.mjs';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tongzhou-setup-test-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  const skillSource = join(root, 'template'), home = join(root, 'home'), directory = join(root, 'data');
  for (const [name, text] of [['SKILL.md','Portable skill'], ['agents/openai.yaml','policy: {}'], ['scripts/tongzhou.mjs','export const name = "test";']]) {
    await mkdir(join(skillSource, name, '..'), {recursive:true}); await writeFile(join(skillSource,name),text);
  }
  const calls = [];
  const setup = createCommunitySetup({home,directory,skillSource,resolveCli:({cliPath}={})=>cliPath || '/mock/codex',runCommand:async (cli,args)=>{calls.push([cli,args]);return {stdout:'private account detail never returned'};},...overrides});
  return {root,home,directory,setup,calls,target:join(home,'.agents/skills/tongzhou-collaboration')};
}
test('checking status performs only login status and does not install files or expose account output', async t => {
  const f = await fixture(t); const result = await f.setup.status();
  assert.equal(result.codex.authenticated,true); assert.equal(result.skill.installed,false);
  assert.deepEqual(f.calls,[['/mock/codex',['login','status']]]);
  assert.ok(!JSON.stringify(result).includes('private account'));
  await assert.rejects(readdir(f.home),{code:'ENOENT'});
});
test('missing Codex leaves home untouched with a clear unavailable state', async t => {
  const f=await fixture(t,{resolveCli:()=>{throw new Error('missing');}});
  assert.equal((await f.setup.status()).codex.available,false);
  await assert.rejects(f.setup.install(),{code:'CODEX_CLI_UNAVAILABLE',statusCode:409});
  await assert.rejects(readdir(f.home),{code:'ENOENT'});
});
test('one click installs exactly the skill plus receipt; repeated clicks preserve files', async t => {
  const f=await fixture(t); await f.setup.install();
  assert.equal(await readFile(join(f.target,'SKILL.md'),'utf8'),'Portable skill');
  assert.deepEqual((await readdir(join(f.home,'.agents'))),['skills']);
  const receipt=await readFile(join(f.target,'.tongzhou-install.json'),'utf8');
  assert.equal(JSON.parse(receipt).version,'0.3.0');
  await f.setup.install(); assert.equal(await readFile(join(f.target,'.tongzhou-install.json'),'utf8'),receipt);
});
test('an existing different skill is preserved byte for byte', async t => {
  const f=await fixture(t); await mkdir(f.target,{recursive:true});
  await writeFile(join(f.target,'SKILL.md'),'existing local customization');
  assert.equal((await f.setup.status()).skill.conflict,true);
  await assert.rejects(f.setup.install(),{code:'SKILL_CONFLICT',statusCode:409});
  assert.equal(await readFile(join(f.target,'SKILL.md'),'utf8'),'existing local customization');
  assert.deepEqual(await readdir(f.target),['SKILL.md']);
});
test('custom CLI path is validated and saved without credentials or replacing other settings', async t => {
  const f=await fixture(t); await mkdir(f.directory,{recursive:true});
  await writeFile(join(f.directory,'connection-settings.json'),JSON.stringify({pythonDsh:'/mock/python'}));
  await assert.rejects(f.setup.install({codexCliPath:'relative/codex'}),{code:'INVALID_CODEX_PATH'});
  await f.setup.install({codexCliPath:'/custom/codex'});
  assert.deepEqual(JSON.parse(await readFile(join(f.directory,'connection-settings.json'),'utf8')),{pythonDsh:'/mock/python',codexCliPath:'/custom/codex'});
});
test('logged-out CLI can receive skill without attempting a login or model call', async t=>{
  const f=await fixture(t,{runCommand:async (_cli,args)=>{assert.deepEqual(args,['login','status']);throw new Error('not logged in');}});
  const result=await f.setup.install();assert.equal(result.skill.installed,true);assert.equal(result.codex.authenticated,false);
});
