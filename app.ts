// app.ts — the HTTP server: one process, four surfaces.
//
//   GET  /healthz                              the env's boot probe: 200 {"ok":true}
//   /api/v3/*                                  GitHub REST v3 (rest.ts)
//   POST /api/graphql                         GitHub GraphQL v4 (graphql.ts)
//   POST /mcp                                 Model Context Protocol (mcp.ts)
//   /{owner}/{repo}.git/info/refs             git smart HTTP advertisements (git-http.ts)
//   POST /{owner}/{repo}.git/git-upload-pack  clone/fetch
//   POST /{owner}/{repo}.git/git-receive-pack push
//
// Every JSON reply carries application/json and a non-empty X-GitHub-Request-Id.
// The bearer <redacted> names the scenario viewer; with no token (or the wrong one) the
// API surfaces answer 401. The shop token comes from MAKEFUN_SHOP_TOKEN — the env sets
// it for the trial; when it is absent (a standalone run) any non-empty bearer is accepted.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { handleGraphQL } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git-http.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** A monotonic request counter: deterministic request ids, one per reply. */
let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${(requestCounter += 1)}`,
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `req-${(requestCounter += 1)}`,
  });
  res.end(body);
}

/** Read the request body in full (empty when the request carries none). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isAuthed(req: IncomingMessage, shopToken: string): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ') || header.length <= 7) return false;
  if (shopToken === '') return true;
  return header === `Bearer ${shopToken}`;
}

/** The git smart-HTTP path, or null when the path is not one. */
function gitRoute(path: string): { owner: string; repo: string; endpoint: string } | null {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (match === null) return null;
  try {
    return {
      owner: decodeURIComponent(match[1]!),
      repo: decodeURIComponent(match[2]!),
      endpoint: match[3]!,
    };
  } catch {
    return null;
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const shopToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        let url: URL;
        try {
          url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        } catch {
          sendJson(res, 400, { message: 'Bad Request' });
          return;
        }
        const path = url.pathname;

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' ||
          (method === 'DELETE' && (req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined));
        const rawBody = needsBody ? await readBody(req) : Buffer.alloc(0);

        // Git smart HTTP: /{owner}/{repo}.git/info/refs, git-upload-pack, git-receive-pack.
        const git = gitRoute(path);
        if (git !== null) {
          if (git.endpoint === 'info/refs') {
            if (method !== 'GET') {
              sendJson(res, 405, { message: 'Method Not Allowed' });
              return;
            }
            const service = url.searchParams.get('service') ?? '';
            const protocol = req.headers['git-protocol'] ?? null;
            const reply = handleInfoRefs(store, git.owner, git.repo, service, protocol);
            sendBuffer(res, reply.status, reply.contentType, reply.body);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const reply = git.endpoint === 'git-upload-pack'
            ? handleUploadPack(store, git.owner, git.repo, rawBody)
            : handleReceivePack(store, git.owner, git.repo, rawBody);
          sendBuffer(res, reply.status, reply.contentType, reply.body);
          return;
        }

        // REST v3 under /api/v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const restPath = path === '/api/v3' ? '/' : path.slice('/api/v3'.length);
          let segments: string[];
          try {
            segments = restPath.split('/').filter((entry) => entry !== '').map((entry) => decodeURIComponent(entry));
          } catch {
            sendJson(res, 400, { message: 'Bad Request' });
            return;
          }
          let body: unknown;
          let bodyMalformed = false;
          if (rawBody.length > 0) {
            try {
              body = JSON.parse(rawBody.toString('utf8')) as unknown;
            } catch {
              bodyMalformed = true;
            }
          }
          const reply = handleRest(store, {
            method,
            segments,
            query: url.searchParams,
            body,
            bodyMalformed,
            authed: isAuthed(req, shopToken),
            origin: url.origin,
          });
          if (reply.body === undefined) {
            res.writeHead(reply.status, {
              'content-length': 0,
              'x-github-request-id': `req-${(requestCounter += 1)}`,
              ...(reply.headers ?? {}),
            });
            res.end();
            return;
          }
          sendJson(res, reply.status, reply.body, reply.headers);
          return;
        }

        // GraphQL v4 at /api/graphql.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          let body: unknown;
          try {
            body = rawBody.length > 0 ? (JSON.parse(rawBody.toString('utf8')) as unknown) : {};
          } catch {
            sendJson(res, 400, { message: 'malformed JSON body' });
            return;
          }
          const reply = handleGraphQL(store, body, isAuthed(req, shopToken));
          sendJson(res, reply.status, reply.body);
          return;
        }

        // MCP at /mcp.
        if (path === '/mcp') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const reply = handleMcp(store, rawBody.toString('utf8'), isAuthed(req, shopToken));
          if (reply.notification) {
            res.writeHead(202, { 'content-length': 0 });
            res.end();
            return;
          }
          sendJson(res, reply.status, reply.body);
          return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // A request handler must never take the server down with it.
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.end();
        }
      }
    })();
  });
}
