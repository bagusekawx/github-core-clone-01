// git-http.ts — git smart HTTP: info/refs, upload-pack (v2 + v0) and receive-pack (v0).
//
// The suite's git client (sdk/conformance/git-client.ts) is the only caller. The wire
// rules it enforces, in brief:
//   - v2 upload-pack: `version 2` + capability lines; ls-refs with peel/symrefs/unborn
//     and server-side ref-prefix filtering; fetch with shallow/deepen and sideband-framed
//     packs, sections in order: acknowledgments, shallow-info, packfile.
//   - v0 upload-pack: `# service=` preamble, symref + side-band-64k in the capabilities,
//     `capabilities^{}` for an empty repository.
//   - receive-pack is v0 only: report-status, side-band-64k, delete-refs; the report is
//     sideband-framed (`unpack ok`, then `ok`/`ng` per ref); a non-fast-forward update is
//     refused per-ref with the exact reason `non-fast-forward` and moves nothing.
// Packs are written plain (no deltas); pushed packs are read with full delta support.

import {
  ZERO_OID,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  pktLine,
  pktTextLines,
  parsePktLines,
  readPack,
  writePack,
} from './git.ts';
import type { GitObject, Pkt } from './git.ts';
import {
  collectReachable,
  collectShallow,
  isAncestor,
  peelTag,
  peelToCommit,
} from './store.ts';
import type { Repo, Store } from './store.ts';

const AGENT = 'github-core-clone-forge/1.0.0';
const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** The sideband chunk size for pack data: a pkt-line holds at most 65516 payload bytes. */
const SIDEBAND_CHUNK = 65500;

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function httpError(status: number, message: string): GitResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

