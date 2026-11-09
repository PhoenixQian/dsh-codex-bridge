import {mkdir,readFile,writeFile,readdir,lstat,realpath,copyFile,cp,rm,open,unlink,rename,link} from 'node:fs/promises';
import {resolve,join,dirname,basename,extname,isAbsolute,relative} from 'node:path';
import {randomUUID} from 'node:crypto';import{homedir}from'node:os';
import {TaskStore} from './task-store.mjs';
import {TaskFiles,snapshotInputs,checkInputVersions,safeRelative,sensitivePath,within,noLinks,digest} from './files.mjs';
import {CodexTaskWorker,getCodexCapabilities} from './codex-worker.mjs';
import {DshTaskWorker,getDshCapabilities} from './dsh-worker.mjs';
import {getPythonConfig,isCredentialPath} from '../runtime-config.mjs';

const text=(value,max=12000)=>typeof value==='string'?value.trim().slice(0,max):'';
const expand=path=>resolve(path.startsWith('~/')?join(homedir(),path.slice(2)):path);
const activeStatuses=new Set(['planning','running','validating']);
const terminalMessage=error=>String(error?.message??error).replace(/\bsk-[\w-]+/g,'[redacted]').slice(0,1500);
const overlap=(a,b)=>within(a.toLowerCase(),b.toLowerCase())||within(b.toLowerCase(),a.toLowerCase());
const nativeToolTypes=new Set(['commandExecution','fileChange','mcpToolCall','webSearch','imageGeneration','imageView','sleep','collabAgentToolCall']);
function imageFormat(bytes){if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(20)>0)return'image/png';if(bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes.at(-2)===255&&bytes.at(-1)===217)return'image/jpeg';if(bytes.length>=16&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return'image/webp';if(bytes.length>=10&&/^GIF8[79]a$/.test(bytes.toString('ascii',0,6)))return'image/gif';return null;}
const mime=path=>({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.md':'text/markdown','.txt':'text/plain','.json':'application/json'})[extname(path).toLowerCase()]??'application/octet-stream';
async function exists(path){try{return await lstat(path);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function canonicalDestination(path){let current=path,tail=[];while(!await exists(current)){tail.unshift(basename(current));const parent=dirname(current);if(parent===current)break;current=parent;}return join(await realpath(current),...tail);}
function parsePlan(value){let raw=value.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');const start=raw.indexOf('{'),end=raw.lastIndexOf('}');if(start<0||end<start)throw new Error('Agent未返回可执行分工JSON。');return JSON.parse(raw.slice(start,end+1));}
async function filesBelow(root){const result=[];if(!await exists(root))return result;for(const entry of await readdir(root,{withFileTypes:true})){const path=join(root,entry.name);if(entry.isSymbolicLink())throw new Error('Artifact symlink is forbidden.');if(entry.isDirectory())result.push(...await filesBelow(path));else if(entry.isFile()&&!entry.name.includes('.task-'))result.push(path);}return result;}

export class TaskRuntime {
  constructor({directory,workerFactory,capabilityLoader,approvalBroker,discussionHandler,availabilityHandler}={}){this.directory=resolve(directory);this.store=new TaskStore(join(this.directory,'tasks'));this.jobs=new Map();this.workers=new Set();this.leases=new Map();this.workerSlots=0;this.workerQueue=[];this.workerFactory=workerFactory??(options=>options.agent==='Codex'?new CodexTaskWorker(options):new DshTaskWorker(options));this.capabilityLoader=capabilityLoader;this.epoch=randomUUID();this.approvalBroker=approvalBroker;this.discussionHandler=discussionHandler;this.availabilityHandler=availabilityHandler;}
  static async create(options){const runtime=new TaskRuntime(options);await runtime.init();return runtime;}
  async init(){
    await this.store.init();this.directory=await realpath(this.directory);this.store.root=await realpath(this.store.root);this.lockPath=join(this.store.root,'.controller.lock');
    try{this.ownerLock=await open(this.lockPath,'wx',0o600);}catch(error){if(error.code!=='EEXIST')throw error;const prior=JSON.parse(await readFile(this.lockPath,'utf8'));let alive=true;try{process.kill(prior.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}if(alive)throw new Error('Another task controller owns this task store.');await unlink(this.lockPath);this.ownerLock=await open(this.lockPath,'wx',0o600);}
    await this.ownerLock.writeFile(JSON.stringify({pid:process.pid,epoch:this.epoch}));
    for(const task of await this.store.list())if(activeStatuses.has(task.status)){await this.store.update(task.id,{status:'needs_attention',error:'服务中断；保留已有产物，未自动重放模型或提交。',progress:'等待检查后恢复'});await this.store.event(task.id,{type:'interrupted',message:'上次执行中断，自动执行已停止。'});}
  }
  get activeCount(){return this.jobs.size;}
  async capabilities(){
    if(this.capabilitiesValue&&Date.now()-this.capabilitiesAt<300000)return this.decorateCapabilities(this.capabilitiesValue);
    if(this.capabilitiesPending)return this.decorateCapabilities(await this.capabilitiesPending);
    this.capabilitiesPending=(async()=>{
      if(this.capabilityLoader)return this.capabilityLoader();
      const results=await Promise.allSettled([getCodexCapabilities({directory:join(this.directory,'capabilities','codex')}),getDshCapabilities()]);
      const codex=results[0].status==='fulfilled'?results[0].value:{models:[],error:terminalMessage(results[0].reason)};
      const dsh=results[1].status==='fulfilled'?results[1].value:{models:[],error:terminalMessage(results[1].reason)};
      return {Codex:{...codex,models:(codex.models??[]).filter(m=>!m.hidden).map(m=>({...m,id:m.id??m.model,displayName:m.displayName??m.name??m.model??m.id,default:m.isDefault??m.default??false})),imageGeneration:codex.imageGeneration??codex.providerCapabilities?.imageGeneration??false,webSearch:codex.webSearch??codex.providerCapabilities?.webSearch??false},DSH:dsh};
    })();
    try{this.capabilitiesValue=await this.capabilitiesPending;this.capabilitiesAt=Date.now();return this.decorateCapabilities(this.capabilitiesValue);}finally{this.capabilitiesPending=null;}
  }
  async decorateCapabilities(value){const tasks=await this.store.list();const verified=new Set();for(const task of tasks)for(const agent of ['Codex','DSH'])if(task.nativePlanningParticipants?.[agent]||task.nativeParticipants?.[agent])verified.add(agent+':'+task.models[agent]);return Object.fromEntries(['Codex','DSH'].map(agent=>{const capability=value[agent]??{};const preferred=null;return[agent,{...capability,models:(capability.models??[]).map(model=>({...model,nativeDefault:model.isDefault??model.default??false,default:preferred?model.id===preferred:model.default??model.isDefault??false,verified:verified.has(agent+':'+model.id)}))}];}));}
  async createTask(input){
    const title=text(input.title,120),goal=text(input.goal);if(!title||!goal)throw new Error('请填写任务名称与目标。');
    const inputs=(input.inputs??[]);if(!Array.isArray(inputs)||inputs.length>20||inputs.some(p=>typeof p!=='string'||!p.trim()))throw new Error('Invalid input paths.');
    const paths=inputs.map(expand);if(paths.some(path=>sensitivePath(path)||isCredentialPath(path)))throw new Error('Credential inputs are outside task scope.');
    for(const path of paths){const canonical=await realpath(path);if(sensitivePath(canonical)||isCredentialPath(canonical))throw new Error('Input resolves outside the permitted task scope.');}
    const output=input.outputDirectory?expand(input.outputDirectory):null;
    if(output&&(sensitivePath(output)||isCredentialPath(output)||output==='/'))throw new Error('Output directory is outside the task scope.');
    const capabilities=await this.capabilities();const models={};
    for(const agent of ['Codex','DSH']){const list=capabilities[agent]?.models??[];const selected=input.models?.[agent]||list.find(m=>m.default||m.isDefault)?.id;if(!selected||!list.some(m=>(m.id??m.model)===selected))throw new Error(agent+'模型不在当前原生目录中。');const selectedModel=list.find(m=>(m.id??m.model)===selected);if(selectedModel.taskExecution===false||selectedModel.availability==='host-only')throw new Error(agent+' 模型仅可用于 Host 讨论，不可用于独立任务。');models[agent]=selected;}
    if(input.imageGeneration&&!capabilities.Codex.imageGeneration)throw new Error('当前原生Codex未声明生图能力。');
    if(input.connectedApps&&!input.networkAccess)throw new Error('使用已连接应用须同时允许联网。');
    const timeoutSeconds=input.budget?.timeoutSeconds??300,maxToolCalls=input.budget?.maxToolCalls??20;
    if(!Number.isInteger(timeoutSeconds)||timeoutSeconds<30||timeoutSeconds>1800||!Number.isInteger(maxToolCalls)||maxToolCalls<2||maxToolCalls>100)throw new Error('预算范围：30—1800秒，2—100次工具调用。');
    const leadAgent=input.leadAgent??'Codex';if(!['Codex','DSH'].includes(leadAgent))throw new Error('Invalid lead Agent.');
    const efforts={};for(const agent of ['Codex','DSH']){const model=capabilities[agent].models.find(m=>(m.id??m.model)===models[agent]);const rawSupported=model.supportedReasoningEfforts??model.reasoningEfforts??model.supportedReasoningLevels??[];const supported=Array.isArray(rawSupported)?rawSupported:Object.keys(rawSupported);const values=supported.map(v=>typeof v==='string'?v:v.reasoningEffort??v.effort??v.value??v.id);if(input.efforts?.[agent]&&input.efforts[agent]!=='default'&&!values.includes(input.efforts[agent])&&input.efforts[agent]!==model.defaultReasoningEffort)throw new Error(agent+'思考程度未由原生模型声明 (reasoning)。');efforts[agent]=input.efforts?.[agent]??model.defaultReasoningEffort??values[0]??'default';}
    const replyLimit=input.replyLimit??200,discussionLimit=input.discussionLimit??100,discussionTimeoutSeconds=input.discussionTimeoutSeconds??1800;for(const n of [replyLimit,discussionLimit,discussionTimeoutSeconds])if(!Number.isSafeInteger(n)||n<1||n>100000)throw new Error('Invalid reply/discussion limit.');
    const inputMode=input.inputMode??(paths.length?'materials':'draft');if(!['materials','draft'].includes(inputMode))throw new Error('Invalid input mode.');
    const task=await this.store.create({title,goal,leadAgent,supportAgents:['Codex','DSH'].filter(a=>a!==leadAgent),efforts,replyLimit,discussionLimit,discussionTimeoutSeconds,inputMode,acceptance:text(input.acceptance,4000),inputs:paths,outputDirectory:output,models,budget:{timeoutSeconds,maxToolCalls},networkAccess:input.networkAccess===true,imageGeneration:input.imageGeneration===true,connectedApps:input.connectedApps===true,allowOverwrite:input.allowOverwrite===true,allowOfficeEdit:input.allowOfficeEdit===true,authorization:{kind:'web-user-task',scopeVersion:1,readRoots:paths,writeRoot:output,writeTypes:input.allowOverwrite?['create','replace']:['create'],network:input.networkAccess===true}});
    if(!task.outputDirectory){task.outputDirectory=join(this.store.path(task.id),'published');task.authorization.writeRoot=task.outputDirectory;await this.store.update(task.id,{outputDirectory:task.outputDirectory,authorization:task.authorization});}
    if(input.autoStart!==false)await this.start(task.id);return (await this.store.get(task.id)).task;
  }
  async get(id){const detail=await this.store.get(id);return {...detail,approvals:this.approvalBroker?await this.approvalBroker.list({taskId:id}):[]};}
  async list(){return this.store.list();}
  async event(id,event){return this.store.event(id,event);}
  async start(id){
    if(this.jobs.has(id))throw new Error('任务正在执行。');
    const controller=new AbortController(),record={controller,workers:new Set(),promise:Promise.resolve(),toolKeys:new Set(),agents:new Map(),toolResults:new Map()};this.jobs.set(id,record);
    try{const{task}=await this.get(id);if(task.archivedAt)throw new Error('任务已归档 (archived)，请先恢复。');
      await this.store.update(id,{status:'planning',progress:'准备协商分工'});
      const promise=Promise.resolve().then(()=>this.executeRounds(id,record)).catch(async error=>{
        const cancelled=controller.signal.aborted;const current=await this.get(id);let artifacts=current.task.artifacts??[];
        try{const partial=await this.collectArtifacts(id,join(this.store.path(id),'attempt-'+current.task.attempt),current.task.assignments??[]);const combined=new Map(partial.map(a=>[a.round+'/'+a.agent+'/'+a.name,a]));for(const a of artifacts)combined.set(a.round+'/'+a.agent+'/'+a.name,a);artifacts=[...combined.values()];}catch{}
        const attention=error.code==='OUTPUT_CONFLICT';await this.store.update(id,{status:cancelled?'cancelled':attention?'needs_attention':'error',artifacts,error:terminalMessage(controller.signal.reason??error),progress:cancelled?'已停止，保留部分产物':attention?'发布冲突，等待处理':'执行失败'});await this.event(id,{type:cancelled?'cancelled':'error',message:terminalMessage(controller.signal.reason??error)});
      }).finally(async()=>{if(this.jobs.get(id)!==record)return;this.jobs.delete(id);if(record.controller.signal.aborted)return;const {task}=await this.get(id);if(!this.jobs.has(id)&&!task.archivedAt&&['completed','partial','needs_attention'].includes(task.status)&&task.userMessages?.some(m=>m.status==='queued'))await this.start(id);});record.promise=promise;return {accepted:true};
    }catch(error){if(this.jobs.get(id)===record)this.jobs.delete(id);throw error;}
  }
  async wait(id){while(this.jobs.has(id))await this.jobs.get(id).promise;return this.get(id);}
  async cancel(id){const job=this.jobs.get(id);if(!job){await this.store.update(id,{status:'cancelled',progress:'已取消'});return{ok:true};}job.controller.abort();await Promise.allSettled([...job.workers].map(w=>w.cancel()));await this.event(id,{type:'cancel-requested',message:'已停止派发并请求终止运行中步骤。'});return{ok:true};}
  assertActive(job){if(job.controller.signal.aborted)throw new Error('Task cancelled.');}
  async acquireWorker(job){
    this.assertActive(job);if(this.workerSlots>=2)await new Promise((resolveSlot,reject)=>{const entry={resolve:()=>{job.controller.signal.removeEventListener('abort',abort);resolveSlot();}};const abort=()=>{const i=this.workerQueue.indexOf(entry);if(i>=0)this.workerQueue.splice(i,1);reject(job.controller.signal.reason??new Error('Task cancelled.'));};job.controller.signal.addEventListener('abort',abort,{once:true});this.workerQueue.push(entry);});else this.workerSlots++;
    let released=false;return()=>{if(released)return;released=true;const next=this.workerQueue.shift();if(next)next.resolve();else this.workerSlots--;};
  }
  admitTool(task,job,agent,phase,key){
    const id=agent+':'+phase+':'+key;if(job.toolKeys.has(id)){this.assertActive(job);return;}job.toolKeys.add(id);
    if(job.toolKeys.size>task.budget.maxToolCalls){job.controller.abort(new Error('全任务工具预算已用尽，已停止双方后续调用。'));for(const worker of job.workers)worker.cancel().catch(()=>{});throw job.controller.signal.reason;}
    this.store.update(task.id,{totalToolCalls:job.toolKeys.size}).catch(()=>{});this.assertActive(job);
  }
  async worker(task,job,agent,phase,cwd,tools=[],assignment){
    await mkdir(cwd,{recursive:true,mode:0o700});cwd=await realpath(cwd);let events=Promise.resolve();
    const controlled=tools.map(tool=>({...tool,execute:(args,context={})=>{this.admitTool(task,job,agent,phase,context.callId??randomUUID());this.assertActive(this.memberJob(job,agent));return tool.execute(args,context);}}));
    const member=this.memberJob(job,agent);
    const options={agent,phase,assignment,onWait:(...args)=>member.onWait?.(...args),onApproval:async request=>{if(!this.approvalBroker)throw new Error('Approval broker unavailable.');const result=await this.approvalBroker.request({...request,taskId:task.id,roundId:task.round,agent,scopeVersion:task.authorization.scopeVersion,signal:request.signal?AbortSignal.any([member.controller.signal,request.signal]):member.controller.signal});if(result.choice==='cancel_agent')await this.cancelAgent(task.id,agent);return result;},directory:join(dirname(cwd),'native'),cwd,model:task.models[agent],effort:task.efforts?.[agent]??'default',tools:controlled,timeoutMs:task.budget.timeoutSeconds*1000,maxToolCalls:task.budget.maxToolCalls,capabilities:agent==='Codex'?{network:task.networkAccess,imageGeneration:task.imageGeneration,connectedApps:task.connectedApps}:{},onEvent:event=>{const item=event.params?.item;if(agent==='Codex'&&event.type==='native'&&['item/started','item/completed'].includes(event.method)&&nativeToolTypes.has(item?.type)){try{this.admitTool(task,job,agent,phase,item.id);}catch{}}events=events.catch(()=>{}).then(()=>this.event(task.id,{type:'worker',agent,phase,event}));}};
    const scopeFingerprint=digest(JSON.stringify({cwd,model:options.model,effort:options.effort,capabilities:options.capabilities,scopeVersion:task.authorization.scopeVersion,tools:controlled.map(({name,inputSchema})=>({name,inputSchema}))}));
    const current=(await this.get(task.id)).task,prior=current.memberSessions?.[agent];
    if(prior?.scopeFingerprint===scopeFingerprint)options.directory=prior.directory;
    else{
      const previousThreadId=prior?.threadId??current.nativeParticipants?.[agent];
      options.directory=join(dirname(cwd),'native-'+scopeFingerprint.slice(0,16));
      const branches=[...(prior?.branches??[]),...(previousThreadId?[{threadId:previousThreadId,directory:prior?.directory??null,scopeFingerprint:prior?.scopeFingerprint??null,endedAt:new Date().toISOString()}]:[])];
      await this.store.update(task.id,t=>({memberSessions:{...t.memberSessions,[agent]:{directory:options.directory,cwd,scopeFingerprint,branches}}}));
      if(previousThreadId)await this.event(task.id,{type:'native-branch',agent,previousThreadId,previousDirectory:prior?.directory??null,directory:options.directory,reason:prior?'Model, reasoning, tools or approved scope changed.':'Legacy task has no compatible persistent member scope.',round:task.round});
    }
    const worker=this.workerFactory(options);this.workers.add(worker);job.workers.add(worker);member.workers.add(worker);
    return{worker,async finish(){await events;await worker.close();},options};
  }
  async memberState(id,agent,state){await this.store.update(id,t=>({agentStates:{...t.agentStates,[agent]:{...t.agentStates?.[agent],...state,updatedAt:new Date().toISOString()}}}));}
  memberJob(job,agent){if(!job.agents.has(agent)){const controller=new AbortController();const abort=()=>controller.abort(job.controller.signal.reason);job.controller.signal.addEventListener('abort',abort,{once:true});if(job.controller.signal.aborted)abort();job.agents.set(agent,{controller,workers:new Set(),parent:job,detach:()=>job.controller.signal.removeEventListener('abort',abort)});}return job.agents.get(agent);}
  async memberPromptContext(task,agent,cwd){
    const current=(await this.get(task.id)).task,session=current.memberSessions?.[agent]??{};
    const historyRoot=join(cwd,'inputs','history');await noLinks(historyRoot);await mkdir(join(historyRoot,'messages'),{recursive:true,mode:0o700});
    const audit={taskId:task.id,round:task.round,goal:current.goal,userMessages:current.userMessages??[],decisions:current.decisions??[],rounds:current.rounds??[]};
    await noLinks(join(historyRoot,'task-history.json'));await writeFile(join(historyRoot,'task-history.json'),JSON.stringify(audit,null,2)+'\n',{mode:0o600});
    for(const message of audit.userMessages){const path=join(historyRoot,'messages',safeRelative(message.id)+'.json');await noLinks(path);await writeFile(path,JSON.stringify(message,null,2)+'\n',{mode:0o600});}
    const seen=session.contextRound===task.round?session.contextMessageIds??[]:[];
    const messages=audit.userMessages.filter(m=>m.round===task.round&&m.status==='delivered'&&!seen.includes(m.id)).slice(0,32);
    let remaining=12000;const instructions=messages.map(m=>{const excerpt=m.text.slice(0,remaining);remaining-=excerpt.length;return{id:m.id,clientMessageId:m.clientMessageId,round:m.round,source:m.source,text:excerpt,truncated:excerpt.length<m.text.length,sourcePath:'inputs/history/messages/'+m.id+'.json'};});
    const latest=audit.decisions.filter(d=>d.round<task.round).at(-1);const brief=latest&&latest.round!==session.contextBriefRound?{round:latest.round,agent:latest.agent,messageId:latest.messageId,decision:latest.decision,brief:String(latest.brief??'').slice(0,4000)}:null;
    return{text:'\n本次增量共享上下文（仅本轮尚未送达本成员的用户指令；不代表已读取全部历史）：'+JSON.stringify({taskId:task.id,round:task.round,instructions,latestBrief:brief,historySource:'inputs/history/task-history.json',historyAccess:'可用task_read按需查阅原文；每条用户原文另存inputs/history/messages/<id>.json。原生成员续用已有上下文；新分支依据最近简报和来源按需读取。历史产物在inputs/history/<round>/<agent>/。queued消息尚未采用，不扩大本轮执行要求。'}) ,cursor:{contextRound:task.round,contextMessageIds:[...seen,...messages.map(m=>m.id)],...(latest?{contextBriefRound:latest.round}:{})}};
  }
  async runWorker(task,job,agent,phase,cwd,prompt,tools=[],assignment){
    const member=this.memberJob(job,agent);this.assertActive(member);
    if(!tools.some(t=>t.name==='task_read')){const fs=new TaskFiles({workspace:cwd,allowedOutputs:[],pythonPrefix:getPythonConfig({agent}).prefix,network:task.networkAccess,signal:member.controller.signal});await fs.init();tools=[...fs.tools(),...tools];}
    const current=(await this.get(task.id)).task;if((current.replyCounts?.[agent]??0)>=(task.replyLimit??200))throw new Error(agent+'回复额度已用尽，请用户调整后继续。');
    let release=await this.acquireWorker(member),owned,waiting=0;
    member.remainingMs??=task.budget.timeoutSeconds*1000;let activeAt,timer;
    const pauseTimer=()=>{if(activeAt!==undefined){member.remainingMs=Math.max(0,member.remainingMs-(performance.now()-activeAt));activeAt=undefined;}clearTimeout(timer);};
    const resumeTimer=()=>{this.assertActive(member);activeAt=performance.now();timer=setTimeout(()=>{member.controller.abort(new Error(agent+'主动执行时限已到；同伴独立工作继续。'));for(const worker of member.workers)worker.cancel().catch(()=>{});},Math.max(1,member.remainingMs));};
    const onWait=async(value,reason='approval')=>{if(value){if(waiting++===0){pauseTimer();release?.();release=null;await this.memberState(task.id,agent,{status:reason==='discussion'?'waiting_discussion':'waiting_approval',reason,phase});}}else if(waiting>0&&--waiting===0){release=await this.acquireWorker(member);resumeTimer();await this.memberState(task.id,agent,{status:'running',phase,reason:null});}};
    member.onWait=onWait;
    try{
      resumeTimer();await this.memberState(task.id,agent,{status:'running',phase});
      owned=await this.worker(task,job,agent,phase,cwd,tools,assignment);
      // Both native implementations await this callback when resuming inference.
      owned.worker.onWait=onWait;
      const shared=await this.memberPromptContext(task,agent,cwd);prompt+=shared.text;
      const messageId=`${task.id}-${task.attempt}-${phase}-${agent}-${randomUUID()}`;
      const result=await owned.worker.run({messageId,authorId:'codex-dsh-bridge:task-coordinator',text:prompt,signal:member.controller.signal});this.assertActive(member);
      await this.event(task.id,{type:'agent-message',agent,phase,round:task.round,messageId,message:result.text,threadId:result.threadId,usage:result.usage,toolCalls:result.toolCalls});
      await this.store.update(task.id,t=>({replyCounts:{...t.replyCounts,[agent]:(t.replyCounts?.[agent]??0)+1},nativeParticipants:{...t.nativeParticipants,[agent]:result.threadId},memberSessions:{...t.memberSessions,[agent]:{...t.memberSessions?.[agent],threadId:result.threadId,...shared.cursor}},usage:{...t.usage,[task.attempt+'-'+phase+'-'+agent]:result.usage??null},actualModels:{...t.actualModels,[agent]:result.provenance?.model??task.models[agent]}}));
      await this.memberState(task.id,agent,{status:'idle',phase,threadId:result.threadId});return{...result,messageId};
    }catch(error){await this.memberState(task.id,agent,{status:member.controller.signal.aborted?'cancelled':'error',error:terminalMessage(error)});throw error;}
    finally{try{if(owned){await owned.finish();this.workers.delete(owned.worker);job.workers.delete(owned.worker);member.workers.delete(owned.worker);}}finally{pauseTimer();release?.();member.onWait=null;}}
  }
  async appendMessage(id,{clientMessageId,text:message,expectedRequirementsVersion,autoStart=true}={}){
    if(typeof clientMessageId!=='string'||!clientMessageId.trim()||clientMessageId.length>200||typeof message!=='string'||!message.trim())throw new Error('A message and stable clientMessageId are required.');
    if(Buffer.byteLength(message,'utf8')>50000)throw new Error('Message exceeds 50000-byte size limit; original was not saved or truncated.');
    let duplicate=false,row;
    await this.store.update(id,t=>{const prior=t.userMessages?.find(m=>m.clientMessageId===clientMessageId);if(prior){if(prior.text!==message)throw new Error('Message ID already has different content.');duplicate=true;row=prior;return{};}if(t.archivedAt)throw new Error('Archived task must be restored.');if(expectedRequirementsVersion!==undefined&&expectedRequirementsVersion!==(t.requirementsVersion??1))throw new Error('Requirements version conflict.');row={id:randomUUID(),clientMessageId,text:message,timestamp:new Date().toISOString(),status:'queued',source:{kind:'web-user-task',clientMessageId}};return{userMessages:[...(t.userMessages??[]),row],requirementsVersion:(t.requirementsVersion??1)+1,lastActivityAt:row.timestamp};});
    if(!duplicate){await this.event(id,{type:'user-message',messageId:row.id,clientMessageId,text:row.text,message:row.text,source:row.source});if(autoStart&&!this.jobs.has(id))await this.start(id);}
    return{accepted:true,duplicate,message:row,task:(await this.get(id)).task};
  }
  async updateSettings(id,input={}){if(!input||Array.isArray(input)||Object.keys(input).some(k=>k!=='replyLimit'))throw new Error('Unsupported task settings.');const n=input.replyLimit;if(!Number.isSafeInteger(n)||n<1||n>100000)throw new Error('replyLimit must be between 1 and 100000.');return this.store.update(id,t=>{if(n<Math.max(0,...Object.values(t.replyCounts??{})))throw new Error('replyLimit cannot be below replies already used (已用额度).');return{replyLimit:n};});}
  async archive(id,{stop=false}={}){if(this.jobs.has(id)){if(!stop)throw new Error('运行中任务须停止并归档。');await this.cancel(id);await this.wait(id);}await this.store.update(id,{archivedAt:new Date().toISOString()});await this.event(id,{type:'archived',message:'任务已归档，历史与产物保留。'});return{ok:true};}
  async unarchive(id){await this.store.update(id,{archivedAt:null});await this.event(id,{type:'unarchived',message:'任务已恢复，未启动模型。'});return{ok:true};}
  async cancelAgent(id,agent){if(!['Codex','DSH'].includes(agent))throw new Error('Invalid Agent.');const job=this.jobs.get(id);if(job){const member=this.memberJob(job,agent);member.controller.abort(new Error('用户停止了该Agent。'));await Promise.allSettled([...member.workers].map(w=>w.cancel()));}await this.memberState(id,agent,{status:'cancelled'});await this.event(id,{type:'agent-cancelled',agent,message:'已停止该Agent，独立同伴继续。'});return{ok:true};}
  async checkMemberAvailability(taskId,agent){const{task}=await this.get(taskId);const state=task.agentStates?.[agent];const busy=!!this.jobs.get(taskId)?.agents.get(agent)?.workers.size;return{online:!!task.nativeParticipants?.[agent],canRespond:false,reason:busy?'Member is busy':'Task native session has write tools; requires admitted read-only channel',status:busy?state?.status??'busy':state?.status??'offline',threadId:task.nativeParticipants?.[agent],capabilities:{readOnlyDiscussion:true}};}
  async runPeerDiscussion(){return{status:'unavailable',reason:'Task member native scopes include write tools; use a separately admitted read-only channel.'};}
  async executeRounds(id,job){
    do{await this.execute(id,job);if(job.controller.signal.aborted)break;const{task}=await this.get(id);if(['needs_attention','error','cancelled'].includes(task.status))break;if(!task.userMessages?.some(m=>m.status==='queued')&&!job.continuePlan)break;}while(true);
  }
  controlledTools(task,job,agent){
    const invoke=(name,fn)=>({name,description:name==='task_discuss'?'向另一成员发起只读关联讨论；失败会明确返回。':'请求用户对具体设计或动作作出确认；确认本身不执行动作。',inputSchema:{type:'object',properties:name==='task_discuss'?{targetAgent:{type:'string',enum:['Codex','DSH']},title:{type:'string'},question:{type:'string'},timeoutSeconds:{type:'integer'}}:{reason:{type:'string'},action:{type:'string'},target:{type:'string'},preview:{type:'string'}},required:name==='task_discuss'?['targetAgent','question']:['reason','action'],additionalProperties:false},execute:(args,context={})=>{const callId=context.callId??randomUUID(),key=task.round+':'+agent+':'+callId;if(job.toolResults.has(key))return job.toolResults.get(key);const member=this.memberJob(job,agent);const wait=async(reason,operation)=>context.wait?context.wait(reason,operation):(async()=>{await member.onWait?.(true,reason);try{return await operation();}finally{await member.onWait?.(false,reason);}})();const promise=Promise.resolve().then(()=>fn(args,{...context,callId,signal:context.signal?AbortSignal.any([member.controller.signal,context.signal]):member.controller.signal,wait}));job.toolResults.set(key,promise);return promise;}});
    return[invoke('task_request_approval',async(a,c)=>{if(!this.approvalBroker)return{status:'unavailable',reason:'Approval broker unavailable; no action approved.'};return c.wait('approval',()=>this.approvalBroker.request({taskId:task.id,roundId:task.round,agent,callId:c.callId,kind:'confirmation',reason:text(a.reason),action:text(a.action),target:text(a.target),preview:text(a.preview),argsHash:digest(JSON.stringify(a)),scopeVersion:task.authorization.scopeVersion,choices:[{id:'allow_once',label:'一次确认'},{id:'deny',label:'拒绝'},{id:'cancel_agent',label:'停止该Agent'}],signal:c.signal})).then(async result=>{if(result.choice==='cancel_agent')await this.cancelAgent(task.id,agent);return result;});}),invoke('task_discuss',async(a,c)=>{if(!this.discussionHandler)return{status:'unavailable',reason:'Read-only discussion channel unavailable.'};if(a.targetAgent===agent)return{status:'unavailable',reason:'Cannot discuss with self.'};try{return await c.wait('discussion',()=>this.discussionHandler({taskId:task.id,roundId:task.round,agent,sourceThreadId:c.threadId,targetAgent:a.targetAgent,title:text(a.title,120),question:text(a.question),timeoutSeconds:a.timeoutSeconds??task.discussionTimeoutSeconds,callId:c.callId},{signal:c.signal,onWait:()=>{}}));}catch(error){return{status:c.signal.aborted?'cancelled':'failed',reason:terminalMessage(error)};}})];
  }
  async execute(id,job){
    this.assertActive(job);
    let{task}=await this.get(id);const attempt=(task.attempt??0)+1,attemptRoot=join(this.store.path(id),'attempt-'+attempt);await mkdir(attemptRoot,{recursive:true,mode:0o700});
    const round=(task.round??0)+1;const queued=(task.userMessages??[]).filter(m=>m.status==='queued');
    task=await this.store.update(id,t=>({attempt,round,status:'planning',error:null,progress:'主Agent制定安排',nativeImages:[],validation:null,summary:null,totalToolCalls:0,assignments:[],agentStates:{},userMessages:(t.userMessages??[]).map(m=>queued.some(q=>q.id===m.id)?{...m,status:'delivered',round}:m),rounds:[...(t.rounds??[]),{round,attempt,startedAt:new Date().toISOString(),messageIds:queued.map(m=>m.id)}]}));
    job.toolKeys.clear();for(const member of job.agents.values())member.detach?.();job.agents.clear();
    const target=await canonicalDestination(task.outputDirectory);if(sensitivePath(within(this.store.path(task.id),target)?relative(this.store.path(task.id),target):target)||(!within(this.store.path(task.id),target)&&isCredentialPath(target)))throw new Error('Output scope changed to a protected path.');
    for(const[owner,path]of this.leases)if(owner!==id&&overlap(path,target))throw new Error('交付目录被另一任务占用，请稍后恢复。');
    this.leases.set(id,target);
    // Active-time deadlines are owned by each worker; user/discussion waits pause them.
    try{
      const manifest=await snapshotInputs(task.inputs,join(attemptRoot,'inputs'));await this.store.update(id,{inputManifest:manifest,outputDirectory:target});
      const rules=await import('./cooperation-rules.mjs');
      const outline=`用户任务：${task.goal}\n验收：${task.acceptance||'真实产物存在，双方分别自验并说明缺口'}\n输入快照：${JSON.stringify(manifest.files.map(f=>({path:f.path,size:f.size})))}\n生图：${task.imageGeneration}。当前两侧模型：${JSON.stringify(task.models)}。请协商具体分工，Codex负责适合GPT的主产物/生图/代码，DSH负责独立补充、核验或其擅长文本，避免重复做整份工作。只返回JSON：{"assignments":[{"agent":"Codex","goal":"具体工作","outputs":["Codex-result.md","codex/"]},{"agent":"DSH","goal":"独立工作","outputs":["DSH-review.md","dsh/"],"dependsOn":[]}]}。输出路径相对最终交付目录，不得重叠或用SUMMARY.md。依赖需先完成，不得成环。图片必须由Codex产出images/，DSH可以依赖Codex形成说明与核验，不能声称看过未提供的图。规划时不调用工具。`;
      const memberRoot=agent=>join(this.store.path(id),'members',agent,'workspace');
      const priorArtifacts=task.artifacts??[];
      for(const agent of ['Codex','DSH']){const cwd=memberRoot(agent);await mkdir(cwd,{recursive:true});await rm(join(cwd,'output'),{recursive:true,force:true});await rm(join(cwd,'inputs'),{recursive:true,force:true});await cp(join(attemptRoot,'inputs'),join(cwd,'inputs'),{recursive:true});if(priorArtifacts.length){await mkdir(join(cwd,'inputs','history'),{recursive:true});for(const artifact of priorArtifacts){await noLinks(artifact.path);const destination=join(cwd,'inputs','history',String(artifact.round??1),artifact.agent,safeRelative(artifact.name));await mkdir(dirname(destination),{recursive:true});await copyFile(artifact.path,destination);}}}
      const lead=task.leadAgent??'Codex';
      const history=`\n本轮 ${task.round}，主Agent ${lead}。主Agent真实决定所需成员，不必每次唤醒双方。仅需一名成员时 assignments 可以只含该成员。`;
      let rawPlan=job.continuePlan;job.continuePlan=null;let first;
      if(!rawPlan){first=await this.runWorker(task,job,lead,'planning',memberRoot(lead),outline+history+'\n你是主Agent。只返回 JSON {"assignments":[...]}；若无需文件工作可返回 {"decision":"finish"或"needs_user","brief":"依据与缺口"}。',this.controlledTools(task,job,lead));rawPlan=parsePlan(first.text);}
      if(rawPlan.decision==='finish'||rawPlan.decision==='needs_user'){if(!text(rawPlan.brief))throw new Error('主Agent结束判断缺少简报。');await this.store.update(id,t=>({status:rawPlan.decision==='finish'?'completed':'needs_attention',summary:rawPlan.brief,decisions:[...(t.decisions??[]),{agent:lead,round:task.round,messageId:first?.messageId,...rawPlan}],rounds:t.rounds.map(r=>r.round===task.round?{...r,status:rawPlan.decision,endedAt:new Date().toISOString()}:r)}));return;}
      const selected=rawPlan.assignments?.map(a=>a.agent);if(!Array.isArray(selected)||!selected.length)throw new Error('主Agent未给出可执行安排。');
      const validatePlan=value=>{const selected=value.assignments.map(a=>a.agent);const filled={...value,assignments:[...value.assignments,...['Codex','DSH'].filter(a=>!selected.includes(a)).map(agent=>({agent,goal:'not requested',outputs:['unused-'+agent+'.md']}))]};const normalized=rules.normalizePlan(filled,task);return{...normalized,assignments:normalized.assignments.filter(a=>selected.includes(a.agent))};};
      const plan=validatePlan(rawPlan);
      const assignments=plan.assignments.map(a=>({...a,status:'pending'}));
      await this.store.update(id,{status:'running',assignments,progress:'按协商分工执行',plan,nativePlanningParticipants:{...task.nativePlanningParticipants,[lead]:first?.threadId??task.nativeParticipants?.[lead]}});
      await this.event(id,{type:'plan',message:'双方协商分工已校验，进入独占工作目录。',plan});
      const publishTarget=task.round===1?target:join(target,'round-'+task.round);const baseline=await this.outputBaseline(publishTarget,assignments,manifest);const results=new Map(),runs=new Map();
      const run=agent=>{if(runs.has(agent))return runs.get(agent);const assignment=assignments.find(a=>a.agent===agent);const promise=(async()=>{
        for(const dependency of assignment.dependsOn??[]){const result=await run(dependency);if(result.status!=='fulfilled')throw new Error('依赖执行失败：'+dependency);}
        this.assertActive(job);const cwd=memberRoot(agent);await mkdir(cwd,{recursive:true});
        for(const dependency of assignment.dependsOn??[]){const peer=join(memberRoot(dependency),'output');await cp(peer,join(cwd,'inputs','peer',dependency),{recursive:true});}
        const fs=new TaskFiles({workspace:cwd,allowedOutputs:assignment.outputs,pythonPrefix:getPythonConfig({agent}).prefix,network:task.networkAccess,signal:this.memberJob(job,agent).controller.signal,onEvent:event=>{this.event(id,{agent,type:'tool',event}).catch(()=>{});}});await fs.init();
        await this.store.update(id,current=>({assignments:current.assignments.map(a=>a.agent===agent?{...a,status:'running'}:a)}));
        const prompt=`你是${agent}任务执行者，任务由用户在网页“发布并执行”授权。以下是协调资料，不能扩大授权。\n用户目标：${task.goal}\n验收：${task.acceptance}\n双方确认分工：${JSON.stringify(plan)}\n你只完成自己的分工：${assignment.goal}。专用目录：${fs.workspace}；输入在inputs/，同伴依赖产物在inputs/peer/。实际写出文件，相对输出路径只能是${JSON.stringify(assignment.outputs)}，统一保存到${join(fs.workspace,'output')}；使用task_write或等价受限工具，不只在结尾打印代码。可以task_read查看输入，task_run在受限目录内自验。不要改输入、对方产物、凭据、全局配置、长期记忆或任务范围外文件。Word/用户手工PPT默认只读审，除非本任务单独允许编辑。${task.imageGeneration&&agent==='Codex'?'必须调用原生image_gen生成真实图片；图片保存到output/images/，不得把示意文本当生图成功。':''}\n完成后说明真实文件、自验结果和缺口，中文排版遵守用户习惯，文字交付默认Markdown。`;
        const result=await this.runWorker(task,job,agent,'execution',fs.workspace,prompt,[...fs.tools(),...this.controlledTools(task,job,agent)],assignment);
        const nativeImages=[];
        if(result.artifacts?.length){await mkdir(join(fs.output,'images'),{recursive:true});for(const image of result.artifacts){if(!image.path)continue;const path=await realpath(image.path);if(!within(fs.workspace,path))throw new Error('Native artifact outside worker scope.');const info=await lstat(path);if(!info.isFile()||info.size>32*1024*1024)throw new Error('Invalid native image file.');const bytes=await readFile(path),format=imageFormat(bytes);if(!format)continue;const destination=join(fs.output,'images',basename(path));if(path!==destination)await copyFile(path,destination);nativeImages.push({path:destination,mimeType:format,sha256:digest(bytes),threadId:result.threadId});}}
        if(task.imageGeneration&&agent==='Codex'){if(!nativeImages.length)throw new Error('原生生图未返回可校验图片；文本说明或未下载URL不能算生图完成。');await this.store.update(id,{nativeImages});}
        this.assertActive(job);
        const files=await this.collectArtifacts(id,attemptRoot,[assignment]);const missing=assignment.outputs.filter(path=>!files.some(file=>path.endsWith('/')?file.name.startsWith(path):file.name===path));
        if(missing.length)throw new Error(agent+'声明完成但缺少计划产物：'+missing.join('、'));
        results.set(agent,result);await this.store.update(id,current=>({nativeParticipants:{...current.nativeParticipants,[agent]:result.threadId},assignments:current.assignments.map(a=>a.agent===agent?{...a,status:'completed',threadId:result.threadId,toolCalls:result.toolCalls,usage:result.usage}:a)}));return result;
      })().then(value=>({status:'fulfilled',value}),async reason=>{await this.store.update(id,current=>({assignments:current.assignments.map(a=>a.agent===agent?{...a,status:'error',error:terminalMessage(reason)}:a)}));await this.event(id,{type:'worker-error',agent,message:terminalMessage(reason)});return{status:'rejected',reason};});runs.set(agent,promise);return promise;};
      const settled=await Promise.all(assignments.map(a=>run(a.agent)));this.assertActive(job);
      await this.store.update(id,{status:'validating',progress:'检查产物、输入版本与发布冲突'});
      let artifacts=await this.collectArtifacts(id,attemptRoot,assignments);
      await this.store.update(id,{artifacts:[...priorArtifacts,...artifacts]});
      const changed=await checkInputVersions(manifest);
      if(changed.length){await this.store.update(id,{status:'needs_attention',error:'输入版本已变化，未发布覆盖：'+changed.join('、'),progress:'输入已变化，等待处理',artifacts:[...priorArtifacts,...artifacts],validation:{inputVersions:false,changed}});return;}
      const missing=assignments.flatMap(a=>a.outputs.filter(path=>!artifacts.some(file=>file.agent===a.agent&&(path.endsWith('/')?file.name.startsWith(path):file.name===path))).map(path=>a.agent+':'+path));
      const passed=settled.every(result=>result.status==='fulfilled')&&missing.length===0;
      if(this.memberJob(job,lead).controller.signal.aborted){await this.store.update(id,{status:'needs_attention',progress:'主Agent已停止；同伴产物保留，未作主Agent收束。',error:terminalMessage(this.memberJob(job,lead).controller.signal.reason),artifacts:[...priorArtifacts,...artifacts],validation:{round:task.round,inputVersions:true,outputsPresent:missing.length===0,missing}});await this.event(id,{type:'lead-stopped',agent:lead,message:'主Agent未执行收束，需用户检查后继续。'});return;}
      const closure=await this.runWorker(task,job,lead,'closure',memberRoot(lead),`你是本轮主Agent，必须依据真实结果判断继续、结束或需用户补充。本轮指令见已送达原生上下文及inputs/history/task-history.json；尚在queued状态的用户消息留待下一安全轮次。执行结果：${JSON.stringify(assignments.map(a=>({agent:a.agent,text:results.get(a.agent)?.text??null,status:settled[assignments.indexOf(a)].status})))}。产物证据：${JSON.stringify(artifacts)}。缺失：${JSON.stringify(missing)}；验证通过：${passed}。只返回JSON：{"decision":"finish"|"continue"|"needs_user","brief":"完成项、交付物、核验情况、缺口和结束原因","assignments":[仅continue时给出下一轮安排]}。不得将失败称为通过。`,this.controlledTools(task,job,lead));
      const decision=parsePlan(closure.text);if(!['finish','continue','needs_user'].includes(decision.decision)||!text(decision.brief))throw new Error('主Agent未提供有效结束/继续判断与简报。');
      if(decision.decision==='continue')job.continuePlan=validatePlan(decision);
      await this.store.update(id,t=>({decisions:[...(t.decisions??[]),{...decision,agent:lead,round:task.round,messageId:closure.messageId}],rounds:t.rounds.map(r=>r.round===task.round?{...r,decision:decision.decision,brief:decision.brief,endedAt:new Date().toISOString()}:r)}));
      const summary=`# ${task.title}\n\n主Agent：${lead}\n本轮：${task.round}\n\n${decision.brief}\n\n`+assignments.map(({agent})=>`## ${agent}\n\n${results.get(agent)?.text??'执行失败，详见事件记录。'}\n`).join('\n')+`\n## 交付\n\n${artifacts.map(file=>'- '+file.agent+'：'+file.name).join('\n')}\n${missing.length?'\n未完成文件：'+missing.join('、'):''}\n`;
      const summaryPath=join(attemptRoot,'SUMMARY.md');await writeFile(summaryPath,summary);artifacts.push({id:randomUUID(),name:'SUMMARY.md',path:summaryPath,mimeType:'text/markdown',size:Buffer.byteLength(summary),sha256:digest(summary),agent:'协调服务',round:task.round,published:false});
      await this.store.update(id,{artifacts:[...priorArtifacts,...artifacts]});artifacts=await this.publish(task,artifacts,baseline,publishTarget,job);
      this.assertActive(job);
      const finalStatus=decision.decision==='needs_user'?'needs_attention':decision.decision==='continue'?'running':passed?'completed':'partial';await this.store.update(id,{status:finalStatus,progress:passed?'交付完成，等待用户验收':'已交付可用部分与失败说明',summary,artifacts:[...priorArtifacts,...artifacts],error:passed?null:'部分分工或计划产物未完成',validation:{round:task.round,inputVersions:true,outputsPresent:missing.length===0,missing,workerSuccess:settled.map((result,index)=>({agent:assignments[index].agent,passed:result.status==='fulfilled'}))}});
      await this.event(id,{type:'delivered',message:'单一发布者已提交产物；用户验收与交付分开。',status:finalStatus,artifacts:artifacts.map(a=>({id:a.id,name:a.name,sha256:a.sha256}))});
    }finally{this.leases.delete(id);}
  }
  async outputBaseline(root,assignments,manifest){
    const baseline={};for(const assignment of assignments)for(const output of assignment.outputs){const path=join(root,safeRelative(output));await noLinks(path);const info=await exists(path);if(info?.isFile())baseline[path]=digest(await readFile(path));else if(info?.isDirectory())for(const file of await filesBelow(path))baseline[file]=digest(await readFile(file));else baseline[path]=null;}
    const summary=join(root,'SUMMARY.md');baseline[summary]=await exists(summary)?digest(await readFile(summary)):null;
    for(const item of manifest.files)if(within(root,item.source))baseline[item.source]=item.sha256;
    return baseline;
  }
  async collectArtifacts(id,attemptRoot,assignments){
    const artifacts=[];
    for(const assignment of assignments){const stable=join(this.store.path(id),'members',assignment.agent,'workspace','output');const root=join(attemptRoot,'workers',assignment.agent,'workspace','output');if(await exists(stable)){await mkdir(root,{recursive:true});await cp(stable,root,{recursive:true});}for(const path of await filesBelow(root)){const name=path.slice(root.length+1).split('\\').join('/');safeRelative(name);if(!assignment.outputs.some(owned=>owned.endsWith('/')?name.startsWith(owned):name===owned))continue;const bytes=await readFile(path);if(bytes.length>32*1024*1024)throw new Error('Artifact exceeds 32MB limit.');artifacts.push({id:randomUUID(),name,path,mimeType:mime(name),size:bytes.length,sha256:digest(bytes),agent:assignment.agent,round:Number(basename(attemptRoot).replace('attempt-','')),published:false});}}
    return artifacts;
  }
  async publish(task,artifacts,baseline,target,job){
    for(const artifact of artifacts){const destination=join(target,safeRelative(artifact.name));await noLinks(destination);const info=await exists(destination);if(info&&!task.allowOverwrite)throw Object.assign(new Error('交付目标已存在，未授权覆盖：'+artifact.name),{code:'OUTPUT_CONFLICT'});const expected=baseline[destination]??null;const current=info?digest(await readFile(destination)):null;if(current!==expected)throw Object.assign(new Error('交付目录版本冲突：'+artifact.name),{code:'OUTPUT_CONFLICT'});if(/\.(?:docx|pptx)$/i.test(artifact.name)&&!task.allowOfficeEdit)throw new Error('本任务未授权编辑Word/PPT。');}
    const result=[];for(const artifact of artifacts){this.assertActive(job);const destination=join(target,artifact.name);await mkdir(dirname(destination),{recursive:true,mode:0o700});await noLinks(dirname(destination));if(await exists(destination)){const backup=join(this.store.path(task.id),'backups',String(task.attempt),artifact.name);await mkdir(dirname(backup),{recursive:true});await copyFile(destination,backup);}
      const temporary=join(dirname(destination),'.publish-'+randomUUID());await copyFile(artifact.path,temporary);
      try{this.assertActive(job);await noLinks(destination);const now=await exists(destination);const current=now?digest(await readFile(destination)):null;if(current!==(baseline[destination]??null))throw Object.assign(new Error('提交前目标版本已改变：'+artifact.name),{code:'OUTPUT_CONFLICT'});this.assertActive(job);if(task.allowOverwrite)await rename(temporary,destination);else{await link(temporary,destination);await unlink(temporary);}}catch(error){await unlink(temporary).catch(()=>{});throw error;}
      const published={...artifact,publishedPath:destination,published:true};result.push(published);
      await this.store.update(task.id,current=>({artifacts:current.artifacts.map(a=>a.id===artifact.id?published:a)}));}
    return result;
  }
  async artifact(id,artifactId){const current=await this.get(id);const artifact=current.artifacts.find(a=>a.id===artifactId);if(!artifact)throw Object.assign(new Error('Artifact not found.'),{code:'ENOENT'});await noLinks(artifact.path);const path=await realpath(artifact.path);if(!within(this.store.path(id),path)&&!within(current.task.outputDirectory,path))throw new Error('Artifact path outside task scope.');const bytes=await readFile(path);if(digest(bytes)!==artifact.sha256)throw new Error('Artifact changed after verification.');return{...artifact,bytes};}
  async export(id){const{task,events}=await this.get(id);const snapshot={models:task.models,actualModels:task.actualModels,budget:task.budget,totalToolCalls:task.totalToolCalls,usage:task.usage,inputs:task.inputs,outputDirectory:task.outputDirectory,permissions:{networkAccess:task.networkAccess,imageGeneration:task.imageGeneration,connectedApps:task.connectedApps,allowOverwrite:task.allowOverwrite,allowOfficeEdit:task.allowOfficeEdit},nativePlanningParticipants:task.nativePlanningParticipants,nativeParticipants:task.nativeParticipants,assignments:task.assignments,validation:task.validation,artifacts:task.artifacts?.map(a=>({id:a.id,name:a.name,agent:a.agent,sha256:a.sha256,published:a.published}))};return `# ${task.title}\n\n任务ID：${task.id}\n版本：${task.version}\n生成时间：${new Date().toISOString()}\n状态：${task.status}\n\n${task.summary??task.goal}\n\n## 身份、范围与验收快照\n\n\`\`\`json\n${JSON.stringify(snapshot,null,2)}\n\`\`\`\n\n## 事件\n\n${events.filter(event=>event.type!=='worker'||['ready','error','stopping'].includes(event.event?.type)).map(event=>`- ${event.timestamp} ${event.agent??''} ${event.phase??''} ${event.message??JSON.stringify(event.event??event.plan??event.type)}`).join('\n')}\n`;}
  async close(){for(const[id]of this.jobs)await this.cancel(id);await Promise.allSettled([...this.jobs.values()].map(job=>job.promise));for(const worker of this.workers)await worker.close();if(this.ownerLock){await this.ownerLock.close();this.ownerLock=null;const owner=JSON.parse(await readFile(this.lockPath,'utf8'));if(owner.epoch===this.epoch)await unlink(this.lockPath);}}
}
