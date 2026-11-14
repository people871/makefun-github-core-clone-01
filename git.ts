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
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** One pkt-line: 4 hex length bytes (payload + 4) then the payload. */
function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
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
  try { o = decodeURIComponent(owner); r = decodeURIComponent(repo); } catch { /* keep raw */ }
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

function sendV2Advertisement(res: ServerResponse): void {
  const parts = [
    pkt('version 2\n'),
    pkt('agent=forge/1.0\n'),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow filter\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ];
  const body = Buffer.concat(parts);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-length': body.length });
  res.end(body);
}

function sendV0Advertisement(res: ServerResponse, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): void {
  const refs = sortedRefs(repo);
  const head = headOid(repo);
  const caps = service === 'git-receive-pack'
    ? `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/1.0 symref=HEAD:${headRefName(repo)}`
    : `side-band-64k ofs-delta agent=forge/1.0 symref=HEAD:${headRefName(repo)}`;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headLine = head ?? refs[0].oid;
    parts.push(pkt(`${headLine} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pkt(`${ref.oid} ${ref.name}\n`));
      if (isTagObject(repo, ref.oid) && ref.name.startsWith('refs/tags/')) {
        parts.push(pkt(`${peelOid(repo, ref.oid)} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(FLUSH);
  const body = Buffer.concat(parts);
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
  const parts: Buffer[] = [];
  const head = headOid(repo);
  const refs = sortedRefs(repo);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (prefixes.length === 0) {
    if (head !== null) {
      parts.push(pkt(`${head} HEAD${symrefs ? ` symref-target:${headRefName(repo)}` : ''}\n`));
    } else if (unborn) {
      parts.push(pkt(`unborn HEAD${symrefs ? ` symref-target:${headRefName(repo)}` : ''}\n`));
    }
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && isTagObject(repo, ref.oid)) line += ` peeled:${peelOid(repo, ref.oid)}`;
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  const body = Buffer.concat(parts);
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
  const plan = computeFetch(repo, wants, haves, shallow, depth, filter);
  const pack = buildPack(plan.packObjects);

  const parts: Buffer[] = [];
  // acknowledgments section
  parts.push(pkt('acknowledgments\n'));
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pkt(`ACK ${ack}\n`));
    parts.push(pkt('ready\n'));
  } else {
    parts.push(pkt('NAK\n'));
  }
  parts.push(FLUSH);
  // shallow-info section (only when there is something to report)
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pkt(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pkt(`unshallow ${s}\n`));
    parts.push(FLUSH);
  }
  // packfile section, sideband band 1
  parts.push(pkt('packfile\n'));
  for (let off = 0; off < pack.length; off += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + SIDEBAND_CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pkt(payload));
  }
  parts.push(FLUSH);
  const body = Buffer.concat(parts);
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

function handleReceivePack(repo: Repo, body: Buffer, res: ServerResponse): void {
  const { packets, restOffset } = decodePktLines(body);
  const commands: PushCommand[] = [];
  let sideband = true;
  let first = true;
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8').replace(/\n$/, '');
    if (first) {
      first = false;
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        // Capabilities the client sent (report-status, side-band-64k, ...).
        sideband = line.slice(nul + 1).split(' ').includes('side-band-64k');
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length < 3) throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) throw new Error('receive-pack with no commands');

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

  const reportParts: Buffer[] = [];
  for (const line of lines) {
    const inner = pkt(line);
    reportParts.push(sideband ? pkt(Buffer.concat([Buffer.from([1]), inner])) : inner);
  }
  // The report-status stream itself ends with a flush pkt-line.
  reportParts.push(sideband ? pkt(Buffer.concat([Buffer.from([1]), FLUSH])) : FLUSH);
  if (sideband) reportParts.push(FLUSH);
  const responseBody = Buffer.concat(reportParts);
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': responseBody.length });
  res.end(responseBody);
}

// -------------------------------------------------------------------------------------------
// entry point
// -------------------------------------------------------------------------------------------

export async function handleGit(req: IncomingMessage, res: ServerResponse, store: Store, token: string): Promise<boolean> {
  let pathname: string;
  let query: URLSearchParams;
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    pathname = url.pathname;
    query = url.searchParams;
  } catch {
    return false;
  }
  const parsed = parseGitPath(pathname);
  if (!parsed) return false;

  try {
    if ((req.headers.authorization ?? '') !== `Bearer ${token}`) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return true;
    }
    const method = req.method ?? 'GET';
    const repo = store.resolveRepo(parsed.owner, parsed.repo);
    if (method === 'GET' && parsed.rest === 'info/refs') {
      const service = query.get('service');
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
