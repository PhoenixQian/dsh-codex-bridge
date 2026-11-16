import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdCompressSync } from 'node:zlib';
import { createNativeReading } from '../server/native-reading.mjs';

async function syntheticHistory(t, {truncated = false} = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'tongzhou-codec-')));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const sessionsRoot = join(directory, 'sessions'), cwd = '/tmp', sessionId = 'session-synthetic-codec';
  const target = join(sessionsRoot, '--tmp--', sessionId);
  await mkdir(target, {recursive: true});
  await writeFile(join(directory, 'dsh-reading-sessions.json'), JSON.stringify({sessions: {[sessionId]: {type: 'subagent', cwd}}}));
  const header = {type: 'session', version: 4, id: sessionId, cwd, createdAt: 1, isSeeded: false, delegationDepth: 0};
  const events = [
    {type: 'assistant/message', seq: 0, time: 1, data: {message: {content: [{type: 'text', text: 'Reply from the later batch'}]}}},
    {type: 'turn/end', seq: 1, time: 2, data: {reason: {kind: 'completed'}}},
  ];
  const first = zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n'));
  const second = zstdCompressSync(Buffer.from(events.map(JSON.stringify).join('\n') + '\n'));
  await writeFile(join(target, 'session.v4.jsonl.zstd'), Buffer.concat([first, truncated ? second.subarray(0, second.length - 1) : second]));
  return {sessionId, reader: createNativeReading({directory, sessionsRoot, store: {list: async () => []}})};
}

test('native reading returns the final public reply from a later compressed batch', async t => {
  const {reader, sessionId} = await syntheticHistory(t);
  const result = await reader(sessionId);
  assert.equal(result.source, 'native-public');
  assert.equal(result.status, 'completed');
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].text, 'Reply from the later batch');
});

test('native reading rejects a truncated later batch instead of showing a partial history', async t => {
  const {reader, sessionId} = await syntheticHistory(t, {truncated: true});
  await assert.rejects(reader(sessionId), {code: 'NATIVE_LOG_CORRUPT'});
});
