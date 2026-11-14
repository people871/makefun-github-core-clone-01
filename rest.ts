// REST v3 API layer (/api/v3/*) for the github-core-clone-01 forge.
// Node 22 stdlib only. Deterministic: no wall-clock time, no Math.random.
// One shared Store instance; owner pinning via store.resolveRepo.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store.ts';
import type { Repo, Issue, Pull } from './store.ts';
import { buildBlob, buildTree, parseTree, buildFixedCommit, parseCommit } from './gitobj.ts';
import type { TreeEntry } from './gitobj.ts';

const FIXED_TS = '2023-11-14T22:13:20Z'; // 1700000000 UTC, deterministic for all REST timestamps
const VERSION = '1.0.0';

function isoFromUnix(t: number): string {
  if (!t || !Number.isFinite(t)) return FIXED_TS;
  try {
    return new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  } catch {
    return FIXED_TS;
  }
}

function ownerOf(repo: Repo, store: Store): string {
  return repo.ownerLogin ?? store.viewerLogin ?? 'viewer';
}

function dec(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function send(res: ServerResponse, store: Store, status: number, body: unknown, extra?: Record<string, string>): void {
  const text = body === null || body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': store.nextRequestId(),
    'content-length': String(Buffer.byteLength(text)),
  };
  if (extra) for (const k of Object.keys(extra)) headers[k] = extra[k] as string;
  res.writeHead(status, headers);
  res.end(text);
}

function sendErr(res: ServerResponse, store: Store, status: number, message: string): void {
  send(res, store, status, { message });
}

function readBodyText(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c: Buffer) => { data += c.toString('utf8'); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(data));
  });
}

/** Parse a request JSON body. Returns {ok:false} on malformed JSON, {ok:true,value:{}} on empty body. */
async function readJson(req: IncomingMessage): Promise<{ ok: boolean; value: any }> {
  const text = await readBodyText(req);
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false, value: null };
  }
}

// ---------------------------------------------------------------------------------------------
// JSON shapes

function repoJson(repo: Repo, store: Store): Record<string, unknown> {
  const owner = ownerOf(repo, store);
  const full = `${owner}/${repo.name}`;
  return {
    id: repo.id,
    name: repo.name,
    full_name: full,
    owner: { login: owner, id: repo.ownerId, type: 'User', html_url: `https://example.invalid/${owner}` },
    description: repo.description,
    private: repo.private,
    fork: false,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${full}`,
    url: `https://api.example.invalid/repos/${full}`,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    pushed_at: FIXED_TS,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    visibility: repo.private ? 'private' : 'public',
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
  };
}

function labelJson(repo: Repo, store: Store, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    name,
    color: label ? label.color : 'ededed',
    description: label ? label.description : null,
    url: `https://api.example.invalid/repos/${ownerOf(repo, store)}/${repo.name}/labels/${encodeURIComponent(name)}`,
  };
}

function issueJson(repo: Repo, store: Store, issue: Issue): Record<string, unknown> {
  const owner = ownerOf(repo, store);
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, store, name)),
    comments: issue.comments.length,
    user: { login: owner, id: store.viewerId, type: 'User' },
    assignee: null,
    milestone: null,
    locked: false,
    html_url: `https://example.invalid/${owner}/${repo.name}/issues/${issue.number}`,
    url: `https://api.example.invalid/repos/${owner}/${repo.name}/issues/${issue.number}`,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    closed_at: issue.state === 'closed' ? FIXED_TS : null,
  };
}

function pullJson(repo: Repo, store: Store, pull: Pull): Record<string, unknown> {
  const owner = ownerOf(repo, store);
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? FIXED_TS : null,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headBranch, sha: pull.headSha, label: `${owner}:${pull.headBranch}` },
    base: { ref: pull.baseBranch, sha: pull.baseSha, label: `${owner}:${pull.baseBranch}` },
    user: { login: owner, id: store.viewerId, type: 'User' },
    draft: false,
    html_url: `https://example.invalid/${owner}/${repo.name}/pull/${pull.number}`,
    url: `https://api.example.invalid/repos/${owner}/${repo.name}/pulls/${pull.number}`,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    closed_at: pull.state === 'closed' ? FIXED_TS : null,
  };
}

function commentJson(repo: Repo, store: Store, issue: Issue, c: { id: number; body: string }): Record<string, unknown> {
  const owner = ownerOf(repo, store);
  return {
    id: c.id,
    body: c.body,
    user: { login: owner, id: store.viewerId, type: 'User' },
    html_url: `https://example.invalid/${owner}/${repo.name}/issues/${issue.number}#issuecomment-${c.id}`,
    url: `https://api.example.invalid/repos/${owner}/${repo.name}/issues/comments/${c.id}`,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
  };
}

// ---------------------------------------------------------------------------------------------
// Pagination

interface PageParams { page: number; perPage: number; }

