import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskRuntime} from '../server/execution/runtime.mjs';

test('a failed catalog can recover immediately while successful discovery retains its cache',async()=>{
 let calls=0;const broken={Codex:{models:[{id:'codex'}]},DSH:{models:[],error:'Desktop profile unavailable',errorCode:'DSH_PROFILE_UNAVAILABLE'}};
 const healthy={Codex:{models:[{id:'codex'}]},DSH:{models:[{id:'native-dsh'}]}};
 const runtime=new TaskRuntime({directory:'/tmp/tongzhou-capability-retry-fixture',capabilityLoader:async()=>++calls===1?broken:healthy});
 runtime.store={list:async()=>[]};
 assert.equal((await runtime.capabilities()).DSH.errorCode,'DSH_PROFILE_UNAVAILABLE');
 const recovered=await runtime.capabilities();assert.equal(recovered.DSH.models[0]?.id,'native-dsh');assert.equal(calls,2);
 await runtime.capabilities();assert.equal(calls,2,'healthy metadata should remain cached');
});
test('concurrent recovery requests share one metadata discovery',async()=>{
 let calls=0,finish;const runtime=new TaskRuntime({directory:'/tmp/tongzhou-capability-retry-fixture',capabilityLoader:async()=>{calls++;if(calls===1)return {Codex:{models:[]},DSH:{models:[],error:'temporary'}};return new Promise(resolve=>finish=resolve);}});runtime.store={list:async()=>[]};
 await runtime.capabilities();const first=runtime.capabilities(),second=runtime.capabilities();
 assert.equal(calls,2);assert.equal(typeof finish,'function');finish({Codex:{models:[]},DSH:{models:[{id:'restored'}]}});
 const results=await Promise.all([first,second]);assert.equal(results[0].DSH.models[0].id,'restored');assert.equal(results[1].DSH.models[0].id,'restored');assert.equal(calls,2);
});
