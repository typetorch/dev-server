# @typetorch/dev-server

`remote-claude` for [TypeTorch](https://github.com/typetorch): prompt **Claude Code on your own machine** from inside a
live Roblox dev server.

You stand in a private server on a `dev` branch and type a prompt in the dev menu's Claude tab. The game server
forwards it over HTTPS to this server on your machine, through an account-free **Cloudflare Quick Tunnel**. Claude Code
edits the branch in a dedicated git worktree, the server commits, then runs `typetorch deploy`, and the private server
hot-swaps to the result.

```
dev's Roblox client ─► game server (dev channel; checks dev + allowlist + rate limit)
                         │ POST /v1/token     (Roblox Secrets Store secret → 5-minute JWT)
                         │ POST /v1/prompts   (JWT)          GET /v1/prompts/:id every 2–3 s
                         ▼
          https://<words>.trycloudflare.com  (Cloudflare Quick Tunnel, no account)
                         ▼
   typetorch-dev-server remote-claude  ─►  127.0.0.1:<random port>
        queue (1 run at a time) ─► claude -p in ../<repo>-remote-claude ─► git commit ─► typetorch deploy
```

## Requirements
- [Bun](https://bun.sh) 1.3+
- [Claude Code](https://claude.com/claude-code) (`claude`), installed and logged in
- `cloudflared` (installed automatically with winget on Windows when missing; macOS `brew install cloudflared`)
- A TypeTorch game repo (`typetorch.json`) and an Open Cloud API key with MessagingService publish access
  (`TYPETORCH_API_KEY`, `OPENCLOUD_API_KEY` or `ROBLOX_API_KEY`, in the environment or a `.env`)

## Setup (once per project)
1. **Exchange secret on your machine:**
   ```sh
   typetorch-dev-server remote-claude --init-secret [--env-file <path to .env>]
   ```
   This appends `TYPETORCH_REMOTE_CLAUDE_SECRET=<48 random bytes, base64url>` to the nearest `.env` (only if it is not
   set yet). The value is never printed; open the `.env` to copy it.
2. **The same value in Roblox:** Creator Hub → your experience → **Secrets** → Create Secret:
   name `typetorch_remote_claude`, value = the `.env` value, domain `*.trycloudflare.com`.
   For Studio testing, also add it under Studio's local secrets (Game Settings → Security) and enable HTTP requests.
3. Install `cloudflared` and Claude Code.

## Usage
```sh
typetorch-dev-server remote-claude --users 1,2,56 [--repo <dir>] [--branch <name>] [--port <n>]
                                   [--max-prompts 50] [--no-deploy] [--cli <typetorch cli entry>]
```
- `--users` (required): Roblox user ids allowed to prompt. No default, no wildcard.
- `--branch`: the git branch (default: the repo's current branch), mapped to a TypeTorch branch by `typetorch.json`
  (`branches`). It must be on the **dev** channel (`channels`; `defaultBranch` is prod). Prod branches are refused,
  with no override.
- `--no-deploy` stops after the commit. `--cli` points at the TypeTorch CLI used for `deploy` (default: the sibling
  `../cli/src/index.ts`, then `typetorch` on PATH; without one, prompts stop at `committed`).
- Also: `--model <name>`, `--max-budget-usd <n>` (passed to `claude`), `--no-announce` (local testing), `--no-install`.

Terminal commands while it runs: `revoke <userId>` (removes the user for this session and kills their tokens),
`users`, `rotate` (new signing key: every token dies), `status`, `cancel <promptId>`, `quit` (or Ctrl+C: publishes the
closed message, stops the tunnel and exits).

The library entry exports `startRemoteClaude(options)` (the TypeTorch CLI exposes it as `typetorch remote-claude`)
and `createRemoteClaudeServer(options)` (just the HTTP server, for embedding and tests).

## Security model
The Quick Tunnel URL is public, so the server authenticates everything itself:

| Layer | What it does |
|---|---|
| Loopback bind | The HTTP server listens on `127.0.0.1` only; the LAN can't reach it, only the tunnel |
| Exchange secret | Accepted **only** by `POST /v1/token`, compared in constant time (SHA-256 + `timingSafeEqual`). Must be ≥32 random bytes or the server refuses to start. Roblox game code can attach it (Secrets Store, `*.trycloudflare.com`) but never read it |
| Lockout | 5 bad secrets from one IP (Cloudflare's `cf-connecting-ip`) within a minute → that IP gets `429` for the rest of the session |
| Access token | HS256 JWT (jose), 5 minutes, bound to one user, one game server (`job`), this session (`aud`, `sid`) and this branch, with scopes. Signed with a 256-bit key generated in memory per session (never written or logged); Ctrl+C or `rotate` kills every token |
| Verification | `algorithms: ["HS256"]` only (so `alg: none` and algorithm confusion fail), issuer, audience, `clockTolerance: 30`, `maxTokenAge: "5m"`, required claims; then **at use time**: `sid`, user still allowed and not revoked, `ver` current, `X-TT-Job` = `job`, branch, scope, prompt ownership |
| Replay | Every POST to `/v1/prompts*` (create, cancel) needs a unique `X-TT-Nonce` and an `X-TT-Timestamp` within ±300 s |
| Limits | Headers ≤ 2 KB (Cloudflare's own `cf-*`/`x-forwarded-*` excluded; ≤ 8 KB in all), body ≤ 32 KB, strict JSON schemas (unknown fields rejected), ≤ 6 tokens per user per minute, one Claude run at a time, a queue of 5, `--max-prompts` |
| Responses | `Cache-Control: no-store`; errors are bare status codes with no body. The terminal logs `sub`, the first 8 characters of `jti` and the decision, never a token, secret or key |
| Claude | `claude -p --restricted` in a dedicated worktree; tools `Read, Edit, Write, Glob, Grep, Bash(bun run build*), Bash(typetorch build*), Bash(typetorch test*)`; `WebFetch`/`WebSearch` denied; anything else denied without asking. Edits to build/tool configuration (package.json, lockfiles, tsconfig, `*.project.json`, `typetorch.json`, scripts, hooks, `.github`, `.claude`, `.env`) are denied, and if one changes anyway the commit is kept but **not deployed** |
| Untrusted context | The game's `context` (paths, error lines, artifact id; players can influence it) is JSON-escaped inside `<untrusted-game-context>` and the system prompt tells Claude it is data, never instructions |
| Secrets in children | `.env` values stay in a private map; Claude, git and builds never inherit the exchange secret or the API key (the deploy gets the API key only) |
| Git | The server commits (`remote-claude: <summary>` + `Requested-By: roblox:<userId>`), with hooks disabled. Nothing is ever pushed |

## HTTP contract (v1)
Everything else is `404`. Every response has `Cache-Control: no-store`; error responses have no body.

### Studio
In Studio `game.JobId` is `""`: send `job: ""` in the token body. Roblox may drop an empty header, so a missing
`X-TT-Job` counts as `""` and matches only a token whose `job` claim is `""`.

### `POST /v1/token`
- `Authorization: Bearer <exchange secret>`, `Content-Type: application/json`
- Body (exactly these fields): `{"sid": "<session id>", "user": <Roblox user id>, "job": "<game.JobId>", "branch": "<TypeTorch branch>"}`
- `200` → `{"access_token": "<JWT>", "expires_in": 300}`
- `401` for every failure (secret, body, sid, branch, user not allowed or revoked); `429` for the token rate limit or a
  locked-out IP.

### `POST /v1/prompts`
- `Authorization: Bearer <JWT>`, `X-TT-Job: <game.JobId>`, `X-TT-Nonce: <unique, 8–128 chars [A-Za-z0-9._:{}-]>`,
  `X-TT-Timestamp: <unix seconds, ±300 s>`, `Content-Type: application/json`
- Body (≤ 32 KB): `{"prompt": "<1–4000 chars>", "context"?: {"path"?: string ≤1024, "errors"?: string[] (≤50 × ≤4000), "artifact"?: string ≤128}}`
- `200` → `{"id": "<22 chars>", "state": "queued"}`

### `GET /v1/prompts/:id`
- `Authorization: Bearer <JWT>`, `X-TT-Job` (reads need no nonce)
- `200` → `{"id", "state", "summary"?, "commit"?, "artifactId"?, "error"?, "log": string[] (last 20 lines), "queuedAt", "startedAt"?, "finishedAt"?}`
  (times are unix seconds). Any allowed user of the session may read any prompt of the session.
- `state`: `queued` → `running` → `committed` → `building` → `deployed`, or `failed` / `cancelled`. A prompt is
  finished when `finishedAt` is set (`committed` is final with `--no-deploy`, without a CLI, or when protected files
  changed). A run that changes no files ends `failed` with `error: "no changes"` (its `summary` is Claude's answer).

### `POST /v1/prompts/:id/cancel`
- `Authorization: Bearer <JWT>`, `X-TT-Job`, `X-TT-Nonce`, `X-TT-Timestamp` (like every POST); no body or Content-Type
  needed (a body is ignored). Only the requester (or the dev at the terminal) may cancel.
- `200` → `{"ok": true}` (also when it was already cancelled); `409` when it already finished.

### Status codes
| Code | Meaning | Game server should |
|---|---|---|
| `401` | Missing/invalid secret or token (signature, alg, iss, aud, expiry, sid, user not allowed/revoked, stale `ver`) | Re-exchange once, then give up |
| `403` | Valid token, wrong `X-TT-Job`, branch or scope; cancel by a non-requester | Give up |
| `400` | Bad body/schema/unknown field, missing or invalid `X-TT-Nonce`/`X-TT-Timestamp`, timestamp outside ±300 s | Fix the request |
| `404` | Unknown prompt id or route | |
| `409` | Nonce already used; cancel of a finished prompt | |
| `413` / `431` | Body over 32 KB / headers over 2 KB | |
| `429` | Token rate limit, IP locked out, queue full (5), `--max-prompts` reached | Back off |
| `503` | Session shutting down | |

### Registration (Open Cloud MessagingService)
Topic `TypeTorch/remote-claude`, every 60 s (and right away when the tunnel URL changes or a user is revoked):
`{"v":1,"s":"<session id>","b":"<branch>","u":[<user ids>],"url":"https://<words>.trycloudflare.com","exp":<unix now+120>}`.
On exit: `{"v":1,"s":"<session id>","closed":true}`. Messages are under 1 KiB.

## Worktree
Claude works in `<repo>/../<repo-name>-remote-claude`, never in your working copy. Git can't check out one branch twice,
so when the session branch is checked out elsewhere (the usual case) the worktree uses `remote-claude/<branch>`: it is
fast-forwarded (or merged) to the branch head before every run, commits land there, and you bring them home with
`git merge remote-claude/<branch>`. Leftovers of a failed or cancelled run are reset before the next one.

## Tests
```sh
bun test                 # security tests on 127.0.0.1 + one real Quick Tunnel (TT_SKIP_TUNNEL=1 to skip it)
bun test/e2e.ts          # one real prompt through the tunnel and Claude, in test-fixture/ (--no-deploy)
```

## License
MIT
