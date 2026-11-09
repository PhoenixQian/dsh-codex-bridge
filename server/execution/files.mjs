import {mkdir, lstat, realpath, readFile, writeFile, readdir, rename, access} from 'node:fs/promises';
import {join, resolve, relative, dirname, isAbsolute, sep, basename} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {getPythonConfig,resolveProgram,isCredentialPath,credentialRoots} from '../runtime-config.mjs';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const denied = /^(?:\.env(?:[.-].*)?|auth\.json|\.credentials(?:\..*)?|credentials(?:\..*)?|secrets\.json|\.npmrc|\.netrc|\.git-credentials|\.pypirc|\.ssh|\.aws|\.codex|\.dsh|\.gnupg|\.kube|id_(?:rsa|dsa|ed25519|ecdsa)(?:\.pub)?)$/i;
const excluded = new Set(['.git','node_modules','__pycache__','.DS_Store','.venv','venv']);
export const sensitivePath = path => path.split(/[\\/]/).some(part => denied.test(part));
const excludedInput = path => sensitivePath(path)||isCredentialPath(path)||excluded.has(basename(path));
const directoryMembers = (entries,root) => entries.filter(entry=>!excludedInput(join(root,entry.name))).map(entry=>({name:entry.name,type:entry.isDirectory()?'directory':entry.isFile()?'file':entry.isSymbolicLink()?'symlink':'other'})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
export function within(root, path) {const r=relative(root,path);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));}
const privateWithinWorkspace=(target,workspace)=>credentialRoots().some(root=>within(root,target)&&!(root!==workspace&&within(root,workspace)));
export function safeRelative(path) {
  if(typeof path!=='string'||!path.trim()||isAbsolute(path)||path.includes('\\')||path.includes('\0')||path.split('/').includes('..')) throw new Error('Invalid relative path or traversal.');
  if(sensitivePath(path))throw new Error('Credential paths are outside task scope.');
  return path.replace(/^\.\//,'');
}
export async function noLinks(path) {
  const absolute=resolve(path);let current=sep;
  for(const part of absolute.split(sep).filter(Boolean)){
    current=join(current,part);
    try{if((await lstat(current)).isSymbolicLink())throw new Error('Symbolic link is outside safe task scope: '+current);}
    catch(error){if(error.code==='ENOENT')break;throw error;}
  }
  return absolute;
}

export async function snapshotInputs(paths, destination, {maxBytes=20*1024*1024,maxFiles=500}={}) {
  await mkdir(destination,{recursive:true,mode:0o700});
  const manifest={createdAt:new Date().toISOString(),files:[],directories:[],skipped:[],bytes:0};
  async function copy(source,target,logical){
    if(excludedInput(source)){manifest.skipped.push({path:source,reason:'excluded'});return;}
    const info=await lstat(source);
    if(info.isSymbolicLink())throw new Error('Input symbolic links must be resolved explicitly: '+source);
    if(info.isDirectory()){
      const entries=await readdir(source,{withFileTypes:true});
      manifest.directories.push({source,path:logical,members:directoryMembers(entries,source)});
      await mkdir(target,{recursive:true,mode:0o700});
      for(const entry of entries)await copy(join(source,entry.name),join(target,entry.name),join(logical,entry.name));
      return;
    }
    if(!info.isFile()){manifest.skipped.push({path:source,reason:'not a regular file'});return;}
    if(manifest.files.length>=maxFiles||manifest.bytes+info.size>maxBytes)throw new Error('Input snapshot exceeds the task file/byte budget. Narrow the inputs.');
    const bytes=await readFile(source);await mkdir(dirname(target),{recursive:true,mode:0o700});await writeFile(target,bytes,{flag:'wx',mode:0o400});
    manifest.files.push({source,path:logical,size:bytes.length,sha256:digest(bytes)});manifest.bytes+=bytes.length;
  }
  for(let index=0;index<paths.length;index++){
    const input=resolve(paths[index]);if(sensitivePath(input)||isCredentialPath(input))throw new Error('Credential input is forbidden.');
    if((await lstat(input)).isSymbolicLink())throw new Error('Input symbolic links must be resolved explicitly.');
    const canonical=await realpath(input);await noLinks(canonical);
    await copy(canonical,join(destination,String(index),basename(canonical)),join(String(index),basename(canonical)));
  }
  await writeFile(join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o400});return manifest;
}
export async function checkInputVersions(manifest) {
  const changed=new Set();
  for(const item of manifest.files){try{await noLinks(item.source);if(digest(await readFile(item.source))!==item.sha256)changed.add(item.source);}catch{changed.add(item.source);}}
  for(const directory of manifest.directories??[]){
    try{
      await noLinks(directory.source);
      const current=new Map(directoryMembers(await readdir(directory.source,{withFileTypes:true}),directory.source).map(member=>[member.name,member.type]));
      const previous=new Map(directory.members.map(member=>[member.name,member.type]));
      for(const name of new Set([...previous.keys(),...current.keys()]))if(previous.get(name)!==current.get(name))changed.add(join(directory.source,name));
    }catch{changed.add(directory.source);}
  }
  return [...changed].sort();
}

