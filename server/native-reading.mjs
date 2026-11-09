import{readFile,realpath,stat}from'node:fs/promises';
import{join,resolve}from'node:path';
import{homedir}from'node:os';
import{projectKey,decodeNativeLog}from'./session-codec.mjs';
const validId=id=>typeof id==='string'&&/^(?:session-[A-Za-z0-9-]{1,180}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(id);
const validTopic=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
async function optional(path){try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return{};throw e;}}
function textOf(message){return(message?.content??[]).filter(block=>block.type==='text'&&typeof block.text==='string').map(block=>block.text).join('\n');}
function plainReply(text){const trimmed=text.trim(),fence=/^```json\s*\n([\s\S]*?)\n```$/i.exec(trimmed);try{const value=JSON.parse(fence?fence[1]:trimmed);if(value&&typeof value.text==='string')return value.text;}catch{}return text;}
export function publicNativeMessages(events,sessionId){
 let pending=null,taskText='',lastReason=null;const messages=[];
 for(const event of events){
  if(event.type==='user/message'&&!taskText&&!['agent-instructions','runtime-context','skill-catalog'].includes((event.data?.message??event.data)?.source?.kind)){let text=textOf(event.data?.message??event.data);const start=text.indexOf('{');if(start>=0)try{const v=JSON.parse(text.slice(start));if(typeof v.question==='string')text=v.question;}catch{}taskText=text.slice(0,30000);}
  if(event.type==='assistant/message'){const text=textOf(event.data?.message);if(text.trim())pending={id:`native-${sessionId}-${event.seq}`,kind:'agent',from:{name:'DSH'},text:plainReply(text),timestamp:Number.isFinite(event.time)?new Date(event.time).toISOString():undefined,origin:{kind:'native-session-public-text',sessionId,seq:event.seq}};}
  if(event.type==='turn/end'){lastReason=event.data?.reason??null;if(pending){messages.push({...pending,...(lastReason?.kind==='error'?{incomplete:true}:{})});pending=null;}}
 }
 return{messages,taskText,lastReason};
}
const publicMessage=m=>({id:m.id,kind:m.kind,from:{name:m.from?.name??'系统',...(m.from?.agentId?{agentId:m.from.agentId}:{})},text:String(m.text??''),timestamp:m.timestamp,...(m.role?{role:m.role}:{}),...(m.origin?{origin:{kind:m.origin.kind,sessionId:m.origin.sessionId,seq:m.origin.seq}}:{})});
export function createNativeReading({directory,store,sessionsRoot=join(process.env.DSH_HOME||join(homedir(),'.dsh'),'sessions')}={}){
 return async sessionId=>{
  if(!validId(sessionId))throw Object.assign(Error('Invalid native session ID'),{code:'INVALID_SESSION'});
  const explicit=(await optional(join(directory,'dsh-reading-sessions.json'))).sessions?.[sessionId];
  if(explicit&&['failed-attempt','subagent'].includes(explicit.type)){
   if(typeof explicit.cwd!=='string'||!explicit.cwd.startsWith('/'))throw Error('Invalid owned session mapping');
   const root=await realpath(sessionsRoot),path=join(root,projectKey(explicit.cwd),sessionId,'session.v4.jsonl.zstd');
   if(await realpath(path)!==path)throw Error('Native session path is not canonical');
   if((await stat(path)).size>64*1024*1024)throw Error('Native history is too large for this view');
   const raw=decodeNativeLog(await readFile(path),{maxOutputLength:128*1024*1024}).toString('utf8');
   const rows=raw.trimEnd().split('\n').map(JSON.parse),header=rows.shift();
   if(header.id!==sessionId||header.cwd!==explicit.cwd||header.type!=='session'||header.version!==4)throw Error('Native history identity mismatch');
   if(rows.some((row,index)=>row.seq!==index))throw Error('Native history sequence mismatch');
   const extracted=publicNativeMessages(rows,sessionId);
   return{sessionId,source:'native-public',type:explicit.type,title:explicit.title??'协作记录',status:explicit.type==='failed-attempt'?'error':extracted.lastReason?.kind==='completed'?'completed':'interrupted',failureCode:explicit.failureCode??null,messages:extracted.messages,taskText:extracted.taskText,...(explicit.relatedConversationId&&validTopic(explicit.relatedConversationId)?{relatedUrl:'/?conversation='+encodeURIComponent(explicit.relatedConversationId)}:{}),sourceLabel:explicit.type==='failed-attempt'?'早期原生协作尝试，未形成同舟讨论':'同舟派生子会话的公开答复'};
  }
  const lanes=Object.values((await optional(join(directory,'dsh-host-lanes.json'))).lanes??{});
  let conversationId=lanes.filter(l=>l.sessionId===sessionId).map(l=>l.conversationId??/^discussion:([^:]+):/.exec(l.laneId??'')?.[1]).find(validTopic);
  if(!conversationId){const candidates=await store.list();conversationId=candidates.find(c=>c.participants?.DSH===sessionId||c.memberMetadata?.DSH?.threadId===sessionId)?.id;}
  if(!validTopic(conversationId))return null;
  let detail;try{detail=await store.get(conversationId);}catch(e){if(e.code==='ENOENT')return null;throw e;}
  const c=detail.conversation;
  return{sessionId,source:'shared-discussion',type:'discussion',title:c.title,status:c.status,conversationId:c.id,url:'/?conversation='+encodeURIComponent(c.id),brief:typeof c.brief==='string'?c.brief:'',messages:detail.messages.filter(m=>['agent','user','review'].includes(m.kind)).map(publicMessage),sourceLabel:'同舟共享讨论 · 双方公开消息'};
 };
}