function pageParams(q: URLSearchParams): PageParams {
  let perPage = 30;
  const pp = q.get('per_page');
  if (pp !== null) {
    const n = parseInt(pp, 10);
    if (Number.isFinite(n) && n > 0) perPage = Math.min(n, 100);
  }
  let page = 1;
  const pg = q.get('page');
  if (pg !== null) {
    const n = parseInt(pg, 10);
    if (Number.isFinite(n) && n > 0) page = n;
  }
  return { page, perPage };
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host;
  return `http://${host && host.length > 0 ? host : 'localhost'}`;
}

/** Link header with rel="next" (and rel="last") when more pages remain. */
function linkHeader(req: IncomingMessage, path: string, q: URLSearchParams, page: number, perPage: number, total: number): string | null {
  if (page * perPage >= total) return null;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const nextQ = new URLSearchParams(q);
  nextQ.set('page', String(page + 1));
  nextQ.set('per_page', String(perPage));
  const lastQ = new URLSearchParams(q);
  lastQ.set('page', String(lastPage));
  lastQ.set('per_page', String(perPage));
  const origin = originOf(req);
  return `<${origin}${path}?${nextQ.toString()}>; rel="next", <${origin}${path}?${lastQ.toString()}>; rel="last"`;
}

function paginate<T>(items: T[], page: number, perPage: number): T[] {
  const start = (page - 1) * perPage;
  if (start >= items.length) return [];
  return items.slice(start, start + perPage);
}

// ---------------------------------------------------------------------------------------------
// Git tree helpers (contents commits, PR files, merge)

function commitTreeSha(repo: Repo, commitSha: string): string | null {
  const obj = repo.objects.get(commitSha);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

function flattenTree(repo: Repo, treeSha: string, prefix: string, out: Map<string, string>): void {
  const obj = repo.objects.get(treeSha);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') flattenTree(repo, e.sha, p, out);
    else out.set(p, e.sha);
  }
}

function flattenAtCommit(repo: Repo, commitSha: string): Map<string, string> {
  const out = new Map<string, string>();
  const treeSha = commitTreeSha(repo, commitSha);
  if (treeSha) flattenTree(repo, treeSha, '', out);
  return out;
}

/** Rebuild every tree for a flat path->blob map; stores the tree objects; returns the root tree sha. */
function buildTreeFromFlat(repo: Repo, flat: Map<string, string>): string {
  function buildDir(prefix: string): string {
    const files: { name: string; sha: string }[] = [];
    const dirs = new Set<string>();
    for (const key of flat.keys()) {
      if (prefix !== '') {
        if (!key.startsWith(prefix + '/')) continue;
      }
      const rest = prefix === '' ? key : key.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        const sha = flat.get(key);
        if (sha !== undefined) files.push({ name: rest, sha });
      } else {
        dirs.add(rest.slice(0, slash));
      }
    }
    const entries: TreeEntry[] = [];
    for (const f of files) entries.push({ mode: '100644', name: f.name, sha: f.sha });
    for (const d of dirs) entries.push({ mode: '40000', name: d, sha: buildDir(prefix === '' ? d : `${prefix}/${d}`) });
    const t = buildTree(entries);
    repo.objects.set(t.sha, { type: 'tree', data: t.raw });
    return t.sha;
  }
  return buildDir('');
}

/** Create a fixed-ident commit, store it, return its sha. */
function makeCommit(repo: Repo, treeSha: string, parents: string[], message: string): string {
  const c = buildFixedCommit(treeSha, parents, message);
  repo.objects.set(c.sha, { type: 'commit', data: c.raw });
  return c.sha;
}

/** Resolve a branch name / full ref / commit sha to a commit sha. */
function resolveRefToCommit(repo: Repo, ref: string): string | null {
  if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
  const heads = `refs/heads/${ref}`;
  if (repo.refs.has(heads)) return repo.refs.get(heads) as string;
  const tags = `refs/tags/${ref}`;
  if (repo.refs.has(tags)) {
    const target = repo.refs.get(tags) as string;
    const obj = repo.objects.get(target);
    if (obj && obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (m) return m[1] as string;
    }
    return target;
  }
  if (/^[0-9a-f]{40}$/i.test(ref) && repo.objects.has(ref)) return ref;
  return null;
}

