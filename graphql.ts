// GraphQL v4 handler for the github-core-clone-01 forge.
// POST /api/graphql {query, variables} — a small, real executor for exactly the
// documents gh / github-mcp-server send (see kit checks-graphql.ts). No deps,
// no network, deterministic (no clock, no randomness).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, Pull, Repo, Store } from './store.ts';
import { buildFixedCommit, buildTree, parseCommit, parseTree } from './gitobj.ts';

// ---------------------------------------------------------------------------
// Opaque global ids. Check graphql.global-id-stability requires ids that are
// NOT the plain database id / issue number, but mutations must round-trip
// them, so ids are base64url("<Kind>:<numeric id>") — stable and decodable.
// ---------------------------------------------------------------------------

export function encodeGlobalId(kind: string, numericId: number): string {
  return Buffer.from(`${kind}:${numericId}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; num: number } | null {
  if (typeof id !== 'string' || id === '') return null;
  if (/^\d+$/.test(id)) return { kind: '', num: Number(id) };
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const m = /^(Repository|Issue|PullRequest|IssueComment|User):(\d+)$/.exec(text);
    if (m) return { kind: m[1], num: Number(m[2]) };
  } catch {
    // not a base64 id
  }
  return null;
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    if (m) return Number(m[1]);
  } catch {
    // not a cursor
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Store lookups
// ---------------------------------------------------------------------------

function repoById(store: Store, id: number): Repo | null {
  for (const repo of store.reposByName.values()) if (repo.id === id) return repo;
  return null;
}

function findIssueByNumericId(store: Store, numericId: number): { repo: Repo; issue: Issue } | null {
  for (const repo of store.reposByName.values()) {
    for (const issue of repo.issues) if (issue.id === numericId) return { repo, issue };
  }
  return null;
}

function findPullByNumericId(store: Store, numericId: number): { repo: Repo; pull: Pull } | null {
  for (const repo of store.reposByName.values()) {
    for (const pull of repo.pulls) if (pull.id === numericId) return { repo, pull };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Git helpers: squash-merge a pull request, and the changed-file list.
// ---------------------------------------------------------------------------

function commitTreeSha(repo: Repo, sha: string): string | null {
  if (!sha) return null;
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

function flattenTree(repo: Repo, treeSha: string, prefix: string, out: Map<string, string>): void {
  const obj = repo.objects.get(treeSha);
  if (!obj || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '40000') flattenTree(repo, entry.sha, `${prefix}${entry.name}/`, out);
    else out.set(`${prefix}${entry.name}`, entry.sha);
  }
}

/** Paths changed between the pull's base and head trees (added/modified/deleted). */
export function pullChangedFiles(repo: Repo, pull: Pull): string[] {
  const baseFiles = new Map<string, string>();
  const headFiles = new Map<string, string>();
  const baseTree = commitTreeSha(repo, pull.baseSha);
  const headTree = commitTreeSha(repo, pull.headSha);
  if (baseTree) flattenTree(repo, baseTree, '', baseFiles);
  if (headTree) flattenTree(repo, headTree, '', headFiles);
  const changed = new Set<string>();
  for (const [path, sha] of headFiles) if (baseFiles.get(path) !== sha) changed.add(path);
  for (const path of baseFiles.keys()) if (!headFiles.has(path)) changed.add(path);
  return [...changed].sort();
}

/** Squash-merge: one fixed-ident commit (head tree, default-branch tip as parent). */
export function mergePullInStore(repo: Repo, pull: Pull): string {
  if (pull.merged && pull.mergeCommitSha) return pull.mergeCommitSha;
  let tree = commitTreeSha(repo, pull.headSha);
  if (!tree) tree = commitTreeSha(repo, pull.baseSha);
  if (!tree) {
    const empty = buildTree([]);
    repo.objects.set(empty.sha, { type: 'tree', data: empty.raw });
    tree = empty.sha;
  }
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '';
  const parents: string[] = tip ? [tip] : pull.baseSha ? [pull.baseSha] : [];
  const commit = buildFixedCommit(tree, parents, pull.title);
  repo.objects.set(commit.sha, { type: 'commit', data: commit.raw });
  repo.refs.set(`refs/heads/${repo.defaultBranch}`, commit.sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = commit.sha;
  return commit.sha;
}

// ---------------------------------------------------------------------------
// Minimal GraphQL document parser (fields, arguments, variables, fragments).
// ---------------------------------------------------------------------------

type ValueNode =
  | { t: 'var'; name: string }
  | { t: 'string'; value: string }
  | { t: 'int'; value: number }
  | { t: 'bool'; value: boolean }
  | { t: 'null' }
  | { t: 'enum'; value: string }
  | { t: 'list'; items: ValueNode[] }
  | { t: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldSel {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection: Selection[] | null;
}
interface InlineFrag {
  kind: 'inline';
  typeCondition: string | null;
  selection: Selection[];
}
interface SpreadFrag {
  kind: 'spread';
  name: string;
}
type Selection = FieldSel | InlineFrag | SpreadFrag;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selection: Selection[];
}

interface Token { type: 'name' | 'int' | 'string' | 'punct' | 'var' | 'spread'; value: string }

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (src.startsWith('...', i)) { tokens.push({ type: 'spread', value: '...' }); i += 3; continue; }
    if (c === '$') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ type: 'var', value: src.slice(i + 1, j) });
      i = j; continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'u' && j + 5 < src.length) { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 4; }
          else out += e;
          j += 2;
        } else { out += src[j]; j += 1; }
      }
      tokens.push({ type: 'string', value: out });
      i = j + 1; continue;
    }
    if (/[0-9-]/.test(c) && (c !== '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      while (j < src.length && /[eE+-]/.test(src[j]) && /[0-9eE+-]/.test(src[j])) j += 1;
      tokens.push({ type: 'int', value: src.slice(i, j) });
      i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ type: 'name', value: src.slice(i, j) });
      i = j; continue;
    }
    tokens.push({ type: 'punct', value: c });
    i += 1;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token | undefined { return this.tokens[this.pos++]; }
  private expectPunct(v: string): void {
    const t = this.next();
    if (!t || t.type !== 'punct' || t.value !== v) throw new Error(`expected '${v}'`);
  }
  private atPunct(v: string): boolean {
    const t = this.peek();
    return !!t && t.type === 'punct' && t.value === v;
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, Selection[]> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, Selection[]>();
    while (this.peek()) {
      const t = this.peek()!;
      if (t.type === 'punct' && t.value === '{') {
        operations.push({ kind: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      if (t.type === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const kind = this.next()!.value as 'query' | 'mutation';
        let name: string | null = null;
        const n = this.peek();
        if (n && n.type === 'name') name = this.next()!.value;
        if (this.atPunct('(')) this.skipParens();
        this.skipDirectives();
        operations.push({ kind, name, selection: this.parseSelectionSet() });
        continue;
      }
      if (t.type === 'name' && t.value === 'fragment') {
        this.next();
        const fragName = this.next();
        if (!fragName || fragName.type !== 'name') throw new Error('bad fragment');
        const on = this.next();
        if (!on || on.value !== 'on') throw new Error('bad fragment');
        const typeName = this.next();
        if (!typeName || typeName.type !== 'name') throw new Error('bad fragment');
        void typeName;
        fragments.set(fragName.value, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected token ${t.value}`);
    }
    return { operations, fragments };
  }

  private skipParens(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (!t) throw new Error('unbalanced parens');
      if (t.type === 'punct' && t.value === '(') depth += 1;
      else if (t.type === 'punct' && t.value === ')') depth -= 1;
      else if (t.type === 'punct' && (t.value === '[' || t.value === '{')) depth += 1;
      else if (t.type === 'punct' && (t.value === ']' || t.value === '}')) depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.peek() && this.peek()!.type === 'punct' && this.peek()!.value === '@') {
      this.next();
      const n = this.next();
      if (!n) break;
      if (this.atPunct('(')) this.skipParens();
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const sels: Selection[] = [];
    while (!this.atPunct('}')) {
      const t = this.peek();
      if (!t) throw new Error('unterminated selection set');
      if (t.type === 'spread') {
        this.next();
        const n = this.peek();
        if (n && n.type === 'name' && n.value === 'on') {
          this.next();
          const typeName = this.next();
          if (!typeName || typeName.type !== 'name') throw new Error('bad inline fragment');
          this.skipDirectives();
          sels.push({ kind: 'inline', typeCondition: typeName.value, selection: this.parseSelectionSet() });
        } else {
          if (!n || n.type !== 'name') throw new Error('bad fragment spread');
          this.next();
          this.skipDirectives();
          sels.push({ kind: 'spread', name: n.value });
        }
        continue;
      }
      if (t.type !== 'name') throw new Error(`expected field name, got ${t.value}`);
      const first = this.next()!.value;
      let alias: string | null = null;
      let name = first;
      if (this.atPunct(':')) {
        this.next();
        const real = this.next();
        if (!real || real.type !== 'name') throw new Error('bad alias');
        alias = first;
        name = real.value;
      }
      const args: { name: string; value: ValueNode }[] = [];
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')')) {
          const argName = this.next();
          if (!argName || argName.type !== 'name') throw new Error('bad argument');
          this.expectPunct(':');
          args.push({ name: argName.value, value: this.parseValue() });
        }
        this.expectPunct(')');
      }
      this.skipDirectives();
      const selection = this.atPunct('{') ? this.parseSelectionSet() : null;
      sels.push({ kind: 'field', alias, name, args, selection });
    }
    this.expectPunct('}');
    return sels;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (!t) throw new Error('expected value');
    if (t.type === 'var') return { t: 'var', name: t.value };
    if (t.type === 'string') return { t: 'string', value: t.value };
    if (t.type === 'int') return { t: 'int', value: Number(t.value) };
    if (t.type === 'name') {
      if (t.value === 'true') return { t: 'bool', value: true };
      if (t.value === 'false') return { t: 'bool', value: false };
      if (t.value === 'null') return { t: 'null' };
      return { t: 'enum', value: t.value };
    }
    if (t.type === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { t: 'list', items };
    }
    if (t.type === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.atPunct('}')) {
        const fname = this.next();
        if (!fname || fname.type !== 'name') throw new Error('bad input object field');
        this.expectPunct(':');
        fields.push({ name: fname.value, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { t: 'object', fields };
    }
    throw new Error(`unexpected value token ${t.value}`);
  }
}

