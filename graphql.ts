// graphql.ts — GitHub GraphQL v4 at /api/graphql.
//
// A small, exact GraphQL executor for the documents gh and github-mcp-server send
// (checks-graphql.ts lists all eighteen). It parses each document, validates every
// field against a small schema (an unknown field is a 200 with an `errors` array
// naming it, never an HTTP error), and executes against the same store as REST.
//
// Global ids are opaque base64url of a typed key (R:<repoId>, I:<repoId>:<number>,
// P:<repoId>:<number>, C:<repoId>:<issue>:<comment>) — stable across reads and never
// the plain database id or number. Batched bodies (a JSON array) answer in order.

import { pullConflicts, pullFiles, squashMerge } from './store.ts';
import { MERGED_AT, VIEWER } from './store.ts';
import type { Issue, PullRequest, Repo, Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// global ids and cursors
// ---------------------------------------------------------------------------------------------

function encodeId(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url');
}

function decodeId(id: string): string | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    if (Buffer.from(text, 'utf8').toString('base64url') !== id) return null;
    return text;
  } catch {
    return null;
  }
}

const repoGlobalId = (repo: Repo): string => encodeId(`R:${repo.id}`);
const issueGlobalId = (repo: Repo, issue: Issue): string => encodeId(`I:${repo.id}:${issue.number}`);
const pullGlobalId = (repo: Repo, pull: PullRequest): string => encodeId(`P:${repo.id}:${pull.number}`);
const commentGlobalId = (repo: Repo, issueNumber: number, commentId: number): string =>
  encodeId(`C:${repo.id}:${issueNumber}:${commentId}`);

const cursorFor = (number: number): string => encodeId(`cur:${number}`);