function branchNameOf(value: string): string {
  const idx = value.indexOf(':');
  return idx >= 0 ? value.slice(idx + 1) : value;
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const oldLines = oldData.length === 0 ? [] : oldData.toString('utf8').split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  const newLines = newData.length === 0 ? [] : newData.toString('utf8').split('\n');
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const freq = new Map<string, number>();
  for (const line of oldLines) freq.set(line, (freq.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const c = freq.get(line) ?? 0;
    if (c > 0) freq.set(line, c - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const c of freq.values()) deletions += c;
  return { additions, deletions };
}

function blobData(repo: Repo, sha: string): Buffer {
  const obj = repo.objects.get(sha);
  return obj && obj.type === 'blob' ? obj.data : Buffer.alloc(0);
}

// ---------------------------------------------------------------------------------------------
// Handlers

export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store, token: string): Promise<boolean> {
  const rawUrl = req.url ?? '/';
  const qIndex = rawUrl.indexOf('?');
  const rawPath = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
  if (rawPath !== '/api/v3' && !rawPath.startsWith('/api/v3/')) return false;
  const queryString = qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '';
  const method = (req.method ?? 'GET').toUpperCase();

  // Auth: every /api/v3 request needs the bearer token.
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${token}`) {
    sendErr(res, store, 401, 'Bad credentials');
    return true;
  }

  const segments = rawPath.split('/').filter((s) => s.length > 0).map(dec);
  // segments[0] = 'api', segments[1] = 'v3'
  const tail = segments.slice(2);
  const lazyQuery = (): URLSearchParams => new URLSearchParams(queryString);

  // ---- GET /api/v3/ (root) ----
  if (tail.length === 0) {
    if (method !== 'GET') {
      sendErr(res, store, 404, 'Not Found');
      return true;
    }
    const origin = originOf(req);
    send(res, store, 200, {
      current_user_url: `${origin}/api/v3/user`,
      current_user_authorizations_html_url: `${origin}/api/v3/authorizations`,
      authorizations_url: `${origin}/api/v3/authorizations`,
      code_search_url: `${origin}/api/v3/search/code?q={query}`,
      commit_search_url: `${origin}/api/v3/search/commits?q={query}`,
      emails_url: `${origin}/api/v3/user/emails`,
      emojis_url: `${origin}/api/v3/emojis`,
      events_url: `${origin}/api/v3/events`,
      feeds_url: `${origin}/api/v3/feeds`,
      followers_url: `${origin}/api/v3/user/followers`,
      following_url: `${origin}/api/v3/user/following{/target}`,
      gists_url: `${origin}/api/v3/gists{/gist_id}`,
      hub_url: `${origin}/api/v3/hub`,
      issue_search_url: `${origin}/api/v3/search/issues?q={query}`,
      issues_url: `${origin}/api/v3/issues`,
      keys_url: `${origin}/api/v3/user/keys`,
      label_search_url: `${origin}/api/v3/search/labels?q={query}`,
      notifications_url: `${origin}/api/v3/notifications`,
      organization_url: `${origin}/api/v3/orgs/{org}`,
      organization_repositories_url: `${origin}/api/v3/orgs/{org}/repos`,
      organization_teams_url: `${origin}/api/v3/orgs/{org}/teams`,
      public_gists_url: `${origin}/api/v3/gists/public`,
      rate_limit_url: `${origin}/api/v3/rate_limit`,
      repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: `${origin}/api/v3/search/repositories?q={query}`,
      current_user_repositories_url: `${origin}/api/v3/user/repos`,
      starred_url: `${origin}/api/v3/user/starred{/owner}{/repo}`,
      starred_gists_url: `${origin}/api/v3/gists/starred`,
      topic_search_url: `${origin}/api/v3/search/topics?q={query}`,
      user_url: `${origin}/api/v3/users/{user}`,
      user_organizations_url: `${origin}/api/v3/users/{user}/orgs`,
      user_repositories_url: `${origin}/api/v3/users/{user}/repos`,
      user_search_url: `${origin}/api/v3/search/users?q={query}`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // ---- GET /api/v3/meta ----
  if (tail.length === 1 && tail[0] === 'meta') {
    if (method !== 'GET') {
      sendErr(res, store, 404, 'Not Found');
      return true;
    }
    send(res, store, 200, { installed_version: VERSION });
    return true;
  }

  // ---- GET /api/v3/user ----
  if (tail.length === 1 && tail[0] === 'user') {
    if (method !== 'GET') {
      sendErr(res, store, 404, 'Not Found');
      return true;
    }
    const v = store.viewer();
    send(res, store, 200, {
      login: v.login, id: v.id, name: v.name, email: v.email, type: 'User',
      html_url: `https://example.invalid/${v.login}`,
      url: `${originOf(req)}/api/v3/users/${encodeURIComponent(v.login)}`,
      created_at: FIXED_TS, updated_at: FIXED_TS,
    });
    return true;
  }

  // ---- /api/v3/user/repos ----
  if (tail.length === 2 && tail[0] === 'user' && tail[1] === 'repos') {
    if (method === 'GET') {
      const q = lazyQuery();
      const { page, perPage } = pageParams(q);
      const all = store.listRepos();
      const slice = paginate(all, page, perPage);
      const link = linkHeader(req, '/api/v3/user/repos', q, page, perPage, all.length);
      send(res, store, 200, slice.map((r) => repoJson(r, store)), link ? { link } : undefined);
      return true;
    }
    if (method === 'POST') {
      const parsed = await readJson(req);
      if (!parsed.ok) {
        sendErr(res, store, 400, 'Invalid JSON body');
        return true;
      }
      const body = parsed.value ?? {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '') {
        sendErr(res, store, 422, 'name is required');
        return true;
      }
      if (store.reposByName.has(name)) {
        sendErr(res, store, 422, 'Repository already exists');
        return true;
      }
      const repo = store.createRepo(name, {
        description: typeof body.description === 'string' ? body.description : (body.description === null ? null : undefined),
        private: body.private === true,
        defaultBranch: typeof body.default_branch === 'string' && body.default_branch !== '' ? body.default_branch : undefined,
      });
      send(res, store, 201, repoJson(repo, store));
      return true;
    }
    sendErr(res, store, 404, 'Not Found');
    return true;
  }

  // ---- /api/v3/repos/{owner}/{name}/... ----
  if (tail.length >= 3 && tail[0] === 'repos') {
    const owner = tail[1] as string;
    const name = tail[2] as string;
    const rest = tail.slice(3);
    const repo = store.resolveRepo(owner, name);
    if (!repo) {
      sendErr(res, store, 404, 'Not Found');
      return true;
    }

    // GET/PATCH/DELETE /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') {
        send(res, store, 200, repoJson(repo, store));
        return true;
      }
      if (method === 'PATCH') {
        const parsed = await readJson(req);
        if (!parsed.ok) {
          sendErr(res, store, 400, 'Invalid JSON body');
          return true;
        }
        const body = parsed.value ?? {};
        if ('description' in body && (typeof body.description === 'string' || body.description === null)) {
          repo.description = body.description;
        }
        if (typeof body.default_branch === 'string' && body.default_branch !== '') {
          repo.defaultBranch = body.default_branch;
        }
        if (typeof body.private === 'boolean') repo.private = body.private;
        send(res, store, 200, repoJson(repo, store));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(name);
        send(res, store, 204, null);
        return true;
      }
      sendErr(res, store, 404, 'Not Found');
      return true;
    }

    // POST /repos/{o}/{r}/git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs') {
      if (method !== 'POST') {
        sendErr(res, store, 404, 'Not Found');
        return true;
      }
      const parsed = await readJson(req);
      if (!parsed.ok) {
        sendErr(res, store, 400, 'Invalid JSON body');
        return true;
      }
      const body = parsed.value ?? {};
      if (typeof body.ref !== 'string' || body.ref === '' || typeof body.sha !== 'string' || !/^[0-9a-f]{40}$/i.test(body.sha)) {
        sendErr(res, store, 422, 'ref and sha are required');
        return true;
      }
      repo.refs.set(body.ref, body.sha.toLowerCase());
      send(res, store, 201, {
        ref: body.ref,
        object: { sha: body.sha.toLowerCase(), type: 'commit' },
        url: `https://api.example.invalid/repos/${owner}/${name}/git/refs/${encodeURIComponent(body.ref)}`,
      });
      return true;
    }

    // GET /repos/{o}/{r}/branches
    if (rest.length === 1 && rest[0] === 'branches') {
      if (method !== 'GET') {
        sendErr(res, store, 404, 'Not Found');
        return true;
      }
      const list: { name: string; commit: { sha: string } }[] = [];
      for (const ref of repo.refs.keys()) {
        if (ref.startsWith('refs/heads/')) {
          list.push({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) as string } });
        }
      }
      list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      send(res, store, 200, list.map((b) => ({ name: b.name, commit: b.commit, protected: false })));
      return true;
    }

    // GET /repos/{o}/{r}/commits
    if (rest.length === 1 && rest[0] === 'commits') {
      if (method !== 'GET') {
        sendErr(res, store, 404, 'Not Found');
        return true;
      }
      const q = lazyQuery();
      const refParam = q.get('sha');
      const tip = refParam
        ? resolveRefToCommit(repo, refParam)
        : (repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null);
      if (!tip) {
        send(res, store, 200, []);
        return true;
      }
      // walkCommits is imported lazily through gitobj's exported helper; do a local walk
      // here to keep the commit order newest-first without an extra import cycle risk.
      const out: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      const stack: string[] = [tip];
      while (stack.length > 0) {
        const sha = stack.pop() as string;
        if (seen.has(sha)) continue;
        seen.add(sha);
        const obj = repo.objects.get(sha);
        if (!obj || obj.type !== 'commit') continue;
        const c = parseCommit(obj.data);
        out.push({
          sha,
          commit: {
            message: c.message,
            author: { name: c.authorName, email: c.authorEmail, date: isoFromUnix(c.authorTime) },
            committer: { name: c.committerName, email: c.committerEmail, date: isoFromUnix(c.committerTime) },
            tree: { sha: c.tree },
          },
          parents: c.parents.map((p) => ({ sha: p })),
          url: `https://api.example.invalid/repos/${owner}/${name}/commits/${sha}`,
        });
        for (const p of c.parents) stack.push(p);
      }
      send(res, store, 200, out);
      return true;
    }

    // /repos/{o}/{r}/contents/{path...}
    if (rest.length >= 1 && rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      if (method === 'PUT') {
        const parsed = await readJson(req);
        if (!parsed.ok) {
          sendErr(res, store, 400, 'Invalid JSON body');
          return true;
        }
        const body = parsed.value ?? {};
        if (typeof body.content !== 'string') {
          sendErr(res, store, 422, 'content is required');
          return true;
        }
        if (filePath === '') {
          sendErr(res, store, 422, 'path is required');
          return true;
        }
        const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Update ${filePath}`;
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const refName = `refs/heads/${branch}`;
        let tip = repo.refs.get(refName) ?? null;
        if (!tip && repo.refs.size > 0 && branch !== repo.defaultBranch) {
          sendErr(res, store, 422, 'branch not found');
          return true;
        }
        const flat = tip ? flattenAtCommit(repo, tip) : new Map<string, string>();
        const existing = flat.get(filePath);
        if (existing !== undefined) {
          if (typeof body.sha !== 'string') {
            sendErr(res, store, 422, 'sha is required to update a file');
            return true;
          }
          if (body.sha.toLowerCase() !== existing.toLowerCase()) {
            sendErr(res, store, 409, 'sha does not match the current blob');
            return true;
          }
        } else if (typeof body.sha === 'string' && body.sha !== '') {
          sendErr(res, store, 422, 'sha does not match: file does not exist');
          return true;
        }
        const bytes = Buffer.from(body.content, 'base64');
        const blob = buildBlob(bytes);
        repo.objects.set(blob.sha, { type: 'blob', data: blob.raw });
        flat.set(filePath, blob.sha);
        const treeSha = buildTreeFromFlat(repo, flat);
        const commitSha = makeCommit(repo, treeSha, tip ? [tip] : [], message);
        repo.refs.set(refName, commitSha);
        const baseName = filePath.slice(filePath.lastIndexOf('/') + 1);
        send(res, store, existing !== undefined ? 200 : 201, {
          content: {
            name: baseName,
            path: filePath,
            sha: blob.sha,
            size: bytes.length,
            type: 'file',
            encoding: 'base64',
            content: bytes.toString('base64'),
            url: `https://api.example.invalid/repos/${owner}/${name}/contents/${encodeURIComponent(filePath)}`,
            html_url: `https://example.invalid/${owner}/${name}/blob/${branch}/${filePath}`,
          },
          commit: {
            sha: commitSha,
            message,
            author: { name: 'forge', email: 'forge@localhost', date: FIXED_TS },
            committer: { name: 'forge', email: 'forge@localhost', date: FIXED_TS },
            parents: tip ? [{ sha: tip }] : [],
          },
        });
        return true;
      }
      if (method === 'GET') {
        const q = lazyQuery();
        const refParam = q.get('ref');
        const tip = refParam
          ? resolveRefToCommit(repo, refParam)
          : (repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null);
        if (!tip) {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        const treeSha = commitTreeSha(repo, tip);
        if (!treeSha) {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        const parts = filePath === '' ? [] : filePath.split('/');
        // Directory listing of the root when no path is given.
        if (parts.length === 0) {
          send(res, store, 200, dirListing(repo, treeSha, ''));
          return true;
        }
        let curTree = treeSha;
        let found: { mode: string; name: string; sha: string } | null = null;
        let failed = false;
        for (let i = 0; i < parts.length; i += 1) {
          const obj = repo.objects.get(curTree);
          if (!obj || obj.type !== 'tree') {
            failed = true;
            break;
          }
          const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
          if (!entry) {
            failed = true;
            break;
          }
          if (i === parts.length - 1) {
            found = entry;
          } else {
            if (entry.mode !== '40000') {
              failed = true;
              break;
            }
            curTree = entry.sha;
          }
        }
        if (failed || !found) {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        if (found.mode === '40000') {
          send(res, store, 200, dirListing(repo, found.sha, filePath));
          return true;
        }
        const blob = repo.objects.get(found.sha);
        if (!blob || blob.type !== 'blob') {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        send(res, store, 200, {
          type: 'file',
          encoding: 'base64',
          content: blob.data.toString('base64'),
          sha: found.sha,
          size: blob.data.length,
          name: parts[parts.length - 1],
          path: filePath,
          url: `https://api.example.invalid/repos/${owner}/${name}/contents/${encodeURIComponent(filePath)}`,
          html_url: `https://example.invalid/${owner}/${name}/blob/${repo.defaultBranch}/${filePath}`,
        });
        return true;
      }
      if (method === 'DELETE') {
        const parsed = await readJson(req);
        if (!parsed.ok) {
          sendErr(res, store, 400, 'Invalid JSON body');
          return true;
        }
        const body = parsed.value ?? {};
        const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${filePath}`;
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const refName = `refs/heads/${branch}`;
        const tip = repo.refs.get(refName) ?? null;
        if (!tip) {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        const flat = flattenAtCommit(repo, tip);
        const existing = flat.get(filePath);
        if (existing === undefined) {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        if (typeof body.sha === 'string' && body.sha !== '' && body.sha.toLowerCase() !== existing.toLowerCase()) {
          sendErr(res, store, 409, 'sha does not match the current blob');
          return true;
        }
        flat.delete(filePath);
        const treeSha = buildTreeFromFlat(repo, flat);
        const commitSha = makeCommit(repo, treeSha, [tip], message);
        repo.refs.set(refName, commitSha);
        send(res, store, 200, {
          content: null,
          commit: {
            sha: commitSha,
            message,
            author: { name: 'forge', email: 'forge@localhost', date: FIXED_TS },
            committer: { name: 'forge', email: 'forge@localhost', date: FIXED_TS },
            parents: [{ sha: tip }],
          },
        });
        return true;
      }
      sendErr(res, store, 404, 'Not Found');
      return true;
    }

    // POST /repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method !== 'POST') {
        sendErr(res, store, 404, 'Not Found');
        return true;
      }
      const parsed = await readJson(req);
      if (!parsed.ok) {
        sendErr(res, store, 400, 'Invalid JSON body');
        return true;
      }
      const body = parsed.value ?? {};
      if (typeof body.name !== 'string' || body.name === '') {
        sendErr(res, store, 422, 'name is required');
        return true;
      }
      const color = typeof body.color === 'string' && body.color !== '' ? body.color : 'ededed';
      repo.labels.set(body.name, {
        name: body.name,
        color,
        description: typeof body.description === 'string' ? body.description : null,
      });
      send(res, store, 201, {
        name: body.name,
        color,
        description: typeof body.description === 'string' ? body.description : null,
        url: `https://api.example.invalid/repos/${owner}/${name}/labels/${encodeURIComponent(body.name)}`,
      });
      return true;
    }

    // /repos/{o}/{r}/issues
    if (rest.length === 1 && rest[0] === 'issues') {
      if (method === 'GET') {
        const q = lazyQuery();
        const state = q.get('state') ?? 'open';
        const sort = q.get('sort') ?? 'created';
        const direction = q.get('direction') ?? 'asc';
        const { page, perPage } = pageParams(q);
        let list = repo.issues;
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        else if (state !== 'all') list = list.filter((i) => i.state === 'open');
        const sorted = [...list];
        if (sort === 'created' && direction === 'desc') sorted.sort((a, b) => b.number - a.number);
        else sorted.sort((a, b) => a.number - b.number);
        const slice = paginate(sorted, page, perPage);
        const link = linkHeader(req, `/api/v3/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues`, q, page, perPage, sorted.length);
        send(res, store, 200, slice.map((i) => issueJson(repo, store, i)), link ? { link } : undefined);
        return true;
      }
      if (method === 'POST') {
        const parsed = await readJson(req);
        if (!parsed.ok) {
          sendErr(res, store, 400, 'Invalid JSON body');
          return true;
        }
        const body = parsed.value ?? {};
        if (typeof body.title !== 'string' || body.title === '') {
          sendErr(res, store, 422, 'title is required');
          return true;
        }
        const rawLabels: unknown[] = Array.isArray(body.labels) ? body.labels : [];
        const labels: string[] = [];
        for (const item of rawLabels) {
          const labelName = typeof item === 'string' ? item : (item !== null && typeof item === 'object' ? (item as Record<string, unknown>).name : undefined);
          if (typeof labelName !== 'string') continue;
          if (!repo.labels.has(labelName)) {
            sendErr(res, store, 422, `Label ${labelName} does not exist`);
            return true;
          }
          labels.push(labelName);
        }
        const issue = store.createIssue(repo, body.title, typeof body.body === 'string' ? body.body : null, labels);
        send(res, store, 201, issueJson(repo, store, issue));
        return true;
      }
      sendErr(res, store, 404, 'Not Found');
      return true;
    }

    // /repos/{o}/{r}/issues/{n} and /issues/{n}/comments
    if (rest.length >= 2 && rest[0] === 'issues') {
      const n = Number(rest[1]);
      if (!Number.isInteger(n) || n < 1) {
        sendErr(res, store, 404, 'Not Found');
        return true;
      }
      // Fast path: issue numbers are sequential from 1, so index n-1 is the issue.
      let issue: Issue | undefined = repo.issues[n - 1];
      if (!issue || issue.number !== n) {
        issue = repo.issues.find((i) => i.number === n);
      }
      if (!issue) {
        sendErr(res, store, 404, 'Not Found');
        return true;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          send(res, store, 200, issueJson(repo, store, issue));
          return true;
        }
        if (method === 'PATCH') {
          const parsed = await readJson(req);
          if (!parsed.ok) {
            sendErr(res, store, 400, 'Invalid JSON body');
            return true;
          }
          const body = parsed.value ?? {};
          if (typeof body.state === 'string') {
            if (body.state !== 'open' && body.state !== 'closed') {
              sendErr(res, store, 422, 'state must be open or closed');
              return true;
            }
            issue.state = body.state;
          }
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string' || body.body === null) issue.body = body.body;
          if (Array.isArray(body.labels)) {
            const labels: string[] = [];
            for (const item of body.labels) {
              const labelName = typeof item === 'string' ? item : (item !== null && typeof item === 'object' ? (item as Record<string, unknown>).name : undefined);
              if (typeof labelName !== 'string') continue;
              if (!repo.labels.has(labelName)) {
                sendErr(res, store, 422, `Label ${labelName} does not exist`);
                return true;
              }
              labels.push(labelName);
            }
            issue.labels = labels;
          }
          send(res, store, 200, issueJson(repo, store, issue));
          return true;
        }
        sendErr(res, store, 404, 'Not Found');
        return true;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          send(res, store, 200, issue.comments.map((c) => commentJson(repo, store, issue as Issue, c)));
          return true;
        }
        if (method === 'POST') {
          const parsed = await readJson(req);
          if (!parsed.ok) {
            sendErr(res, store, 400, 'Invalid JSON body');
            return true;
          }
          const body = parsed.value ?? {};
          if (typeof body.body !== 'string' || body.body === '') {
            sendErr(res, store, 422, 'body is required');
            return true;
          }
          const c = store.addComment(repo, issue, body.body);
          send(res, store, 201, commentJson(repo, store, issue, c));
          return true;
        }
        sendErr(res, store, 404, 'Not Found');
        return true;
      }
      sendErr(res, store, 404, 'Not Found');
      return true;
    }

    // /repos/{o}/{r}/pulls
    if (rest.length === 1 && rest[0] === 'pulls') {
      if (method === 'GET') {
        const q = lazyQuery();
        const state = q.get('state') ?? 'open';
        const { page, perPage } = pageParams(q);
        let list = repo.pulls;
        if (state === 'open') list = list.filter((p) => p.state === 'open');
        else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
        else if (state !== 'all') list = list.filter((p) => p.state === 'open');
        const sorted = [...list].sort((a, b) => a.number - b.number);
        const slice = paginate(sorted, page, perPage);
        const link = linkHeader(req, `/api/v3/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`, q, page, perPage, sorted.length);
        send(res, store, 200, slice.map((p) => pullJson(repo, store, p)), link ? { link } : undefined);
        return true;
      }
      if (method === 'POST') {
        const parsed = await readJson(req);
        if (!parsed.ok) {
          sendErr(res, store, 400, 'Invalid JSON body');
          return true;
        }
        const body = parsed.value ?? {};
        if (typeof body.title !== 'string' || body.title === '') {
          sendErr(res, store, 422, 'title is required');
          return true;
        }
        if (typeof body.head !== 'string' || body.head === '' || typeof body.base !== 'string' || body.base === '') {
          sendErr(res, store, 422, 'head and base are required');
          return true;
        }
        const headBranch = branchNameOf(body.head);
        const baseBranch = branchNameOf(body.base);
        const headSha = repo.refs.get(`refs/heads/${headBranch}`) ?? null;
        if (!headSha) {
          sendErr(res, store, 422, 'head branch not found');
          return true;
        }
        const baseSha = repo.refs.get(`refs/heads/${baseBranch}`) ?? null;
        if (!baseSha) {
          sendErr(res, store, 422, 'base branch not found');
          return true;
        }
        const pull = store.createPull(repo, body.title, typeof body.body === 'string' ? body.body : null, headBranch, baseBranch, headSha, baseSha);
        send(res, store, 201, pullJson(repo, store, pull));
        return true;
      }
      sendErr(res, store, 404, 'Not Found');
      return true;
    }

    // /repos/{o}/{r}/pulls/{n}[/files|/merge]
    if (rest.length >= 2 && rest[0] === 'pulls') {
      const n = Number(rest[1]);
      if (!Number.isInteger(n) || n < 1) {
        sendErr(res, store, 404, 'Not Found');
        return true;
      }
      let pull: Pull | undefined = repo.pulls[n - 1];
      if (!pull || pull.number !== n) {
        pull = repo.pulls.find((p) => p.number === n);
      }
      if (!pull) {
        sendErr(res, store, 404, 'Not Found');
        return true;
      }
      if (rest.length === 2) {
        if (method !== 'GET') {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        send(res, store, 200, pullJson(repo, store, pull));
        return true;
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (method !== 'GET') {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        send(res, store, 200, pullFiles(repo, pull));
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (method !== 'PUT') {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        // Drain the body (merge_method) so keep-alive stays clean; malformed JSON is a 400.
        const parsed = await readJson(req);
        if (!parsed.ok) {
          sendErr(res, store, 400, 'Invalid JSON body');
          return true;
        }
        if (pull.merged && pull.mergeCommitSha) {
          send(res, store, 200, { sha: pull.mergeCommitSha, merged: true, message: 'Pull Request successfully merged' });
          return true;
        }
        const baseRef = `refs/heads/${pull.baseBranch}`;
        const baseTip = repo.refs.get(baseRef) ?? null;
        if (!baseTip) {
          sendErr(res, store, 404, 'Not Found');
          return true;
        }
        const headTip = repo.refs.get(`refs/heads/${pull.headBranch}`) ?? pull.headSha;
        const mergeBaseFlat = flattenAtCommit(repo, pull.baseSha);
        const headFlat = flattenAtCommit(repo, headTip);
        const baseFlat = flattenAtCommit(repo, baseTip);
        // Conflict: head and base both changed the same path differently since the merge-base.
        const allPaths = new Set<string>([...mergeBaseFlat.keys(), ...headFlat.keys(), ...baseFlat.keys()]);
        for (const p of allPaths) {
          const mb = mergeBaseFlat.get(p);
          const hd = headFlat.get(p);
          const bs = baseFlat.get(p);
          const headChanged = hd !== mb;
          const baseChanged = bs !== mb;
          if (headChanged && baseChanged && hd !== bs) {
            sendErr(res, store, 405, 'Merge conflict');
            return true;
          }
        }
        // Squash: start from the current base tree, apply the head's changes vs merge-base.
        const merged = new Map<string, string>(baseFlat);
        for (const [p, sha] of headFlat) {
          if (mergeBaseFlat.get(p) !== sha) merged.set(p, sha);
        }
        for (const p of mergeBaseFlat.keys()) {
          if (!headFlat.has(p)) merged.delete(p);
        }
        const treeSha = buildTreeFromFlat(repo, merged);
        const commitSha = makeCommit(repo, treeSha, [baseTip], `Merge pull request #${pull.number} from ${pull.headBranch}`);
        repo.refs.set(baseRef, commitSha);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergeCommitSha = commitSha;
        send(res, store, 200, { sha: commitSha, merged: true, message: 'Pull Request successfully merged' });
        return true;
      }
      sendErr(res, store, 404, 'Not Found');
      return true;
    }

    // Unknown sub-route under a known repo.
    sendErr(res, store, 404, 'Not Found');
    return true;
  }

  // Unknown /api/v3 route.
  sendErr(res, store, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------------------------
// Pull files diff

function pullFiles(repo: Repo, pull: Pull): Record<string, unknown>[] {
  const baseFlat = flattenAtCommit(repo, pull.baseSha);
  const headTip = repo.refs.get(`refs/heads/${pull.headBranch}`) ?? pull.headSha;
  const headFlat = flattenAtCommit(repo, headTip);
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  const out: Record<string, unknown>[] = [];
  for (const filename of [...paths].sort()) {
    const inBase = baseFlat.has(filename);
    const inHead = headFlat.has(filename);
    if (inHead && !inBase) {
      const additions = lineCount(blobData(repo, headFlat.get(filename) as string));
      out.push({
        sha: headFlat.get(filename),
        filename,
        status: 'added',
        additions,
        deletions: 0,
        changes: additions,
        blob_url: `https://example.invalid/${filename}`,
        raw_url: `https://example.invalid/${filename}`,
      });
    } else if (!inHead && inBase) {
      const deletions = lineCount(blobData(repo, baseFlat.get(filename) as string));
      out.push({
        sha: baseFlat.get(filename),
        filename,
        status: 'removed',
        additions: 0,
        deletions,
        changes: deletions,
        blob_url: `https://example.invalid/${filename}`,
        raw_url: `https://example.invalid/${filename}`,
      });
    } else if (inHead && inBase && baseFlat.get(filename) !== headFlat.get(filename)) {
      const { additions, deletions } = lineDiff(
        blobData(repo, baseFlat.get(filename) as string),
        blobData(repo, headFlat.get(filename) as string),
      );
      out.push({
        sha: headFlat.get(filename),
        filename,
        status: 'modified',
        additions,
        deletions,
        changes: additions + deletions,
        blob_url: `https://example.invalid/${filename}`,
        raw_url: `https://example.invalid/${filename}`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Directory listing for GET contents on a tree

function dirListing(repo: Repo, treeSha: string, dirPath: string): Record<string, unknown>[] {
  const obj = repo.objects.get(treeSha);
  if (!obj || obj.type !== 'tree') return [];
  const out: Record<string, unknown>[] = [];
  for (const e of parseTree(obj.data)) {
    const isDir = e.mode === '40000';
    const blob = !isDir ? repo.objects.get(e.sha) : undefined;
    out.push({
      type: isDir ? 'dir' : 'file',
      name: e.name,
      path: dirPath === '' ? e.name : `${dirPath}/${e.name}`,
      sha: e.sha,
      size: isDir ? 0 : (blob && blob.type === 'blob' ? blob.data.length : 0),
      url: `https://api.example.invalid/contents/${encodeURIComponent(e.name)}`,
    });
  }
  return out;
}
