import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_ROOT, resolveCodexCli, childEnvironment } from './runtime-config.mjs';

const run = promisify(execFile);
const template = fileURLToPath(new URL('../skills/tongzhou-collaboration/', import.meta.url));
const files = ['SKILL.md', 'agents/openai.yaml', 'scripts/tongzhou.mjs'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const issue = (code, message, statusCode = 400) => Object.assign(new Error(message), {code, statusCode});
const missing = error => error?.code === 'ENOENT';

/** Setup only installs the bundled skill after an explicit same-origin POST.
 * It never reads credential files or edits Codex configuration or AGENTS.md. */
export function createCommunitySetup({directory = DATA_ROOT, home = homedir(), skillSource = template,
  resolveCli = resolveCodexCli, runCommand = (cli, args) => run(cli, args, {
    timeout: 5000, maxBuffer: 65536, env: childEnvironment({kind: 'codex'}), windowsHide: true
  })} = {}) {
  const target = join(home, '.agents', 'skills', 'tongzhou-collaboration');
  let installing;
  let cached;
  async function bundled() {
    return Promise.all(files.map(async path => ({path, bytes: await readFile(join(skillSource, path))})));
  }
  async function skillState(source) {
    let stat;
    try { stat = await lstat(target); } catch (error) { if (missing(error)) return {installed: false, conflict: false, path: target}; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return {installed: false, conflict: true, path: target};
    for (const name of ['agents', 'scripts']) {
      try { const parent = await lstat(join(target, name)); if (!parent.isDirectory() || parent.isSymbolicLink()) return {installed: false, conflict: true, path: target}; }
      catch (error) { if (missing(error)) return {installed: false, conflict: true, path: target}; throw error; }
    }
    for (const file of source) {
      try {
        const path = join(target, file.path);
        if (!(await lstat(path)).isFile() || digest(await readFile(path)) !== digest(file.bytes)) return {installed: false, conflict: true, path: target};
      } catch (error) { if (missing(error)) return {installed: false, conflict: true, path: target}; throw error; }
    }
    return {installed: true, conflict: false, path: target};
  }
  async function codexState(cliPath) {
    let cli;
    try { cli = await resolveCli(cliPath ? {cliPath} : {}); }
    catch { return {available: false, authenticated: false, path: null, message: '未发现本机 Codex。请先安装并登录，或填写 Codex 可执行文件的绝对路径。'}; }
    // Never expose login output: some CLI versions may include account details.
    let authenticated = false;
    try { await runCommand(cli, ['login', 'status']); authenticated = true; } catch {}
    return {available: true, authenticated, path: cli,
      message: authenticated ? '已发现已登录的本机 Codex。' : '已发现 Codex，尚未确认登录。请在 Codex 中完成登录，再检查连接。'};
  }
  async function status({refresh = false} = {}) {
    if (!refresh && cached && Date.now() - cached.at < 15000) return cached.value;
    const [source, codex] = await Promise.all([bundled(), codexState()]);
    const skill = await skillState(source);
    const value = {ok: true, codex, skill, canInstall: codex.available && !skill.conflict,
      message: skill.conflict ? '已存在不同版本的同名技能，未覆盖。请先保留或移走该目录，再接入。' : skill.installed ? '协作技能已接入。可在 Codex 中说“通过同舟与 DSH 讨论”。未识别时重新打开 Codex。' : '点击接入后，仅向本机安装随插件提供的协作技能。'};
    cached = {at: Date.now(), value};
    return value;
  }
  async function installOnce(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'codexCliPath')) throw issue('INVALID_SETUP', '接入参数无效。');
    const selected = input.codexCliPath;
    if (selected !== undefined && (typeof selected !== 'string' || !selected.startsWith('/') || selected.length > 4096 || /[\0\r\n]/.test(selected))) throw issue('INVALID_CODEX_PATH', '请填写 Codex 可执行文件的绝对路径。');
    const codex = await codexState(selected);
    if (!codex.available) throw issue('CODEX_CLI_UNAVAILABLE', codex.message, 409);
    const source = await bundled();
    const before = await skillState(source);
    if (before.conflict) throw issue('SKILL_CONFLICT', '同名协作技能已存在且内容不同；为保留原内容，本次未覆盖。', 409);
    if (!before.installed) {
      const parent = dirname(target);
      await mkdir(parent, {recursive: true, mode: 0o700});
      const temporary = join(parent, `.tongzhou-install-${randomUUID()}`);
      await mkdir(temporary, {mode: 0o700});
      try {
        for (const file of source) {
          const path = join(temporary, file.path);
          await mkdir(dirname(path), {recursive: true, mode: 0o700});
          await writeFile(path, file.bytes, {mode: 0o600, flag: 'wx'});
        }
        await writeFile(join(temporary, '.tongzhou-install.json'), JSON.stringify({schema: 1, package: 'dsh-codex-bridge', version: '0.3.0', files: Object.fromEntries(source.map(file => [file.path, digest(file.bytes)]))}, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
        // Recheck before rename; never remove an existing destination.
        try { await lstat(target); throw issue('SKILL_CONFLICT', '接入期间目标目录已出现，本次未覆盖。', 409); } catch (error) { if (!missing(error)) throw error; }
        await rename(temporary, target);
      } finally { await rm(temporary, {recursive: true, force: true}); }
    }
    if (selected) {
      await mkdir(directory, {recursive: true, mode: 0o700});
      const path = join(directory, 'connection-settings.json');
      let settings = {};
      try {
        settings = JSON.parse(await readFile(path, 'utf8'));
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('invalid');
      } catch (error) { if (!missing(error)) throw issue('SETTINGS_INVALID', '本机连接配置无效，已保留原文件。'); }
      const temporary = path + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, JSON.stringify({...settings, codexCliPath: codex.path}, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
      await rename(temporary, path);
    }
    cached = null;
    // Return the CLI result just probed; custom resolvers and test homes need no global state.
    return {ok: true, codex, skill: {installed: true, conflict: false, path: target}, canInstall: true,
      message: '协作技能已接入。可在 Codex 中说“通过同舟与 DSH 讨论”。未识别时重新打开 Codex。'};
  }
  return {status, install(input = {}) {
    if (installing) return installing;
    installing = installOnce(input).finally(() => { installing = undefined; });
    return installing;
  }};
}
