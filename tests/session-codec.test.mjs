import test from 'node:test';
import assert from 'node:assert/strict';
import { constants, zstdCompressSync } from 'node:zlib';
import { decodeNativeLog } from '../server/session-codec.mjs';

const frame = value => zstdCompressSync(Buffer.from(value), {params: {[constants.ZSTD_c_checksumFlag]: 1}});
const packed = (...values) => Buffer.concat(values.map(frame));
const corrupt = {code: 'NATIVE_LOG_CORRUPT'};

test('reads every independently compressed native log batch', () => {
  assert.equal(decodeNativeLog(packed('header\n', 'first reply\n', '最后答复\n')).toString(), 'header\nfirst reply\n最后答复\n');
  assert.equal(decodeNativeLog(frame('')).length, 0);
});

test('enforces one output budget across all frames and accepts the exact boundary', () => {
  const bytes = packed('one', 'two');
  assert.equal(decodeNativeLog(bytes, {maxOutputLength: 6}).toString(), 'onetwo');
  assert.throws(() => decodeNativeLog(bytes, {maxOutputLength: 5}), {code: 'NATIVE_LOG_TOO_LARGE'});
  assert.throws(() => decodeNativeLog(frame('123456'), {maxOutputLength: 5}), {code: 'NATIVE_LOG_TOO_LARGE'});
});

test('rejects invalid output budgets', () => {
  for (const maxOutputLength of [0, -1, 1.5, NaN, Infinity, '6']) {
    assert.throws(() => decodeNativeLog(frame('one'), {maxOutputLength}), RangeError);
  }
});

test('rejects truncated frames even after a complete earlier batch', () => {
  const first = frame('header\n'), second = frame('reply\n');
  for (let end = 1; end < second.length; end++) {
    assert.throws(() => decodeNativeLog(Buffer.concat([first, second.subarray(0, end)])), corrupt);
  }
  assert.throws(() => decodeNativeLog(Buffer.alloc(0)), corrupt);
});

test('rejects skipped frames and trailing bytes instead of omitting content', () => {
  // The Zstd specification permits skippable frames; native logs use only standard frames.
  const skipped = Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0, 0, 0, 0]);
  assert.throws(() => decodeNativeLog(Buffer.concat([frame('one'), skipped, frame('two')])), corrupt);
  assert.throws(() => decodeNativeLog(Buffer.concat([frame('one'), Buffer.from('trailing')])), corrupt);
});

test('does not split a raw block at magic bytes embedded in its public text', () => {
  const payload = Buffer.from([0x41, 0x28, 0xb5, 0x2f, 0xfd, 0x42]);
  // Standard magic, one-segment frame with one-byte content size, then one final raw block.
  const raw = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, payload.length, (payload.length << 3) | 1, 0, 0]), payload]);
  assert.deepEqual(decodeNativeLog(Buffer.concat([raw, frame('tail')])), Buffer.concat([payload, Buffer.from('tail')]));
});

test('rejects reserved headers, reserved block types and failed checksums', () => {
  for (const reserved of [0x08, 0x10]) {
    const bytes = frame('one'); bytes[4] |= reserved;
    assert.throws(() => decodeNativeLog(bytes), corrupt);
  }
  const reservedBlock = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0, 7, 0, 0]);
  assert.throws(() => decodeNativeLog(reservedBlock), corrupt);
  const badChecksum = frame('one'); badChecksum[badChecksum.length - 1] ^= 1;
  assert.throws(() => decodeNativeLog(badChecksum), corrupt);
});
