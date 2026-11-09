import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

// These checks catch the original plugin's external ../../ service dependency,
// writable package state, and accidental publication of private runtime data.
test('distribution contains every relative runtime module and no private state', async () => {
  const cache = await mkdtemp(join(tmpdir(),'tongzhou-pack-test-'));
  let stdout;
  try { ({stdout} = await run('npm', ['pack','--dry-run','--json','--ignore-scripts','--cache',cache], {cwd:root})); }
  finally { await rm(cache,{recursive:true,force:true}); }
  const [pack] = JSON.parse(stdout), files = new Set(pack.files.map(file => file.path));
  for (const required of ['lib/index.js','client/client.js','cordis.patch.yml','server/start-service.mjs','server/hub.mjs','server/web/index.html','skills/tongzhou-collaboration/SKILL.md','LICENSE']) assert.ok(files.has(required), required);
  for (const name of files) {
    assert.ok(!/(?:^|\/)(?:docs_dev|tests?|node_modules|codex-skill|\.dsh|\.codex|backups?)(?:\/|$)/.test(name), name);
    assert.ok(!/(?:web-service|delivery-state|host-lanes|reading-sessions|connection-settings)\.json$|\.(?:log|sqlite|zst)$/.test(name), name);
    if (!/\.(?:m?js|md|ya?ml|json|css|html)$/.test(name)) continue;
    const text = await readFile(join(root,name),'utf8');
    assert.ok(!/\/Users\/|\/opt\/miniforge3|20\d{6}-tongzhou-v\d|life-maintenance/.test(text), name);
    if (!/\.(?:m?js)$/.test(name)) continue;
    for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
      const target = resolve(dirname(join(root,name)), match[1]);
      assert.ok(target.startsWith(root+'/'), `${name} escapes package: ${match[1]}`);
      assert.ok(files.has(target.slice(root.length+1)), `${name} missing packaged import: ${match[1]}`);
    }
  }
});

test('package declares a DSH bundle and does not run installation scripts', async () => {
  const pkg = JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  assert.equal(pkg.name,'dsh-codex-bridge');
  assert.equal(pkg.version,'0.3.0');
  assert.equal(pkg.dsh.bundle.patch,'./cordis.patch.yml');
  assert.equal(pkg.exports['./client'],'./client/client.js');
  for (const hook of ['preinstall','install','postinstall','prepare']) assert.equal(pkg.scripts?.[hook],undefined);
  assert.deepEqual(pkg.os,['darwin']);
  assert.equal(pkg.engines.node,'>=24.9.0');
});

test('bundled skill creates discussion records without starting a model', async () => {
  const {execute} = await import('../skills/tongzhou-collaboration/scripts/tongzhou.mjs');
  const calls = [], outputs = [];
  await execute(['create','-'], {readInput: async () => JSON.stringify({title:'Review this design',question:'Check the assumptions.'}), client: async (...args) => {calls.push(args);return {conversation:{id:'demo'}};}, output:value=>outputs.push(value)});
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],'POST');
  assert.equal(calls[0][1],'/api/conversations');
  assert.equal(calls[0][2].leadAgent,'DSH');
  assert.match(calls[0][2].sharedContext,/Codex转述/);
  assert.equal(outputs[0].conversation.id,'demo');
});

test('Host wrapper uses actual caller identity and writes only to its data directory', async () => {
  const data = await mkdtemp(join(tmpdir(),'tongzhou-wrapper-test-'));
  try {
    const code = `
      import {registerHooks} from 'node:module';
      import {readFile,writeFile} from 'node:fs/promises';
      import {join} from 'node:path';
      const data = process.env.TONGZHOU_DATA_DIR;
      const stub = source => ({url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true});
      registerHooks({resolve(specifier,context,next){
        if(specifier==='@deepseek-ai/dsh-tools')return stub('export const defineTool=x=>x;');
        if(specifier==='@deepseek-ai/dsh-llm')return stub('export const createUserMessage=x=>({...x,id:"test-message"});');
        if(specifier==='@deepseek-ai/dsh-session')return stub('export const SessionSeq=x=>x;');
        return next(specifier,context);
      }});
      await writeFile(join(data,'web-service.json'),JSON.stringify({localKey:'test-local-key-only-not-a-real-secret'}));
      const {apply} = await import(process.argv[1]);
      const tools=new Map(),calls=[];
      globalThis.fetch=async(url,options)=>{
        calls.push({url,body:JSON.parse(options.body)});
        return new Response(JSON.stringify({accepted:true,messageId:'m1',conversationId:'shared-discussion',status:'queued'}),{headers:{'content-type':'application/json'}});
      };
      apply({tools:{register:t=>tools.set(t.name,t)},effect(){},agents:{get(){}},sessions:{}},{autoStart:false});
      let rejected=false;
      try {await tools.get('codex_bridge_send').execute({text:'Hello'},{});}catch{rejected=true;}
      await tools.get('codex_bridge_send').execute({text:'Hello',nativeAgentId:'spoofed'},{agent:{id:'real-native-agent'}});
      console.log(JSON.stringify({rejected,calls,ledger:JSON.parse(await readFile(join(data,'dsh-delivery-state.json'),'utf8'))}));
    `;
    const {stdout} = await run(process.execPath,['--input-type=module','-e',code,new URL('../lib/index.js',import.meta.url).href],{env:{...process.env,TONGZHOU_DATA_DIR:data}});
    const result=JSON.parse(stdout);
    assert.equal(result.rejected,true);
    assert.equal(result.calls.length,1);
    assert.equal(result.calls[0].body.nativeAgentId,'real-native-agent');
    assert.equal(result.calls[0].body.conversationId,'shared-discussion');
    assert.deepEqual(result.ledger.registered,['real-native-agent']);
  } finally {await rm(data,{recursive:true,force:true});}
});

