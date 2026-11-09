import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, realpath, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActiveTimeBudget } from '../codex-peer.mjs';
import { resolveDshExecutable, dshResources } from '../runtime-config.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const PREFIX = 'DSH_TASK ';
const sensitive = /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.codex|\.gnupg|\.kube|auth\.json|\.credentials\.yaml|credentials(?:\.json)?)$/i;
const fail = (code, message) => Object.assign(new Error(message), { code });
function required(value, label, multiline = false) { if (typeof value !== 'string' || !value.trim() || (multiline ? /\0/ : /[\0\r\n]/).test(value)) throw new Error(`A nonempty ${label} is required.`); return value; }
function absolute(value, label) { required(value, label); if (!isAbsolute(value)) throw new Error(`${label} must be absolute.`); return resolve(value); }
function compact(value, key = '') {
  if (/^(?:access_?token|refresh_?token|id_?token|api_?key|authorization|secret|password)$/i.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(x => compact(x));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, compact(v, k)]));
  if (typeof value !== 'string') return value;
  if (/^(?:data|dataBase64|b64_json)$/i.test(key) && value.length > 512) return '[payload omitted]';
  const text = value.replace(/\b(Bearer\s+)[\w.+/=-]+/gi, '$1[REDACTED]').replace(/\bsk-(?:proj-)?[\w-]{12,}/g, '[REDACTED]').replace(/data:(?:image|audio)\/[^;,]+;base64,[A-Za-z0-9+/=\r\n]+/g, '[media payload omitted]');
  return text.length > 16384 ? text.slice(0, 16384) + '\n[truncated]' : text;
}
function childEnvironment(executablePath) {
  const env = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'DSH_HOME']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TONGZHOU_DSH_EXECUTABLE: executablePath, TONGZHOU_DSH_RESOURCES: dshResources(), ELECTRON_RUN_AS_NODE: '1', DSH_TELEMETRY_DISABLED: '1' };
}
async function metadata({ desktopProfilePath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'desktop', 'cordis.patch.yml'), metadataExecutablePath } = {}) {
  if (process.platform !== 'darwin') throw fail('DSH_PLATFORM_UNSUPPORTED', 'DSH Desktop task execution is supported only on macOS.');
  const executable = resolveDshExecutable({ executablePath: metadataExecutablePath });
  try { await readFile(desktopProfilePath); }
  catch (error) { if (error.code === 'ENOENT') throw fail('DSH_PROFILE_UNAVAILABLE', 'DSH Desktop profile was not found; open and configure the supported DSH Desktop installation first.'); throw error; }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--expose-internals', join(root, 'dsh-metadata.mjs'), desktopProfilePath], { env: childEnvironment(executable), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); reject(fail('METADATA_TIMEOUT', 'DSH metadata inspection timed out.')); }, 10000);
    child.stdout.on('data', data => { output += data; if (output.length > 1024 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', () => {});
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(fail('METADATA_FAILED', 'DSH provider metadata inspection failed.'));
      try { const line = output.split('\n').find(x => x.startsWith('DSH_METADATA ')); resolve(JSON.parse(line.slice(13))); }
      catch { reject(fail('METADATA_PROTOCOL', 'DSH metadata helper returned no valid metadata.')); }
    });
  });
}
export async function getDshCapabilities(options = {}) {
  const info = await metadata(options);
  return { ...dshCapabilitiesFromMetadata(info), discoveredAt: new Date().toISOString() };
}

