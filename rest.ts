// rest.ts — GitHub REST v3 under /api/v3.
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id (app.ts adds
// both); errors carry {"message": string}. The bearer token names the scenario viewer
// (adaiversen); a repository under any other owner is a 404, never a 403.
//
// The routes the suite drives, in full: user, user/repos, repos CRUD, branches,
// commits, git/refs, contents (PUT/GET/DELETE), labels, issues + comments, pulls +
// files + squash merge. Validation statuses follow GitHub: 401 no token, 404 missing,
// 405 a conflicted or already-merged pull, 409 a stale contents sha, 422 a bad label,
// a duplicate repository or a pull request that cannot open.

import { parseCommit } from './git.ts';
import {
  MERGED_AT,
  VIEWER,
  commitFile,
  commitTree,
  flattenTree,
  pullFiles,
  squashMerge,
  treeEntryAt,
  walkCommits,
} from './store.ts';
import type { Issue, PullRequest, Repo, Store } from './store.ts';
import { parseTree as parseTreeBytes } from './git.ts';

export interface RestRequest {
  method: string;
  /** Decoded path segments after /api/v3. */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body (undefined when no body was sent). */
  body: unknown;
  bodyMalformed: boolean;
  authed: boolean;
  /** The request's origin, for absolute Link URLs (e.g. http://127.0.0.1:4123). */
  origin: string;
}

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const CREATED_AT = '2026-01-01T00:00:00Z';

function err(status: number, message: string): RestReply {
  return { status, body: { message } };
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestReply {
  return { status, body, headers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
}

export function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    comments: 0,
  };
}

export function pullJson(pull: PullRequest, repo: Repo): Record<string, unknown> {
  const headSha = repo.branchTip(pull.headRef) ?? pull.headSha;
  const baseSha = repo.branchTip(pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open',
    user: { login: VIEWER.login, id: VIEWER.id },
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number(query.get('per_page'));
  const pageRaw = Number(query.get('page'));
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], query: URLSearchParams, origin: string, path: string): { items: T[]; link: string | null } {
  const { perPage, page } = pageParams(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const url = new URL(`${origin}${path}`);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page + 1));
    link = `<${url.toString()}>; rel="next"`;
  }
  return { items: slice, link };
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function resolveRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

