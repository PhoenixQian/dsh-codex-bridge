import {mkdir,readFile,writeFile,appendFile,readdir,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export class TaskStore {
  #locks=new Map();
  constructor(root){this.root=root;}
  async init(){await mkdir(this.root,{recursive:true,mode:0o700});}
  path(id){if(typeof id!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))throw new Error('Invalid task ID.');return join(this.root,id);}
  async lock(id,operation){this.path(id);const prior=this.#locks.get(id)??Promise.resolve();const next=prior.catch(()=>{}).then(operation);this.#locks.set(id,next);try{return await next;}finally{if(this.#locks.get(id)===next)this.#locks.delete(id);}}
  async state(task){const path=join(this.path(task.id),'task.json');await writeFile(path+'.tmp',JSON.stringify(task,null,2)+'\n',{mode:0o600});await rename(path+'.tmp',path);}
  async create(input){const id=randomUUID();const now=new Date().toISOString();const task={...input,id,status:'draft',version:1,createdAt:now,updatedAt:now,lastActivityAt:now,requirementsVersion:1,round:0,rounds:[],userMessages:[],agentStates:{},decisions:[],replyCounts:{Codex:0,DSH:0},archivedAt:null,assignments:[],nativeParticipants:{},progress:'等待执行',artifacts:[],error:null};await mkdir(this.path(id),{recursive:true,mode:0o700});await this.state(task);await this.event(id,{type:'created',message:'任务已保存',source:{kind:'web-user-task',version:1}});return task;}
  async get(id){const task=JSON.parse(await readFile(join(this.path(id),'task.json'),'utf8'));let events=[];try{events=(await readFile(join(this.path(id),'events.jsonl'),'utf8')).split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code!=='ENOENT')throw e;}return {task,events,artifacts:task.artifacts??[],assignments:task.assignments??[]};}
  async update(id,changes){return this.lock(id,async()=>{const{task}=await this.get(id);if(typeof changes==='function')changes=changes(task);const next={...task,...changes,id,version:task.version+1,updatedAt:new Date().toISOString()};await this.state(next);return next;});}
  async event(id,event){return this.lock(id,async()=>{const row={id:randomUUID(),timestamp:new Date().toISOString(),...event};await appendFile(join(this.path(id),'events.jsonl'),JSON.stringify(row)+'\n',{mode:0o600});if(event.type!=='worker'||['ready','error','stopping','waiting','resumed'].includes(event.event?.type)){const{task}=await this.get(id);await this.state({...task,lastActivityAt:row.timestamp});}return row;});}
  async list(){const result=[];for(const entry of await readdir(this.root,{withFileTypes:true})){if(!entry.isDirectory())continue;try{result.push(JSON.parse(await readFile(join(this.path(entry.name),'task.json'),'utf8')));}catch(e){if(e.code!=='ENOENT')throw e;}}return result.sort((a,b)=>(b.lastActivityAt??b.updatedAt).localeCompare(a.lastActivityAt??a.updatedAt)||a.id.localeCompare(b.id));}
}