export class TaskFiles {
  constructor({workspace,allowedOutputs=['result.md'],readRoots=[],network=false,onEvent,signal,pythonPrefix=getPythonConfig().prefix}={}) {
    this.workspace=resolve(workspace);this.allowedOutputs=allowedOutputs.map(safeRelative);this.readRoots=readRoots;this.network=network;this.onEvent=onEvent;this.signal=signal;
    const pythonConfigs=['Codex','DSH'].map(agent=>getPythonConfig({agent}));
    const python=pythonPrefix?pythonConfigs.find(config=>config.enabled&&config.prefix===resolve(pythonPrefix)):null;
    if(pythonPrefix&&!python)throw new Error('Python must use an explicitly configured dedicated environment.');
    this.pythonPrefix=python?.prefix??null;this.pythonExecutable=python?.executable??null;
  }
  async init(){await mkdir(this.workspace,{recursive:true,mode:0o700});this.workspace=await realpath(this.workspace);if(credentialRoots().includes(this.workspace))throw new Error('Credential homes cannot be task workspaces.');this.output=join(this.workspace,'output');this.temporary=join(this.workspace,'tmp');await mkdir(this.output,{recursive:true,mode:0o700});await mkdir(this.temporary,{recursive:true,mode:0o700});return this;}
  alive(){if(this.signal?.aborted)throw new Error('Task cancelled.');}
  owned(path){return this.allowedOutputs.some(allowed=>allowed.endsWith('/')?path.startsWith(allowed):path===allowed);}
  async read(path){
    this.alive();let target;
    if(isAbsolute(path)){
      target=resolve(path);if(!this.readRoots.some(root=>within(resolve(root),target)))throw new Error('Read path is outside explicit task roots.');
    }else target=resolve(this.workspace,safeRelative(path));
    if((isAbsolute(path)&&isCredentialPath(target))||privateWithinWorkspace(target,this.workspace)||sensitivePath(isAbsolute(path)?target:relative(this.workspace,target))||(!isAbsolute(path)&&!within(this.workspace,target)))throw new Error('Credential/read path outside scope.');
    await noLinks(target);const info=await lstat(target);
    if(info.isDirectory())return {path,entries:(await readdir(target,{withFileTypes:true})).filter(e=>!sensitivePath(e.name)&&!excluded.has(e.name)&&!privateWithinWorkspace(join(target,e.name),this.workspace)&&(!isAbsolute(path)||!isCredentialPath(join(target,e.name)))).map(e=>({name:e.name,directory:e.isDirectory()}))};
    if(info.size>256*1024)throw new Error('File too large for a single text read.');
    return {path,content:await readFile(target,'utf8')};
  }
  async write(path,content){
    this.alive();path=safeRelative(path);if(!this.owned(path))throw new Error('Output path is not owned by this Agent.');
    if(typeof content!=='string'||Buffer.byteLength(content)>2*1024*1024)throw new Error('Invalid output content or size.');
    const target=resolve(this.output,path);if(!within(this.output,target))throw new Error('Write path escape.');if(privateWithinWorkspace(target,this.workspace))throw new Error('Credential output paths are outside task scope.');
    await noLinks(target);await mkdir(dirname(target),{recursive:true,mode:0o700});await noLinks(dirname(target));this.alive();
    const temporary=target+'.task-'+randomUUID();await writeFile(temporary,content,{flag:'wx',mode:0o600});this.alive();await rename(temporary,target);
    const result={path:'output/'+path,size:Buffer.byteLength(content),sha256:digest(content)};this.onEvent?.({type:'file',...result});return result;
  }
  async run({program,args=[],timeoutMs=30000}={}){
    this.alive();
    if(!['node','python3','sh','bash','git','rg'].includes(program))throw new Error('Program family is not allowed.');
    if(program==='python3'&&!this.pythonExecutable)throw new Error('Python is disabled: no dedicated interpreter is configured (未启用).');
    const executable=program==='python3'?this.pythonExecutable:resolveProgram(program);
    if(!Array.isArray(args)||args.some(value=>typeof value!=='string'||value.includes('\0'))||JSON.stringify(args).length>40000)throw new Error('Invalid command arguments.');
    if(process.platform!=='darwin')throw new Error('No verified command sandbox on this platform; command execution is disabled.');
    await access('/usr/bin/sandbox-exec');await access(executable);
    const quote=value=>JSON.stringify(value);
    const readable=['/System','/usr','/bin','/sbin','/Library','/opt/homebrew','/private/var/db','/private/var/select','/dev',...(this.pythonPrefix?[this.pythonPrefix]:[]),dirname(executable),this.workspace,...this.readRoots];
    const ancestors=new Set();for(const root of [this.workspace,...(this.pythonPrefix?[this.pythonPrefix]:[]),dirname(executable),...this.readRoots]){let path=dirname(root);while(path!==sep){ancestors.add(path);path=dirname(path);}}
    const profile=`(version 1)(deny default)(allow process*)(allow sysctl-read)(allow mach-lookup)(allow file-read-metadata ${[...ancestors].map(path=>`(literal ${quote(path)})`).join(' ')})(allow file-read* (literal "/") ${readable.map(path=>`(subpath ${quote(path)})`).join(' ')})(deny file-read* (literal "/usr/bin/python3"))(deny process-exec (literal "/usr/bin/python3"))(allow file-write* (subpath ${quote(this.workspace)}) (literal "/dev/null") (literal "/dev/tty"))`+(this.network?'(allow network*)':'');
    const credentialDenials=credentialRoots().map(root=>root!==this.workspace&&within(root,this.workspace)?`(deny file-read* (require-all (subpath ${quote(root)}) (require-not (subpath ${quote(this.workspace)}))))`:`(deny file-read* (subpath ${quote(root)}))(deny file-write* (subpath ${quote(root)}))`).join('');
    const scopedProfile=profile+credentialDenials;
    const started=Date.now();
    return new Promise((resolveResult,reject)=>{
      const child=spawn('/usr/bin/sandbox-exec',['-p',scopedProfile,executable,...args],{cwd:this.workspace,env:{PATH:[...(this.pythonPrefix?[join(this.pythonPrefix,'bin')]:[]),dirname(executable),'/opt/homebrew/bin','/usr/bin','/bin','/usr/sbin','/sbin'].join(':'),...(this.pythonPrefix?{CONDA_PREFIX:this.pythonPrefix}:{}),PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',LANG:'en_US.UTF-8',TMPDIR:this.temporary},stdio:['ignore','pipe','pipe'],detached:true});
      let stdout='',stderr='',timedOut=false,force;
      const terminate=()=>{try{process.kill(-child.pid,'SIGTERM');}catch{child.kill('SIGTERM');}force??=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}},1000);force.unref();};
      const timer=setTimeout(()=>{timedOut=true;terminate();},Math.min(60000,Math.max(100,timeoutMs)));
      const abort=()=>terminate();this.signal?.addEventListener('abort',abort,{once:true});
      child.stdout.on('data',chunk=>{stdout=(stdout+chunk).slice(0,24000);});child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(0,24000);});
      child.once('error',error=>{clearTimeout(timer);clearTimeout(force);this.signal?.removeEventListener('abort',abort);reject(error);});
      child.once('exit',(exitCode,signal)=>{clearTimeout(timer);clearTimeout(force);this.signal?.removeEventListener('abort',abort);const result={program,args,exitCode,signal,stdout,stderr,timedOut,durationMs:Date.now()-started};this.onEvent?.({type:'command',...result});resolveResult(result);});
    });
  }
  tools(){return [
    {name:'task_read',description:'Read task input/text or list a directory. Relative paths are rooted in this worker workspace; only explicitly allowed native SDK paths may be absolute.',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false},execute:args=>this.read(args.path)},
    {name:'task_write',description:'Write a real artifact. Path is relative to your output directory and must match an assigned output file or namespace. Do not merely print code in the final answer.',inputSchema:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content'],additionalProperties:false},execute:args=>this.write(args.path,args.content)},
    {name:'task_run',description:`Run a supported program inside an OS sandbox limited to this worker workspace and platform libraries. ${this.pythonPrefix ? `Python3 uses the explicitly configured environment ${this.pythonPrefix}.` : `Python3 is disabled until a dedicated interpreter is configured.`} Never install or call system Python. Use argv, not an unquoted command string.`,inputSchema:{type:'object',properties:{program:{type:'string',enum:['node','python3','sh','bash','git','rg']},args:{type:'array',items:{type:'string'}}},required:['program','args'],additionalProperties:false},execute:args=>this.run(args)},
    {name:'task_progress',description:'Record a concise task progress or blocker.',inputSchema:{type:'object',properties:{message:{type:'string'}},required:['message'],additionalProperties:false},execute:async args=>{this.alive();this.onEvent?.({type:'progress',message:String(args.message).slice(0,1000)});return {recorded:true};}},
  ];}
}