/** Provider catalog metadata is not evidence of available task credentials. */
export function dshCapabilitiesFromMetadata(info = {}) {
  const reasoning = (efforts, defaultEffort, source) => ({
    ...(efforts?.length ? { supportedReasoningEfforts: efforts.map(id => ({ reasoningEffort: id, description: id })) } : {}),
    ...(efforts?.includes(defaultEffort) ? { defaultReasoningEffort: defaultEffort } : {}),
    ...(source ? { reasoningSource: source } : {}),
  });
  return {
    models: [
      { id: 'deepseek-account:deepseek-flash', model: 'deepseek-account:deepseek-flash', displayName: 'DeepSeek Flash（现有账户）', provider: 'deepseek-account', default: true, verified: false, taskExecution: true, ...reasoning(info.accountReasoning?.efforts?.map(e => e.id), info.accountReasoning?.defaultEffort, info.reasoningSource) },
      ...(info.providers?.openrouter?.models ?? []).map(model => ({ id: `openrouter:${model.id}`, model: `openrouter:${model.id}`, displayName: `${model.name ?? model.id}（仅Host讨论）`, provider: 'openrouter', default: false, verified: false, taskExecution: false, availability: 'host-only', unavailableReason: '此提供方仅可通过已配置的DSH Desktop Host讨论使用；隔离任务不会复制账户密钥或环境凭据。',
        ...(model.reasoningEfforts !== undefined ? { reasoningEfforts: model.reasoningEfforts } : {}),
        ...reasoning(model.reasoningEfforts && typeof model.reasoningEfforts === 'object' ? Object.keys(model.reasoningEfforts).filter(id => ['off','minimal','low','medium','high','xhigh'].includes(id)) : undefined, info.providers.openrouter.reasoning, 'desktop-provider-config'),
      })),
    ],
    providerCapabilities: { controlledTools: true, imageGeneration: false, webSearch: false, connectedApps: false },
    imageGeneration: false, network: false, authentication: 'not-checked', verified: false, runtimeVersion: info.runtimeVersion,
  };
}