const EXPECTED_INSTANCE = 'a'.repeat(64);
async function browserClient({identityResult={ok:true,value:{buildId:'tongzhou-community-0.3.0',instanceId:EXPECTED_INSTANCE}}}={}) {
  const {default:vm}=await import('node:vm');
  const entries=new Map(), listeners=new Set(), hooks=[], pending=[], timers=new Set(), timeouts=new Set(), identityCalls=[];
  let plugin, index=0, now=0;
  const React={
    createElement(type,props,...children){return {type,props:{...props,children}};},
    useRef(current){const id=index++;return hooks[id]??={current};},
    useState(value){const id=index++;hooks[id]??={value};return [hooks[id].value,next=>{hooks[id].value=typeof next==='function'?next(hooks[id].value):next;}];},
    useEffect(callback,deps){const id=index++,old=hooks[id];if(!old||deps.some((value,i)=>value!==old.deps[i])){old?.cleanup?.();const slot=hooks[id]={deps};pending.push(()=>{slot.cleanup=callback();});}}
  };
  const store={spec:{persist:'dsh.conversation'}};
  const slots={inject(name,callback){callback();},entries(){return [{store}];},register(meta,component){entries.set(meta.name,{meta,component});return()=>{};}};
  const win={__ModuleLoader__:{load({factory}){plugin=factory(()=>React);}},addEventListener(type,fn){listeners.add(fn);},removeEventListener(type,fn){listeners.delete(fn);}};
  vm.runInNewContext(await readFile(join(root,'client/client.js'),'utf8'),{window:win,AbortController,setTimeout:(fn,ms)=>{const timer={fn,at:now+ms};timeouts.add(timer);return timer;},clearTimeout:timer=>timeouts.delete(timer),Date:{now:()=>now},setInterval:fn=>{timers.add(fn);return fn;},clearInterval:fn=>timers.delete(fn)});
  plugin.apply({slots,connection:{rpc:{async call(...args){identityCalls.push(args);return identityResult;}}}});
  return {entries,identityCalls,async settle(){await new Promise(resolve=>setImmediate(resolve));},render(component,props={}){index=0;const entry=[...entries.values()].find(e=>e.component===component);const node=component({...entry?.meta.inject?.(),...props});while(pending.length)pending.shift()();return node;},send(event){for(const listener of listeners)listener(event);},advance(ms){now+=ms;for(const timer of [...timeouts])if(timer.at<=now){timeouts.delete(timer);timer.fn();}for(const timer of timers)timer();},dispose(){for(const hook of hooks)hook?.cleanup?.();}};
}
function element(node,type) {
  if(node?.type===type)return node;
  for(const child of node?.props?.children?.flat(Infinity)??[]){const result=element(child,type);if(result)return result;}
}

