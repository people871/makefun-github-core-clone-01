// Pure git object helpers (no I/O). Used by REST (contents commits, PR merge squash)
// and by git.ts (pack codec). SHA-1 via node:crypto, zlib via node:zlib (in git.ts).
import { createHash } from 'node:crypto';
import { FIXED_GIT_IDENT, FIXED_GIT_TIME } from './store.ts';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of a (type, content) pair: sha1("type len\0" + content). */
export function objectId(type: 'commit' | 'tree' | 'blob' | 'tag', content: Buffer): string {
  const header = Buffer.from(`${type} ${content.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(content).digest('hex');
}

export function buildBlob(content: Buffer): { sha: string; raw: Buffer } {
  return { sha: objectId('blob', content), raw: content };
}

export interface TreeEntry { mode: string; name: string; sha: string; }

/** Build a tree object from entries. Entries are sorted git-style (names, dirs with "/"). */
export function buildTree(entries: TreeEntry[]): { sha: string; raw: Buffer } {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  const raw = Buffer.concat(parts);
  return { sha: objectId('tree', raw), raw };
}

/** Parse a tree object into entries (in stored order). */
export function parseTree(raw: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < raw.length) {
    const sp = raw.indexOf(0x20, off);
    const nul = raw.indexOf(0x00, sp);
    const mode = raw.subarray(off, sp).toString('ascii');
    const name = raw.subarray(sp + 1, nul).toString('utf8');
    const sha = raw.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    off = nul + 21;
  }
  return entries;
}

export interface CommitData {
  tree: string; parents: string[];
  authorName: string; authorEmail: string; authorTime: number; authorTz: string;
  committerName: string; committerEmail: string; committerTime: number; committerTz: string;
  message: string;
}

export function buildCommit(c: CommitData): { sha: string; raw: Buffer } {
  const lines: string[] = [];
  lines.push(`tree ${c.tree}`);
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.authorName} <${c.authorEmail}> ${c.authorTime} ${c.authorTz}`);
  lines.push(`committer ${c.committerName} <${c.committerEmail}> ${c.committerTime} ${c.committerTz}`);
  const raw = Buffer.from(`${lines.join('\n')}\n\n${c.message}`, 'utf8');
  return { sha: objectId('commit', raw), raw };
}

/** Build a commit with the forge's fixed ident (deterministic across runs). */
export function buildFixedCommit(tree: string, parents: string[], message: string): { sha: string; raw: Buffer } {
  return buildCommit({
    tree, parents,
    authorName: FIXED_GIT_IDENT.name, authorEmail: FIXED_GIT_IDENT.email,
    authorTime: FIXED_GIT_TIME, authorTz: '+0000',
    committerName: FIXED_GIT_IDENT.name, committerEmail: FIXED_GIT_IDENT.email,
    committerTime: FIXED_GIT_TIME, committerTz: '+0000',
    message,
  });
}

export function parseCommit(raw: Buffer): CommitData {
  const text = raw.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const c: CommitData = {
    tree: '', parents: [], authorName: '', authorEmail: '', authorTime: 0, authorTz: '+0000',
    committerName: '', committerEmail: '', committerTime: 0, committerTz: '+0000', message,
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) c.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) c.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const m = line.slice(7).match(/^(.*) <(.*)> (\d+) ([+-]\d+)$/);
      if (m) { c.authorName = m[1]; c.authorEmail = m[2]; c.authorTime = Number(m[3]); c.authorTz = m[4]; }
    } else if (line.startsWith('committer ')) {
      const m = line.slice(10).match(/^(.*) <(.*)> (\d+) ([+-]\d+)$/);
      if (m) { c.committerName = m[1]; c.committerEmail = m[2]; c.committerTime = Number(m[3]); c.committerTz = m[4]; }
    }
  }
  return c;
}

/** Is `ancestor` an ancestor of (or equal to) `descendant`, walking first parents + all parents? */
export function isAncestor(
  objects: Map<string, { type: string; data: Buffer }>,
  ancestor: string, descendant: string,
): boolean {
  if (ancestor === descendant) return true;
  // Fast path: the common case (a push) is a direct parent link.
  const head = objects.get(descendant);
  if (head && head.type === 'commit') {
    const c = parseCommit(head.data);
    if (c.parents.includes(ancestor)) return true;
    if (c.parents.length === 0) return false;
  }
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    for (const p of c.parents) {
      if (p === ancestor) return true;
      stack.push(p);
    }
  }
  return false;
}

/** Walk all commits reachable from `tip` (newest first by traversal order). */
export function walkCommits(
  objects: Map<string, { type: string; data: Buffer }>,
  tip: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = objects.get(sha);
    if (!obj || obj.type !== 'commit') continue;
    out.push(sha);
    const c = parseCommit(obj.data);
    for (const p of c.parents) stack.push(p);
  }
  return out;
}
