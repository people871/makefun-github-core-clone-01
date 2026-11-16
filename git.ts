// Git smart HTTP: upload-pack protocol v2 (ls-refs, fetch) and receive-pack v0 (push).
// No git binary, no child_process: node:http + node:zlib + node:crypto only (via gitpack.ts).
// Every request needs `Authorization: Bearer <token>`; missing repo => 404 JSON, server stays up.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Repo, Store } from './store.ts';
import { isAncestor, parseCommit, parseTree } from './gitobj.ts';
import { buildPack, parsePack } from './gitpack.ts';
import type { GitObject } from './store.ts';

export const ZERO_OID = '0'.repeat(40);

const FLUSH = Buffer.from('0000', 'ascii');
const HEX4 = /^[0-9a-fA-F]{4}$/;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Assemble pkt-lines into ONE buffer in a single pass (no per-line alloc+concat).
 * Each entry becomes its 4-hex length prefix followed by the payload; the FLUSH
 * sentinel is emitted raw as `0000` (a flush line carries no length prefix of its own).
 */
function pktJoin(lines: ReadonlyArray<string | Buffer>): Buffer {
  let total = 0;
  const bufs: Buffer[] = new Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const entry = lines[i] as string | Buffer;
    if (entry === FLUSH) { bufs[i] = FLUSH; total += 4; continue; }
    const data = typeof entry === 'string' ? Buffer.from(entry, 'utf8') : entry;
    bufs[i] = data;
    total += 4 + data.length;
  }
  const out = Buffer.allocUnsafe(total);
  let off = 0;
  for (const data of bufs) {
    if (data === FLUSH) { out.write('0000', off, 4, 'ascii'); off += 4; continue; }
    out.write((data.length + 4).toString(16).padStart(4, '0'), off, 4, 'ascii');
    data.copy(out, off + 4);
    off += 4 + data.length;
  }
  return out;
}

/** A fingerprint of everything a git smart-HTTP response depends on: the refs (name=oid)
 * plus the object count. Objects are immutable by sha and only ever added, so this pair
 * fully determines ls-refs / fetch / advertisement bytes for a repo. */
function gitFingerprint(repo: Repo): string {
  let fp = `n${repo.objects.size}|`;
  for (const [name, oid] of repo.refs) fp += `${name}=${oid};`;
  return fp;
}

/** Store a cached response, dropping the whole cache if it grows past a bound (a cache is
 * only a cache: dropping it never changes a response). */
function cachePut(map: Map<string, Buffer>, key: string, value: Buffer): void {
  if (map.size >= 1024) map.clear();
  map.set(key, value);
}

interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/**
 * Decode a whole buffer of pkt-lines. Returns the packets and the offset just past the
 * first flush packet (`restOffset`, -1 when there is none) so a receive-pack body can
 * hand its trailing raw pack bytes to the pack parser.
 */
