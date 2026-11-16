// Shared in-memory store for the github-core-clone-01 forge.
// One instance, shared by REST, GraphQL, MCP and git smart HTTP.
// Deterministic: no wall-clock time, no Math.random in any response.

export interface User { login: string; id: number; name: string; email: string; }
export interface Label { name: string; color: string; description: string | null; }
export interface IssueComment { id: number; body: string; seq: number; }
export interface Issue {
  id: number; number: number; title: string; body: string | null;
  state: 'open' | 'closed'; labels: string[]; comments: IssueComment[]; seq: number;
  /** Cached serialized REST JSON for this issue (Buffer) + the owner it was built for; null when stale. */
  jsonBuf: Buffer | null; jsonOwner: string | null;
}
export interface Pull {
  id: number; number: number; title: string; body: string | null;
  state: 'open' | 'closed'; merged: boolean;
  headBranch: string; baseBranch: string; headSha: string; baseSha: string;
  mergeCommitSha: string | null; seq: number;
}
export interface GitObject { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer; }

export interface Repo {
  id: number; name: string;
  ownerLogin: string | null; // null until pinned by the first owner-bearing request
  ownerId: number;
  description: string | null; private: boolean; defaultBranch: string;
  refs: Map<string, string>; // full ref, e.g. "refs/heads/main", -> commit sha
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[]; pulls: Pull[];
  nextIssue: number; nextPull: number; nextComment: number;
  seq: number;
  /** Git smart-HTTP response caches (ls-refs / fetch / v0 advertisement), keyed by a
   * fingerprint of the refs + object count. Objects are immutable by sha and only ever
   * added, so (refs fingerprint + object count) fully determines the git responses. */
  lsRefsCache: Map<string, Buffer>;
  fetchCache: Map<string, Buffer>;
  v0AdvCache: Map<string, Buffer>;
}

export const FIXED_GIT_TIME = 1700000000;
export const FIXED_GIT_IDENT = { name: 'forge', email: 'forge@localhost' };

export class Store {
  reposByName = new Map<string, Repo>(); // key: repo name (unique across owners in one trial)
  nextRepoId = 5000;
  nextObjectId = 1; // for issue/comment/pull ids that are not repo-scoped
  seq = 0;
  viewerLogin: string | null = null;
  viewerId = 1000;
  requestCounter = 0;

  nextSeq(): number { this.seq += 1; return this.seq; }
  nextRequestId(): string { this.requestCounter += 1; return `req-${this.requestCounter}`; }

  viewer(): User {
    return { login: this.viewerLogin ?? 'viewer', id: this.viewerId, name: this.viewerLogin ?? 'viewer', email: `${this.viewerLogin ?? 'viewer'}@example.invalid` };
  }

  /** Pin the viewer login from an owner seen in a request URL / GraphQL variable. */
  pinViewer(login: string): void {
    if (this.viewerLogin === null) this.viewerLogin = login;
  }

  createRepo(name: string, opts: { description?: string | null; private?: boolean; defaultBranch?: string }): Repo {
    const existing = this.reposByName.get(name);
    if (existing) return existing;
    const repo: Repo = {
      id: this.nextRepoId++, name, ownerLogin: null, ownerId: this.viewerId,
      description: opts.description ?? null, private: opts.private ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      refs: new Map(), objects: new Map(), labels: new Map(),
      issues: [], pulls: [], nextIssue: 1, nextPull: 1, nextComment: 1,
      seq: this.nextSeq(),
      lsRefsCache: new Map(), fetchCache: new Map(), v0AdvCache: new Map(),
    };
    this.reposByName.set(name, repo);
    return repo;
  }

  /** Resolve a repo by owner+name, pinning the owner on first sight. Returns null when absent. */
  resolveRepo(owner: string, name: string): Repo | null {
    const repo = this.reposByName.get(name);
    if (!repo) return null;
    if (repo.ownerLogin === null) {
      repo.ownerLogin = owner;
      this.pinViewer(owner);
    }
    if (repo.ownerLogin !== owner) return null;
    return repo;
  }

  /** Resolve by name only (for routes that carry no owner). Does NOT pin. */
  repoByName(name: string): Repo | null { return this.reposByName.get(name) ?? null; }

  deleteRepo(name: string): boolean { return this.reposByName.delete(name); }

  listRepos(): Repo[] { return [...this.reposByName.values()].sort((a, b) => a.seq - b.seq); }

  createIssue(repo: Repo, title: string, body: string | null, labels: string[]): Issue {
    const issue: Issue = {
      id: repo.id * 100000 + repo.nextIssue, number: repo.nextIssue, title,
      body: body ?? null, state: 'open', labels: [...labels], comments: [], seq: this.nextSeq(),
      jsonBuf: null, jsonOwner: null,
    };
    repo.nextIssue += 1;
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string | null, headBranch: string, baseBranch: string, headSha: string, baseSha: string): Pull {
    const pull: Pull = {
      id: repo.id * 100000 + repo.nextPull, number: repo.nextPull, title, body: body ?? null,
      state: 'open', merged: false, headBranch, baseBranch, headSha, baseSha,
      mergeCommitSha: null, seq: this.nextSeq(),
    };
    repo.nextPull += 1;
    repo.pulls.push(pull);
    return pull;
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const c: IssueComment = { id: repo.id * 1000000 + repo.nextComment, body, seq: this.nextSeq() };
    repo.nextComment += 1;
    issue.comments.push(c);
    issue.jsonBuf = null; // the comments count in the cached JSON changed
    return c;
  }

  /** Drop one issue's cached REST JSON (call after any direct field mutation). */
  touchIssue(issue: Issue): void { issue.jsonBuf = null; }

  /** Drop every issue's cached REST JSON in a repo (call when a label is re-created). */
  clearIssueCaches(repo: Repo): void {
    for (const issue of repo.issues) issue.jsonBuf = null;
  }
}
