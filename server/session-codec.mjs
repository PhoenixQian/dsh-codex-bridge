// DSH v4 storage project-key encoding, kept pure and independent of repair tools.
import {zstdCompressSync,zstdDecompressSync} from 'node:zlib';
export function projectKey(cwd) { let out='',separator=false; for(let i=0;i<cwd.length;i++){const c=cwd[i];if('/\\:'.includes(c)){if(!separator)out+='-';separator=true;}else{out+=c!=='~'&&/^[A-Za-z0-9._-]$/.test(c)?c:'~'+cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4,'0');separator=false;}}return '--'+(out.replace(/^-+/,'')||'root').slice(0,251)+'--'; }
let supportsFrames;
export function decodeNativeLog(bytes,{maxOutputLength=128*1024*1024}={}) {
  if(supportsFrames===undefined) {
    try { supportsFrames=zstdDecompressSync(Buffer.concat([zstdCompressSync(Buffer.from('one')),zstdCompressSync(Buffer.from('two'))])).toString()==='onetwo'; }
    catch { supportsFrames=false; }
  }
  if(!supportsFrames)throw Object.assign(new Error('原生压缩记录阅读未启用：当前宿主 Node 不能完整解码拼接 Zstd 帧。请使用支持该能力的运行时；共享讨论记录仍可阅读。'),{code:'NATIVE_CODEC_UNSUPPORTED'});
  return zstdDecompressSync(bytes,{maxOutputLength});
}