function decodePktLines(buf: Buffer): { packets: Pkt[]; restOffset: number } {
  const packets: Pkt[] = [];
  let off = 0;
  let restOffset = -1;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!HEX4.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      restOffset = off;
      break;
    }
    if (len === 1) { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { packets.push({ kind: 'response-end', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 3 || len > 65520) throw new Error(`invalid pkt-line length ${len}`);
    if (off + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, restOffset };
}

/** `/owner/repo.git/rest...` => { owner, repo, rest } or null. No regex on the hot path. */
function parseGitPath(path: string): { owner: string; repo: string; rest: string } | null {
  if (path.length < 2 || path.charCodeAt(0) !== 0x2f) return null;
  const slash2 = path.indexOf('/', 1);
  if (slash2 < 0) return null;
  const owner = path.slice(1, slash2);
  const tail = path.slice(slash2 + 1);
  const gitSuffix = '.git';
  const gitAt = tail.indexOf(gitSuffix);
  if (gitAt <= 0) return null;
  const repo = tail.slice(0, gitAt);
  const after = tail.slice(gitAt + gitSuffix.length);
  if (after !== '' && after.charCodeAt(0) !== 0x2f) return null;
  let o = owner;
  let r = repo;
  if (owner.indexOf('%') >= 0) { try { o = decodeURIComponent(owner); } catch { /* keep raw */ } }
  if (repo.indexOf('%') >= 0) { try { r = decodeURIComponent(repo); } catch { /* keep raw */ } }
  if (!o || !r) return null;
  return { owner: o, repo: r, rest: after === '' ? '' : after.slice(1) };
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function headRefName(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The target object id of an annotated tag object (header `object <sha>`). */
function parseTagTarget(raw: Buffer): string {
  const text = raw.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) return line.slice(7).trim();
  }
  return '';
}

function headOid(repo: Repo): string | null {
  return repo.refs.get(headRefName(repo)) ?? null;
}

/** Follow an annotated tag (chain) to the object it peels to. */
function peelOid(repo: Repo, oid: string): string {
  let cur = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tag') return cur;
    cur = parseTagTarget(obj.data);
  }
  return cur;
}

function isTagObject(repo: Repo, oid: string): boolean {
  return repo.objects.get(oid)?.type === 'tag';
}

// -------------------------------------------------------------------------------------------
// v2 advertisement + v0 advertisements
// -------------------------------------------------------------------------------------------

/** The v2 capability advertisement is the same for every repo: build once, send forever. */
const V2_ADVERTISEMENT: Buffer = pktJoin([
  'version 2\n',
  'agent=forge/1.0\n',
  'ls-refs=unborn\n',
  'fetch=shallow filter\n',
  'object-format=sha1\n',
  FLUSH,
]);

function sendV2Advertisement(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-length': V2_ADVERTISEMENT.length });
  res.end(V2_ADVERTISEMENT);
}

function sendV0Advertisement(res: ServerResponse, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): void {
  const key = `${service}|${gitFingerprint(repo)}`;
  const cached = repo.v0AdvCache.get(key);
  if (cached !== undefined) {
    res.writeHead(200, { 'content-type': `application/x-${service}-advertisement`, 'content-length': cached.length });
    res.end(cached);
    return;
  }
  const refs = sortedRefs(repo);
  const head = headOid(repo);
  const caps = service === 'git-receive-pack'
    ? `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/1.0 symref=HEAD:${headRefName(repo)}`
    : `side-band-64k ofs-delta agent=forge/1.0 symref=HEAD:${headRefName(repo)}`;
  const lines: Array<string | Buffer> = [`# service=${service}\n`, FLUSH];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headLine = head ?? refs[0].oid;
    lines.push(`${headLine} HEAD\0${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      if (isTagObject(repo, ref.oid) && ref.name.startsWith('refs/tags/')) {
        lines.push(`${peelOid(repo, ref.oid)} ${ref.name}^{}\n`);
      }
    }
  }
  lines.push(FLUSH);
  const body = pktJoin(lines);
  cachePut(repo.v0AdvCache, key, body);
  res.writeHead(200, { 'content-type': `application/x-${service}-advertisement`, 'content-length': body.length });
  res.end(body);
}

// -------------------------------------------------------------------------------------------
// fetch object-set computation (shared by v2 fetch; v0 would reuse it too)
// -------------------------------------------------------------------------------------------

interface FetchPlan {
  packObjects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/**
 * Walk `roots` collecting every reachable object. When `cutParents` contains a commit,
 * that commit's tree/blobs are collected but its parents are not (a shallow boundary the
 * client already holds as a tip). `out` is filled in traversal order.
 */
function collectHeld(repo: Repo, roots: readonly string[], cutParents: ReadonlySet<string>, out: Set<string>): void {
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ZERO_OID || out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      if (!cutParents.has(oid)) for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tag') {
      stack.push(parseTagTarget(obj.data));
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') stack.push(e.sha);
    }
  }
}

function computeFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallow: readonly string[],
  depth: number | null,
  filter: string | null,
): FetchPlan {
  const shallowSet = new Set(shallow);
  const held = new Set<string>();
  if (haves.length > 0) collectHeld(repo, haves, shallowSet, held);

  // Wanted closure, BFS by commit distance from the wants (depth limits generations).
  const wanted = new Set<string>();
  const commitDist = new Map<string, number>();
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const w of wants) {
    if (w !== ZERO_OID) queue.push({ oid: w, dist: 0 });
  }
  let qhead = 0;
  while (qhead < queue.length) {
    const { oid, dist } = queue[qhead++];
    if (wanted.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit' && depth !== null && dist >= depth) continue;
    wanted.add(oid);
    if (obj.type === 'commit') {
      commitDist.set(oid, dist);
      const c = parseCommit(obj.data);
      queue.push({ oid: c.tree, dist });
      if (depth === null || dist + 1 < depth) {
        for (const p of c.parents) queue.push({ oid: p, dist: dist + 1 });
      }
    } else if (obj.type === 'tag') {
      queue.push({ oid: parseTagTarget(obj.data), dist });
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push({ oid: e.sha, dist });
    }
  }

  const newShallow: string[] = [];
  if (depth !== null) {
    for (const [oid, dist] of commitDist) {
      if (dist === depth - 1) newShallow.push(oid);
    }
    newShallow.sort();
  }
  const newShallowSet = new Set(newShallow);
  const unshallow: string[] = [];
  for (const s of shallowSet) {
    if (!wanted.has(s) || newShallowSet.has(s)) continue;
    if (depth === null || (commitDist.get(s) ?? 0) < depth - 1) unshallow.push(s);
  }
  unshallow.sort();

  const acks: string[] = [];
  for (const h of haves) if (repo.objects.has(h)) acks.push(h);

  const packObjects: GitObject[] = [];
  for (const oid of wanted) {
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (filter === 'blob:none' && obj.type === 'blob') continue;
    if (filter === 'tree:0' && (obj.type === 'blob' || obj.type === 'tree')) continue;
    packObjects.push(obj);
  }
  return { packObjects, shallow: newShallow, unshallow, acks };
}

// -------------------------------------------------------------------------------------------
// protocol v2: ls-refs / fetch
// -------------------------------------------------------------------------------------------

function handleLsRefs(repo: Repo, args: string[], res: ServerResponse): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const key = `${args.join('\n')}|${gitFingerprint(repo)}`;
  const cached = repo.lsRefsCache.get(key);
  if (cached !== undefined) {
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': cached.length });
    res.end(cached);
    return;
  }
  const lines: Array<string | Buffer> = [];
  const head = headOid(repo);
  const refs = sortedRefs(repo);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (prefixes.length === 0) {
    if (head !== null) {
      lines.push(`${head} HEAD${symrefs ? ` symref-target:${headRefName(repo)}` : ''}\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${headRefName(repo)}` : ''}\n`);
    }
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && isTagObject(repo, ref.oid)) line += ` peeled:${peelOid(repo, ref.oid)}`;
    lines.push(`${line}\n`);
  }
  lines.push(FLUSH);
  const body = pktJoin(lines);
  cachePut(repo.lsRefsCache, key, body);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': body.length });
  res.end(body);
}

