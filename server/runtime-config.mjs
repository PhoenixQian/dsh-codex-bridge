import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, delimiter, basename, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
export function resolveDataRoot(env = process.env) {
  return resolve(env.TONGZHOU_DATA_DIR || join(env.DSH_HOME || join(homedir(), '.dsh'), 'tongzhou'));
}
export const DATA_ROOT = resolveDataRoot();
function securityPath(path) {
  let current=resolve(path);const tail=[];
  for(;;){try{return join(realpathSync(current),...tail);}catch{const parent=dirname(current);if(parent===current)return resolve(path);tail.unshift(basename(current));current=parent;}}
}
export function credentialRoots({env=process.env}={}) {
  return [...new Set([join(homedir(),'.codex'),join(homedir(),'.dsh'),env.CODEX_HOME,env.DSH_HOME].filter(value=>typeof value==='string'&&value).map(securityPath))];
}
export function isCredentialPath(path,{env=process.env}={}) {
  const actual=securityPath(path);
  return credentialRoots({env}).some(root=>{const child=relative(root,actual);return child===''||(!isAbsolute(child)&&child!=='..'&&!child.startsWith('..'+sep));});
}
/** Public installation identity; it conveys neither paths nor authentication. */
export function instanceFingerprint({directory = DATA_ROOT, codeRoot = CODE_ROOT} = {}) {
  return createHash('sha256').update(JSON.stringify([resolve(directory), resolve(codeRoot)])).digest('hex');
}
const failure = (code, message) => Object.assign(new Error(message), {code});
export function readRuntimeSettings({directory = DATA_ROOT} = {}) {
  try {
    const value = JSON.parse(readFileSync(join(directory, 'connection-settings.json'), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return {}; throw failure('SETTINGS_INVALID', '同舟连接配置无效，请重新接入。'); }
}
function settingsFor(env) { return env === process.env ? readRuntimeSettings() : {}; }
function executable(path) {
  try { if (!isAbsolute(path) || !statSync(path).isFile()) return null; accessSync(path, constants.X_OK); return realpathSync(path); } catch { return null; }
}
function inPath(name, env) {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return null;
  for (const part of (env.PATH ?? '').split(delimiter).filter(isAbsolute)) { const found = executable(join(part, name)); if (found) return found; }
  return null;
}
function chosen(value, env) { return typeof value === 'string' ? (isAbsolute(value) ? executable(value) : inPath(value, env)) : null; }
export function resolveCodexCli({cliPath, env = process.env} = {}) {
  const configured = cliPath || env.TONGZHOU_CODEX_CLI || env.CODEX_PEER_CLI || settingsFor(env).codexCliPath;
  if (configured) { const value = chosen(configured, env); if (value) return value; throw failure('CODEX_CLI_UNAVAILABLE', '已配置的 Codex CLI 不可执行；请在同舟中重新接入本机 Codex。'); }
  const found = inPath('codex', env); if (found) return found;
  if (process.platform === 'darwin') {
    for (const app of ['/Applications/ChatGPT.app', '/Applications/Codex.app', join(homedir(), 'Applications/ChatGPT.app'), join(homedir(), 'Applications/Codex.app')]) {
      const value = executable(join(app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')); if (value) return value;
    }
  }
  throw failure('CODEX_CLI_UNAVAILABLE', '未发现本机 Codex CLI；请在同舟中选择可执行文件，或将 codex 加入 PATH。');
}
export function dshResources({resourcesPath, env = process.env} = {}) {
  const settings = settingsFor(env);
  const binary = env.TONGZHOU_DSH_EXECUTABLE || settings.dshExecutablePath;
  const configured = resourcesPath || env.TONGZHOU_DSH_RESOURCES || settings.dshResourcesPath || (binary && isAbsolute(binary) ? resolve(dirname(binary), '../Resources') : null);
  const candidates = configured ? [configured] : [process.resourcesPath, process.platform === 'darwin' ? '/Applications/DeepSeek Harness.app/Contents/Resources' : null];
  for (const path of candidates) if (typeof path === 'string' && isAbsolute(path) && existsSync(join(path, 'app.asar'))) return realpathSync(path);
  throw failure('DSH_RUNTIME_UNAVAILABLE', '未发现受支持的 DSH Desktop 运行时；请从 DSH 加载同舟或配置本机 DSH 路径。');
}
export function resolveDshExecutable({executablePath, env = process.env} = {}) {
  if (process.platform !== 'darwin') throw failure('UNSUPPORTED_PLATFORM', '社区版原生 DSH 执行目前仅支持 macOS。');
  const configured = executablePath || env.TONGZHOU_DSH_EXECUTABLE || settingsFor(env).dshExecutablePath;
  if (configured) { const value = chosen(configured, env); if (value) return value; throw failure('DSH_RUNTIME_UNAVAILABLE', '已配置的 DSH 可执行文件不可用。'); }
  const resources = dshResources({env}); const value = executable(join(resources, '../MacOS/DeepSeek Harness'));
  if (value) return value;
  throw failure('DSH_RUNTIME_UNAVAILABLE', 'DSH Desktop 可执行文件不可用。');
}
export async function importDshModule(packageName, {resourcesPath, subpath = 'lib/index.js'} = {}) {
  if (!/^@deepseek-ai\/[a-z0-9-]+$/.test(packageName) && packageName !== 'yaml') throw failure('INVALID_HOST_MODULE', 'Unsupported DSH module.');
  if (!/^[a-zA-Z0-9._/-]+$/.test(subpath) || subpath.split('/').includes('..')) throw failure('INVALID_HOST_MODULE', 'Invalid DSH module path.');
  const resources = dshResources({resourcesPath});
  return import(pathToFileURL(join(resources, 'app.asar/dsh/node_modules', packageName, subpath)).href);
}
export async function assertSupportedDsh() {
  if (process.platform !== 'darwin') throw failure('UNSUPPORTED_PLATFORM', '社区版原生 DSH 执行目前仅支持 macOS。');
  let metadata;
  try { metadata = JSON.parse(readFileSync(join(dshResources(), 'app.asar/dsh/node_modules/@deepseek-ai/dsh/package.json'), 'utf8')); }
  catch { throw failure('DSH_RUNTIME_UNAVAILABLE', '需要使用 DSH Desktop 的 Electron Node 载体读取宿主模块。'); }
  if (metadata.version !== '0.2.2-rc.1') throw failure('UNSUPPORTED_DSH_VERSION', '社区版当前验证的 DSH Desktop 版本为 0.2.2-rc.1；此版本尚未验证。');
  return {version:metadata.version};
}
export function getPythonConfig({agent = 'Codex', env = process.env} = {}) {
  const suffix = agent === 'DSH' ? 'DSH' : 'CODEX'; const settings = settingsFor(env);
  const prefixOption = env[`TONGZHOU_PYTHON_${suffix}_PREFIX`] || env.TONGZHOU_PYTHON_PREFIX;
  const configured = env[`TONGZHOU_PYTHON_${suffix}`] || settings[agent === 'DSH' ? 'pythonDsh' : 'pythonCodex'] || (prefixOption ? join(prefixOption, 'bin/python3') : null);
  const disabled = reason => ({enabled:false, executable:null, prefix:null, reason});
  if (!configured) return disabled('Python 未启用：未配置专用 Python 环境；同舟不会自动安装。');
  const value = chosen(configured, env);
  if (!value) return disabled('Python 未启用：配置的解释器不存在或不可执行。');
  if (value.startsWith('/usr/bin/python') || value.startsWith('/Library/Developer/') || value.includes('/CommandLineTools/')) return disabled('Python 未启用：禁止使用系统安装占位程序。');
  let prefix;
  try { prefix = prefixOption ? realpathSync(prefixOption) : dirname(dirname(value)); }
  catch { return disabled('Python 未启用：配置的环境目录不存在。'); }
  if ([homedir(), '/', '/usr', '/usr/local', '/opt/homebrew'].includes(prefix) || /(?:^|[/\\])\.(?:codex|dsh|ssh|aws)(?:[/\\]|$)/.test(prefix)) return disabled('Python 未启用：需要独立的 Python 环境目录。');
  if (dirname(value)!==join(prefix,'bin')||isCredentialPath(prefix,{env})) return disabled('Python 未启用：真实解释器必须位于指定专用环境的 bin 目录内，且不能包含账户目录。');
  return {enabled:true, executable:value, prefix, reason:null};
}
export function resolveProgram(name, {env = process.env} = {}) {
  const configured = env[`TONGZHOU_${name.toUpperCase()}`];
  const value = configured ? chosen(configured, env) : inPath(name, env);
  if (value) return value;
  if (name === 'node' && basename(process.execPath) === 'node') return realpathSync(process.execPath);
  throw failure('PROGRAM_UNAVAILABLE', `任务命令 ${name} 未启用：未找到可执行文件，请配置路径。`);
}
export function childEnvironment({kind = 'codex', env = process.env, extra = {}} = {}) {
  const result = {};
  const allowed = ['HOME','USER','LOGNAME','PATH','TMPDIR','LANG','LC_ALL','LC_CTYPE','CODEX_HOME','DSH_HOME','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR','TONGZHOU_CODEX_CLI','TONGZHOU_DSH_EXECUTABLE','TONGZHOU_DSH_RESOURCES','TONGZHOU_PYTHON_CODEX','TONGZHOU_PYTHON_DSH','TONGZHOU_PYTHON_PREFIX','TONGZHOU_PYTHON_CODEX_PREFIX','TONGZHOU_PYTHON_DSH_PREFIX','TONGZHOU_NODE','TONGZHOU_RG'];
  for (const key of allowed) if (typeof env[key] === 'string') result[key] = env[key];
  result.TONGZHOU_DATA_DIR = resolveDataRoot(env);
  if (kind === 'dsh') { result.ELECTRON_RUN_AS_NODE = '1'; result.DSH_TELEMETRY_DISABLED = '1'; result.TONGZHOU_DSH_RESOURCES = dshResources({env}); result.TONGZHOU_DSH_EXECUTABLE = resolveDshExecutable({env}); }
  return {...result,...extra};
}
