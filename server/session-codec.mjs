/*
 * Frame parsing adapted from @deepseek-ai/dsh-session-persistence-jsonl
 * src/zstd.ts, DeepSeek Harness 0.2.2-rc.3, commit
 * 6b729fedde0c8fd03af7afdf5a711aa64fe87c3b.
 *
 * MIT License
 * Copyright (c) 2026 DeepSeek
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import * as zlib from 'node:zlib';

// DSH v4 storage project-key encoding, independent of repair tools and Host state.
export function projectKey(cwd) { let out='',separator=false; for(let i=0;i<cwd.length;i++){const c=cwd[i];if('/\\:'.includes(c)){if(!separator)out+='-';separator=true;}else{out+=c!=='~'&&/^[A-Za-z0-9._-]$/.test(c)?c:'~'+cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4,'0');separator=false;}}return '--'+(out.replace(/^-+/,'')||'root').slice(0,251)+'--'; }

const corrupt = (detail, cause) => Object.assign(new Error(`原生压缩记录不完整或格式无效：${detail}`, {cause}), {code: 'NATIVE_LOG_CORRUPT'});
const tooLarge = () => Object.assign(new Error('原生压缩记录解压后超过阅读上限。'), {code: 'NATIVE_LOG_TOO_LARGE'});

/** Walk actual frame headers and blocks; magic bytes inside a block are ordinary data. */
function* frameRanges(bytes) {
  if (bytes.length === 0) throw corrupt('empty log');
  let offset = 0;
  const requireBytes = count => {
    if (bytes.length - offset < count) throw corrupt(`truncated frame at byte ${offset}`);
  };
  while (offset < bytes.length) {
    const start = offset;
    requireBytes(4);
    if (bytes.readUInt32LE(offset) !== 0xFD2FB528) throw corrupt(`invalid frame magic at byte ${offset}`);
    offset += 4;
    requireBytes(1);
    const descriptor = bytes[offset++];
    if ((descriptor & 0x18) !== 0) throw corrupt(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    requireBytes(remainingHeaderBytes);
    offset += remainingHeaderBytes;
    for (;;) {
      requireBytes(3);
      const blockHeader = bytes.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) throw corrupt(`reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      requireBytes(payloadBytes);
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) { requireBytes(4); offset += 4; }
    yield {start, end: offset};
  }
}

/** Decode complete native batches with a total budget, including on Node 24's one-frame API. */
export function decodeNativeLog(bytes, {maxOutputLength = 128 * 1024 * 1024} = {}) {
  if (!Number.isSafeInteger(maxOutputLength) || maxOutputLength < 1) throw new RangeError('maxOutputLength must be a positive safe integer');
  if (!Buffer.isBuffer(bytes)) throw new TypeError('Native log must be a Buffer');
  if (typeof zlib.zstdDecompressSync !== 'function') throw Object.assign(new Error('原生压缩记录阅读未启用：当前宿主 Node 不提供 Zstd 解码。'), {code: 'NATIVE_CODEC_UNSUPPORTED'});
  const chunks = [];
  let length = 0;
  for (const {start, end} of frameRanges(bytes)) {
    let decoded;
    try {
      // Node requires a positive per-call limit; a later empty frame may use zero budget.
      decoded = zlib.zstdDecompressSync(bytes.subarray(start, end), {maxOutputLength: Math.max(1, maxOutputLength - length)});
    } catch (error) {
      if (error.code === 'ERR_BUFFER_TOO_LARGE') throw tooLarge();
      throw corrupt(`frame at byte ${start} failed validation`, error);
    }
    length += decoded.length;
    if (length > maxOutputLength) throw tooLarge();
    chunks.push(decoded);
  }
  return Buffer.concat(chunks, length);
}
