// git.ts — the git object model, packfile codec and pkt-line framing.
//
// Everything the smart-HTTP surface needs, with no git binary anywhere: objects are
// hashed and stored as opaque bytes, packs are written plain (no deltas — the suite
// resolves them only "when the server sends them"), and packs the suite pushes are
// read back with full delta support anyway.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const SHA40_RE = /^[0-9a-f]{40}$/;

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** SHA-1 over `<type> <size>\0<data>`: the object id. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** Parse a tree object's entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree object from entries, sorted git-style (directories sort as name + '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object's headers and message. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object. The message is stored verbatim (no newline added). */
export function buildCommit(info: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  timestamp: number;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author} ${info.timestamp} +0000`);
  lines.push(`committer ${info.committer} ${info.timestamp} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------------------------

export const PKT_FLUSH = '0000';
export const PKT_DELIM = '0001';
export const PKT_END = '0002';
const PKT_MAX = 65520;

/** One pkt-line: a 4-hex length prefix plus the payload (payload must be < 65516 bytes). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (body.length > PKT_MAX - 4) throw new Error('pkt-line payload too large');
  const head = Buffer.alloc(4);
  head.write((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const pktFlush = (): Buffer => Buffer.from(PKT_FLUSH, 'ascii');
export const pktDelim = (): Buffer => Buffer.from(PKT_DELIM, 'ascii');
export const pktEnd = (): Buffer => Buffer.from(PKT_END, 'ascii');

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/**
 * Parse pkt-lines from the start of `buffer`. Returns the packets and the offset where the
 * pkt-line stream ended (the first byte after the last parsed packet — a packfile may follow).
 * Throws on a malformed length.
 */
export function parsePktLines(buffer: Buffer, maxPackets = 100000): { packets: Pkt[]; offset: number } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`malformed pkt-line length ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line overruns its buffer');
    packets.push({ kind: 'data', payload: Buffer.from(buffer.subarray(offset + 4, offset + length)) });
    offset += length;
    if (packets.length >= maxPackets) throw new Error('too many pkt-lines');
  }
  return { packets, offset };
}

/** The text lines of data packets, without trailing newlines. */
export function pktTextLines(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

/** Apply a git binary delta to a base buffer. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta varint overruns');
      const byte = delta[offset++]!;
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return result;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          if (offset >= delta.length) throw new Error('delta copy overruns');
          copyOffset |= delta[offset++]! << (bit * 8);
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          if (offset >= delta.length) throw new Error('delta copy overruns');
          copySize |= delta[offset++]! << (bit * 8);
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      outLen += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('delta insert overruns');
      out.push(delta.subarray(offset, offset + op));
      outLen += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (outLen !== resultSize) throw new Error('delta result size mismatch');
  return Buffer.concat(out, outLen);
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  count: number;
}

/** Inflate one zlib stream starting at `offset`; returns its bytes and the offset just past it. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/**
 * Read a packfile (version 2), verifying its SHA-1 trailer. Deltas resolve against objects
 * already in the pack or, for REF_DELTA, against `lookup` (the repository's store).
 */
export function readPack(pack: Buffer, lookup?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 32) throw new Error('pack too small');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const expectedTrailer = pack.subarray(pack.length - 20).toString('hex');
  const actualTrailer = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (expectedTrailer !== actualTrailer) throw new Error('pack trailer checksum mismatch');

  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let offset = 12;
  const end = pack.length - 20;
  for (let index = 0; index < count; index += 1) {
    if (offset >= end) throw new Error('pack truncated');
    const entryOffset = offset;
    let byte = pack[offset++]!;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (offset >= end) throw new Error('pack size varint truncated');
      byte = pack[offset++]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let base: GitObject | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset to the base entry.
      if (offset >= end) throw new Error('ofs-delta offset truncated');
      byte = pack[offset++]!;
      let baseOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (offset >= end) throw new Error('ofs-delta offset truncated');
        byte = pack[offset++]!;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      base = byOffset.get(entryOffset - baseOffset);
      if (base === undefined) throw new Error('ofs-delta base not in pack');
    } else if (typeCode === 7) {
      // REF_DELTA: the base object's id.
      if (offset + 20 > end) throw new Error('ref-delta base truncated');
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      base = objects.get(baseOid) ?? lookup?.(baseOid);
      if (base === undefined) throw new Error(`ref-delta base ${baseOid} unknown`);
    } else if (CODE_TYPES[typeCode] === undefined) {
      throw new Error(`unknown pack object type ${typeCode}`);
    }
    const { data: inflated, next } = inflateAt(pack, offset);
    if (next > end) throw new Error('pack entry overruns the trailer');
    offset = next;
    if (inflated.length !== size) throw new Error(`pack entry size mismatch: header ${size}, inflated ${inflated.length}`);
    let object: GitObject;
    if (base !== undefined) {
      object = { type: base.type, data: applyDelta(base.data, inflated) };
    } else {
      object = { type: CODE_TYPES[typeCode]!, data: inflated };
    }
    const oid = hashObject(object.type, object.data);
    objects.set(oid, object);
    byOffset.set(entryOffset, object);
  }
  return { objects, count };
}

/** Write a packfile (version 2) of plain objects — no deltas. Objects are sorted by id. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects].sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    const code = TYPE_CODES[object.type];
    const size = object.data.length;
    // Object header: (type << 4) | (size & 0x0f), then 7-bit little-endian size continuation.
    const headBytes: number[] = [];
    let remaining = size;
    let first = (code << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    headBytes.push(first);
    while (remaining > 0) {
      let next = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) next |= 0x80;
      headBytes.push(next);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(object.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Verify a packfile's trailer checksum without parsing entries. */
export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 32) return false;
  const expected = pack.subarray(pack.length - 20).toString('hex');
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex') === expected;
}
