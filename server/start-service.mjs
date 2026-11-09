import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODE_ROOT, DATA_ROOT, childEnvironment } from './runtime-config.mjs';

const pause = ms => new Promise(done => setTimeout(done, ms));
export async function startService({directory = DATA_ROOT, port = 32719, request = fetch} = {}) {
  directory = resolve(directory);
  const url = `http://127.0.0.1:${port}`;
  const matches = health => health?.app === 'codex-dsh-bridge' && health.directory === directory && health.installationRoot === CODE_ROOT;
  async function probe() {
    try { const response = await request(url + '/api/health', {signal:AbortSignal.timeout(1000),redirect:'error'}); return {occupied:true,health:await response.json().catch(() => null)}; }
    catch (error) { if (error.cause?.code === 'ECONNREFUSED') return {occupied:false}; return {occupied:true}; }
  }
  const prior = await probe();
  if (matches(prior.health)) return {ok:true,running:true,url,directory};
  if (prior.occupied) return {ok:false,status:'occupied',message:'同舟当前固定使用 32719 端口，一机仅运行一个实例；端口已被另一安装或进程占用。'};
  await mkdir(directory, {recursive:true,mode:0o700});
  const log = await open(join(directory, 'web-service.log'), 'a', 0o600);
  let spawnError;
  const env = childEnvironment({extra:{TONGZHOU_DATA_DIR:directory}});
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  if (process.env.TONGZHOU_DSH_RESOURCES) env.TONGZHOU_DSH_RESOURCES = process.env.TONGZHOU_DSH_RESOURCES;
  else if (process.resourcesPath) env.TONGZHOU_DSH_RESOURCES = process.resourcesPath;
  if (process.env.TONGZHOU_DSH_EXECUTABLE) env.TONGZHOU_DSH_EXECUTABLE = process.env.TONGZHOU_DSH_EXECUTABLE;
  const child = spawn(process.execPath, [join(CODE_ROOT, 'hub.mjs')], {cwd:directory,env,detached:true,stdio:['ignore',log.fd,log.fd]});
  child.once('error', error => {spawnError=error;}); child.unref(); await log.close();
  for (let attempt=0;attempt<30;attempt++) {
    if (spawnError || child.exitCode !== null) break;
    await pause(100); const result = await probe();
    if (matches(result.health)) return {ok:true,started:true,pid:child.pid,url,directory};
    if (result.occupied) return {ok:false,status:'occupied',message:'同舟端口由另一进程接管，未连接其数据。'};
  }
  return {ok:false,status:'offline',message:'同舟服务未就绪；请检查所选运行时以及本机运行日志。'};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startService().then(result => {console.log(JSON.stringify(result)); if (!result.ok) process.exitCode=1;}).catch(() => {console.error('同舟服务启动失败。');process.exitCode=1;});
}
