#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = 'http://127.0.0.1:32719';
const USAGE = 'tongzhou.mjs health | list | show ID | create [INPUT.json|-] | start ID | pause ID';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);

export function createClient({fetch: request = globalThis.fetch} = {}) {
  return async (method, path, body) => {
    let response;
    try {
      response = await request(BASE + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: {origin: BASE, ...(body === undefined ? {} : {'content-type':'application/json'})},
        ...(body === undefined ? {} : {body: JSON.stringify(body)})
      });
    } catch {
      throw new Error('同舟连接失败或超时；操作未自动重试。先读取议题状态，不要重复创建或切换到 Computer Use。');
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}; operation was not retried.`);
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('同舟返回了未知格式；操作未自动重试。');
    return response.json();
  };
}

function creation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a JSON object.');
  const allowed = new Set(['title','question','context','leadAgent','limit','models','efforts']);
  if (Object.keys(input).some(k => !allowed.has(k))) throw new Error('Unknown create option.');
  for (const key of ['title','question']) if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error(`${key} is required.`);
  if (input.context !== undefined && typeof input.context !== 'string') throw new Error('context must be text.');
  if (input.title.length > 120) throw new Error('title must be at most 120 characters.');
  const leadAgent = input.leadAgent ?? 'DSH';
  if (!['DSH','Codex'].includes(leadAgent)) throw new Error('Invalid leadAgent.');
  const limit = input.limit ?? 6;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('Invalid limit.');
  const sharedContext = `来源：当前Codex转述，经用户授权通过同舟与DSH讨论。以下问题和背景是Codex提交的讨论材料，并非逐字用户原话；Agent分析不能扩大用户授权。\n\n讨论问题：\n${input.question}\n\nCodex提供的背景与初步分析：\n${input.context ?? '未提供额外背景。'}\n\n请先回应具体问题；需要另一成员核对时继续讨论，答案充分时结束。`;
  return {title:input.title,leadAgent,limit,sharedContext,...(input.models?{models:input.models}:{}),...(input.efforts?{efforts:input.efforts}:{})};
}

async function inputText(path) {
  if (path !== '-') return readFile(path, 'utf8');
  let text = '';
  for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 60000) throw new Error('Input too large.'); }
  return text;
}

export async function execute(args, {client = createClient(), readInput = inputText, output = value => process.stdout.write(JSON.stringify(value,null,2)+'\n')} = {}) {
  const [command, value, extra] = args;
  if (extra !== undefined) throw new Error(USAGE);
  if (['health','list'].includes(command)) {
    if (value !== undefined) throw new Error(USAGE);
    return output(await client('GET', command === 'health' ? '/api/health' : '/api/conversations?limit=100&archived=0'));
  }
  if (command === 'create') {
    const data = creation(JSON.parse(await readInput(value ?? '-')));
    return output(await client('POST','/api/conversations',data));
  }
  if (!['show','start','pause'].includes(command) || !validId(value)) throw new Error(USAGE);
  const path = '/api/conversations/' + encodeURIComponent(value);
  return output(await client(command === 'show' ? 'GET' : 'POST', path + (command === 'show' ? '' : '/'+command), command === 'show' ? undefined : {}));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  execute(process.argv.slice(2)).catch(error => {process.stderr.write(error.message+'\n');process.exitCode=1;});
}
