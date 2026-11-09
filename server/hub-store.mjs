import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class HubStore {
  #locks = new Map();
  constructor(directory) { this.directory = directory; }
  async init() { await mkdir(join(this.directory, 'live'), { recursive: true, mode: 0o700 }); }
  path(id) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('Invalid conversation ID.');
    return join(this.directory, 'live', id);
  }
  async lock(id, operation) {
    this.path(id);
    const previous = this.#locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.#locks.set(id, next);
    try { return await next; } finally { if (this.#locks.get(id) === next) this.#locks.delete(id); }
  }
  async writeState(state) {
    const path = join(this.path(state.id), 'conversation.json');
    await writeFile(path + '.tmp', JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await rename(path + '.tmp', path);
  }
  async create({ id, title, ...options }) {
    return this.lock(id, async () => {
      const directory = this.path(id);
      try { return JSON.parse(await readFile(join(directory, 'conversation.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (typeof title !== 'string' || !title.trim()) throw new Error('A conversation title is required.');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const state = { ...options, id, title: title.trim().slice(0, 120), status: 'idle', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastActivityAt:new Date().toISOString(), participants: {}, remainingResponses: 4, error: null };
      await this.writeState(state); return state;
    });
  }
  async get(id) {
    const directory = this.path(id);
    const conversation = JSON.parse(await readFile(join(directory, 'conversation.json'), 'utf8'));
    let messages = [];
    try { messages = (await readFile(join(directory, 'events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { conversation, messages };
  }
  async list() {
    const result = [];
    for (const entry of await readdir(join(this.directory, 'live'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try { result.push(JSON.parse(await readFile(join(this.path(entry.name),'conversation.json'),'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async update(id, changes) {
    return this.lock(id, async () => {
      const conversation = JSON.parse(await readFile(join(this.path(id),'conversation.json'),'utf8'));
      if (typeof changes === 'function') changes = changes(conversation);
      if (changes.id !== undefined && changes.id !== id) throw new Error('Conversation identity cannot change.');
      const next = { ...conversation, ...changes, updatedAt: new Date().toISOString() };
      await this.writeState(next); return next;
    });
  }
  async append(id, input) {
    return this.lock(id, async () => {
      if (!input.id || typeof input.text !== 'string' || !input.text.trim()) throw new Error('A message ID and text are required.');
      if (input.kind === 'agent' && (!['Codex', 'DSH'].includes(input.from?.name) || !input.from.agentId || !input.origin?.kind)) throw new Error('Agent identity and native origin are required.');
      if (!['agent', 'review', 'event', 'user'].includes(input.kind)) throw new Error('Invalid message kind.');
      if(input.kind==='user'&&(input.from?.name!=='你'||input.origin?.kind!=='web-user-supplement'))throw new Error('User supplements require a real web origin.');
      const { conversation, messages } = await this.get(id);
      const prior = messages.find((message) => message.id === input.id);
      const comparable = (message) => JSON.stringify({ kind: message.kind, from: message.from, text: message.text, replyTo: message.replyTo, origin: message.origin });
      if (prior) {
        if (comparable(prior) !== comparable(input)) throw new Error('Message ID conflict.');
        return prior;
      }
      const record = { ...input, timestamp: input.timestamp ?? new Date().toISOString() };
      await appendFile(join(this.path(id), 'events.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
      await this.writeState({ ...conversation, updatedAt: record.timestamp, lastActivityAt:record.timestamp, lastMessage: record.text.slice(0, 90) });
      return record;
    });
  }
}