const SIDEBAND_CHUNK = 32768;

function handleFetchV2(repo: Repo, args: string[], res: ServerResponse): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let filter: string | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = parseInt(arg.slice(7), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    } else if (arg.startsWith('filter ')) {
      filter = arg.slice(7).trim();
    }
    // thin-pack, no-progress, ofs-delta, done, deepen-since, deepen-not: no server action needed.
  }
  // The fetch answer is fully determined by the request args + the repo state fingerprint
  // (objects are immutable by sha; refs + object count pin the rest), so identical clones
  // share one cached response.
  const key = `w:${wants.join(',')}|h:${haves.join(',')}|s:${shallow.join(',')}|d:${depth ?? ''}|f:${filter ?? ''}|${gitFingerprint(repo)}`;
  const cached = repo.fetchCache.get(key);
  if (cached !== undefined) {
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': cached.length });
    res.end(cached);
    return;
  }
  const plan = computeFetch(repo, wants, haves, shallow, depth, filter);
  const pack = buildPack(plan.packObjects);

  const lines: Array<string | Buffer> = [];
  // acknowledgments section
  lines.push('acknowledgments\n');
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) lines.push(`ACK ${ack}\n`);
    lines.push('ready\n');
  } else {
    lines.push('NAK\n');
  }
  lines.push(FLUSH);
  // shallow-info section (only when there is something to report)
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    lines.push('shallow-info\n');
    for (const s of plan.shallow) lines.push(`shallow ${s}\n`);
    for (const s of plan.unshallow) lines.push(`unshallow ${s}\n`);
    lines.push(FLUSH);
  }
  // packfile section, sideband band 1
  lines.push('packfile\n');
  for (let off = 0; off < pack.length; off += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + SIDEBAND_CHUNK));
    lines.push(Buffer.concat([Buffer.from([1]), chunk]));
  }
  lines.push(FLUSH);
  const body = pktJoin(lines);
  cachePut(repo.fetchCache, key, body);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': body.length });
  res.end(body);
}