/** Every ref line of a v0 advertisement, HEAD first, then refs sorted by name. */
function v0RefLines(repo: Repo, includeHead: boolean): string[] {
  const lines: string[] = [];
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const mainTip = repo.branchTip(repo.defaultBranch);
  if (includeHead && mainTip !== undefined) lines.push(`${mainTip} HEAD`);
  for (const [ref, oid] of refs) {
    lines.push(`${oid} ${ref}`);
    const peeled = peelTag(repo, oid);
    if (peeled !== null) lines.push(`${peeled} ${ref}^{}`);
  }
  return lines;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow multi_ack_detailed symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const lines = v0RefLines(repo, service === 'git-upload-pack');
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${lines[0]!}\0${caps}\n`));
    for (const line of lines.slice(1)) parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    pktFlush(),
  ];
  return Buffer.concat(parts);
}

export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string | null,
): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return httpError(404, 'Not Found');
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') return ok(UPLOAD_AD, v2Advertisement());
    return ok(UPLOAD_AD, v0Advertisement(repo, 'git-upload-pack'));
  }
  if (service === 'git-receive-pack') {
    return ok(RECEIVE_AD, v0Advertisement(repo, 'git-receive-pack'));
  }
  return httpError(400, `unknown service ${service}`);
}

// ---------------------------------------------------------------------------------------------
// upload-pack v2: ls-refs
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(packets: readonly Pkt[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, unborn: false, prefixes: [] };
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !afterDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') args.peel = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line === 'symrefs') { /* HEAD symref is always reported */ }
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    // ref-exclude is never sent by the suite's client; ignored.
  }
  return args;
}

function handleLsRefs(repo: Repo, packets: readonly Pkt[]): Buffer {
  const args = parseLsRefsArgs(packets);
  const lines: string[] = [];
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const mainTip = repo.branchTip(repo.defaultBranch);
  // HEAD is listed only when no ref-prefix filters the answer (it matches no prefix).
  if (args.prefixes.length === 0) {
    if (mainTip !== undefined) {
      lines.push(`${mainTip} HEAD symref-target:refs/heads/${repo.defaultBranch}`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}`);
    }
  }
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [ref, oid] of refs) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (args.peel) {
      const peeled = peelTag(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  const parts = lines.map((line) => pktLine(`${line}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack v2: fetch
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number;
}

function parseFetchArgs(packets: readonly Pkt[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: 0 };
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !afterDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n) && n > 0) args.depth = Math.trunc(n);
    }
    // done, thin-pack, ofs-delta, no-progress, filter: no action needed.
  }
  return args;
}

/** Split pack bytes into sideband band-1 pkt-lines. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, offset + SIDEBAND_CHUNK);
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
  }
  if (parts.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}

function handleFetchV2(repo: Repo, packets: readonly Pkt[]): Buffer {
  const args = parseFetchArgs(packets);
  const oldShallow = new Set(args.shallow);
  // Acknowledgments: ACK every have that is an ancestor of (or equal to) a want, then ready.
  const acks: string[] = [];
  for (const have of args.haves) {
    if (repo.getObject(have) === undefined) continue;
    if (args.wants.some((want) => isAncestor(repo, have, want))) acks.push(`ACK ${have}`);
  }
  const parts: Buffer[] = [pktLine('acknowledgments\n')];
  if (acks.length > 0) {
    for (const ack of acks) parts.push(pktLine(`${ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktFlush());

  // Object selection.
  let selected: Set<string>;
  let boundary: Set<string> = new Set();
  if (args.depth > 0) {
    const { included, boundary: b } = collectShallow(repo, args.wants, args.depth);
    boundary = b;
    const withTrees = new Set<string>();
    for (const commit of included) {
      withTrees.add(commit);
      const object = repo.getObject(commit);
      if (object !== undefined && object.type === 'commit') {
        for (const oid of collectReachable(repo, [parseCommit(object.data).tree])) withTrees.add(oid);
      }
    }
    // Tags the client wants are included whole.
    for (const want of args.wants) {
      const object = repo.getObject(want);
      if (object !== undefined && object.type === 'tag') {
        for (const oid of collectReachable(repo, [want])) withTrees.add(oid);
      }
    }
    const excluded = collectReachable(repo, args.haves, oldShallow);
    selected = new Set([...withTrees].filter((oid) => !excluded.has(oid)));
  } else {
    const wanted = collectReachable(repo, args.wants);
    const excluded = collectReachable(repo, args.haves, oldShallow);
    selected = new Set([...wanted].filter((oid) => !excluded.has(oid)));
  }

  // Shallow-info: the new boundary, and old shallow commits that are now fully included.
  if (args.depth > 0 || args.shallow.length > 0) {
    const lines: string[] = [];
    for (const oid of [...boundary].sort()) lines.push(`shallow ${oid}`);
    if (args.depth > 0) {
      const { included } = collectShallow(repo, args.wants, args.depth);
      for (const oid of [...oldShallow].sort()) {
        if (!included.has(oid)) continue;
        const object = repo.getObject(oid);
        if (object === undefined || object.type !== 'commit') continue;
        const parents = parseCommit(object.data).parents;
        if (parents.every((parent) => included.has(parent))) lines.push(`unshallow ${oid}`);
      }
    }
    parts.push(pktLine('shallow-info\n'));
    for (const line of lines) parts.push(pktLine(`${line}\n`));
    parts.push(pktFlush());
  }

  const objects: GitObject[] = [];
  for (const oid of selected) {
    const object = repo.getObject(oid);
    if (object !== undefined) objects.push(object);
  }
  const pack = writePack(objects);
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack v0: fetch (the suite never uses it — every client speaks v2 — but it is cheap)
// ---------------------------------------------------------------------------------------------

function handleFetchV0(repo: Repo, packets: readonly Pkt[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  for (const line of pktTextLines(packets)) {
    const clean = line.split('\0')[0]!;
    if (clean.startsWith('want ')) wants.push(clean.slice(5).trim());
    else if (clean.startsWith('have ')) haves.push(clean.slice(5).trim());
  }
  const wanted = collectReachable(repo, wants);
  const excluded = collectReachable(repo, haves);
  const objects: GitObject[] = [];
  for (const oid of wanted) {
    if (excluded.has(oid)) continue;
    const object = repo.getObject(oid);
    if (object !== undefined) objects.push(object);
  }
  const parts: Buffer[] = [pktLine('NAK\n'), ...sidebandPack(writePack(objects)), pktFlush()];
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack dispatch
// ---------------------------------------------------------------------------------------------

export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return httpError(404, 'Not Found');
  let packets: Pkt[];
  try {
    packets = parsePktLines(body).packets;
  } catch {
    return httpError(400, 'malformed pkt-line stream');
  }
  const first = pktTextLines(packets)[0] ?? '';
  try {
    if (first.startsWith('command=ls-refs')) return ok(UPLOAD_RESULT, handleLsRefs(repo, packets));
    if (first.startsWith('command=fetch')) return ok(UPLOAD_RESULT, handleFetchV2(repo, packets));
    if (first.startsWith('want ')) return ok(UPLOAD_RESULT, handleFetchV0(repo, packets));
  } catch (err) {
    return httpError(400, err instanceof Error ? err.message : 'upload-pack failed');
  }
  return httpError(400, 'unknown upload-pack command');
}

// ---------------------------------------------------------------------------------------------
// receive-pack v0
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushCommands(packets: readonly Pkt[]): PushCommand[] {
  const commands: PushCommand[] = [];
  for (const line of pktTextLines(packets)) {
    const clean = line.split('\0')[0]!;
    const parts = clean.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
  }
  return commands;
}

export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return httpError(404, 'Not Found');
  let packets: Pkt[];
  let offset = 0;
  try {
    ({ packets, offset } = parsePktLines(body));
  } catch {
    return httpError(400, 'malformed pkt-line stream');
  }
  const commands = parsePushCommands(packets);
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  const packBytes = body.subarray(offset);

  // Unpack first: a refused update must still unpack, and its objects stay stored.
  let unpackOk = true;
  let unpackDetail = '';
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'missing packfile';
    } else {
      try {
        const read = readPack(packBytes, (oid) => repo.getObject(oid));
        for (const [oid, object] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack failed';
      }
    }
  }

  // Apply the commands, one verdict each, in order.
  const inner: Buffer[] = [];
  inner.push(pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`));
  for (const command of commands) {
    let verdict: string;
    if (!unpackOk) {
      verdict = `ng ${command.ref} unpack failed`;
    } else if (command.newOid === ZERO_OID) {
      // Delete.
      const current = repo.refTip(command.ref);
      if (current === undefined) verdict = `ng ${command.ref} ref does not exist`;
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) verdict = `ng ${command.ref} non-fast-forward`;
      else {
        repo.refs.delete(command.ref);
        verdict = `ok ${command.ref}`;
      }
    } else if (command.oldOid === ZERO_OID) {
      // Create.
      if (repo.refTip(command.ref) !== undefined) {
        verdict = `ng ${command.ref} already exists`;
      } else if (repo.getObject(command.newOid) === undefined) {
        verdict = `ng ${command.ref} object not found`;
      } else {
        repo.refs.set(command.ref, command.newOid);
        verdict = `ok ${command.ref}`;
      }
    } else {
      // Update.
      const current = repo.refTip(command.ref);
      if (current === undefined) {
        verdict = `ng ${command.ref} ref does not exist`;
      } else if (command.oldOid !== current) {
        verdict = `ng ${command.ref} non-fast-forward`;
      } else if (repo.getObject(command.newOid) === undefined) {
        verdict = `ng ${command.ref} object not found`;
      } else if (command.ref.startsWith('refs/tags/')) {
        verdict = `ng ${command.ref} non-fast-forward`;
      } else if (!isAncestor(repo, command.oldOid, command.newOid)) {
        verdict = `ng ${command.ref} non-fast-forward`;
      } else {
        repo.refs.set(command.ref, command.newOid);
        verdict = `ok ${command.ref}`;
      }
    }
    inner.push(pktLine(`${verdict}\n`));
  }
  inner.push(pktFlush());

  // The report rides sideband band 1, one outer pkt-line per inner pkt-line.
  const outer: Buffer[] = [];
  for (const line of inner) outer.push(pktLine(Buffer.concat([Buffer.from([1]), line])));
  outer.push(pktFlush());
  return ok(RECEIVE_RESULT, Buffer.concat(outer));
}

// Re-exported for the REST layer's convenience (unused here, kept close to the wire).
export { buildTree, hashObject, parseCommit, parseTag, parseTree };
