// MCP handler for the github-core-clone-01 forge.
// POST /mcp — JSON-RPC 2.0 over Streamable HTTP (single JSON response object).
// Modern era 2026-07-28 (server/discover) + legacy initialize handshake.
// No deps, no network, deterministic: the tools list is a fixed constant.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pull, Repo, Store } from './store.ts';
import { buildFixedCommit, buildTree, parseCommit } from './gitobj.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, Record<string, string>>; required: string[] };
}

// Fixed order, fixed content: two tools/list calls answer byte for byte.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        owner: { type: 'string', description: 'The owner login of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository (owner/repo).' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository (owner/repo).' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository (owner/repo).' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository (owner/repo).' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository (owner/repo).' },
        pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const REQUIRED: Record<string, string[]> = {
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function pickOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) {
      if (owner === '') owner = parts[0];
      if (repo === '') repo = parts[1];
    }
  }
  return { owner, repo };
}

function repoFullName(store: Store, repo: Repo): string {
  return `${repo.ownerLogin ?? store.viewer().login}/${repo.name}`;
}

function repoPayload(store: Store, repo: Repo): Record<string, unknown> {
  const owner = repo.ownerLogin ?? store.viewer().login;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: repo.ownerId },
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    has_issues: true,
  };
}

function issuePayload(store: Store, repo: Repo, issue: Repo['issues'][number]): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    repository: repoFullName(store, repo),
  };
}

function commitTreeSha(repo: Repo, sha: string): string | null {
  if (!sha) return null;
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

/** Squash-merge, same semantics as the GraphQL merge: one fixed-ident commit. */
function mergePull(repo: Repo, pull: Pull): string {
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

interface ToolOutcome {
  payload: unknown;
  isError: boolean;
}

function ok(payload: unknown): ToolOutcome {
  return { payload, isError: false };
}

function toolError(message: string): ToolOutcome {
  return { payload: { error: message }, isError: true };
}

function missingArg(name: string): ToolOutcome {
  return toolError(`Missing required argument: ${name}`);
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const required = REQUIRED[name] ?? [];
  for (const key of required) {
    const v = args[key];
    if (v === undefined || v === null || v === '') return missingArg(key);
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const repo = store.createRepo(repoName, {
        description: typeof args.description === 'string' ? args.description : null,
        private: args.private === true,
      });
      if (repo.ownerLogin === null) {
        const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : store.viewer().login;
        repo.ownerLogin = owner;
        store.pinViewer(owner);
      }
      return ok(repoPayload(store, repo));
    }
    case 'get_repo': {
      const { owner, repo: repoName } = pickOwnerRepo(args);
      const repo = store.resolveRepo(owner, repoName);
      if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
      return ok(repoPayload(store, repo));
    }
    case 'create_issue': {
      const { owner, repo: repoName } = pickOwnerRepo(args);
      const repo = store.resolveRepo(owner, repoName);
      if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
      const issue = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : null, []);
      return ok(issuePayload(store, repo, issue));
    }
    case 'list_issues': {
      const { owner, repo: repoName } = pickOwnerRepo(args);
      const repo = store.resolveRepo(owner, repoName);
      if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const list = repo.issues.filter((issue) => state === 'all' ? true : issue.state === state);
      return ok(list.map((issue) => issuePayload(store, repo, issue)));
    }
    case 'create_pull_request': {
      const { owner, repo: repoName } = pickOwnerRepo(args);
      const repo = store.resolveRepo(owner, repoName);
      if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
      const head = String(args.head);
      const base = String(args.base);
      const headSha = repo.refs.get(`refs/heads/${head}`) ?? '';
      const baseSha = repo.refs.get(`refs/heads/${base}`) ?? '';
      const pull = store.createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : null, head, base, headSha, baseSha);
      return ok({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: 'open',
        merged: false,
        head: { ref: pull.headBranch, sha: pull.headSha },
        base: { ref: pull.baseBranch, sha: pull.baseSha },
      });
    }
    case 'merge_pull_request': {
      const { owner, repo: repoName } = pickOwnerRepo(args);
      const repo = store.resolveRepo(owner, repoName);
      if (!repo) return toolError(`Repository not found: ${owner}/${repoName}`);
      const num = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) return toolError(`Pull request not found: #${String(args.pull_number)}`);
      const sha = mergePull(repo, pull);
      return ok({ number: pull.number, id: pull.id, merged: true, state: 'closed', sha, message: `Merged pull request #${pull.number}` });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown, sessionId: string | null): void {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text)),
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  res.writeHead(status, headers);
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
 * Handle POST /mcp. Returns true when the request was this route (handled),
 * false otherwise so the router can fall through.
 */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store, auth: string): Promise<boolean> {
  const url = req.url ?? '';
  const path = url.split('?')[0];
  if (req.method !== 'POST' || path !== '/mcp') return false;
  const sessionId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : null;
  if (!auth || req.headers.authorization !== auth) {
    sendJson(res, 401, { message: 'Unauthorized' }, sessionId);
    return true;
  }
  let text: string;
  try {
    text = await readBody(req);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, sessionId);
    return true;
  }
  let parsed: unknown;
  try {
    parsed = text.trim() === '' ? null : JSON.parse(text);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, sessionId);
    return true;
  }
  if (!isRecord(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }, sessionId);
    return true;
  }
  const id: unknown = 'id' in parsed ? parsed.id : undefined;
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const params = isRecord(parsed.params) ? parsed.params : {};
  // Notifications carry no id and get no JSON-RPC result: 202, empty body.
  if (id === undefined) {
    res.writeHead(202, sessionId ? { 'mcp-session-id': sessionId } : {});
    res.end();
    return true;
  }
  const result = (value: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: value }, sessionId);
  };
  const rpcError = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } }, sessionId);
  };
  switch (method) {
    case 'server/discover': {
      result({
        resultType: 'discover',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {}, logging: {}, prompts: {}, resources: {} },
        instructions: 'A GitHub-compatible git forge: repositories, issues and pull requests.',
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
      return true;
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' && params.protocolVersion !== '' ? params.protocolVersion : '2025-11-25';
      result({
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return true;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress': {
      res.writeHead(202, sessionId ? { 'mcp-session-id': sessionId } : {});
      res.end();
      return true;
    }
    case 'ping': {
      result({});
      return true;
    }
    case 'tools/list': {
      result({ tools: TOOLS });
      return true;
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (toolName === '' || !(toolName in REQUIRED)) {
        rpcError(-32601, `Unknown tool: ${toolName === '' ? '(none)' : toolName}`);
        return true;
      }
      const outcome = callTool(store, toolName, args);
      result({
        content: [{ type: 'text', text: JSON.stringify(outcome.payload) }],
        structuredContent: outcome.payload,
        isError: outcome.isError,
      });
      return true;
    }
    case 'resources/list': {
      result({ resources: [] });
      return true;
    }
    case 'prompts/list': {
      result({ prompts: [] });
      return true;
    }
    default: {
      rpcError(-32601, `Method not found: ${method}`);
      return true;
    }
  }
}