// ---------------------------------------------------------------------------
// Schema surface for introspection
// ---------------------------------------------------------------------------

const ISSUE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'labels', 'comments', 'author', 'url'];
const PULL_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'url'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url', 'defaultBranch'];
const USER_FIELDS = ['login', 'id', 'name', 'email', 'url'];
const SEARCH_ENUM = ['ISSUE', 'REPOSITORY', 'USER', 'CODE', 'DISCUSSION', 'COMMIT', 'WIKI', 'MILESTONE'];

interface TypeInfo { kind: 'OBJECT' | 'ENUM' | 'SCALAR'; fields: string[] | null; enumValues: string[] | null }
const TYPE_INFO: Record<string, TypeInfo> = {
  Issue: { kind: 'OBJECT', fields: ISSUE_FIELDS, enumValues: null },
  PullRequest: { kind: 'OBJECT', fields: PULL_FIELDS, enumValues: null },
  Repository: { kind: 'OBJECT', fields: REPO_FIELDS, enumValues: null },
  User: { kind: 'OBJECT', fields: USER_FIELDS, enumValues: null },
  SearchType: { kind: 'ENUM', fields: null, enumValues: SEARCH_ENUM },
  IssueState: { kind: 'ENUM', fields: null, enumValues: ['OPEN', 'CLOSED'] },
  IssueOrderField: { kind: 'ENUM', fields: null, enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', fields: null, enumValues: ['ASC', 'DESC'] },
  MergeableState: { kind: 'ENUM', fields: null, enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestState: { kind: 'ENUM', fields: null, enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  RepositoryPermission: { kind: 'ENUM', fields: null, enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  PullRequestMergeMethod: { kind: 'ENUM', fields: null, enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  String: { kind: 'SCALAR', fields: null, enumValues: null },
  Int: { kind: 'SCALAR', fields: null, enumValues: null },
  ID: { kind: 'SCALAR', fields: null, enumValues: null },
  Boolean: { kind: 'SCALAR', fields: null, enumValues: null },
};

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.t) {
    case 'var': return variables[node.name] ?? null;
    case 'string': return node.value;
    case 'int': return node.value;
    case 'bool': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function argsOf(sel: FieldSel, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of sel.args) out[a.name] = resolveValue(a.value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string }[];
  fragments: Map<string, Selection[]>;
}

type Target = Record<string, unknown> & { __kind: string };

function err(ctx: Ctx, message: string): void {
  ctx.errors.push({ message });
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function repoOwnerLogin(store: Store, repo: Repo): string {
  return repo.ownerLogin ?? store.viewer().login;
}

function issueTarget(repo: Repo, issue: Issue): Target {
  return { __kind: 'Issue', repo, issue };
}
function pullTarget(repo: Repo, pull: Pull): Target {
  return { __kind: 'PullRequest', repo, pull };
}
function repoTarget(repo: Repo): Target {
  return { __kind: 'Repository', repo };
}
function userTarget(login: string, id: number): Target {
  return { __kind: 'User', login, id };
}

interface PageItem<T> { value: T; cursor: string }

function issuesConnection(store: Store, repo: Repo, args: Record<string, unknown>): Target {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? null) as Record<string, unknown> | null;
  const direction = orderBy && typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';
  list.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
  const afterIdx = decodeCursor(args.after);
  const start = afterIdx >= 0 ? afterIdx + 1 : 0;
  const first = typeof args.first === 'number' ? args.first : list.length - start;
  const page = list.slice(start, start + Math.max(0, first));
  const items: PageItem<Issue>[] = page.map((issue, k) => ({ value: issue, cursor: encodeCursor(start + k) }));
  const hasNextPage = start + page.length < list.length;
  const endCursor = items.length > 0 ? items[items.length - 1].cursor : null;
  const startCursor = items.length > 0 ? items[0].cursor : null;
  return {
    __kind: 'IssueConnection', repo, items, totalCount: list.length,
    pageInfo: { hasNextPage, hasPreviousPage: start > 0, endCursor, startCursor },
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): Target {
  const list = [...repo.pulls].sort((a, b) => a.seq - b.seq);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, Math.max(0, first));
  const items: PageItem<Pull>[] = page.map((pull, k) => ({ value: pull, cursor: encodeCursor(k) }));
  return {
    __kind: 'PullRequestConnection', repo, items, totalCount: list.length,
    pageInfo: { hasNextPage: page.length < list.length, hasPreviousPage: false, endCursor: items.length > 0 ? items[items.length - 1].cursor : null, startCursor: items.length > 0 ? items[0].cursor : null },
  };
}

function filesConnection(repo: Repo, pull: Pull, args: Record<string, unknown>): Target {
  const paths = pullChangedFiles(repo, pull);
  const first = typeof args.first === 'number' ? args.first : paths.length;
  const page = paths.slice(0, Math.max(0, first));
  return {
    __kind: 'FileConnection', repo, items: page, totalCount: paths.length,
    pageInfo: { hasNextPage: page.length < paths.length, hasPreviousPage: false, endCursor: null, startCursor: null },
  };
}

function resolveObject(ctx: Ctx, kind: string, target: Target, sels: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name);
      if (frag) Object.assign(out, resolveObject(ctx, kind, target, frag));
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.typeCondition === null || sel.typeCondition === kind) {
        Object.assign(out, resolveObject(ctx, kind, target, sel.selection));
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') { out[key] = kind; continue; }
    const value = resolveField(ctx, kind, target, sel);
    if (value !== SKIP) out[key] = value;
  }
  return out;
}

const SKIP: unique symbol = Symbol('skip');

function resolveField(ctx: Ctx, kind: string, target: Target, sel: FieldSel): unknown {
  const { store } = ctx;
  const args = argsOf(sel, ctx.variables);
  const sub = sel.selection ?? [];
  switch (kind) {
    case 'User': {
      if (sel.name === 'login') return target.login as string;
      if (sel.name === 'id') return encodeGlobalId('User', (target.id as number) ?? 1000);
      if (sel.name === 'name') return target.login as string;
      if (sel.name === 'email') return `${target.login as string}@example.invalid`;
      err(ctx, `Cannot query field "${sel.name}" on type "User".`);
      return SKIP;
    }
    case 'Ref': {
      if (sel.name === 'name') return target.name as string;
      err(ctx, `Cannot query field "${sel.name}" on type "Ref".`);
      return SKIP;
    }
    case 'Repository': {
      const repo = target.repo as Repo;
      switch (sel.name) {
        case 'id': return encodeGlobalId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repoOwnerLogin(store, repo)}/${repo.name}`;
        case 'owner': return resolveObject(ctx, 'User', userTarget(repoOwnerLogin(store, repo), repo.ownerId), sub);
        case 'defaultBranchRef': return resolveObject(ctx, 'Ref', { __kind: 'Ref', name: repo.defaultBranch }, sub);
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'private': return repo.private;
        case 'defaultBranch': return repo.defaultBranch;
        case 'issue': {
          const n = args.number as number;
          const issue = repo.issues.find((i) => i.number === n);
          if (!issue) return null;
          return resolveObject(ctx, 'Issue', issueTarget(repo, issue), sub);
        }
        case 'issues': return resolveObject(ctx, 'IssueConnection', issuesConnection(store, repo, args), sub);
        case 'pullRequests': return resolveObject(ctx, 'PullRequestConnection', pullsConnection(repo, args), sub);
        case 'pullRequest': {
          const n = args.number as number;
          const pull = repo.pulls.find((p) => p.number === n);
          if (!pull) return null;
          return resolveObject(ctx, 'PullRequest', pullTarget(repo, pull), sub);
        }
        default:
          err(ctx, `Cannot query field "${sel.name}" on type "Repository".`);
          return SKIP;
      }
    }
    case 'Issue': {
      const issue = target.issue as Issue;
      switch (sel.name) {
        case 'id': return encodeGlobalId('Issue', issue.id);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issueState(issue);
        case 'url': return null;
        default:
          err(ctx, `Cannot query field "${sel.name}" on type "Issue".`);
          return SKIP;
      }
    }
    case 'PullRequest': {
      const repo = target.repo as Repo;
      const pull = target.pull as Pull;
      switch (sel.name) {
        case 'id': return encodeGlobalId('PullRequest', pull.id);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pullState(pull);
        case 'merged': return pull.merged;
        case 'mergeable': return 'MERGEABLE';
        case 'headRefName': return pull.headBranch;
        case 'baseRefName': return pull.baseBranch;
        case 'headRef': return resolveObject(ctx, 'Ref', { __kind: 'Ref', name: pull.headBranch }, sub);
        case 'baseRef': return resolveObject(ctx, 'Ref', { __kind: 'Ref', name: pull.baseBranch }, sub);
        case 'files': return resolveObject(ctx, 'FileConnection', filesConnection(repo, pull, args), sub);
        case 'url': return null;
        default:
          err(ctx, `Cannot query field "${sel.name}" on type "PullRequest".`);
          return SKIP;
      }
    }
    case 'IssueConnection': {
      const items = target.items as PageItem<Issue>[];
      const repo = target.repo as Repo;
      switch (sel.name) {
        case 'nodes': return items.map((item) => resolveObject(ctx, 'Issue', issueTarget(repo, item.value), sub));
        case 'edges': return items.map((item) => resolveObject(ctx, 'Edge', { __kind: 'Edge', nodeKind: 'Issue', repo, value: item.value, cursor: item.cursor }, sub));
        case 'pageInfo': return resolveObject(ctx, 'PageInfo', { __kind: 'PageInfo', ...(target.pageInfo as Record<string, unknown>) }, sub);
        case 'totalCount': return target.totalCount as number;
        default:
          err(ctx, `Cannot query field "${sel.name}" on type "IssueConnection".`);
          return SKIP;
      }
    }
    case 'PullRequestConnection': {
      const items = target.items as PageItem<Pull>[];
      const repo = target.repo as Repo;
      switch (sel.name) {
        case 'nodes': return items.map((item) => resolveObject(ctx, 'PullRequest', pullTarget(repo, item.value), sub));
        case 'edges': return items.map((item) => resolveObject(ctx, 'Edge', { __kind: 'Edge', nodeKind: 'PullRequest', repo, value: item.value, cursor: item.cursor }, sub));
        case 'pageInfo': return resolveObject(ctx, 'PageInfo', { __kind: 'PageInfo', ...(target.pageInfo as Record<string, unknown>) }, sub);
        case 'totalCount': return target.totalCount as number;
        default:
          err(ctx, `Cannot query field "${sel.name}" on type "PullRequestConnection".`);
          return SKIP;
      }
    }
    case 'FileConnection': {
      const items = target.items as string[];
      switch (sel.name) {
        case 'nodes': return items.map((path) => resolveObject(ctx, 'ChangedFile', { __kind: 'ChangedFile', path }, sub));
        case 'edges': return items.map((path) => resolveObject(ctx, 'Edge', { __kind: 'Edge', nodeKind: 'ChangedFile', value: path, cursor: '' }, sub));
        case 'pageInfo': return resolveObject(ctx, 'PageInfo', { __kind: 'PageInfo', ...(target.pageInfo as Record<string, unknown>) }, sub);
        case 'totalCount': return target.totalCount as number;
        default:
          err(ctx, `Cannot query field "${sel.name}" on type "FileConnection".`);
          return SKIP;
      }
    }
    case 'Edge': {
      switch (sel.name) {
        case 'cursor': return target.cursor as string;
        case 'node': {
          const nodeKind = target.nodeKind as string;
          if (nodeKind === 'Issue') return resolveObject(ctx, 'Issue', issueTarget(target.repo as Repo, target.value as Issue), sub);
          if (nodeKind === 'PullRequest') return resolveObject(ctx, 'PullRequest', pullTarget(target.repo as Repo, target.value as Pull), sub);
          if (nodeKind === 'ChangedFile') return resolveObject(ctx, 'ChangedFile', { __kind: 'ChangedFile', path: target.value as string }, sub);
          return null;
        }
        default:
          err(ctx, `Cannot query field "${sel.name}" on type "Edge".`);
          return SKIP;
      }
    }
    case 'ChangedFile': {
      if (sel.name === 'path') return target.path as string;
      if (sel.name === 'filename') return target.path as string;
      err(ctx, `Cannot query field "${sel.name}" on type "PullRequestChangedFile".`);
      return SKIP;
    }
    case 'PageInfo': {
      switch (sel.name) {
        case 'hasNextPage': return target.hasNextPage as boolean;
        case 'hasPreviousPage': return (target.hasPreviousPage as boolean) ?? false;
        case 'endCursor': return (target.endCursor as string | null) ?? null;
        case 'startCursor': return (target.startCursor as string | null) ?? null;
        default:
          err(ctx, `Cannot query field "${sel.name}" on type "PageInfo".`);
          return SKIP;
      }
    }
    case '__Type': {
      const info = target.info as TypeInfo;
      const name = target.name as string;
      switch (sel.name) {
        case 'name': return name;
        case 'kind': return info.kind;
        case 'description': return null;
        case 'fields': {
          if (!info.fields) return null;
          return info.fields.map((f) => resolveObject(ctx, 'TypeField', { __kind: 'TypeField', name: f }, sub));
        }
        case 'enumValues': {
          if (!info.enumValues) return null;
          return info.enumValues.map((v) => resolveObject(ctx, 'EnumValue', { __kind: 'EnumValue', name: v }, sub));
        }
        default:
          err(ctx, `Cannot query field "${sel.name}" on type "__Type".`);
          return SKIP;
      }
    }
    case 'TypeField':
    case 'EnumValue': {
      if (sel.name === 'name') return target.name as string;
      if (sel.name === 'description') return null;
      err(ctx, `Cannot query field "${sel.name}" on type "${kind}".`);
      return SKIP;
    }
    case '__Schema': {
      switch (sel.name) {
        case 'queryType': return resolveObject(ctx, 'NamedType', { __kind: 'NamedType', name: 'Query' }, sub);
        case 'mutationType': return resolveObject(ctx, 'NamedType', { __kind: 'NamedType', name: 'Mutation' }, sub);
        case 'types': return Object.keys(TYPE_INFO).map((n) => resolveObject(ctx, 'NamedType', { __kind: 'NamedType', name: n }, sub));
        case 'directives': return [];
        default:
          err(ctx, `Cannot query field "${sel.name}" on type "__Schema".`);
          return SKIP;
      }
    }
    case 'NamedType': {
      if (sel.name === 'name') return target.name as string;
      if (sel.name === 'kind') return (TYPE_INFO[target.name as string] ?? { kind: 'OBJECT' }).kind;
      err(ctx, `Cannot query field "${sel.name}" on type "__Type".`);
      return SKIP;
    }
    case 'Payload': {
      const fields = target.fields as Record<string, Target>;
      const child = fields[sel.name];
      if (!child) {
        err(ctx, `Cannot query field "${sel.name}" on type "Payload".`);
        return SKIP;
      }
      return resolveObject(ctx, child.__kind, child, sub);
    }
    case 'CommentEdge': {
      if (sel.name === 'node') return resolveObject(ctx, 'IssueComment', target.node as Target, sub);
      err(ctx, `Cannot query field "${sel.name}" on type "IssueCommentEdge".`);
      return SKIP;
    }
    case 'IssueComment': {
      if (sel.name === 'id') return target.id as string;
      if (sel.name === 'body') return target.body as string;
      err(ctx, `Cannot query field "${sel.name}" on type "IssueComment".`);
      return SKIP;
    }
    default:
      err(ctx, `Cannot query field "${sel.name}" on type "${kind}".`);
      return SKIP;
  }
}

function executeOperation(ctx: Ctx, op: Operation): Record<string, unknown> {
  const { store } = ctx;
  const data: Record<string, unknown> = {};
  for (const sel of op.selection) {
    if (sel.kind === 'spread' || sel.kind === 'inline') continue;
    const key = sel.alias ?? sel.name;
    const args = argsOf(sel, ctx.variables);
    const sub = sel.selection ?? [];
    switch (sel.name) {
      case '__typename':
        data[key] = op.kind === 'mutation' ? 'Mutation' : 'Query';
        break;
      case 'viewer': {
        const viewer = store.viewer();
        data[key] = resolveObject(ctx, 'User', userTarget(viewer.login, viewer.id), sub);
        break;
      }
      case 'repository': {
        const owner = args.owner as string;
        const name = args.name as string;
        if (typeof owner !== 'string' || typeof name !== 'string') {
          err(ctx, 'repository requires owner and name arguments.');
          data[key] = null;
          break;
        }
        const repo = store.resolveRepo(owner, name);
        data[key] = repo ? resolveObject(ctx, 'Repository', repoTarget(repo), sub) : null;
        break;
      }
      case 'node': {
        const decoded = decodeGlobalId(args.id as string);
        let resolved: unknown = null;
        if (decoded && decoded.kind === 'Repository') {
          const repo = repoById(store, decoded.num);
          if (repo) resolved = resolveObject(ctx, 'Repository', repoTarget(repo), sub);
        } else if (decoded && decoded.kind === 'Issue') {
          const found = findIssueByNumericId(store, decoded.num);
          if (found) resolved = resolveObject(ctx, 'Issue', issueTarget(found.repo, found.issue), sub);
        } else if (decoded && decoded.kind === 'PullRequest') {
          const found = findPullByNumericId(store, decoded.num);
          if (found) resolved = resolveObject(ctx, 'PullRequest', pullTarget(found.repo, found.pull), sub);
        } else if (decoded && decoded.kind === '') {
          const repo = repoById(store, decoded.num);
          if (repo) resolved = resolveObject(ctx, 'Repository', repoTarget(repo), sub);
        }
        data[key] = resolved;
        break;
      }
      case '__type': {
        const name = args.name as string;
        const info = TYPE_INFO[name];
        data[key] = info ? resolveObject(ctx, '__Type', { __kind: '__Type', name, info }, sub) : null;
        break;
      }
      case '__schema': {
        data[key] = resolveObject(ctx, '__Schema', { __kind: '__Schema' }, sub);
        break;
      }
      case 'createIssue': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        const repo = decoded ? repoById(store, decoded.num) : null;
        if (!repo || typeof input.title !== 'string') {
          err(ctx, 'createIssue: unknown repository.');
          data[key] = null;
          break;
        }
        const issue = store.createIssue(repo, input.title, typeof input.body === 'string' ? input.body : null, []);
        data[key] = resolveObject(ctx, 'Payload', {
          __kind: 'Payload',
          fields: { issue: issueTarget(repo, issue) },
        }, sub);
        break;
      }
      case 'closeIssue': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.issueId ?? ''));
        const found = decoded ? findIssueByNumericId(store, decoded.num) : null;
        if (!found) {
          err(ctx, 'closeIssue: unknown issue.');
          data[key] = null;
          break;
        }
        found.issue.state = 'closed';
        data[key] = resolveObject(ctx, 'Payload', {
          __kind: 'Payload',
          fields: { issue: issueTarget(found.repo, found.issue) },
        }, sub);
        break;
      }
      case 'createPullRequest': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        const repo = decoded ? repoById(store, decoded.num) : null;
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo?.defaultBranch ?? 'main';
        if (!repo || head === '') {
          err(ctx, 'createPullRequest: unknown repository or head branch.');
          data[key] = null;
          break;
        }
        const headSha = repo.refs.get(`refs/heads/${head}`) ?? '';
        const baseSha = repo.refs.get(`refs/heads/${base}`) ?? '';
        const pull = store.createPull(repo, typeof input.title === 'string' ? input.title : '', typeof input.body === 'string' ? input.body : null, head, base, headSha, baseSha);
        data[key] = resolveObject(ctx, 'Payload', {
          __kind: 'Payload',
          fields: { pullRequest: pullTarget(repo, pull) },
        }, sub);
        break;
      }
      case 'mergePullRequest': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
        const found = decoded ? findPullByNumericId(store, decoded.num) : null;
        if (!found) {
          err(ctx, 'mergePullRequest: unknown pull request.');
          data[key] = null;
          break;
        }
        mergePullInStore(found.repo, found.pull);
        data[key] = resolveObject(ctx, 'Payload', {
          __kind: 'Payload',
          fields: { pullRequest: pullTarget(found.repo, found.pull) },
        }, sub);
        break;
      }
      case 'addComment': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.subjectId ?? ''));
        const found = decoded ? findIssueByNumericId(store, decoded.num) : null;
        const body = typeof input.body === 'string' ? input.body : '';
        if (!found) {
          err(ctx, 'addComment: unknown subject.');
          data[key] = null;
          break;
        }
        const comment = store.addComment(found.repo, found.issue, body);
        const node: Target = { __kind: 'IssueComment', id: encodeGlobalId('IssueComment', comment.id), body: comment.body };
        data[key] = resolveObject(ctx, 'Payload', {
          __kind: 'Payload',
          fields: { commentEdge: { __kind: 'CommentEdge', node } },
        }, sub);
        break;
      }
      default:
        err(ctx, `Cannot query field "${sel.name}" on type "${op.kind === 'mutation' ? 'Mutation' : 'Query'}".`);
        break;
    }
  }
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

function executeOne(store: Store, body: Record<string, unknown>): Record<string, unknown> {
  const query = body.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'Must provide a query string.' }] };
  }
  let parsed: { operations: Operation[]; fragments: Map<string, Selection[]> };
  try {
    parsed = new Parser(tokenize(query)).parseDocument();
  } catch (e) {
    return { data: null, errors: [{ message: e instanceof Error ? e.message : 'Syntax error in GraphQL document.' }] };
  }
  if (parsed.operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation in GraphQL document.' }] };
  }
  let op = parsed.operations[0];
  const operationName = body.operationName;
  if (typeof operationName === 'string') {
    const named = parsed.operations.find((o) => o.name === operationName);
    if (named) op = named;
  }
  const ctx: Ctx = {
    store,
    variables: (body.variables ?? {}) as Record<string, unknown>,
    errors: [],
    fragments: parsed.fragments,
  };
  return executeOperation(ctx, op);
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Handle POST /api/graphql. Returns true when the request was this route
 * (handled), false otherwise so the router can fall through.
 */
export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, store: Store, token: string): Promise<boolean> {
  const url = req.url ?? '';
  const path = url.split('?')[0];
  if (req.method !== 'POST' || path !== '/api/graphql') return false;
  if (!token || req.headers.authorization !== `Bearer ${token}`) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }
  let text: string;
  try {
    text = await readBody(req);
  } catch {
    sendJson(res, 400, { message: 'Could not read request body' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    sendJson(res, 400, { message: 'Invalid JSON body' });
    return true;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) =>
      entry && typeof entry === 'object' ? executeOne(store, entry as Record<string, unknown>) : { data: null, errors: [{ message: 'Invalid operation.' }] },
    );
    sendJson(res, 200, results);
    return true;
  }
  if (!parsed || typeof parsed !== 'object') {
    sendJson(res, 400, { message: 'Invalid request body' });
    return true;
  }
  sendJson(res, 200, executeOne(store, parsed as Record<string, unknown>));
  return true;
}