function handleUploadPack(repo: Repo, body: Buffer, res: ServerResponse): void {
  const { packets } = decodePktLines(body);
  let command: string | null = null;
  const args: string[] = [];
  let seenDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') { seenDelim = true; continue; }
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      // agent= / object-format= before the delim: ignored.
    } else {
      args.push(line);
    }
  }
  if (command === 'ls-refs') handleLsRefs(repo, args, res);
  else if (command === 'fetch') handleFetchV2(repo, args, res);
  else throw new Error(`unknown upload-pack command ${JSON.stringify(command)}`);
}

// -------------------------------------------------------------------------------------------
// receive-pack v0: push
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Build a report-status response in ONE buffer (no per-line alloc+concat). Byte-identical
 * to the pkt()/concat construction it replaces: each line is an inner pkt-line, wrapped in
 * a band-1 outer pkt-line when sideband is on, ending with a band-1 flush + bare flush. */
function buildReceiveReport(lines: string[], sideband: boolean): Buffer {
  const lineBufs: Buffer[] = new Array(lines.length);
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const lb = Buffer.from(lines[i] as string, 'utf8');
    lineBufs[i] = lb;
    total += sideband ? 9 + lb.length : 4 + lb.length;
  }
  total += sideband ? 13 : 4;
  const out = Buffer.allocUnsafe(total);
  let off = 0;
  for (const lb of lineBufs) {
    if (sideband) {
      out.write((9 + lb.length).toString(16).padStart(4, '0'), off, 4, 'ascii'); off += 4;
      out[off++] = 1;
    }
    out.write((4 + lb.length).toString(16).padStart(4, '0'), off, 4, 'ascii'); off += 4;
    lb.copy(out, off); off += lb.length;
  }
  if (sideband) {
    out.write('0009', off, 4, 'ascii'); off += 4;
    out[off++] = 1;
    out.write('0000', off, 4, 'ascii'); off += 4;
    out.write('0000', off, 4, 'ascii'); off += 4;
  } else {
    out.write('0000', off, 4, 'ascii'); off += 4;
  }
  return out;
}