test('client hides an occupied older service until the expected build replies', async()=>{
  const c=await browserClient(),panel=c.entries.get('main').component;
  try {
    let tree=c.render(panel);
    assert.equal(element(tree,'iframe'),undefined);
    await c.settle();
    const frame=element(c.render(panel),'iframe');
    assert.equal(frame.props.style.visibility,'hidden');
    assert.equal(c.identityCalls[0][0],'/api');
    assert.equal(c.identityCalls[0][1],'tongzhou.bridgeIdentity');
    const source={};frame.props.ref.current={contentWindow:source};
    const event={origin:'http://127.0.0.1:32719',source,data:{type:'agent-bridge:ready'}};
    c.send(event);
    assert.equal(element(c.render(panel),'iframe').props.style.visibility,'hidden');
    c.send({...event,data:{...event.data,buildId:'some-other-installation'}});
    assert.equal(element(c.render(panel),'iframe').props.style.visibility,'hidden');
    const expected={...event,data:{...event.data,buildId:'tongzhou-community-0.3.0',instanceId:EXPECTED_INSTANCE}};
    c.send({...expected,data:{...expected.data,instanceId:'b'.repeat(64)}});
    assert.equal(element(c.render(panel),'iframe').props.style.visibility,'hidden');
    c.send({...expected,source:{}});
    assert.equal(element(c.render(panel),'iframe').props.style.visibility,'hidden');
    c.send(expected);
    assert.equal(element(c.render(panel),'iframe').props.style.visibility,'visible');
    c.advance(9000);
    tree=c.render(panel);
    assert.equal(element(tree,'iframe').props.style.visibility,'hidden');
    assert.match(JSON.stringify(tree),/端口/);
  } finally {c.dispose();}
});

test('native reading probe rejects old-service ownership before changing native tabs', async()=>{
  const c=await browserClient(),probe=c.entries.get('conversation.session.header.utilities').component;
  try {
    const selected=[],props={sessionId:'native-demo',useStore:selector=>selector({view:null}),actions:{setView:id=>selected.push(id)}};
    assert.equal(element(c.render(probe,props),'iframe'),undefined);
    await c.settle();
    const frame=element(c.render(probe,props),'iframe'),source={};frame.props.ref.current={contentWindow:source};
    const event={origin:'http://127.0.0.1:32719',source,data:{type:'agent-bridge:reading-ready',sessionId:'native-demo',source:'shared-discussion'}};
    c.send(event);
    assert.deepEqual(selected,[]);
    c.send({...event,data:{...event.data,buildId:'tongzhou-community-0.3.0',instanceId:'b'.repeat(64)}});
    assert.deepEqual(selected,[]);
    c.send({...event,data:{...event.data,buildId:'tongzhou-community-0.3.0',instanceId:EXPECTED_INSTANCE}});
    assert.deepEqual(selected,['tongzhou-reading']);
  } finally {c.dispose();}
});


test('a missing Host identity disables embedding even when a local service replies', async()=>{
  const c=await browserClient({identityResult:{ok:false,error:{code:'offline'}}}),panel=c.entries.get('main').component;
  try {
    c.render(panel);await c.settle();
    const tree=c.render(panel);
    assert.equal(element(tree,'iframe'),undefined);
    assert.match(JSON.stringify(tree),/无法验证/);
  } finally {c.dispose();}
});

test('DSH identity route returns only the Host fingerprint and ignores no caller-supplied paths', async()=>{
  const {createIdentityRoute}=await import('../lib/instance-identity.js');
  const {instanceFingerprint}=await import('../server/runtime-config.mjs');
  const route=createIdentityRoute();
  assert.equal(route.path,'/api/tongzhou.bridgeIdentity');
  assert.deepEqual(route.methods,['POST']);
  const envelope={type:'client-request',rpcId:'test-request',method:'tongzhou.bridgeIdentity',payload:{}};
  const request=body=>new Request('http://dsh.test'+route.path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const response=await route.fetch(request(envelope)),data=await response.json();
  assert.equal(response.status,200);
  assert.deepEqual(data,{type:'server-response',rpcId:'test-request',result:{ok:true,value:{buildId:'tongzhou-community-0.3.0',instanceId:instanceFingerprint()}}});
  const injected=await route.fetch(request({...envelope,payload:{directory:'/tmp/other-instance',instanceId:'b'.repeat(64)}}));
  assert.equal(injected.status,400);
  assert.notEqual(instanceFingerprint({directory:'/tmp/first'}),instanceFingerprint({directory:'/tmp/second'}));
  assert.notEqual(instanceFingerprint({codeRoot:'/tmp/build-a'}),instanceFingerprint({codeRoot:'/tmp/build-b'}));
});


test('an unresponsive Host identity reports unavailable without embedding a page', async()=>{
  const c=await browserClient({identityResult:new Promise(()=>{})}),panel=c.entries.get('main').component;
  try {
    c.render(panel);await c.settle();c.advance(4001);
    const tree=c.render(panel);
    assert.equal(element(tree,'iframe'),undefined);
    assert.match(JSON.stringify(tree),/无法验证/);
  } finally {c.dispose();}
});
