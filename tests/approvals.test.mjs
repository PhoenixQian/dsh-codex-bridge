import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ApprovalBroker} from '../server/approvals.mjs';

const tick=()=>new Promise(r=>setImmediate(r));
const request=(extra={})=>({taskId:'task-a',roundId:1,agent:'Codex',callId:'native-call-1',kind:'confirmation',reason:'修改前审阅',action:'write',target:'result.md',preview:'proposed change',argsHash:'abc',scopeVersion:1,choices:[{id:'allow_once',label:'允许这一次'},{id:'deny',label:'拒绝此动作'}],...extra});
async function fixture(){const directory=await mkdtemp(join(tmpdir(),'tongzhou-approvals-'));const broker=new ApprovalBroker({directory});await broker.init();return{broker,directory,async close(){await broker.close();await rm(directory,{recursive:true,force:true});}};}

test('approval does not execute before a real offered choice and resolves exactly once',async()=>{
 const h=await fixture();try{let executions=0;const waits=[];const pending=h.broker.request(request({onWait:async w=>waits.push(w)})).then(r=>{if(r.choice==='allow_once')executions++;return r;});await tick();await tick();
 const cards=await h.broker.list({taskId:'task-a'});assert.equal(cards.length,1);assert.equal(cards[0].status,'pending');assert.equal(executions,0);
 await assert.rejects(h.broker.decide(cards[0].id,{choice:'allow_forever'}),/choice|选项/i);
 await h.broker.decide(cards[0].id,{choice:'allow_once'});assert.equal((await pending).choice,'allow_once');assert.equal(executions,1);assert.deepEqual(waits,[true,false]);
 await h.broker.decide(cards[0].id,{choice:'allow_once'});assert.equal(executions,1);await assert.rejects(h.broker.decide(cards[0].id,{choice:'deny'}),/already|已|conflict/i);
 }finally{await h.close();}
});

test('Agent-bound request IDs reject changed operations and do not share the peer decision',async()=>{
 const h=await fixture();try{const a=h.broker.request(request());const b=h.broker.request(request({agent:'DSH'}));await tick();await tick();const cards=await h.broker.list();assert.equal(cards.length,2);
 await assert.rejects(h.broker.request(request({preview:'different side effect'})),/conflict|changed|冲突/i);
 const ca=cards.find(c=>c.agent==='Codex'),cb=cards.find(c=>c.agent==='DSH');await h.broker.decide(ca.id,{choice:'deny'});assert.equal((await a).choice,'deny');assert.equal((await h.broker.list()).find(c=>c.id===cb.id).status,'pending');await h.broker.decide(cb.id,{choice:'allow_once'});assert.equal((await b).choice,'allow_once');
 }finally{await h.close();}
});

test('cancelled requests are inert and a process restart never revives a prior approval',async()=>{
 const h=await fixture();try{const c=new AbortController();const p=h.broker.request(request({signal:c.signal}));await tick();await tick();const id=(await h.broker.list())[0].id;c.abort();await assert.rejects(p,/cancel|取消/i);await assert.rejects(h.broker.decide(id,{choice:'allow_once'}),/cancel|inactive|失效|取消/i);
 const pending=h.broker.request(request({callId:'waiting-at-restart'}));pending.catch(()=>{});await h.broker.list();const other=new ApprovalBroker({directory:h.directory});await other.init();const restored=(await other.list()).find(x=>x.callId==='waiting-at-restart');assert.equal(restored.status,'interrupted');await assert.rejects(other.decide(restored.id,{choice:'allow_once'}),/inactive|interrupted|连接|失效/i);await other.close();
 }finally{await h.close();}
});

test('cancellation during durable decision notification wins before native delivery',async()=>{
 const h=await fixture();try{let enter,release;const entered=new Promise(r=>enter=r),hold=new Promise(r=>release=r);h.broker.onChange=async row=>{if(row.status==='decided'){enter();await hold;}};const c=new AbortController();const pending=h.broker.request(request({signal:c.signal}));const outcome=pending.then(v=>({value:v}),e=>({error:e}));await h.broker.list();const id=(await h.broker.list())[0].id;const decided=h.broker.decide(id,{choice:'allow_once'});await entered;c.abort();release();await decided.catch(()=>{});const result=await outcome;assert.ok(result.error,'cancelled approval must never return allow_once');assert.equal(result.value,undefined);
 }finally{await h.close();}
});

test('failed decision persistence never returns duplicate success or abandons the pending request',async()=>{
 const h=await fixture();try{const pending=h.broker.request(request());await h.broker.list();const id=(await h.broker.list())[0].id;const original=h.broker.save.bind(h.broker);let fail=true;h.broker.save=async()=>{if(fail)throw new Error('disk unavailable');return original();};await assert.rejects(h.broker.decide(id,{choice:'allow_once'}),/disk/);assert.equal((await h.broker.list())[0].status,'pending');fail=false;await h.broker.decide(id,{choice:'deny'});assert.equal((await pending).choice,'deny');
 }finally{await h.close();}
});

test('a cancellation save error still rejects the original native wait',async()=>{
 const h=await fixture();try{const c=new AbortController();h.broker.onChange=async row=>{if(row.status==='decided')c.abort();};const pending=h.broker.request(request({signal:c.signal}));const outcome=pending.then(value=>({value}),error=>({error}));await h.broker.list();const id=(await h.broker.list())[0].id,original=h.broker.save.bind(h.broker);h.broker.save=async()=>{if(h.broker.records.get(id).status==='cancelled')throw new Error('disk unavailable on cancel');return original();};await assert.rejects(h.broker.decide(id,{choice:'allow_once'}),/disk/);const result=await Promise.race([outcome,new Promise(r=>setTimeout(()=>r({timedOut:true}),30))]);assert.ok(result.error,'the cancelled native wait must reject even if durable cancellation fails');
 }finally{await h.close();}
});