function handleReceivePack(repo: Repo, body: Buffer, res: ServerResponse): void {
  // Fast path: the common push is exactly one command pkt-line, a flush, then the raw pack.
  // Anything else falls back to the full pkt-line decoder below (identical behaviour).
  let commands: PushCommand[] | null = null;
  let sideband = true;
  let restOffset = -1;
  if (body.length >= 8) {
    const head = body.subarray(0, 4).toString('ascii');
    if (HEX4.test(head)) {
      const len = parseInt(head, 16);
      if (len >= 5 && len <= body.length - 4 && body.subarray(len, len + 4).toString('ascii') === '0000') {
        let line = body.subarray(4, len).toString('utf8');
        if (line.endsWith('\n')) line = line.slice(0, -1);
        const nul = line.indexOf('\0');
        if (nul >= 0) {
          sideband = line.slice(nul + 1).split(' ').includes('side-band-64k');
          line = line.slice(0, nul);
        }
        const parts = line.split(' ');
        if (parts.length >= 3) {
          commands = [{ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string }];
          restOffset = len + 4;
        }
      }
    }
  }
  if (commands === null) {
    const { packets, restOffset: ro } = decodePktLines(body);
    const list: PushCommand[] = [];
    let first = true;
    for (const p of packets) {
      if (p.kind === 'flush') break;
      if (p.kind !== 'data') continue;
      let line = p.payload.toString('utf8').replace(/\n$/, '');
      if (first) {
        first = false;
        const nul = line.indexOf('\0');
        if (nul >= 0) {
          sideband = line.slice(nul + 1).split(' ').includes('side-band-64k');
          line = line.slice(0, nul);
        }
      }
      const parts = line.split(' ');
      if (parts.length < 3) throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
      list.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
    if (list.length === 0) throw new Error('receive-pack with no commands');
    commands = list;
    restOffset = ro;
  }

  // The pack (if any) follows the flush pkt-line, raw.
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = restOffset >= 0 ? body.subarray(restOffset) : Buffer.alloc(0);
  if (packBytes.length > 0) {
    try {
      const parsed = parsePack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of parsed.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  // Apply commands, fast-forward only, per ref.
  const lines: string[] = [];
  lines.push(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`);
  for (const cmd of commands) {
    let ok = false;
    let reason = '';
    if (!unpackOk) {
      reason = 'unpack failed';
    } else if (cmd.newOid === ZERO_OID) {
      // Delete.
      const cur = repo.refs.get(cmd.ref);
      if (cur === undefined) reason = 'ref does not exist';
      else if (cmd.oldOid !== ZERO_OID && cur !== cmd.oldOid) reason = 'non-fast-forward';
      else { repo.refs.delete(cmd.ref); ok = true; }
    } else if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (repo.refs.has(cmd.ref)) reason = 'already exists';
      else if (!repo.objects.has(cmd.newOid)) reason = 'missing object';
      else { repo.refs.set(cmd.ref, cmd.newOid); ok = true; }
    } else {
      // Update.
      const cur = repo.refs.get(cmd.ref);
      if (cur === undefined) reason = 'ref does not exist';
      else if (cur !== cmd.oldOid) reason = 'non-fast-forward';
      else if (!repo.objects.has(cmd.newOid)) reason = 'missing object';
      else {
        // Fast-forward: old must be an ancestor of (or equal to) new.
        if (isAncestor(repo.objects, cmd.oldOid, cmd.newOid)) {
          repo.refs.set(cmd.ref, cmd.newOid);
          ok = true;
        } else {
          reason = 'non-fast-forward';
        }
      }
    }
    lines.push(ok ? `ok ${cmd.ref}\n` : `ng ${cmd.ref} ${reason}\n`);
  }

  const reportBody = buildReceiveReport(lines, sideband);
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': reportBody.length });
  res.end(reportBody);
}

// -------------------------------------------------------------------------------------------
// entry point
// -------------------------------------------------------------------------------------------

export async function handleGit(req: IncomingMessage, res: ServerResponse, store: Store, auth: string): Promise<boolean> {
  const rawUrl = req.url ?? '/';
  const qIndex = rawUrl.indexOf('?');
  const pathname = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
  const parsed = parseGitPath(pathname);
  if (!parsed) return false;
  // The only query parameter the git surface reads.
  let service: string | null = null;
  if (qIndex >= 0) {
    const qs = rawUrl.slice(qIndex + 1);
    const si = qs.indexOf('service=');
    if (si >= 0) {
      const amp = qs.indexOf('&', si + 8);
      service = amp >= 0 ? qs.slice(si + 8, amp) : qs.slice(si + 8);
      if (service.indexOf('%') >= 0) { try { service = decodeURIComponent(service); } catch { /* keep raw */ } }
    }
  }

  try {
    if ((req.headers.authorization ?? '') !== auth) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return true;
    }
    const method = req.method ?? 'GET';
    const repo = store.resolveRepo(parsed.owner, parsed.repo);
    if (method === 'GET' && parsed.rest === 'info/refs') {
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (service === 'git-receive-pack') {
        sendV0Advertisement(res, repo, 'git-receive-pack');
      } else if ((req.headers['git-protocol'] ?? '') === 'version=0') {
        sendV0Advertisement(res, repo, 'git-upload-pack');
      } else {
        sendV2Advertisement(res);
      }
      return true;
    }
    // POST paths need the repo to exist; a push cannot invent one.
    if (method === 'POST' && (parsed.rest === 'git-upload-pack' || parsed.rest === 'git-receive-pack')) {
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      const body = await readBody(req);
      if (parsed.rest === 'git-upload-pack') handleUploadPack(repo, body, res);
      else handleReceivePack(repo, body, res);
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  } catch (err) {
    if (!res.headersSent) sendJson(res, 400, { message: err instanceof Error ? err.message : 'Bad Request' });
    return true;
  }
}
