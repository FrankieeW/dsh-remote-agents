import test from 'node:test';
import assert from 'node:assert/strict';
import { OmpFrameDecoder, MAX_FRAME_BYTES, MAX_REASSEMBLED_BYTES } from '../reference/src/chat/omp-frames.js';
const line = frame => Buffer.from(JSON.stringify(frame) + '\n');
function chunks(value) {
  const bytes = Buffer.from(JSON.stringify(value)), size = 256 * 1024;
  return Array.from({ length: Math.ceil(bytes.length / size) }, (_, index) => ({ type: 'rpc_chunk', chunkId: 'large', index, count: Math.ceil(bytes.length / size), byteLength: bytes.length, data: bytes.subarray(index * size, (index + 1) * size).toString('base64') }));
}
test('strict JSONL supports split UTF8 and multiple frames', () => {
  const decoder = new OmpFrameDecoder(), data = line({ type: 'x', text: '你😀' });
  const results = [];
  for (const byte of data) results.push(...decoder.push(Buffer.from([byte])));
  assert.deepEqual(results, [{ type: 'x', text: '你😀' }]);
  assert.equal(decoder.push(Buffer.concat([data, data])).length, 2);
  decoder.end();
});
test('v2 reassembles losslessly above physical cap', () => {
  const value = { type: 'message_end', text: '你好'.repeat(300000) };
  const decoder = new OmpFrameDecoder();
  assert.deepEqual(chunks(value).flatMap(chunk => decoder.push(line(chunk))), [value]);
  decoder.end();
});
test('invalid physical JSON, UTF8, overflow and incomplete EOF are fatal', () => {
  for (const data of [Buffer.from('oops\n'), Buffer.from('[1]\n'), Buffer.from([0xff, 10]), Buffer.alloc(MAX_FRAME_BYTES + 1, 120)]) {
    const decoder = new OmpFrameDecoder(); assert.throws(() => decoder.push(data)); assert.throws(() => decoder.push(line({ type: 'x' })), /closed/);
  }
  const decoder = new OmpFrameDecoder(); decoder.push(Buffer.from('{')); assert.throws(() => decoder.end(), /Incomplete/);
});
test('chunk metadata/base64/order/interleaving/size checked strictly', () => {
  const frames = chunks({ type: 'x', text: 'x'.repeat(MAX_FRAME_BYTES) });
  for (const patch of [{ index: 1 }, { count: 999 }, { byteLength: MAX_REASSEMBLED_BYTES + 1 }, { byteLength: 1 }, { data: '%%%=' }, { data: 'AB==' }, { chunkId: '' }, { index: 0.5 }]) {
    assert.throws(() => new OmpFrameDecoder().push(line({ ...frames[0], ...patch })));
  }
  for (const next of [frames[0], { ...frames[1], chunkId: 'other' }, { type: 'notice' }]) {
    const decoder = new OmpFrameDecoder(); decoder.push(line(frames[0])); assert.throws(() => decoder.push(line(next)));
  }
  const decoder = new OmpFrameDecoder(); decoder.push(line(frames[0])); assert.throws(() => decoder.end(), /Incomplete/);
  assert.throws(() => { const d = new OmpFrameDecoder(); for (const frame of frames) d.push(line({ ...frame, byteLength: frame.byteLength + 1 })); }, /length mismatch/);
});
