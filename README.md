# @typetorch/dev-server

`remote-claude` for [TypeTorch](https://github.com/typetorch): prompt **Claude Code on your own machine** from inside a
live Roblox dev server.

You start the dev server on your machine. It prints a **pairing code**. You join a private server on a `dev` branch,
paste the code into the dev menu's Claude tab once, and from then on you can type prompts there. The game server
forwards them over HTTPS to this server, through an account-free **Cloudflare Quick Tunnel**. Claude Code edits the
branch in a dedicated git worktree, the dev server commits, then runs `typetorch deploy`, and the private server
hot-swaps to the result.

```
dev's Roblox client ─► game server (dev channel; checks dev + allowlist + rate limit)
                         │ POST /v1/token     pairing code → access token (5 min) + refresh token
                         │ POST /v1/prompts   access token           GET /v1/prompts/:id every 2–3 s
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
- A TypeTorch game repo (`typetorch.json`) and an Open Cloud API key that can publish MessagingService messages
  (`TYPETORCH_API_KEY`, `OPENCLOUD_API_KEY` or `ROBLOX_API_KEY`, in the environment or a `.env`). It is used to tell
  game servers where the session is.

There is nothing to set up in Roblox: no secrets, no settings.

## Usage
```sh
typetorch-dev-server remote-claude --users 1,2,56 [--repo <dir>] [--branch <name>] [--port <n>]
                                   [--max-prompts 50] [--no-deploy] [--cli <typetorch cli entry>]
```
At startup it prints one line:
```
pairing code: ABCD-EFGH-JKLM-NPQR-STUV-WXYZ  (valid until 18:02, paste it into DEV > Claude in game)
```
The code is also copied to the clipboard and saved, with its expiry time, to `<repo>/.typetorch/remote-claude.code`
(git-ignored through `.git/info/exclude`, deleted when the session ends). Paste it into **DEV > Claude** in game; that
game server is then paired and renews its tokens on its own for up to 3 hours, then asks for a code again.

Each code lives **3 hours** (`--code-ttl <minutes>`). When it expires a new one is printed (and copied and saved) right
away; servers that already paired keep working until 3 hours after they paired.

- `--users` (required): Roblox user ids allowed to prompt. No default, no wildcard.
- `--branch`: the git branch (default: the repo's current branch), mapped to a TypeTorch branch by `typetorch.json`
  (`branches`). It must be on the **dev** channel (`channels`; `defaultBranch` is prod). Prod branches are refused,
  with no override.
- `--no-deploy` stops after the commit. `--cli` points at the TypeTorch CLI used for `deploy` (default: the sibling
  `../cli/src/index.ts`, then `typetorch` on PATH; without one, prompts stop at `committed`).
- `--protect <globs>`: extra files Claude may not edit (for example files your build script runs); a change to one is
  committed but not deployed.
- `--code-ttl <minutes>`: lifetime of each pairing code (default 180). Refresh tokens never outlive it (12 h at most).
- Also: `--model <name>`, `--max-budget-usd <n>` (passed to `claude`), `--no-announce` (local testing), `--no-install`.

Terminal commands while it runs:

| Command | Effect |
|---|---|
| `code` | Prints the pairing code again and re-copies it |
| `revoke <userId>` | Removes the user for this session: their access and refresh tokens die and they can't pair again |
| `users` | Lists users, revoked or not, and their token version |
| `rotate` | New signing key, no refresh tokens, new pairing code: every game server must pair again |
| `status` | Session, tunnel, queue, how long the pairing code is still valid (not the code), refresh tokens |
| `cancel <promptId>` | Cancels a prompt |
| `quit` / Ctrl+C | Tells game servers the session closed, stops the tunnel and exits |

The library entry exports `startRemoteClaude(options)` (the TypeTorch CLI exposes it as `typetorch remote-claude`)
and `createRemoteClaudeServer(options)` (just the HTTP server, for embedding and tests).

## Security model
The Quick Tunnel URL is public, so the server authenticates everything itself:

| Layer | What it does |
|---|---|
| Loopback bind | The HTTP server listens on `127.0.0.1` only; the LAN can't reach it, only the tunnel |
| Pairing code | 24 symbols from a 32-symbol alphabet without look-alikes (120 bits), new every session and every 3 hours (`--code-ttl`). Shown only on your terminal, your clipboard and a git-ignored file; never announced, logged elsewhere or committed. Compared in constant time |
| Brute force | Code attempts only count once `sid`, branch and an allowed user id are right. More than 10 wrong codes in a minute → code grants answer `429` for 60 s; more than 30 in total → the code rotates automatically (the new one is printed). Counted per session, not per IP, because Roblox servers share egress IPs |
| Refresh token | 32 random bytes, stored only as a SHA-256 hash, bound to one user, one game server (`job`), this session and the user's token version; it lasts as long as a code (3 hours by default, 12 hours at most) counted from pairing, and is gone when the session ends |
| Access token | HS256 JWT (jose), 5 minutes, bound to one user, one game server (`job`), this session (`aud`, `sid`) and this branch, with scopes. Signed with a 256-bit key generated in memory per session (never written or logged); Ctrl+C or `rotate` kills every token |
| Verification | `algorithms: ["HS256"]` only (so `alg: none` and algorithm confusion fail), issuer, audience, `clockTolerance: 30`, `maxTokenAge: "5m"`, required claims; then **at use time**: `sid`, user still allowed and not revoked, `ver` current, `X-TT-Job` = `job`, branch, scope, prompt ownership |
| Replay | Every POST to `/v1/prompts*` (create, cancel) needs a unique `X-TT-Nonce` and an `X-TT-Timestamp` within ±300 s |
| Limits | Headers ≤ 2 KB (Cloudflare's own `cf-*`/`x-forwarded-*` excluded; ≤ 8 KB in all), body ≤ 32 KB (token body ≤ 1 KB), strict JSON schemas (unknown fields rejected), ≤ 6 tokens per user per minute, one Claude run at a time, a queue of 5, `--max-prompts` |
| Responses | `Cache-Control: no-store`; errors are bare status codes with no body. The terminal logs `sub`, the first 8 characters of `jti` and the decision, never a token, code or key |
| Claude | `claude -p --restricted` in a dedicated worktree; tools `Read, Edit, Write, Glob, Grep, Bash(bun run build*), Bash(typetorch build*), Bash(typetorch test*)`; `WebFetch`/`WebSearch` denied; anything else denied without asking (Claude Code still auto-allows its read-only commands such as `git status` inside the worktree). File tools can't leave the worktree. Edits to build/tool configuration (package.json, lockfiles, tsconfig, `*.project.json`, `typetorch.json`, scripts, hooks, `.github`, `.claude`, `.env`, plus `--protect`) are denied, and if one changes anyway the commit is kept but **not deployed** |
| Untrusted context | The game's `context` (paths, error lines, artifact id; players can influence it) is JSON-escaped inside `<untrusted-game-context>` and the system prompt tells Claude it is data, never instructions |
| Secrets in children | `.env` values stay in a private map, and values Bun auto-loads from `.env` files are stripped: Claude, git and builds never inherit the API key or other local secrets (the deploy gets the API key only) |
| Git | The dev server commits (`remote-claude: <summary>` + `Requested-By: roblox:<userId>`), with hooks disabled. Nothing is ever pushed |

## HTTP contract (v1)
Everything else is `404`. Every response has `Cache-Control: no-store`; error responses have no body.

### `POST /v1/token`
No `Authorization` header. `Content-Type: application/json`, body ≤ 1 KB, exactly one of:
- **Pairing:** `{"grant":"code","sid":"<session id>","user":<Roblox user id>,"job":"<game.JobId>","branch":"<TypeTorch branch>","code":"<pairing code>"}`
  (the code is normalized: case, spaces and dashes don't matter)
- **Refresh:** `{"grant":"refresh","sid","user","job","branch","refresh_token":"<43 chars>"}`

`200` → `{"access_token":"<JWT>","expires_in":300,"refresh_token":"<43 chars>","refresh_expires_in":<seconds>}`
(`refresh_expires_in` is at most the code lifetime, 10800 s by default, counted from pairing; a refresh returns the
same refresh token and its remaining lifetime).
`401` for every failure (schema, sid, branch, user not allowed or revoked, wrong code, refresh token not valid for
this user/job/session); `429` when code attempts are blocked or the user hit 6 tokens per minute.

Game servers keep the refresh token in server memory only, refresh the access token when it is under 60 s from expiry
or after a `401`, and ask the dev to paste the code again when the refresh grant answers `401`.

### Studio
In Studio `game.JobId` is `""`: send `job: ""`. Roblox may drop an empty header, so a missing `X-TT-Job` counts as
`""` and matches only tokens whose `job` is `""`.

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
| `401` | Token endpoint: any failed grant. Prompt endpoints: missing/invalid access token (signature, alg, iss, aud, expiry, sid, user not allowed/revoked, stale `ver`) | Prompt endpoints: refresh once; token endpoint: ask for the code again |
| `403` | Valid token, wrong `X-TT-Job`, branch or scope; cancel by a non-requester | Give up |
| `400` | Bad body/schema/unknown field, missing or invalid `X-TT-Nonce`/`X-TT-Timestamp`, timestamp outside ±300 s | Fix the request |
| `404` | Unknown prompt id or route | |
| `409` | Nonce already used; cancel of a finished prompt | |
| `413` / `431` | Body over 32 KB / headers over 2 KB | |
| `429` | Code attempts blocked, token rate limit, queue full (5), `--max-prompts` reached | Back off |
| `503` | Session shutting down | |

### Registration (Open Cloud MessagingService)
Topic `TypeTorch/remote-claude`, every 60 s (and right away when the tunnel URL changes or a user is revoked):
`{"v":1,"s":"<session id>","b":"<branch>","u":[<user ids>],"url":"https://<words>.trycloudflare.com","exp":<unix now+120>}`.
On exit: `{"v":1,"s":"<session id>","closed":true}`. Messages are under 1 KiB and never contain the pairing code.

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
