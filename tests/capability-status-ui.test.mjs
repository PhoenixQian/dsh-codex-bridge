import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../server/web/tasks.js', import.meta.url), 'utf8').catch(() => '');
const discussionSource = await readFile(new URL('../server/web/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../server/web/index.html', import.meta.url), 'utf8');
const htmlNodes = new Map([...html.matchAll(/<\w+\b[^>]*\bid="([^"]+)"[^>]*>/g)].map(match => [match[1], match[0]]));
const capabilitySource = await readFile(new URL('../server/web/capability-status.js', import.meta.url), 'utf8').catch(() => '');
const settle = () => new Promise(resolve => setImmediate(resolve));
const contents = node => [node.textContent, ...(node.children || []).map(contents)].join(' ');
const capabilities = {
  Codex: { models: [{ id: 'expensive', displayName: '高级模型' }, { id: 'native-low', displayName: '原生低成本', default: true }], imageGeneration: true, webSearch: true },
  DSH: { models: [{ id: 'or-costly', displayName: 'OR模型', provider: 'openrouter', verified: false }, { id: 'deepseek-native', displayName: 'DeepSeek原生', provider: 'deepseek', verified: true, default: true }], imageGeneration: false, webSearch: false }
};
const task = (id, status = 'draft') => ({ id, title: `任务 ${id}`, goal: '生成可核验交付物', status, models: { Codex: 'native-low', DSH: 'deepseek-native' }, budget: { timeoutSeconds: 300, maxToolCalls: 20 }, outputDirectory: '/task-output/' + id });

class Element {
  constructor() {
    this.children = []; this.listeners = new Map(); this.dataset = {}; this.attributes = new Map();
    this.textContent = ''; this.value = ''; this.disabled = false; this.hidden = false; this.checked = false;
    const classes = new Set();
    this.classList = {
      add(...names) { names.forEach(name => classes.add(name)); },
      remove(...names) { names.forEach(name => classes.delete(name)); },
      contains(name) { return classes.has(name); },
      toggle(name) { if (classes.has(name)) { classes.delete(name); return false; } classes.add(name); return true; }
    };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  reportValidity() { return true; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function harness(href = 'http://127.0.0.1:32719/', withDiscussion = false) {
  const nodes = new Map(), requests = [], intervals = [], shell = new Element();
  const element = id => {
    assert.ok(htmlNodes.has(id), `the page must contain #${id}`);
    if (!nodes.has(id)) {
      const item = new Element(), markup = htmlNodes.get(id);
      item.value = markup.match(/\bvalue="([^"]*)"/)?.[1] || '';
      item.hidden = /\bhidden\b/.test(markup); item.disabled = /\bdisabled\b/.test(markup);
      nodes.set(id, item);
    }
    return nodes.get(id);
  };
  const window = {}; window.parent = window;
  const context = vm.createContext({
    URL, Intl, Date, JSON, window, location: { href },
    localStorage: { getItem() { return null; }, setItem() {} }, history: { replaceState() {} },
    document: { getElementById: element, createElement: () => new Element(), createTextNode: text => ({ textContent: text }), querySelector: () => shell },
    setInterval(callback) { intervals.push(callback); },
    fetch(path, options) { return new Promise(resolve => requests.push({ path, options, responded: false, respond(value, ok = true) { this.responded = true; resolve({ ok, json: async () => value }); } })); }
  });
  vm.runInContext(capabilitySource, context);
  if (withDiscussion) vm.runInContext(discussionSource, context);
  vm.runInContext(source, context);
  return {
    requests, element,
    trigger(id, name = 'click', event = {}) { const listener = element(id).listeners.get(name); assert.ok(listener, `${id} ${name} must be available`); return listener({ preventDefault() {}, ...event }); },
    async respond(path, value, ok = true) { const request = requests.find(item => item.path.split('?')[0] === path && !item.responded); assert.ok(request, `request ${path}`); request.respond(value, ok); await settle(); },
    clickTask(index) { element('task-list').children[index].listeners.get('click')(); },
    tick() { intervals.at(-1)?.(); }
  };
}


const unavailable = {models:[],errorCode:'UNSUPPORTED_DSH_VERSION',runtimeVersion:'0.2.2-rc.4',supportedRuntimeVersions:['0.2.2-rc.1','0.2.2-rc.3'],error:'Only verified DSH versions are supported.'};
test('task form explains an unsupported host version instead of only showing zero models',async()=>{const h=harness();h.trigger('show-tasks');await h.respond('/api/capabilities',{Codex:capabilities.Codex,DSH:unavailable});assert.match(h.element('task-form-feedback').textContent,/0\.2\.2-rc\.4/);assert.match(contents(h.element('task-capabilities')),/0\.2\.2-rc\.3/);assert.equal(h.element('task-dsh-model').disabled,true);assert.equal(h.requests.filter(r=>r.options?.method==='POST').length,0);});
test('new discussion displays capability failure inside its open dialog',async()=>{const h=harness(undefined,true);h.trigger('new-conversation');await h.respond('/api/capabilities',{Codex:capabilities.Codex,DSH:unavailable});assert.equal(h.element('discussion-capability-feedback').hidden,false);assert.match(h.element('discussion-capability-feedback').textContent,/0\.2\.2-rc\.4/);assert.equal(h.element('discussion-dsh-model').disabled,true);});
test('task form keeps Host-only routes out while retaining a usable native task model',async()=>{const h=harness();h.trigger('show-tasks');await h.respond('/api/capabilities',{Codex:capabilities.Codex,DSH:{models:[{id:'openrouter:host-only',taskExecution:false,availability:'host-only'},{id:'native:task',default:true,taskExecution:true}]}});assert.equal(h.element('task-dsh-model').value,'native:task');assert.ok(!contents(h.element('task-dsh-model')).includes('openrouter:host-only'));});

test('reopening a failed discussion catalog retries discovery and clears the old warning after recovery',async()=>{const h=harness(undefined,true);h.trigger('new-conversation');await h.respond('/api/capabilities',{Codex:capabilities.Codex,DSH:unavailable});h.trigger('cancel-new');h.trigger('new-conversation');await h.respond('/api/capabilities',capabilities);assert.equal(h.element('discussion-capability-feedback').hidden,true);assert.equal(h.element('discussion-capability-feedback').textContent,'');assert.equal(h.element('discussion-dsh-model').value,'deepseek-native');});
test('a failed task catalog retries when the task dialog is reopened',async()=>{const h=harness();h.trigger('show-tasks');await h.respond('/api/capabilities',{Codex:capabilities.Codex,DSH:unavailable});h.trigger('new-task');await h.respond('/api/capabilities',capabilities);assert.equal(h.element('task-form-feedback').textContent,'');assert.equal(h.element('task-dsh-model').value,'deepseek-native');});
