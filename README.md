# github-core-clone-01 — a GitHub-compatible git forge in one Node process

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/bagusekawx/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/bagusekawx/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge: one process, its own in-memory store, no
UI, no outside service, no `git` binary, no dependencies at run time. It speaks all
four surfaces the contest scores:

| Surface | Route | What it does |
| --- | --- | --- |
| Git smart HTTP | `/<owner>/<repo>.git/...` | `info/refs`, `git-upload-pack` (protocol v2 + v0), `git-receive-pack` (v0) — clone, fetch, push, shallow clones, tags, fast-forward enforcement |
| REST v3 | `/api/v3/...` | repositories, branches, commits, contents, labels, issues, comments, pull requests, squash merges |
| GraphQL v4 | `POST /api/graphql` | the documents `gh` and `github-mcp-server` send, plus introspection and batched operations |
| MCP | `POST /mcp` | JSON-RPC 2.0 over streamable HTTP: `initialize`, `server/discover`, `tools/list`, `tools/call` |

Local grade with the kit's own runner: **120/120 conformance, score 943**
(feature 600 + agent 200 + perf 143).

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. There is nothing to install: the program imports
`node:http`, `node:zlib`, `node:crypto` and its own modules only, and the trial
has no package manager and no internet.

`main.ts` is the harness lifecycle (kept as the starter shipped it): bind an
ephemeral port with `listen(0)`, `POST $MAKEFUN_ENV_URL/register {"port": N}`,
poll `GET $MAKEFUN_ENV_URL/done` until `{"done": true}`, exit 0. The API token
is `MAKEFUN_SHOP_TOKEN` (the env sets it for the trial); `/healthz` takes none.

## Layout

- `main.ts` — the entry ↔ env lifecycle. Unchanged from the starter.
- `app.ts` — the HTTP server: routing, auth, body reading, the JSON envelope
  (`application/json` + `X-GitHub-Request-Id` on every reply).
- `git.ts` — the git object layer: SHA-1 object ids, commit/tree/blob/tag
  parse and build, pkt-line framing, packfile read (OFS/REF deltas) and write,
  delta application.
- `store.ts` — the in-memory store: repositories, refs, objects, issues, pull
  requests, labels, comments; graph walks (ancestry, merge-base, shallow
  collection), tree diffs, squash merges with conflict detection.
- `git-http.ts` — git smart HTTP: v0/v2 advertisements, `ls-refs`, `fetch`
  (thin-pack, shallow, deepen), `receive-pack` with per-ref report-status.
- `rest.ts` — GitHub REST v3: the full resource surface, paginated with
  absolute `Link` URLs, GitHub's status codes (401/404/405/409/422).
- `graphql.ts` — a small exact GraphQL executor: a document parser, schema
  validation (an unknown field is a 200 with an `errors` array naming it),
  opaque stable global ids, cursor pagination, batched operations.
- `mcp.ts` — the MCP endpoint: the 2025-11-25 handshake and the 2026-07-28
  `server/discover` revision, six tools acting on the same store as REST.

## Design notes

- **Deterministic.** Nothing the server sends depends on the wall clock or
  unseeded randomness: timestamps are fixed, request ids are a monotonic
  counter, ids are assigned in creation order. Replay exports are
  byte-identical.
- **Fast hot paths.** Everything lives in memory; the four timed workloads
  (200 pushes, 50 concurrent shallow clones, 2,000 issue reads, 200 issue
  writes) never touch disk. Packfiles are written without deltas — plain
  objects, deflated — which is what the suite's client reads fastest.
- **One store, four surfaces.** A pull request created over MCP merges over
  REST; an issue created over GraphQL lists over MCP. The conformance suite
  is the only client, and it checks that the surfaces agree.

MIT licensed.
