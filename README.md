# github-core-clone-01 — a standalone GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/people871/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/people871/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

One process, no UI, no outside service: it serves git smart HTTP, the REST v3 API,
GraphQL v4 and MCP from its own in-memory store. Node 22 standard library only;
no dependencies, no git binary, no package manager, no network at run time.

## Run

```sh
node main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own. There is nothing to install.

The process binds an ephemeral port (`listen(0)`), registers it with the env
(`POST $MAKEFUN_ENV_URL/register {"port": N}`), then polls
`GET $MAKEFUN_ENV_URL/done` until the trial is over and exits 0.

## Layout

- `main.ts` — the entry <-> env lifecycle (bind, register, wait for done, exit).
- `app.ts` — the HTTP router: health probe, REST v3, GraphQL, MCP, git smart HTTP.
- `store.ts` — the single in-memory store (repos, refs, objects, issues, labels, pulls).
- `gitobj.ts` — pure git object helpers (SHA-1 ids, commit/tree/blob build+parse, ancestry).
- `gitpack.ts` — the packfile codec (PACK v2/v3, plain + OFS_DELTA + REF_DELTA).
- `git.ts` — git smart HTTP: upload-pack protocol v2 (ls-refs, fetch) and receive-pack v0.
- `rest.ts` — GitHub REST v3: repositories, branches, commits, contents, issues, comments,
  labels, pull requests, files, merges.
- `graphql.ts` — GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send.
- `mcp.ts` — Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call.

## Notes

- Deterministic: no wall-clock time and no randomness in any response. Repositories,
  issues and pull requests are ordered by a monotonic sequence; git commits the forge
  creates itself (contents PUT, pull-request squash merges) use a fixed ident and
  timestamp, so two runs on the same instance leave the same state export byte for byte.
- Ownership: the scenario's viewer login is seed-derived, so the forge learns it at
  run time — the first owner-bearing request for a repository pins its owner, and a
  different owner for the same name is a 404, never a 403.
- Auth: every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (`/healthz`
  takes none); a missing or wrong token is a 401. Every REST reply is `application/json`
  with a non-empty `X-GitHub-Request-Id`; unknown routes are a JSON 404.

## Local score (kit grade-local, process driver, Node 22.23.4)

| trial | agent | feature | perf | score |
| --- | --- | --- | --- | --- |
| 0 | 200 | 600 | 179 | 979 |
| 1 | 200 | 600 | 176 | 976 |
| 2 | 200 | 600 | 178 | 978 |
| **mean** | **200** | **600** | **177.7** | **977.7** |

90% interval of the primary column: 975.09 – 980.24. All three replays matched
byte for byte (state export identical to the house reference's, 120/120 checks).

## License

MIT — see `LICENSE`.
