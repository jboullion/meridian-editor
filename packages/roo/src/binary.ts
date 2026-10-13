// Little-endian byte reader and writer for .roo files. Floats are stored as
// C `float`, so every write goes through setFloat32 (which rounds like
// Math.fround) and every read comes back exact.

export class ByteReader {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  get remaining(): number {
    return this.bytes.byteLength - this.pos;
  }

  seek(pos: number): void {
    if (pos < 0 || pos > this.bytes.byteLength) {
      throw new RangeError(`seek to ${pos} is outside the file (${this.bytes.byteLength} bytes)`);
    }
    this.pos = pos;
  }

  private need(n: number): number {
    const at = this.pos;
    if (at + n > this.bytes.byteLength) {
      throw new RangeError(`short read at ${at} (wanted ${n} bytes, file is ${this.bytes.byteLength})`);
    }
    this.pos = at + n;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.need(1));
  }
  u16(): number {
    return this.view.getUint16(this.need(2), true);
  }
  i16(): number {
    return this.view.getInt16(this.need(2), true);
  }
  i32(): number {
    return this.view.getInt32(this.need(4), true);
  }
  f32(): number {
    return this.view.getFloat32(this.need(4), true);
  }
  take(n: number): Uint8Array {
    const at = this.need(n);
    return this.bytes.slice(at, at + n);
  }
}

export class ByteWriter {
  private buf = new Uint8Array(64 * 1024);
  private view = new DataView(this.buf.buffer);
  pos = 0;

  /** Claims n bytes and returns their offset. Call before touching `view`, which may be replaced. */
  private reserve(n: number): number {
    const at = this.pos;
    if (at + n > this.buf.byteLength) {
      let size = this.buf.byteLength * 2;
      while (size < at + n) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.buf.subarray(0, at));
      this.buf = next;
      this.view = new DataView(next.buffer);
    }
    this.pos = at + n;
    return at;
  }

  u8(v: number): void {
    const at = this.reserve(1);
    this.view.setUint8(at, v & 0xff);
  }
  u16(v: number): void {
    const at = this.reserve(2);
    this.view.setUint16(at, v & 0xffff, true);
  }
  i16(v: number): void {
    const at = this.reserve(2);
    this.view.setInt16(at, v, true);
  }
  i32(v: number): void {
    const at = this.reserve(4);
    this.view.setInt32(at, v, true);
  }
  f32(v: number): void {
    const at = this.reserve(4);
    this.view.setFloat32(at, v, true);
  }
  raw(bytes: Uint8Array): void {
    const at = this.reserve(bytes.byteLength);
    this.buf.set(bytes, at);
  }

  patchI32(at: number, v: number): void {
    this.view.setInt32(at, v, true);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

const f32Scratch = new Float32Array(1);
const i32Scratch = new Int32Array(f32Scratch.buffer);

/** The bit pattern of `v` as a C float, read back as an int (save.cpp `ftoi`). */
export function floatBits(v: number): number {
  f32Scratch[0] = v;
  return i32Scratch[0];
}
