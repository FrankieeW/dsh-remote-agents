// Wire contract: can1357/oh-my-pi tag v18.17.0, modes/rpc/rpc-frame.ts.
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const parse = bytes => {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!object(value) || typeof value.type !== 'string') throw new Error('Invalid OMP frame object');
  return value;
};

/** Strict, bounded JSONL plus uninterrupted v2 chunk sequences. Never truncates. */
export class OmpFrameDecoder {
  constructor() { this.buffer = Buffer.alloc(0); this.pending = null; this.failed = false; }
  push(bytes) {
    if (this.failed) throw new Error('OMP decoder is closed');
    try {
      const output = [];
      const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      let start = 0;
      while (start < input.length) {
        const newline = input.indexOf(10, start);
        const end = newline < 0 ? input.length : newline + 1;
        const part = input.subarray(start, end);
        if (this.buffer.length + part.length > MAX_FRAME_BYTES) throw new Error('OMP physical frame exceeds limit');
        this.buffer = Buffer.concat([this.buffer, part]);
        start = end;
        if (newline < 0) break;
        const line = this.buffer.subarray(0, -1);
        this.buffer = Buffer.alloc(0);
        const frame = this.frame(parse(line));
        if (frame) output.push(frame);
      }
      return output;
    } catch (error) { this.failed = true; this.buffer = Buffer.alloc(0); this.pending = null; throw error; }
  }
  frame(value) {
    if (value.type !== 'rpc_chunk') {
      if (this.pending) throw new Error('OMP chunk sequence interrupted');
      return value;
    }
    const { chunkId, index, count, byteLength, data } = value;
    if (typeof chunkId !== 'string' || !chunkId.length || chunkId.length > 128 ||
        !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || !Number.isSafeInteger(byteLength) ||
        index < 0 || index >= count || count < 2 || count > 256 || byteLength < MAX_FRAME_BYTES || byteLength > MAX_REASSEMBLED_BYTES ||
        typeof data !== 'string' || !data.length || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('Invalid OMP chunk metadata/data');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > CHUNK_BYTES || bytes.toString('base64') !== data) throw new Error('Invalid OMP chunk payload');
    if (!this.pending) {
      if (index !== 0) throw new Error('OMP chunk sequence must start at zero');
      this.pending = { chunkId, count, byteLength, index: 0, length: 0, chunks: [] };
    }
    const p = this.pending;
    if (p.chunkId !== chunkId || p.count !== count || p.byteLength !== byteLength || p.index !== index) throw new Error('OMP chunk sequence mismatch');
    p.index++; p.length += bytes.length; p.chunks.push(bytes);
    if (p.length > byteLength) throw new Error('OMP chunk declared length exceeded');
    if (p.index < count) return;
    if (p.length !== byteLength) throw new Error('OMP chunk length mismatch');
    this.pending = null;
    const frame = parse(Buffer.concat(p.chunks, p.length));
    if (frame.type === 'rpc_chunk') throw new Error('Nested OMP chunks forbidden');
    return frame;
  }
  end() {
    if (this.buffer.length || this.pending) throw new Error('Incomplete OMP frame at EOF');
  }
}