function cursorNumber(cursor: string): number | null {
  const text = decodeId(cursor);
  if (text === null || !text.startsWith('cur:')) return null;
  const n = Number(text.slice(4));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------------------------
// the document parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | string
  | number
  | boolean
  | null
  | { __enum: string }
  | { __var: string }
  | ValueNode[]
  | { [key: string]: ValueNode };

interface FieldSelection {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  children: Selection[];
}

interface FragmentSelection {
  kind: 'fragment';
  typeCondition: string | null;
  children: Selection[];
}

type Selection = FieldSelection | FragmentSelection;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefaults: Record<string, ValueNode>;
  selections: Selection[];
}

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!$=[]@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      // Block strings (""") are not in the suite's documents; treat them as plain strings.
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: input.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          if (esc === 'u') {
            out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' }[esc] ?? esc;
            j += 2;
          }
        } else {
          out += input[j];
          j += 1;
        }
      }
      if (j >= input.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9.]/.test(input[j]!)) j += 1;
      if (input[j] === 'e' || input[j] === 'E') {
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      tokens.push({ kind: 'number', value: Number(input.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_0-9A-Za-z]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document, got ${token.kind === 'punct' ? token.value : token.value}`);
    }
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const first = this.peek();
    if (first !== undefined && first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = first.value;
      this.next();
      const after = this.peek();
      if (after !== undefined && after.kind === 'name') name = this.next().value as string;
    }
    const varDefaults: Record<string, ValueNode> = {};
    const varOpen = this.peek();
    if (varOpen !== undefined && varOpen.kind === 'punct' && varOpen.value === '(') {
      this.next();
      while (true) {
        const token = this.peek();
        if (token === undefined) throw new Error('unterminated variable definitions');
        if (token.kind === 'punct' && token.value === ')') {
          this.next();
          break;
        }
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        const eq = this.peek();
        if (eq !== undefined && eq.kind === 'punct' && eq.value === '=') {
          this.next();
          varDefaults[varName] = this.parseValue();
        }
      }
    }
    const selections = this.parseSelectionSet();
    return { kind, name, varDefaults, selections };
  }

  private parseType(): void {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    const bang = this.peek();
    if (bang !== undefined && bang.kind === 'punct' && bang.value === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (true) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        break;
      }
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === '...') {
      this.next();
      let typeCondition: string | null = null;
      const on = this.peek();
      if (on !== undefined && on.kind === 'name' && on.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      return { kind: 'fragment', typeCondition, children: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    const colon = this.peek();
    if (colon !== undefined && colon.kind === 'punct' && colon.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    const open = this.peek();
    if (open !== undefined && open.kind === 'punct' && open.value === '(') {
      this.next();
      while (true) {
        const next = this.peek();
        if (next === undefined) throw new Error('unterminated arguments');
        if (next.kind === 'punct' && next.value === ')') {
          this.next();
          break;
        }
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    let children: Selection[] = [];
    const brace = this.peek();
    if (brace !== undefined && brace.kind === 'punct' && brace.value === '{') {
      children = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, children };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'string' || token.kind === 'number') return token.value;
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    if (token.kind === 'punct' && token.value === '$') return { __var: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (true) {
        const next = this.peek();
        if (next === undefined) throw new Error('unterminated list value');
        if (next.kind === 'punct' && next.value === ']') {
          this.next();
          break;
        }
        items.push(this.parseValue());
      }
      return items;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: { [key: string]: ValueNode } = {};
      while (true) {
        const next = this.peek();
        if (next === undefined) throw new Error('unterminated object value');
        if (next.kind === 'punct' && next.value === '}') {
          this.next();
          break;
        }
        const key = this.expectName();
        this.expectPunct(':');
        object[key] = this.parseValue();
      }
      return object;
    }
    throw new Error(`unexpected value token ${token.kind}`);
  }
}

function parseDocument(query: string): Operation {
  const parser = new Parser(tokenize(query));
  return parser.parseOperation();
}

// ---------------------------------------------------------------------------------------------
// the schema (field -> return type; [T] is a list)
// ---------------------------------------------------------------------------------------------

const SCHEMA: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Node: { id: 'ID' },
  User: { id: 'ID', login: 'String', name: 'String', email: 'String' },
  Repository: {
    id: 'ID',
    databaseId: 'Int',
    name: 'String',
    nameWithOwner: 'String',
    owner: 'User',
    defaultBranchRef: 'Ref',
    viewerPermission: 'String',
    hasIssuesEnabled: 'Boolean',
    description: 'String',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  Ref: { name: 'String' },
  Issue: { id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'String' },
  PullRequest: {
    id: 'ID',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'String',
    merged: 'Boolean',
    mergeable: 'String',
    headRefName: 'String',
    baseRefName: 'String',
    files: 'PullRequestFileConnection',
  },
  IssueConnection: { nodes: '[Issue]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestConnection: { nodes: '[PullRequest]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestFileConnection: { nodes: '[PullRequestFile]', pageInfo: 'PageInfo' },
  PullRequestFile: { path: 'String' },
  PageInfo: { hasNextPage: 'Boolean', endCursor: 'String', hasPreviousPage: 'Boolean', startCursor: 'String' },
  __Type: { name: 'String', kind: 'String', fields: '[__Field]', enumValues: '[__EnumValue]' },
  __Field: { name: 'String' },
  __EnumValue: { name: 'String' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
  IssueCommentEdge: { node: 'IssueComment' },
  IssueComment: { id: 'ID', body: 'String' },
};

const SCALARS = new Set(['ID', 'Int', 'String', 'Boolean']);

function unwrapList(type: string): string {
  return type.startsWith('[') && type.endsWith(']') ? type.slice(1, -1) : type;
}

const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'closed'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'author', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'login', 'name', 'email'],
  SearchType: [],
};

const INTROSPECTION_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
};

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface GqlNode {
  __type: string;
  [key: string]: unknown;
}

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  varDefaults: Record<string, ValueNode>;
  errors: Array<{ message: string }>;
}

function resolveValue(value: ValueNode, ctx: Ctx): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, ctx));
  if ('__enum' in value) return value.__enum;
  if ('__var' in value) {
    if (value.__var in ctx.variables) return ctx.variables[value.__var];
    const def = ctx.varDefaults[value.__var];
    return def === undefined ? undefined : resolveValue(def, ctx);
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = resolveValue(entry, ctx);
  return out;
}

function resolveArgs(field: FieldSelection, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = resolveValue(value, ctx);
  return out;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** Validate every field of a selection set against the schema; unknown fields are errors. */
function validateSelections(selections: readonly Selection[], typeName: string, errors: Array<{ message: string }>): void {
  const fields = SCHEMA[typeName];
  if (fields === undefined) return;
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const narrowed = selection.typeCondition ?? typeName;
      if (SCHEMA[narrowed] !== undefined) validateSelections(selection.children, narrowed, errors);
      continue;
    }
    const returnType = fields[selection.name];
    if (returnType === undefined) {
      errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      continue;
    }
    if (selection.children.length > 0 && !SCALARS.has(unwrapList(returnType))) {
      validateSelections(selection.children, unwrapList(returnType), errors);
    }
  }
}

function repoByGlobalId(ctx: Ctx, id: string): Repo | null {
  const text = decodeId(id);
  if (text === null) return null;
  const match = /^R:(\d+)$/.exec(text);
  if (match === null) return null;
  for (const repo of ctx.store.repos.values()) {
    if (repo.id === Number(match[1])) return repo;
  }
  return null;
}

function issueByGlobalId(ctx: Ctx, id: string): { repo: Repo; issue: Issue } | null {
  const text = decodeId(id);
  if (text === null) return null;
  const match = /^I:(\d+):(\d+)$/.exec(text);
  if (match === null) return null;
  for (const repo of ctx.store.repos.values()) {
    if (repo.id !== Number(match[1])) continue;
    const issue = repo.issues.get(Number(match[2]));
    return issue === undefined ? null : { repo, issue };
  }
  return null;
}

function pullByGlobalId(ctx: Ctx, id: string): { repo: Repo; pull: PullRequest } | null {
  const text = decodeId(id);
  if (text === null) return null;
  const match = /^P:(\d+):(\d+)$/.exec(text);
  if (match === null) return null;
  for (const repo of ctx.store.repos.values()) {
    if (repo.id !== Number(match[1])) continue;
    const pull = repo.pulls.get(Number(match[2]));
    return pull === undefined ? null : { repo, pull };
  }
  return null;
}

function issueNode(repo: Repo, issue: Issue): GqlNode {
  return { __type: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: PullRequest): GqlNode {
  return { __type: 'PullRequest', repo, pull };
}

function userNode(): GqlNode {
  return { __type: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
}

function repoNode(repo: Repo): GqlNode {
  return { __type: 'Repository', repo };
}

/** The issues connection for a repository, filtered, ordered and paged. */
function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlNode {
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((entry) => String(entry).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'DESC' ? 'desc' : 'asc';
  issues.sort((x, y) => (direction === 'asc' ? x.seq - y.seq : y.seq - x.seq));
  const after = typeof args.after === 'string' ? cursorNumber(args.after) : null;
  if (after !== null) {
    const index = issues.findIndex((issue) => issue.number === after);
    if (index >= 0) issues = issues.slice(index + 1);
  }
  const first = asInt(args.first);
  const limit = first === null ? issues.length : Math.max(0, first);
  const page = issues.slice(0, limit);
  const hasNextPage = issues.length > limit;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null;
  return {
    __type: 'IssueConnection',
    nodes: page.map((issue) => issueNode(repo, issue)),
    pageInfo: { __type: 'PageInfo', hasNextPage, endCursor },
    totalCount: issues.length,
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): GqlNode {
  let pulls = [...repo.pulls.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((entry) => String(entry).toLowerCase()));
    pulls = pulls.filter((pull) => wanted.has(pull.state));
  } else {
    pulls = pulls.filter((pull) => pull.state === 'open');
  }
  pulls.sort((x, y) => y.seq - x.seq);
  const first = asInt(args.first);
  const limit = first === null ? pulls.length : Math.max(0, first);
  const page = pulls.slice(0, limit);
  return {
    __type: 'PullRequestConnection',
    nodes: page.map((pull) => pullNode(repo, pull)),
    pageInfo: { __type: 'PageInfo', hasNextPage: pulls.length > limit, endCursor: null },
    totalCount: pulls.length,
  };
}

/** Resolve one field of one node. Returns null when the field's value is null. */
function resolveField(ctx: Ctx, typeName: string, node: GqlNode, field: FieldSelection): unknown {
  const args = resolveArgs(field, ctx);
  const name = field.name;

  if (typeName === 'Query') {
    if (name === 'viewer') return userNode();
    if (name === 'repository') {
      const owner = asString(args.owner);
      const repoName = asString(args.name);
      if (owner !== VIEWER.login) return null;
      const repo = ctx.store.getRepo(owner, repoName);
      return repo === undefined ? null : repoNode(repo);
    }
    if (name === 'node') {
      const id = asString(args.id);
      const repoText = decodeId(id);
      if (repoText === null) return null;
      if (repoText.startsWith('R:')) {
        const repo = repoByGlobalId(ctx, id);
        return repo === null ? null : repoNode(repo);
      }
      if (repoText.startsWith('I:')) {
        const found = issueByGlobalId(ctx, id);
        return found === null ? null : issueNode(found.repo, found.issue);
      }
      if (repoText.startsWith('P:')) {
        const found = pullByGlobalId(ctx, id);
        return found === null ? null : pullNode(found.repo, found.pull);
      }
      return null;
    }
    if (name === '__type') {
      const type = asString(args.name);
      if (INTROSPECTION_FIELDS[type] === undefined && INTROSPECTION_ENUMS[type] === undefined) return null;
      return { __type: '__Type', typeName: type };
    }
  }

  if (typeName === 'Mutation') {
    if (name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(ctx, asString(input.repositoryId));
      if (repo === null) {
        ctx.errors.push({ message: 'repository not found' });
        return null;
      }
      const issue = ctx.store.createIssue(repo, asString(input.title), asString(input.body), []);
      return { __type: 'CreateIssuePayload', issue: issueNode(repo, issue) };
    }
    if (name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGlobalId(ctx, asString(input.issueId));
      if (found === null) {
        ctx.errors.push({ message: 'issue not found' });
        return null;
      }
      found.issue.state = 'closed';
      return { __type: 'CloseIssuePayload', issue: issueNode(found.repo, found.issue) };
    }
    if (name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGlobalId(ctx, asString(input.repositoryId));
      if (repo === null) {
        ctx.errors.push({ message: 'repository not found' });
        return null;
      }
      const head = asString(input.headRefName);
      const base = asString(input.baseRefName);
      const headTip = repo.branchTip(head);
      const baseTip = repo.branchTip(base);
      if (headTip === undefined || baseTip === undefined) {
        ctx.errors.push({ message: 'head or base branch does not exist' });
        return null;
      }
      for (const pull of repo.pulls.values()) {
        if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
          ctx.errors.push({ message: 'a pull request from this head branch is already open' });
          return null;
        }
      }
      const pull = ctx.store.createPull(repo, asString(input.title), asString(input.body), head, base, headTip, baseTip);
      return { __type: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) };
    }
    if (name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = pullByGlobalId(ctx, asString(input.pullRequestId));
      if (found === null) {
        ctx.errors.push({ message: 'pull request not found' });
        return null;
      }
      if (found.pull.state !== 'open') {
        ctx.errors.push({ message: 'pull request is already merged or closed' });
        return null;
      }
      const outcome = squashMerge(found.repo, found.pull);
      if (!outcome.ok) {
        ctx.errors.push({ message: outcome.reason ?? 'cannot merge' });
        return null;
      }
      found.pull.state = 'closed';
      found.pull.merged = true;
      found.pull.mergedAt = MERGED_AT;
      found.pull.mergeCommitSha = outcome.sha!;
      return { __type: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull) };
    }
    if (name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGlobalId(ctx, asString(input.subjectId));
      if (found === null) {
        ctx.errors.push({ message: 'subject not found' });
        return null;
      }
      const comment = { id: found.repo.nextCommentId++, body: asString(input.body) };
      const list = found.repo.comments.get(found.issue.number) ?? [];
      list.push(comment);
      found.repo.comments.set(found.issue.number, list);
      return {
        __type: 'AddCommentPayload',
        commentEdge: {
          __type: 'IssueCommentEdge',
          node: { __type: 'IssueComment', id: commentGlobalId(found.repo, found.issue.number, comment.id), body: comment.body },
        },
      };
    }
  }

  if (typeName === 'Node') {
    // The node() field's declared type is the Node interface; the runtime node is a
    // Repository, Issue or PullRequest, and its global id is the one to return.
    if (name === 'id') {
      if (node.__type === 'Repository') return repoGlobalId(node.repo as Repo);
      if (node.__type === 'Issue') return issueGlobalId(node.repo as Repo, node.issue as Issue);
      if (node.__type === 'PullRequest') return pullGlobalId(node.repo as Repo, node.pull as PullRequest);
    }
  }

  if (typeName === 'User') {
    if (name === 'login') return node.login;
    if (name === 'id') return encodeId(`U:${String(node.id ?? VIEWER.id)}`);
    if (name === 'name') return node.name ?? VIEWER.name;
    if (name === 'email') return node.email ?? VIEWER.email;
  }

  if (typeName === 'Repository') {
    const repo = node.repo as Repo;
    if (name === 'id') return repoGlobalId(repo);
    if (name === 'databaseId') return repo.id;
    if (name === 'name') return repo.name;
    if (name === 'nameWithOwner') return repo.fullName;
    if (name === 'owner') return userNode();
    if (name === 'defaultBranchRef') return { __type: 'Ref', name: repo.defaultBranch };
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'description') return repo.description;
    if (name === 'issue') {
      const number = asInt(args.number);
      if (number === null) return null;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueNode(repo, issue);
    }
    if (name === 'issues') return issuesConnection(repo, args);
    if (name === 'pullRequests') return pullsConnection(repo, args);
    if (name === 'pullRequest') {
      const number = asInt(args.number);
      if (number === null) return null;
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : pullNode(repo, pull);
    }
  }

  if (typeName === 'Ref') {
    if (name === 'name') return node.name;
  }

  if (typeName === 'Issue') {
    const repo = node.repo as Repo;
    const issue = node.issue as Issue;
    if (name === 'id') return issueGlobalId(repo, issue);
    if (name === 'number') return issue.number;
    if (name === 'title') return issue.title;
    if (name === 'body') return issue.body;
    if (name === 'state') return issue.state.toUpperCase();
  }

  if (typeName === 'PullRequest') {
    const repo = node.repo as Repo;
    const pull = node.pull as PullRequest;
    if (name === 'id') return pullGlobalId(repo, pull);
    if (name === 'number') return pull.number;
    if (name === 'title') return pull.title;
    if (name === 'body') return pull.body;
    if (name === 'state') return pull.state.toUpperCase();
    if (name === 'merged') return pull.merged;
    if (name === 'mergeable') {
      if (pull.state !== 'open') return 'UNKNOWN';
      return pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    }
    if (name === 'headRefName') return pull.headRef;
    if (name === 'baseRefName') return pull.baseRef;
    if (name === 'files') {
      const changes = pullFiles(repo, pull);
      const first = asInt(args.first);
      const limit = first === null ? changes.length : Math.max(0, first);
      const page = changes.slice(0, limit);
      return {
        __type: 'PullRequestFileConnection',
        nodes: page.map((change) => ({ __type: 'PullRequestFile', path: change.filename })),
        pageInfo: { __type: 'PageInfo', hasNextPage: changes.length > limit, endCursor: null },
      };
    }
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestFileConnection') {
    if (name === 'nodes') return node.nodes;
    if (name === 'pageInfo') return node.pageInfo;
    if (name === 'totalCount') return node.totalCount ?? 0;
  }

  if (typeName === 'PullRequestFile') {
    if (name === 'path') return node.path;
  }

  if (typeName === 'PageInfo') {
    if (name === 'hasNextPage') return node.hasNextPage ?? false;
    if (name === 'endCursor') return node.endCursor ?? null;
    if (name === 'hasPreviousPage') return false;
    if (name === 'startCursor') return null;
  }

  if (typeName === '__Type') {
    const type = node.typeName as string;
    if (name === 'name') return type;
    if (name === 'kind') return INTROSPECTION_ENUMS[type] !== undefined ? 'ENUM' : 'OBJECT';
    if (name === 'fields') {
      const fields = INTROSPECTION_FIELDS[type] ?? [];
      return fields.map((fieldName) => ({ __type: '__Field', name: fieldName }));
    }
    if (name === 'enumValues') {
      const values = INTROSPECTION_ENUMS[type] ?? [];
      return values.map((value) => ({ __type: '__EnumValue', name: value }));
    }
  }

  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (name === 'name') return node.name;
  }

  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    if (name === 'issue') return node.issue;
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    if (name === 'pullRequest') return node.pullRequest;
  }
  if (typeName === 'AddCommentPayload') {
    if (name === 'commentEdge') return node.commentEdge;
  }
  if (typeName === 'IssueCommentEdge') {
    if (name === 'node') return node.node;
  }
  if (typeName === 'IssueComment') {
    if (name === 'id') return node.id;
    if (name === 'body') return node.body;
  }

  return null;
}

/** Execute a selection set against one node of `typeName`. */
function executeSelections(ctx: Ctx, selections: readonly Selection[], typeName: string, node: GqlNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = SCHEMA[typeName] ?? {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const condition = selection.typeCondition;
      if (condition !== null && condition !== node.__type) continue;
      const narrowed = condition ?? typeName;
      Object.assign(out, executeSelections(ctx, selection.children, narrowed, node));
      continue;
    }
    const key = selection.alias ?? selection.name;
    const returnType = fields[selection.name];
    if (returnType === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    const value = resolveField(ctx, typeName, node, selection);
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (selection.children.length === 0 || SCALARS.has(unwrapList(returnType))) {
      out[key] = value;
      continue;
    }
    const childType = unwrapList(returnType);
    if (Array.isArray(value)) {
      out[key] = value.map((entry) => executeSelections(ctx, selection.children, childType, entry as GqlNode));
    } else {
      out[key] = executeSelections(ctx, selection.children, childType, value as GqlNode);
    }
  }
  return out;
}

export interface GraphQLReply {
  status: number;
  body: unknown;
}

function envelope(data: unknown, errors: Array<{ message: string }>): Record<string, unknown> {
  const out: Record<string, unknown> = { data };
  if (errors.length > 0) out.errors = errors;
  return out;
}

function executeOne(store: Store, operation: { query?: unknown; variables?: unknown }): Record<string, unknown> {
  const query = operation.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return envelope(null, [{ message: 'query is required' }]);
  }
  let parsed: Operation;
  try {
    parsed = parseDocument(query);
  } catch (err) {
    return envelope(null, [{ message: err instanceof Error ? err.message : 'could not parse the GraphQL document' }]);
  }
  const variables = (operation.variables ?? {}) as Record<string, unknown>;
  const ctx: Ctx = { store, variables, varDefaults: parsed.varDefaults, errors: [] };
  const rootType = parsed.kind === 'mutation' ? 'Mutation' : 'Query';
  validateSelections(parsed.selections, rootType, ctx.errors);
  if (ctx.errors.length > 0) return envelope(null, ctx.errors);
  const root: GqlNode = { __type: rootType };
  const data = executeSelections(ctx, parsed.selections, rootType, root);
  return envelope(data, ctx.errors);
}

/**
 * Handle one POST /api/graphql body: a single operation, or a JSON array of them
 * (GitHub's operation batching — answered in order). Auth is decided by the caller.
 */
export function handleGraphQL(store: Store, body: unknown, authed: boolean): GraphQLReply {
  if (!authed) return { status: 401, body: { message: 'Requires authentication' } };
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => executeOne(store, (entry ?? {}) as { query?: unknown; variables?: unknown })) };
  }
  if (typeof body !== 'object' || body === null) {
    return { status: 400, body: { message: 'a GraphQL request body must be a JSON object' } };
  }
  return { status: 200, body: executeOne(store, body as { query?: unknown; variables?: unknown }) };
}
