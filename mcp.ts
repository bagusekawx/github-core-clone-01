// mcp.ts — Model Context Protocol endpoint at POST /mcp.
//
// JSON-RPC 2.0 over Streamable HTTP, speaking both dialects the suite probes:
//   * the current 2025-11-25 protocol version (initialize + notifications/initialized),
//   * the newer 2026-07-28 revision (server/discover answers supportedVersions, and a
//     malformed body is an HTTP 400 carrying -32700).
// Tools act on the same store as REST, so an issue created over MCP reads back over
// REST with the same number, and a pull request merged over MCP is closed for REST.
//
// The six tools the suite drives are the github-mcp-server surface: create_repo,
// get_repo, create_issue, list_issues, create_pull_request, merge_pull_request.
// Tool names match by suffix (case-insensitive), so a server prefix is accepted.

import { pullFiles, squashMerge } from './store.ts';
import { MERGED_AT, VIEWER } from './store.ts';
import type { Issue, PullRequest, Repo, Store } from './store.ts';

const PROTOCOL_VERSION = '2025-11-25';
const LATEST_REVISION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository to create.' },
        description: { type: 'string', description: 'An optional description of the repository.' },
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
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
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
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch the pull request merges from.' },
        base: { type: 'string', description: 'The base branch the pull request merges into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'number', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** The tools/list payload, built once so two calls are byte-identical. */
const TOOLS_LIST: Record<string, unknown> = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
};

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    repository_url: `/repos/${repo.fullName}`,
  };
}

function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
  };
}

function toolText(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function toolError(message: string): Record<string, unknown> {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function resolveRepo(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

function findTool(name: string): ToolDef | undefined {
  const wanted = name.toLowerCase();
  return TOOLS.find((tool) => wanted === tool.name || wanted.endsWith(`_${tool.name}`) || wanted.endsWith(`/${tool.name}`));
}

/** Run one tool call. Returns the tools/call result object. */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = findTool(name);
  if (tool === undefined) {
    return { __rpcError: -32602, message: `unknown tool: ${name}` };
  }
  // Missing a required argument is an isError result, never a crash.
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`missing required argument: ${required}`);
    }
  }

  switch (tool.name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const existing = store.getRepo(VIEWER.login, repoName);
      if (existing !== undefined) return toolError(`repository ${VIEWER.login}/${repoName} already exists`);
      const repo = store.createRepo(
        VIEWER.login,
        repoName,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      if (repo === null) return toolError(`repository ${VIEWER.login}/${repoName} already exists`);
      return toolText(repoJson(repo));
    }
    case 'get_repo': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError('repository not found');
      return toolText(repoJson(repo));
    }
    case 'create_issue': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError('repository not found');
      const issue = store.createIssue(
        repo,
        String(args.title),
        typeof args.body === 'string' ? args.body : '',
        [],
      );
      return toolText(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const issues = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
      return toolText(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError('repository not found');
      const head = String(args.head);
      const base = String(args.base);
      const headTip = repo.branchTip(head);
      const baseTip = repo.branchTip(base);
      if (headTip === undefined || baseTip === undefined) return toolError('head or base branch does not exist');
      for (const pull of repo.pulls.values()) {
        if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
          return toolError('a pull request from this head branch is already open');
        }
      }
      const pull = store.createPull(
        repo,
        String(args.title),
        typeof args.body === 'string' ? args.body : '',
        head,
        base,
        headTip,
        baseTip,
      );
      return toolText(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError('repository not found');
      const number = Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolError('pull request not found');
      if (pull.state !== 'open') return toolError('pull request is already merged or closed');
      const outcome = squashMerge(repo, pull);
      if (!outcome.ok) return toolError(outcome.reason ?? 'cannot merge');
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = MERGED_AT;
      pull.mergeCommitSha = outcome.sha!;
      return toolText({ ...pullJson(repo, pull), merged: true, sha: outcome.sha, files: pullFiles(repo, pull) });
    }
    default:
      return { __rpcError: -32602, message: `unknown tool: ${name}` };
  }
}

export interface McpReply {
  status: number;
  body: unknown;
  /** True when the request was a notification (no id) — the caller sends no body. */
  notification: boolean;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Handle one POST /mcp body. `body` is the raw request text (an empty string means no
 * body was sent) and `authed` whether the caller passed the shop token. Notifications
 * (requests without an id) are answered with 202 and no body.
 */
export function handleMcp(store: Store, body: string, authed: boolean): McpReply {
  if (!authed) {
    return { status: 401, body: { message: 'Requires authentication' }, notification: false };
  }
  if (body.trim() === '') {
    return { status: 400, body: rpcError(null, -32700, 'Parse error: empty body'), notification: false };
  }
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(body) as JsonRpcRequest;
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error'), notification: false };
  }
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request'), notification: false };
  }
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const isNotification = id === undefined || id === null;

  // Notifications are acknowledged and never answered with a body.
  if (method.startsWith('notifications/')) {
    return { status: 202, body: null, notification: true };
  }

  if (method === 'initialize') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const clientVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
    const serverVersion = clientVersion >= LATEST_REVISION ? LATEST_REVISION : PROTOCOL_VERSION;
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: serverVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'github-core-clone', version: '1.0.0' },
      }),
      notification: false,
    };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: LATEST_REVISION,
        supportedVersions: [LATEST_REVISION, PROTOCOL_VERSION],
        serverInfo: { name: 'github-core-clone', version: '1.0.0' },
        capabilities: { tools: {} },
      }),
      notification: false,
    };
  }

  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}), notification: false };
  }

  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, TOOLS_LIST), notification: false };
  }

  if (method === 'tools/call') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const result = callTool(store, name, args);
    const rpcCode = (result as Record<string, unknown>).__rpcError;
    if (typeof rpcCode === 'number') {
      return {
        status: 200,
        body: rpcError(id, rpcCode, String((result as Record<string, unknown>).message ?? 'unknown tool')),
        notification: false,
      };
    }
    return { status: 200, body: rpcResult(id, result), notification: false };
  }

  return { status: 200, body: rpcError(id, -32601, `method not found: ${method}`), notification: false };
}