/** The child has no filesystem/shell capability; parent tools own task authority. */
export class DshTaskWorker {
  constructor({ directory, cwd, model = 'deepseek-account:deepseek-flash', effort = 'high', tools = [], capabilities = {}, onEvent, onWait, timeoutMs = 300000, maxToolCalls = 20, maxModelCalls = 30, maxTokens = 8192, executablePath, launchPath = join(root, 'dsh-task-launch.mjs'), desktopProfilePath, metadataExecutablePath } = {}) {
    if (typeof model === 'string' && model.startsWith('openrouter:')) throw fail('DSH_HOST_ONLY_PROVIDER', '此提供方仅可通过已配置的DSH Desktop Host讨论使用；隔离任务不会复制账户密钥或环境凭据。');
    if (process.platform !== 'darwin') throw fail('DSH_PLATFORM_UNSUPPORTED', 'DSH Desktop task execution is supported only on macOS.');
    executablePath = resolveDshExecutable({ executablePath });
    metadataExecutablePath ??= executablePath;
    this.directory = absolute(directory, 'directory'); this.cwd = absolute(cwd ?? directory, 'cwd');
    if ([this.cwd, this.directory].some(path => [sep, homedir()].includes(path) || path.split(/[\\/]/).some(p => sensitive.test(p)))) throw new Error('A dedicated task workspace is required.');
    for (const [name, value] of Object.entries({ timeoutMs, maxToolCalls, maxModelCalls, maxTokens })) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
    this.model = required(model, 'model'); this.effort = required(effort, 'effort');
    if (!/^(?:deepseek-account:deepseek-flash|openrouter:[^\s:]+)$/.test(model)) throw new Error('Unsupported DSH task model route.');
    if (capabilities.imageGeneration || capabilities.connectedApps || capabilities.network) throw new Error('DSH exposes controlled parent tools only; native network, image generation and connected apps are unavailable.');
    this.tools = new Map();
    for (const tool of tools) {
      if (!tool || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(tool.name) || this.tools.has(tool.name) || typeof tool.execute !== 'function' || tool.inputSchema?.type !== 'object') throw new Error('Invalid controlled DSH task tool.');
      required(tool.description, 'tool description', true); this.tools.set(tool.name, tool);
    }
    Object.assign(this, { timeoutMs, maxToolCalls, maxModelCalls, maxTokens, onEvent, onWait, executablePath, launchPath, desktopProfilePath, metadataExecutablePath });
    this.waitDepth = 0;
    this.statePath = join(this.directory, 'dsh-task-state.json'); this.eventPath = join(this.directory, 'dsh-task-events.jsonl');
    this.fingerprint = createHash('sha256').update(JSON.stringify({ cwd: this.cwd, model, effort, maxTokens, maxToolCalls, maxModelCalls, tools: [...this.tools.values()].map(({ name, inputSchema }) => ({ name, inputSchema })) })).digest('hex');
  }
  _emit(event) { const safe = compact({ timestamp: new Date().toISOString(), ...event }); try { this.onEvent?.(safe); } catch {} }
  _record(direction, event) { appendFileSync(this.eventPath, JSON.stringify({ timestamp: new Date().toISOString(), direction, message: compact(event) }) + '\n', { mode: 0o600 }); }
  async _save() { await writeFile(this.statePath, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 }); }
  async _acquire() {
    if (this.owner) return;
    this.lockPath = join(this.directory, 'dsh-task-owner.lock');
    const owner = { pid: process.pid, token: randomUUID() };
    try {
      const lock = await open(this.lockPath, 'wx', 0o600);
      try { await lock.writeFile(JSON.stringify(owner)); this.owner = owner; } finally { await lock.close(); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let prior; try { prior = JSON.parse(await readFile(this.lockPath, 'utf8')); } catch { throw fail('WORKER_OWNED', 'DSH task directory has an unreadable owner lock.'); }
      if (!Number.isSafeInteger(prior.pid) || prior.pid < 1) throw fail('WORKER_OWNED', 'DSH task directory has an invalid owner lock.');
      try { process.kill(prior.pid, 0); } catch (e) { if (e.code === 'ESRCH') { await unlink(this.lockPath); return this._acquire(); } }
      throw fail('WORKER_OWNED', 'Another worker already owns this DSH task directory.');
    }
  }
  async _release() {
    if (!this.owner) return;
    try { const current = JSON.parse(await readFile(this.lockPath, 'utf8')); if (current.token === this.owner.token) await unlink(this.lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    finally { this.owner = null; }
  }
  async _prepare() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (await realpath(this.cwd) !== this.cwd || await realpath(this.directory) !== this.directory) throw new Error('Task directories cannot traverse symbolic links.');
    await this._acquire();
    try { this.state = JSON.parse(await readFile(this.statePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.state ??= { sessionId: `session-${randomUUID()}`, fingerprint: this.fingerprint, messages: {} };
    if (this.state.fingerprint !== this.fingerprint) throw new Error('DSH task scope or model changed; use a new execution directory.');
    this.threadId = this.state.sessionId;
    const info = await metadata(this);
    const [provider, model] = this.model.split(/:(.*)/s);
    if (provider === 'openrouter' && !info.providers?.openrouter?.models?.some(x => x.id === model)) throw new Error('The selected OpenRouter model is not in the configured DSH catalog.');
    const profile = join(this.directory, 'profile'); await mkdir(profile, { recursive: true, mode: 0o700 });
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'agent-bridge-dsh-task', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }, null, 2), { mode: 0o600 });
    await writeFile(join(profile, 'cordis.yml'), '[]\n', { mode: 0o600 });
    const disabled = ['hmr', 'plugin-manager', 'config-editor', 'settings', 'session-title-llm', 'session-log-deepseek', 'otel', 'session-telemetry-otel', 'agent-instructions', 'skill-filesystem', 'skill', 'tool-skill', 'subagent', 'subagent-spawn-in-process', 'subagent-fork-in-process', 'tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'goal-round-driver', 'shell-env'];
    let patch = disabled.map(id => `- id: ${id}\n  disabled: true\n`).join('');
    patch += `- id: session-persistence-jsonl\n  config:\n    root: ${JSON.stringify(join(this.directory, 'runtime', 'sessions'))}\n    compression: none\n`;
    patch += `- id: storage-json\n  config:\n    root: ${JSON.stringify(join(this.directory, 'runtime', 'storages'))}\n`;
    patch += '- id: deepseek-account\n  config:\n    desktopPlatform: darwin\n';
    patch += '- id: agent-loop\n  config:\n    maxParallelToolCalls: 1\n    agents: []\n';
    patch += '- id: llm-pi-ai\n  config:\n    providers:\n';
    if (info.providers?.openrouter) {
      patch += `      openrouter:\n        apiKeyEnv: ${JSON.stringify(info.providers.openrouter.apiKeyEnv)}\n        models: ${JSON.stringify(info.providers.openrouter.models)}\n        retryPolicy: { mode: normal, maxRetries: 0 }\n`;
      if (info.providers.openrouter.reasoning) patch += `        reasoning: ${JSON.stringify(info.providers.openrouter.reasoning)}\n`;
    } else patch += '      {}\n';
    patch += `- insert:\n    - id: dsh-task-bridge\n      name: ${JSON.stringify(join(root, 'dsh-task-runner.mjs'))}\n      config:\n        directory: ${JSON.stringify(this.directory)}\n`;
    await writeFile(join(profile, 'cordis.patch.yml'), patch, { mode: 0o600 });
    await writeFile(join(this.directory, 'task-config.json'), JSON.stringify({ directory: this.directory, cwd: this.cwd, sessionId: this.state.sessionId, resume: this.state.materialized === true, provider, model, ...(this.effort === 'default' ? {} : { reasoningEffort: this.effort }), maxTokens: this.maxTokens, timeoutMs: this.timeoutMs, maxToolCalls: this.maxToolCalls, maxModelCalls: this.maxModelCalls, tools: [...this.tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }, null, 2), { mode: 0o600 });
    await this._save();
  }
  async _start() {
    if (this.child) return;
    await this._prepare(); if (this.stopError) throw this.stopError;
    await new Promise((resolve, reject) => {
      this.readyReject = reject;
      const child = this.child = spawn(this.executablePath, ['--expose-internals', this.launchPath, this.directory], { cwd: this.directory, env: childEnvironment(this.executablePath), stdio: ['pipe', 'pipe', 'pipe'] });
      this.childExit = new Promise(done => child.once('exit', done));
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(fail('STARTUP_TIMEOUT', 'DSH task startup timed out.')); }, 20000);
      child.stderr.on('data', () => {});
      this.lines = createInterface({ input: child.stdout });
      this.lines.on('line', line => {
        if (!line.startsWith(PREFIX)) return;
        let event; try { event = JSON.parse(line.slice(PREFIX.length)); } catch { return; }
        this._record('native', event);
        if (event.type === 'fatal') { const error = fail(event.code ?? 'STARTUP_FAILED', compact(event.message ?? 'DSH task startup failed.')); clearTimeout(timer); reject(error); this.active?.reject(error); child.kill('SIGTERM'); return; }
        if (event.type === 'ready') {
          if (event.sessionId !== this.threadId) { reject(fail('NATIVE_PROTOCOL', 'Unexpected DSH session identity.')); child.kill('SIGTERM'); return; }
          clearTimeout(timer); this.readyReject = null; this._emit({ type: 'ready', threadId: this.threadId, model: this.model }); resolve(); return;
        }
        this._handle(event).catch(error => { this.stopError ??= error; this.active?.reject(error); this.cancel('NATIVE_PROTOCOL').catch(() => {}); });
      });
      child.once('error', error => { clearTimeout(timer); reject(error); this.active?.reject(error); });
      child.once('exit', () => { clearTimeout(timer); this.child = null; this.lines?.close(); const error = this.stopError ?? fail('NATIVE_EXIT', 'DSH task process exited.'); reject(error); this.active?.reject(error); });
    });
    this.state.materialized = true; await this._save();
  }
  _send(value) { if (!this.child?.stdin.writable) throw fail('NATIVE_EXIT', 'DSH task process is unavailable.'); this._record('controller', value); this.child.stdin.write(JSON.stringify(value) + '\n'); }
  async _wait(reason, fn, callId, active = this.active) {
    if (!active || active !== this.active || active.abort.signal.aborted) throw fail('CANCELLED', 'No active DSH call owns this wait.');
    active.waitCalls ??= new Map();
    const depth = active.waitCalls.get(callId) ?? 0; active.waitCalls.set(callId, depth + 1);
    if (!depth) this._send({ type: 'tool-wait', runId: active.runId, callId, waiting: true });
    if (this.waitDepth++ === 0) {
      this.runTimer?.pause(); this._emit({ type: 'waiting', reason });
      this.waitEntered = Promise.resolve().then(() => this.onWait?.(true, reason));
    }
    try { await this.waitEntered; active.abort.signal.throwIfAborted(); return await fn(); }
    finally {
      if (--this.waitDepth === 0) {
        try { await this.onWait?.(false, reason); }
        finally { if (!this.waitDepth) this.runTimer?.resume(); this._emit({ type: 'resumed', reason }); }
      }
      const remaining = active.waitCalls.get(callId) - 1; active.waitCalls.set(callId, remaining);
      if (!remaining && active === this.active && this.child?.stdin.writable) this._send({ type: 'tool-wait', runId: active.runId, callId, waiting: false });
    }
  }
  async _handle(event) {
    const active = this.active;
    if (!active) return;
    if (event.runId !== active.runId || event.sessionId !== this.threadId || event.messageId !== active.messageId) throw fail('NATIVE_PROTOCOL', 'DSH task message denied: unowned task/session.');
    if (event.type === 'tool-call') {
      const tool = this.tools.get(event.name);
      const reply = result => { if (this.child?.stdin.writable) this._send({ type: 'tool-result', runId: active.runId, callId: event.callId, ...result }); };
      if (!tool || !event.callId || this.stopError || active.abort.signal.aborted) { reply({ success: false, error: 'Task tool denied.' }); return; }
      const fingerprint = createHash('sha256').update(JSON.stringify({ name: event.name, arguments: event.arguments })).digest('hex');
      const prior = active.calls.get(event.callId);
      if (prior && prior.fingerprint !== fingerprint) throw fail('NATIVE_PROTOCOL', 'Conflicting DSH tool call identity.');
      if (prior) { reply(await prior.promise); return; }
      active.toolCalls++;
      if (active.toolCalls > this.maxToolCalls) { await this.cancel('TOOL_BUDGET_EXCEEDED'); reply({ success: false, error: 'Task tool budget exceeded.' }); return; }
      this._emit({ type: 'tool-started', name: event.name, callId: event.callId, toolCalls: active.toolCalls });
      const promise = (async () => {
        try { return { success: true, value: await tool.execute(event.arguments, { signal: active.abort.signal, cwd: this.cwd, threadId: this.threadId, turnId: active.runId, callId: event.callId, wait: (reason, fn) => this._wait(reason, fn, event.callId, active) }) ?? null }; }
        catch (error) { return { success: false, error: compact(String(error.message ?? error)) }; }
      })();
      active.calls.set(event.callId, { fingerprint, promise }); const result = await promise;
      reply(this.stopError ? { success: false, error: 'Task cancelled.' } : result); this._emit({ type: 'tool-completed', name: event.name, callId: event.callId, success: result.success }); return;
    }
    if (event.type === 'completed') {
      if (this.stopError) return active.reject(this.stopError);
      const result = { text: String(event.text ?? ''), threadId: this.threadId, turnId: active.runId, usage: compact(event.usage ?? null), toolCalls: active.toolCalls, artifacts: [], eventsFile: this.eventPath, provenance: { kind: 'native-dsh-agent-loop', inputType: 'agent-message', messageId: active.messageId, authorId: active.authorId, recipientId: this.threadId, model: this.model } };
      active.resolve(result); return;
    }
    if (event.type === 'error' || event.type === 'cancelled') return active.reject(this.stopError ?? fail(event.code ?? 'NATIVE_TURN_FAILED', compact(event.message ?? 'DSH task cancelled.')));
    this._emit({ type: 'native', ...event });
  }
  async run({ messageId, authorId, text, signal } = {}) {
    required(messageId, 'messageId'); required(authorId, 'authorId'); required(text, 'text', true);
    if (this.pending) throw new Error('This DSH task worker already has a pending run.');
    if (signal?.aborted) throw fail('CANCELLED', 'DSH task cancelled before admission.');
    this.pending = true; const abort = () => { this.cancel().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = this.runTimer = new ActiveTimeBudget(() => { this.cancel('TIMEOUT').catch(() => {}); }, this.timeoutMs);
    try {
      await this._start(); if (this.stopError) throw this.stopError;
      const fingerprint = createHash('sha256').update(JSON.stringify({ authorId, text })).digest('hex');
      const previous = this.state.messages[messageId];
      if (previous) { if (previous.fingerprint !== fingerprint) throw new Error('DSH message identity conflict.'); if (previous.result) return previous.result; throw fail('INDETERMINATE_PREVIOUS_RUN', 'A previous DSH run with this messageId did not complete; inspect its audit before issuing a new message.'); }
      this.state.messages[messageId] = { fingerprint, status: 'running' }; await this._save();
      const result = await new Promise((resolve, reject) => {
        const active = this.active = { runId: randomUUID(), messageId, authorId, abort: new AbortController(), calls: new Map(), toolCalls: 0, resolve, reject };
        this._send({ type: 'run', runId: active.runId, messageId, authorId, text });
      });
      this.state.messages[messageId] = { fingerprint, status: 'completed', result }; await this._save(); this._emit({ type: 'completed', ...result }); return result;
    } catch (error) { const final = this.stopError ?? error; this._emit({ type: 'error', code: final.code ?? 'NATIVE_ERROR', message: final.message }); await this.close(); throw final; }
    finally { timer.dispose(); this.runTimer = null; clearTimeout(this.killTimer); signal?.removeEventListener('abort', abort); this.active?.abort.abort(); this.active = null; this.pending = false; }
  }
  async cancel(code = 'CANCELLED') {
    if (!this.pending && !this.active) return;
    this.stopError ??= fail(code, code === 'TIMEOUT' ? 'DSH task timed out.' : code === 'TOOL_BUDGET_EXCEEDED' ? 'DSH task tool budget exceeded.' : 'DSH task cancelled.');
    this.active?.abort.abort(this.stopError); this._emit({ type: 'stopping', code: this.stopError.code });
    if (this.child?.stdin.writable) this._send({ type: 'cancel', runId: this.active?.runId, code: this.stopError.code });
    this.readyReject?.(this.stopError);
    if (!this.killTimer) this.killTimer = setTimeout(() => { this.child?.kill('SIGTERM'); this.active?.reject(this.stopError); }, 2500);
    if (!this.child) this.active?.reject(this.stopError);
  }
  async close() {
    await this.cancel(); const child = this.child; if (!child) { clearTimeout(this.killTimer); await this._release(); return; }
    try { this._send({ type: 'shutdown' }); } catch {}
    const term = setTimeout(() => child.kill('SIGTERM'), 1000);
    const kill = setTimeout(() => child.kill('SIGKILL'), 2500);
    try { await this.childExit; } finally { clearTimeout(term); clearTimeout(kill); clearTimeout(this.killTimer); this.child = null; this.lines?.close(); await this._release(); }
  }
}