/** Resolve a ref query (?ref= / ?sha=) to a commit id: a branch name or a commit sha. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') {
    const tip = repo.branchTip(repo.defaultBranch);
    return tip ?? null;
  }
  const branchTip = repo.branchTip(ref);
  if (branchTip !== undefined) return branchTip;
  const object = repo.getObject(ref);
  if (object !== undefined && object.type === 'commit') return ref;
  return null;
}

function numberParam(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

export function handleRest(store: Store, req: RestRequest): RestReply {
  const [a, b, c, ...rest] = req.segments;

  // The API root and meta are public, as the starter serves them; everything else needs the token.
  const isPublic = req.method === 'GET' && (req.segments.length === 0 || (req.segments.length === 1 && a === 'meta'));
  if (!isPublic && !req.authed) return err(401, 'Requires authentication');

  if (req.bodyMalformed) return err(400, 'Invalid JSON in request body');
  const body = isRecord(req.body) ? req.body : {};

  // GET /api/v3/ — the API root, with the token's scopes.
  if (req.segments.length === 0) {
    if (req.method !== 'GET') return err(404, 'Not Found');
    return ok(
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  // GET /api/v3/meta
  if (a === 'meta' && req.segments.length === 1) {
    if (req.method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: false, hooks: [] });
  }

  // GET /api/v3/user
  if (a === 'user' && req.segments.length === 1) {
    if (req.method !== 'GET') return err(404, 'Not Found');
    return ok(200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
  }

  // /api/v3/user/repos
  if (a === 'user' && b === 'repos' && req.segments.length === 2) {
    if (req.method === 'GET') {
      const repos = store.reposOf(VIEWER.login).map(repoJson);
      const { items, link } = paginate(repos, req.query, req.origin, '/api/v3/user/repos');
      return ok(200, items, link === null ? undefined : { link });
    }
    if (req.method === 'POST') {
      const name = asString(body.name);
      if (name === '') return err(422, 'name is required');
      const repo = store.createRepo(VIEWER.login, name, body.private === true, asString(body.description, ''));
      if (repo === null) return err(422, 'Repository already exists');
      return ok(201, repoJson(repo));
    }
    return err(404, 'Not Found');
  }

  // Everything below is /api/v3/repos/{owner}/{name}/...
  if (a !== 'repos' || b === undefined || c === undefined) return err(404, 'Not Found');
  const repo = resolveRepo(store, b, c);
  if (repo === null) return err(404, 'Not Found');
  const repoPath = `/api/v3/repos/${encodeURIComponent(b)}/${encodeURIComponent(c)}`;

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (req.method === 'GET') return ok(200, repoJson(repo));
    if (req.method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      return ok(200, repoJson(repo));
    }
    if (req.method === 'DELETE') {
      store.deleteRepo(b, c);
      return { status: 204 };
    }
    return err(404, 'Not Found');
  }

  const [section, ...tail] = rest;

  // ---- branches ----
  if (section === 'branches') {
    if (req.method !== 'GET') return err(404, 'Not Found');
    if (tail.length === 0) {
      const branches = repo.listBranches().map((branch) => ({ name: branch.name, commit: { sha: branch.sha }, protected: false }));
      return ok(200, branches);
    }
    const branch = tail.join('/');
    const tip = repo.branchTip(branch);
    if (tip === undefined) return err(404, 'Not Found');
    return ok(200, { name: branch, commit: { sha: tip }, protected: false });
  }

  // ---- commits ----
  if (section === 'commits') {
    if (req.method !== 'GET' || tail.length > 0) return err(404, 'Not Found');
    const tip = resolveRef(repo, req.query.get('sha'));
    if (tip === null) return ok(200, []);
    const commits = walkCommits(repo, [tip]).map((sha) => {
      const object = repo.getObject(sha)!;
      const parsed = parseCommit(object.data);
      return {
        sha,
        commit: {
          message: parsed.message.replace(/\n$/, ''),
          author: { name: VIEWER.name, email: VIEWER.email, date: CREATED_AT },
          committer: { name: VIEWER.name, email: VIEWER.email, date: CREATED_AT },
        },
        author: { login: VIEWER.login, id: VIEWER.id },
      };
    });
    const { items } = paginate(commits, req.query, req.origin, `${repoPath}/commits`);
    return ok(200, items);
  }

  // ---- git/refs ----
  if (section === 'git' && tail[0] === 'refs') {
    const refTail = tail.slice(1);
    if (req.method === 'POST' && refTail.length === 0) {
      const ref = asString(body.ref);
      const sha = asString(body.sha);
      if (!ref.startsWith('refs/') || sha === '') return err(422, 'ref and sha are required');
      if (repo.getObject(sha) === undefined) return err(422, 'sha does not name an object in this repository');
      if (repo.refTip(ref) !== undefined) return err(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      const object = repo.getObject(sha)!;
      return ok(201, { ref, object: { sha, type: object.type } });
    }
    if (req.method === 'GET') {
      if (refTail.length === 0) {
        const refs = [...repo.refs.entries()]
          .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
          .map(([ref, sha]) => ({ ref, object: { sha } }));
        return ok(200, refs);
      }
      const ref = `refs/${refTail.join('/')}`;
      const sha = repo.refTip(ref);
      if (sha === undefined) return err(404, 'Not Found');
      return ok(200, { ref, object: { sha } });
    }
    return err(404, 'Not Found');
  }

  // ---- contents ----
  if (section === 'contents') {
    return handleContents(repo, req, tail, body);
  }

  // ---- labels ----
  if (section === 'labels' && tail.length === 0) {
    if (req.method === 'GET') {
      return ok(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    }
    if (req.method === 'POST') {
      const name = asString(body.name);
      if (name === '') return err(422, 'name is required');
      const existing = repo.labels.get(name);
      if (existing !== undefined) return ok(201, { name: existing.name, color: existing.color });
      const label = { name, color: asString(body.color, 'ededed') };
      repo.labels.set(name, label);
      return ok(201, { name: label.name, color: label.color });
    }
    return err(404, 'Not Found');
  }

  // ---- issues ----
  if (section === 'issues') {
    return handleIssues(store, repo, req, tail, body);
  }

  // ---- pulls ----
  if (section === 'pulls') {
    return handlePulls(store, repo, req, tail, body);
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function handleContents(repo: Repo, req: RestRequest, tail: string[], body: Record<string, unknown>): RestReply {
  const path = tail.join('/');
  const branch = asString(body.branch, '') || repo.defaultBranch;

  if (req.method === 'PUT') {
    const message = asString(body.message, '') || `Update ${path}`;
    const content = body.content;
    if (typeof content !== 'string') return err(422, 'content is required');
    const bytes = Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64');
    // A stale sha is a 409; a matching sha (or none) is an update.
    const tip = repo.branchTip(branch) ?? repo.branchTip(repo.defaultBranch);
    let exists = false;
    let currentSha: string | null = null;
    if (tip !== undefined) {
      const tree = commitTree(repo, tip);
      if (tree !== null) {
        const entry = treeEntryAt(repo, tree, path.split('/'));
        if (entry !== null && entry.mode !== '40000') {
          exists = true;
          currentSha = entry.oid;
        }
      }
    }
    const givenSha = asString(body.sha, '');
    if (exists && givenSha !== '' && givenSha.toLowerCase() !== (currentSha ?? '').toLowerCase()) {
      return err(409, 'sha does not match the current file');
    }
    const { commitSha, blobSha } = commitFile(repo, branch, path, bytes, message);
    const name = path.split('/').pop() ?? path;
    return ok(exists ? 200 : 201, {
      content: { name, path, sha: blobSha, size: bytes.length, encoding: 'base64', type: 'file' },
      commit: { sha: commitSha, message },
    });
  }

  if (req.method === 'GET') {
    const tip = resolveRef(repo, req.query.get('ref'));
    if (tip === null) return err(404, 'Not Found');
    const tree = commitTree(repo, tip);
    if (tree === null) return err(404, 'Not Found');
    // The repository root lists its top-level entries.
    if (path === '') {
      const object = repo.getObject(tree);
      if (object === undefined) return err(404, 'Not Found');
      const entries = parseTreeBytes(object.data).map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: entry.name,
        sha: entry.oid,
      }));
      return ok(200, entries);
    }
    const entry = treeEntryAt(repo, tree, path.split('/'));
    if (entry === null) return err(404, 'Not Found');
    if (entry.mode === '40000') {
      const object = repo.getObject(entry.oid);
      if (object === undefined) return err(404, 'Not Found');
      const entries = parseTreeBytes(object.data).map((child) => ({
        type: child.mode === '40000' ? 'dir' : 'file',
        name: child.name,
        path: `${path}/${child.name}`,
        sha: child.oid,
      }));
      entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
      return ok(200, entries);
    }
    const blob = repo.getObject(entry.oid);
    if (blob === undefined) return err(404, 'Not Found');
    return ok(200, {
      type: 'file',
      name: entry.name,
      path,
      sha: entry.oid,
      size: blob.data.length,
      encoding: 'base64',
      content: blob.data.toString('base64'),
    });
  }

  if (req.method === 'DELETE') {
    const message = asString(body.message, '') || `Delete ${path}`;
    const tip = repo.branchTip(branch);
    if (tip === undefined) return err(404, 'Not Found');
    const tree = commitTree(repo, tip);
    if (tree === null) return err(404, 'Not Found');
    const entry = treeEntryAt(repo, tree, path.split('/'));
    if (entry === null || entry.mode === '40000') return err(404, 'Not Found');
    const givenSha = asString(body.sha, '');
    if (givenSha !== '' && givenSha.toLowerCase() !== entry.oid.toLowerCase()) {
      return err(409, 'sha does not match the current file');
    }
    const { commitSha } = commitFile(repo, branch, path, null, message);
    return ok(200, { commit: { sha: commitSha, message } });
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

function handleIssues(store: Store, repo: Repo, req: RestRequest, tail: string[], body: Record<string, unknown>): RestReply {
  const repoPath = `/api/v3/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

  if (tail.length === 0) {
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      else if (state !== 'all') return err(422, 'invalid state');
      const direction = req.query.get('direction') ?? 'desc';
      issues.sort((x, y) => (direction === 'asc' ? x.seq - y.seq : y.seq - x.seq));
      const { items, link } = paginate(issues.map(issueJson), req.query, req.origin, `${repoPath}/issues`);
      return ok(200, items, link === null ? undefined : { link });
    }
    if (req.method === 'POST') {
      const title = asString(body.title);
      if (title === '') return err(422, 'title is required');
      const labelNames = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
      const labels: Array<{ name: string; color: string }> = [];
      for (const name of labelNames) {
        const label = repo.labels.get(name);
        if (label === undefined) return err(422, `label ${JSON.stringify(name)} does not exist`);
        labels.push(label);
      }
      const issue = store.createIssue(repo, title, asString(body.body, ''), labels);
      return ok(201, issueJson(issue));
    }
    return err(404, 'Not Found');
  }

  const number = numberParam(tail[0]!);
  if (number === null) return err(404, 'Not Found');
  const issue = repo.issues.get(number);

  // /issues/{n}/comments
  if (tail[1] === 'comments' && tail.length === 2) {
    if (issue === undefined) return err(404, 'Not Found');
    if (req.method === 'GET') {
      const comments = (repo.comments.get(number) ?? []).map((comment) => ({
        id: comment.id,
        body: comment.body,
        user: { login: VIEWER.login, id: VIEWER.id },
        created_at: CREATED_AT,
      }));
      return ok(200, comments);
    }
    if (req.method === 'POST') {
      const commentBody = asString(body.body, '');
      const comment = { id: repo.nextCommentId++, body: commentBody };
      const list = repo.comments.get(number) ?? [];
      list.push(comment);
      repo.comments.set(number, list);
      return ok(201, { id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: CREATED_AT });
    }
    return err(404, 'Not Found');
  }

  if (tail.length !== 1) return err(404, 'Not Found');
  if (issue === undefined) return err(404, 'Not Found');

  if (req.method === 'GET') return ok(200, issueJson(issue));
  if (req.method === 'PATCH') {
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
    if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
    if (Array.isArray(body.labels)) {
      const labels: Array<{ name: string; color: string }> = [];
      for (const entry of body.labels) {
        if (typeof entry !== 'string') continue;
        const label = repo.labels.get(entry);
        if (label === undefined) return err(422, `label ${JSON.stringify(entry)} does not exist`);
        labels.push(label);
      }
      issue.labels = labels;
    }
    return ok(200, issueJson(issue));
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// pulls
// ---------------------------------------------------------------------------------------------

function handlePulls(store: Store, repo: Repo, req: RestRequest, tail: string[], body: Record<string, unknown>): RestReply {
  const repoPath = `/api/v3/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

  if (tail.length === 0) {
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      else if (state !== 'all') return err(422, 'invalid state');
      pulls.sort((x, y) => y.seq - x.seq);
      const { items, link } = paginate(pulls.map((pull) => pullJson(pull, repo)), req.query, req.origin, `${repoPath}/pulls`);
      return ok(200, items, link === null ? undefined : { link });
    }
    if (req.method === 'POST') {
      const title = asString(body.title);
      const head = asString(body.head);
      const base = asString(body.base);
      if (title === '' || head === '' || base === '') return err(422, 'title, head and base are required');
      const headTip = repo.branchTip(head);
      const baseTip = repo.branchTip(base);
      if (headTip === undefined || baseTip === undefined) return err(422, 'head or base branch does not exist');
      if (head === base) return err(422, 'head and base are the same branch');
      for (const pull of repo.pulls.values()) {
        if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
          return err(422, 'a pull request from this head branch is already open');
        }
      }
      const pull = store.createPull(repo, title, asString(body.body, ''), head, base, headTip, baseTip);
      return ok(201, pullJson(pull, repo));
    }
    return err(404, 'Not Found');
  }

  const number = numberParam(tail[0]!);
  if (number === null) return err(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (pull === undefined) return err(404, 'Not Found');

  // /pulls/{n}/files
  if (tail[1] === 'files' && tail.length === 2) {
    if (req.method !== 'GET') return err(404, 'Not Found');
    return ok(200, pullFiles(repo, pull));
  }

  // /pulls/{n}/merge
  if (tail[1] === 'merge' && tail.length === 2) {
    if (req.method !== 'PUT') return err(404, 'Not Found');
    if (pull.state !== 'open') return err(405, 'Pull Request is already merged or closed');
    const outcome = squashMerge(repo, pull);
    if (!outcome.ok) {
      const conflict = outcome.reason === 'merge conflict';
      return err(conflict ? 405 : 422, outcome.reason ?? 'cannot merge');
    }
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = MERGED_AT;
    pull.mergeCommitSha = outcome.sha!;
    return ok(200, { merged: true, sha: outcome.sha, message: 'Pull Request successfully merged' });
  }

  if (tail.length !== 1) return err(404, 'Not Found');
  if (req.method === 'GET') return ok(200, pullJson(pull, repo));
  return err(404, 'Not Found');
}

// Re-exported so app.ts has one import for the tree helper it does not need.
export { flattenTree };
