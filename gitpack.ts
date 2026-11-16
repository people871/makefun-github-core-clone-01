// Packfile codec (PACK v2): parse (plain + OFS_DELTA + REF_DELTA, thin-pack aware)
// and build (plain objects, thin-pack safe). No git binary, node:zlib + node:crypto only.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { objectId } from './gitobj.ts';
import type { GitObject } from './store.ts';

export type PackObjectType = 'commit' | 'tree' | 'blob' | 'tag';

const CODE_TO_TYPE: Record<number, PackObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_TO_CODE: Record<PackObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of base');
      if (written + copySize > targetSize) throw new Error('delta writes past target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert truncated');
      if (written + literal > targetSize) throw new Error('delta writes past target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/** Inflate one zlib stream starting at `offset` (never past `end`); returns bytes + next offset. */
function inflateAt(pack: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const result = inflateSync(pack.subarray(offset, end), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + consumed };
}

export interface ParsedPack {
  version: number;
  count: number;
  objects: Map<string, GitObject>;
}

/**
 * Parse a PACK v2/v3 buffer and resolve every object (deltas included). `resolveBase`
 * supplies a base object a thin pack leaves out (looked up in the repo store). Throws on
 * a bad header, a bad trailer checksum, a size mismatch or an unresolvable delta base.
 */
export function parsePack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): ParsedPack {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: GitObject;
    oid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off;
    let byte = pack[off];
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    off += 1;
    while (byte & 0x80) {
      if (off >= trailerStart) throw new Error('pack entry size varint truncated');
      byte = pack[off++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (shift > 63) throw new Error('pack entry size varint too long');
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      byte = pack[off];
      off += 1;
      let base = byte & 0x7f;
      while (byte & 0x80) {
        if (off >= trailerStart) throw new Error('ofs-delta base offset truncated');
        byte = pack[off++];
        base = ((base + 1) * 128) + (byte & 0x7f);
      }
      if (base <= 0 || base > entryOffset) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - base;
    } else if (typeCode === 7) {
      if (off + 20 > trailerStart) throw new Error('ref-delta base id truncated');
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TO_TYPE[typeCode]) {
      throw new Error(`pack entry ${i} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, off, trailerStart);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    off = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (off !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  // Fast path: no deltas — every entry is a plain object, so resolve each directly
  // without the delta machinery (no byOffset lookups, no recursion, no resolving set).
  // Push packs built by the kit client are always plain; deltas fall through below.
  let hasDelta = false;
  for (const entry of raw) {
    if (entry.typeCode === 6 || entry.typeCode === 7) { hasDelta = true; break; }
  }
  if (!hasDelta) {
    const objects = new Map<string, GitObject>();
    for (const entry of raw) {
      const obj: GitObject = { type: CODE_TO_TYPE[entry.typeCode] as GitObject['type'], data: entry.data };
      const oid = objectId(obj.type, obj.data);
      if (!objects.has(oid)) objects.set(oid, obj);
    }
    return { version, count, objects };
  }

  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): GitObject => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let obj: GitObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      obj = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid!);
      let base: GitObject | undefined;
      if (baseEntry) base = resolve(baseEntry);
      else base = resolveBase?.(entry.baseOid!);
      if (!base) throw new Error(`ref-delta base ${entry.baseOid} is neither in the pack nor supplied`);
      obj = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      obj = { type: CODE_TO_TYPE[entry.typeCode], data: entry.data };
    }
    entry.resolved = obj;
    entry.oid = objectId(obj.type, obj.data);
    resolvedByOid.set(entry.oid, entry);
    resolving.delete(entry.offset);
    return obj;
  };

  const objects = new Map<string, GitObject>();
  for (const entry of raw) {
    const obj = resolve(entry);
    if (!objects.has(entry.oid!)) objects.set(entry.oid!, obj);
  }
  return { version, count, objects };
}

/** Encode one object's pack header: the type/size varint the pack format uses. */
function packObjectHeader(type: PackObjectType, size: number): Buffer {
  const code = TYPE_TO_CODE[type];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  const bytes: number[] = [];
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a PACK v2 buffer from plain objects (no deltas; every base is in-pack). */
export function buildPack(objects: Iterable<GitObject>): Buffer {
  const list = Array.isArray(objects) ? objects : [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const obj of list) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
