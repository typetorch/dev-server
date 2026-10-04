# @typetorch/dev-server

`remote-claude` for [TypeTorch](https://github.com/typetorch): prompt **Claude Code on your own machine** from inside a
live Roblox dev server.

You start the dev server on your machine. It prints a **pairing code**. You join a private server on a `dev` branch,
paste the code into the dev menu's Claude tab once, and from then on you can type prompts there. The game server
forwards them over HTTPS to this server, through an account-free **Cloudflare Quick Tunnel**. Claude Code edits the
branch in a dedicated git worktree, the dev server commits, then runs `typetorch deploy`, and the private server
hot-swaps to the result. The Claude tab is a chat: follow-ups continue the same Claude Code session, replies stream
in, and you can attach screenshots of your game view.

**remote-claude only runs on your Claude subscription; API keys are refused.** It checks `claude auth status` at
startup (a claude.ai login is required), strips every `ANTHROPIC_*` / Bedrock / Vertex / Foundry variable from the
processes it starts, and kills any run whose Claude Code reports an API key as its credential.

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
- [Claude Code](https://claude.com/claude-code) (`claude`), installed and logged in **with your Claude subscription**
  (`claude auth login`, Claude.ai account). An API-key, Bedrock, Vertex or Foundry login is refused at startup
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
- Also: `--model <name>`, `--max-budget-usd <n>` (a per-run cap on Claude Code's own cost estimate; runs are always
  billed to your subscription), `--no-announce` (local testing), `--no-install`.

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
| Replay | Every POST (create, cancel, attachments) needs a unique `X-TT-Nonce` and an `X-TT-Timestamp` within ±300 s |
| Limits | Headers ≤ 2 KB (Cloudflare's own `cf-*`/`x-forwarded-*` excluded; ≤ 8 KB in all), body ≤ 32 KB (token body ≤ 1 KB, attachment body ≤ 3 MB), strict JSON schemas (unknown fields rejected), ≤ 6 tokens per user per minute, one Claude run at a time, a queue of 5, `--max-prompts` |
| Responses | `Cache-Control: no-store`; errors are bare status codes with no body. The terminal logs `sub`, the first 8 characters of `jti` and the decision, never a token, code or key |
| Claude | `claude -p --restricted` in a dedicated worktree; tools `Read, Edit, Write, Glob, Grep, Bash(bun run build*), Bash(typetorch build*), Bash(typetorch test*)`; `WebFetch`/`WebSearch` denied; anything else denied without asking (Claude Code still auto-allows its read-only commands such as `git status` inside the worktree). File tools can't leave the worktree. Edits to build/tool configuration (package.json, lockfiles, tsconfig, `*.project.json`, `typetorch.json`, scripts, hooks, `.github`, `.claude`, `.typetorch`, `.env`, plus `--protect`) are denied, and if one changes anyway the commit is kept but **not deployed** |
| Untrusted context | The game's `context` (paths, error lines, artifact id; players can influence it) is JSON-escaped inside `<untrusted-game-context>` and the system prompt tells Claude it is data, never instructions |
| Secrets in children | `.env` values stay in a private map, and values Bun auto-loads from `.env` files are stripped: Claude, git and builds never inherit the API key or other local secrets (the deploy gets the API key only) |
| Git | The dev server commits (`remote-claude: <summary>` + `Requested-By: roblox:<userId>`), with hooks disabled. Nothing is ever pushed |
| Subscription only | `claude auth status` must report `loggedIn`, `authMethod: "claude.ai"`, `apiProvider: "firstParty"` or the session doesn't start. Child processes never get `ANTHROPIC_*`, `CLAUDE_CODE_USE_*` or `AWS_BEARER_TOKEN_BEDROCK` (the host app's `ANTHROPIC_BASE_URL` included), no `--settings`/`apiKeyHelper` is passed, and a run whose stream-json `init` event has an `apiKeySource` other than `"none"` is killed before it publishes anything (`error: "api_billing_refused"`). Costs shown are Claude Code's estimates (`est.`), not charges |
| Conversations | Per user and private: a follow-up must name a conversation the caller owns (else `404`) and runs `claude -p --resume <session>` in the same worktree; one prompt at a time per conversation (`409`) |
| Events | Assistant text, tool lines and results are redacted (pairing code, API key, `.env` values, JWT/Bearer shapes, tunnel URLs) before they are stored; streamed text holds back any tail that could be the start of one, so a secret split across chunks is never published in part. Tool results are one line (a count or a status), never file contents |
| Attachments | RGBA8 only, ≤ 1024 px per side, ≤ 4 MB raw, ≤ 2 MB decoded data, zstd frames must declare exactly `width × height × 4` and are inflated with that hard cap. The dev server writes the PNG itself to `<worktree>/.typetorch/attachments/<id>.png` (git-ignored through `.git/info/exclude`, never committed, deleted when the session ends). ≤ 4 per prompt, ≤ 20 per user per session, only the uploader can use one, once. Claude is told the images are game data, not instructions |

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
- Body (≤ 32 KB): `{"prompt": "<1–4000 chars>", "context"?: {"path"?: string ≤1024, "errors"?: string[] (≤50 × ≤4000), "artifact"?: string ≤128}, "conversationId"?: "<22 chars>", "attachments"?: ["<32 hex>", ...] (≤ 4, distinct)}`
  - No `conversationId`: a new conversation (a new Claude Code session). With one: a follow-up in that conversation;
    Claude runs `claude -p --resume <its session>` in the same worktree and keeps the context. It must be the caller's
    own conversation (`404` otherwise) with no prompt still running (`409`). If Claude Code lost that session, the run
    starts fresh and says so in a `status` event.
  - `attachments`: ids from `POST /v1/attachments`, uploaded by the caller and not used by another prompt (`400`
    otherwise). Claude gets their paths (`Attached screenshot: .typetorch/attachments/<id>.png (WxH)`).
- `200` → `{"id": "<22 chars>", "state": "queued", "conversationId": "<22 chars>"}`

### `GET /v1/prompts/:id[?since=<n>]`
- `Authorization: Bearer <JWT>`, `X-TT-Job` (reads need no nonce)
- `200` → `{"id", "state", "conversationId", "summary"?, "commit"?, "artifactId"?, "error"?, "costUsd"?, "attachments"?: [{"id","width","height"}], "log": string[] (last 20 lines), "queuedAt", "startedAt"?, "finishedAt"?}`
  (times are unix seconds; `costUsd` is Claude Code's estimate, shown as "est.", never a charge: runs use the
  subscription). Any allowed user of the session may read any prompt of the session.
- With `?since=<n>` (0–9999999; start at 0) the reply also has `"events": [...]` (the events with `i >= n`, at most
  300), `"next"` (pass it as `since` next time) and `"more"` (another page is ready now). Poll about once a second
  while the prompt runs. Each event is `{"i", "kind", "text", "tool"?, "target"?, "block"?, "state"?}`:

  | `kind` | `text` | extra |
  |---|---|---|
  | `assistant_text` | a chunk of Claude's reply (Markdown) | `block`: consecutive chunks with the same block form one text block |
  | `tool_use` | `Edit src/server/x.ts`, `Bash bun run build`, `Grep foo in src` | `tool`, `target` (path relative to the worktree, command or pattern) |
  | `tool_result` | one line: `120 lines`, `3 files`, `done`, `error: ...` (never file contents) | `tool` |
  | `status` | the new state (`queued`, `running`, `committed abc1234`, `building`, `deployed`, `answered`, ...) or a note | `state` when it is a state change |
  | `error` | why the run failed (e.g. `api_billing_refused`, `claude timed out`) | |
- `state`: `queued` → `running` → `committed` → `building` → `deployed`; or `answered` (Claude changed no files and
  replied: a question, an explanation; its `summary` is the first line or the SUMMARY line); or `failed` (a real error)
  / `cancelled`. A prompt is finished when `finishedAt` is set (`committed` is final with `--no-deploy`, without a CLI,
  or when protected files changed). Terminal states: `deployed | committed | answered | failed | cancelled`.

### `POST /v1/prompts/:id/cancel`
- `Authorization: Bearer <JWT>`, `X-TT-Job`, `X-TT-Nonce`, `X-TT-Timestamp` (like every POST); no body or Content-Type
  needed (a body is ignored). Only the requester (or the dev at the terminal) may cancel.
- `200` → `{"ok": true}` (also when it was already cancelled); `409` when it already finished.

### `POST /v1/attachments`
- Headers like `POST /v1/prompts` (JWT with `prompt:create`, nonce, timestamp, JSON); body ≤ 3 MB:
  `{"width": 1–1024, "height": 1–1024, "format": "rgba8", "compression": "zstd" | "none", "data": "<base64>"}`.
  `data` is the RGBA8 pixels, rows top to bottom (`width × height × 4` bytes, ≤ 4 MB), compressed with zstd (one frame
  that declares that size, as Roblox `EncodingService:CompressBuffer(..., Enum.CompressionAlgorithm.Zstd)` writes) or
  not; decoded `data` is ≤ 2 MB either way.
- `200` → `{"id": "<32 hex>", "width", "height"}`. `400` for any size or format mismatch, `429` after 20 uploads by this
  user in this session.

### `GET /v1/conversations`
- `Authorization: Bearer <JWT>`, `X-TT-Job`. The caller's own conversations, latest activity first (at most 20):
  `{"conversations": [{"id", "title", "createdAt", "updatedAt", "prompts": <count>, "state": "<last prompt's state>"}]}`.

### `GET /v1/conversations/:id`
- `Authorization: Bearer <JWT>`, `X-TT-Job`. Only the caller's own (`404` otherwise):
  `{"id", "title", "createdAt", "updatedAt", "prompts", "state", "truncated": bool, "messages": [{"id", "prompt", "state", "summary"?, "commit"?, "artifactId"?, "error"?, "costUsd"?, "attachments", "queuedAt", "startedAt"?, "finishedAt"?, "events": [...], "next"}]}`
  (the last 30 prompts; `events` with the chunks of each text block merged; continue a running prompt with
  `GET /v1/prompts/:id?since=<next>`). Use it to reopen a chat after a swap or a rejoin.

### Status codes
| Code | Meaning | Game server should |
|---|---|---|
| `401` | Token endpoint: any failed grant. Other endpoints: missing/invalid access token (signature, alg, iss, aud, expiry, sid, user not allowed/revoked, stale `ver`) | Other endpoints: refresh once; token endpoint: ask for the code again |
| `403` | Valid token, wrong `X-TT-Job`, branch or scope; cancel by a non-requester | Give up |
| `400` | Bad body/schema/unknown field, missing or invalid `X-TT-Nonce`/`X-TT-Timestamp`, timestamp outside ±300 s, bad `since`, an attachment that isn't the caller's or was used, an image whose sizes don't match | Fix the request |
| `404` | Unknown prompt, conversation (or someone else's) or route | |
| `409` | Nonce already used; cancel of a finished prompt; a follow-up while the conversation's last prompt runs | |
| `413` / `431` | Body over 32 KB (3 MB for attachments) / headers over 2 KB | |
| `429` | Code attempts blocked, token rate limit, queue full (5), `--max-prompts` reached, 20 attachments uploaded | Back off |
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

Attachments are saved in the worktree as `.typetorch/attachments/<id>.png`, git-ignored through `.git/info/exclude`
(never a tracked file), so `git add -A` never picks them up. The folder is emptied at startup and deleted at exit.
Claude Code keeps its sessions under `~/.claude/projects/`, which is what lets a conversation resume.

## Tests
```sh
bun test                 # security + chat tests on 127.0.0.1 (a fake claude drives the real runner) and one real
                         # Quick Tunnel (TT_SKIP_TUNNEL=1 to skip it)
bun test/e2e.ts          # a real two-message conversation with an image attachment through the tunnel and Claude,
                         # in test-fixture/ (--no-deploy)
```

## License
MIT
