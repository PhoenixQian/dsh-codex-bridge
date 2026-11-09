import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const failure=(code,message)=>Object.assign(new Error(message),{code});
const clean=value=>typeof value==='string'?value.replace(/\bBearer\s+[\w.+/=-]+/gi,'Bearer [redacted]').replace(/\bsk-(?:proj-)?[\w-]{12,}/g,'[redacted]').slice(0,24000):value;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now=()=>new Date().toISOString();

/** A durable decision record, never a substitute for a native permission grant. */
export class ApprovalBroker {
  constructor({directory,onChange}={}){this.path=join(directory,'approval-state.json');this.directory=directory;this.onChange=onChange;this.records=new Map();this.live=new Map();this.queue=Promise.resolve();this.epoch=randomUUID();}
  async init(){
    await mkdir(this.directory,{recursive:true,mode:0o700});
    let rows=[];try{rows=JSON.parse(await readFile(this.path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    for(const row of rows){if(row.status==='pending'){row.status='interrupted';row.reasonAfter='执行连接已中断，旧请求不可批准';}this.records.set(row.id,row);}
    if(rows.length)await this.save();return this;
  }
  atomic(fn){const next=this.queue.then(fn);this.queue=next.catch(()=>{});return next;}
  async save(){const temp=this.path+'.tmp';await writeFile(temp,JSON.stringify([...this.records.values()],null,2)+'\n',{mode:0o600});await rename(temp,this.path);}
  async changed(row){try{await this.onChange?.({...row});}catch{/* Observers cannot turn an unapproved action into an approved one. */}}
  async list({taskId}={}){await this.queue;return [...this.records.values()].filter(r=>!taskId||r.taskId===taskId).sort((a,b)=>b.requestedAt.localeCompare(a.requestedAt)).map(r=>({...r}));}
  request(input){
    if(input.signal?.aborted)return Promise.reject(failure('CANCELLED','批准请求已取消'));
    const {taskId,roundId=1,agent,callId,kind='confirmation',scopeVersion=1}=input;
    if(!taskId||!['Codex','DSH'].includes(agent)||!callId)return Promise.reject(failure('INVALID_APPROVAL','Missing task, Agent or original call identity.'));
    const choices=input.choices??[{id:'allow_once',label:'允许这一次'},{id:'deny',label:'拒绝此动作'},{id:'cancel_agent',label:'停止该Agent'}];
    if(!Array.isArray(choices)||!choices.length||choices.some(c=>!c?.id||!c.label)||new Set(choices.map(c=>c.id)).size!==choices.length)return Promise.reject(failure('INVALID_APPROVAL','Invalid approval choices.'));
    const identity={taskId,roundId,agent,callId};const id=hash(identity).slice(0,32);
    const payload={...identity,kind,action:clean(input.action??'确认后继续'),target:clean(input.target??''),preview:clean(typeof input.preview==='string'?input.preview:JSON.stringify(input.preview??null)),reason:clean(input.reason??''),argsHash:input.argsHash??'',scopeVersion,choices:choices.map(c=>({id:String(c.id),label:clean(c.label)}))};
    const fingerprint=hash(payload),prior=this.records.get(id);
    if(prior){
      if(prior.fingerprint!==fingerprint)return Promise.reject(failure('APPROVAL_CONFLICT','Conflicting approval: original operation changed.'));
      if(this.live.has(id))return this.live.get(id).promise;
      return Promise.reject(failure('APPROVAL_INACTIVE','原批准请求已经失效，不会重放。'));
    }
    let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const state={promise,resolve,reject,signal:input.signal,onWait:input.onWait,waiting:false,settled:false};this.live.set(id,state);
    const row={id,...payload,fingerprint,controllerEpoch:this.epoch,requestedAt:now(),expiresAt:input.expiresAt??null,status:'pending'};this.records.set(id,row);
    const settle=async(result,error)=>{
      if(state.settled)return;state.settled=true;clearTimeout(state.timer);input.signal?.removeEventListener('abort',state.abort);this.live.delete(id);
      if(state.waiting){try{await state.onWait?.(false);}catch(e){error??=e;}}
      if(!error&&state.signal?.aborted)error=failure('CANCELLED','批准请求在送达执行器前已取消');
      if(error)reject(error);else resolve(result);
    };state.settle=settle;
    state.abort=()=>{this.atomic(async()=>{if(row.status!=='pending')return;row.status='cancelled';row.decidedAt=now();await this.save();await this.changed(row);await settle(null,failure('CANCELLED','批准请求已取消'));}).catch(e=>settle(null,e));};
    input.signal?.addEventListener('abort',state.abort,{once:true});
    this.atomic(async()=>{
      try{
        if(input.signal?.aborted){row.status='cancelled';await this.save();return settle(null,failure('CANCELLED','批准请求已取消'));}
        state.waiting=true;await state.onWait?.(true);await this.save();await this.changed(row);
        if(row.expiresAt){const delay=Date.parse(row.expiresAt)-Date.now();if(!Number.isFinite(delay)||delay<=0)throw failure('APPROVAL_EXPIRED','批准请求已过期');state.timer=setTimeout(()=>this.atomic(async()=>{if(row.status!=='pending')return;row.status='expired';row.decidedAt=now();await this.save();await this.changed(row);await settle(null,failure('APPROVAL_EXPIRED','批准请求已过期'));}).catch(e=>settle(null,e)),Math.min(delay,2147483647));state.timer.unref();}
      }catch(e){row.status='error';row.reasonAfter=clean(e.message);await this.save().catch(()=>{});await settle(null,e);}
    }).catch(e=>settle(null,e));
    return promise;
  }
  async decide(id,{choice}={}){
    return this.atomic(async()=>{
      const row=this.records.get(id);if(!row)throw failure('NOT_FOUND','Unknown approval.');
      if(!row.choices.some(c=>c.id===choice))throw failure('INVALID_CHOICE','所选决定不是原请求提供的选项。');
      if(row.status==='decided'){
        if(row.choice!==choice)throw failure('APPROVAL_CONFLICT','Approval already decided differently.');
        return{ok:true,id,choice,status:row.status,duplicate:true};
      }
      const pending=this.live.get(id);
      if(row.status!=='pending'||!pending||pending.signal?.aborted||row.controllerEpoch!==this.epoch)throw failure('APPROVAL_INACTIVE','批准请求失效或连接中断，不可执行。');
      if(row.expiresAt&&Date.parse(row.expiresAt)<=Date.now())throw failure('APPROVAL_EXPIRED','批准请求已过期');
      const previous={...row};row.status='decided';row.choice=choice;row.decidedAt=now();
      try{await this.save();}catch(e){for(const key of Object.keys(row))delete row[key];Object.assign(row,previous);throw e;}
      await this.changed(row);
      if(pending.signal?.aborted){row.status='cancelled';row.reasonAfter='执行连接在决定送达前已取消';try{await this.save();}finally{queueMicrotask(()=>pending.settle(null,failure('CANCELLED','批准请求已取消')));}throw failure('APPROVAL_INACTIVE','执行连接已取消，未发送批准');}
      // Resolve outside the state queue: resume can itself emit persisted state.
      queueMicrotask(()=>pending.settle({id,choice,status:'decided'}));
      return{ok:true,id,choice,status:'decided'};
    });
  }
  async close(){for(const pending of [...this.live.values()])await pending.settle(null,failure('CANCELLED','批准连接已关闭'));await this.queue;}
}
