# @typetorch/dev-server

`remote-claude` for [TypeTorch](https://github.com/typetorch): prompt **Claude Code on your own machine** from inside a
live Roblox dev server.

You start the dev server on your machine. It prints a **pairing code**. You join a private server on a `dev` branch,
paste the code into the dev menu's Claude tab once, and from then on you can chat with Claude there. The game server
forwards your messages over HTTPS to this server, through an account-free **Cloudflare Quick Tunnel**. Each message
runs in one of two modes:

- **Live** (the default): Claude reads the code and acts on *your running server* with the game tools: it inspects
  instances, reads logs and runs Luau snippets you approve one by one ("jump me", "give me 100 coins"). It can't edit
  files, commit or deploy.
- **Code**: Claude edits the branch in a dedicated git worktree and may run `bun run build`. When it changed files, the
  dev server commits them and shows a **deploy proposal** in your chat (files, +/- lines, summary). **Deploy** runs
  `typetorch deploy` and the server hot-swaps to the result; **Discard** undoes the commit. Unanswered proposals are
  discarded after 15 minutes.

The Claude tab is a chat: follow-ups continue the same Claude Code session (also across a mode switch), replies stream
in, and you can attach screenshots (cropped and marked up if you like), your client's log history, another player's
client log history and the server's log history. Claude can show you images from the worktree (`![caption](path)` in
its reply), and its `screenshot` tool sees what you see.

**Toolbox (Creator Store), only when you ask for it.** Pick **Toolbox** in the "+" menu and that one message lets Claude
search the Creator Store from this PC (free assets; no key; the results show as cards in your chat). In Live mode it can
then insert an asset you picked into your server: every insert shows an approval card (what loaded, what is removed,
Anchor, Keep scripts off by default) with Insert / Deny, and inserted assets get a Remove button. In Code mode it can
record an asset in `toolbox.lock.toml` instead. The chip clears after each send; without it Claude has no Creator Store
tools at all. Live inserts need the experience setting "Allow Loading Third Party Assets" (Studio > File > Experience
Settings > Security; it applies to every server of the experience, prod included).

**remote-claude only runs on your Claude subscription; API keys are refused.** It checks `claude auth status` at
startup (a claude.ai login is required), strips every `ANTHROPIC_*` / Bedrock / Vertex / Foundry variable from the
processes it starts, and kills any run whose Claude Code reports an API key as its credential.

```
dev's Roblox client ─► game server (dev channel; checks dev + allowlist + rate limit)
                         │ POST /v1/token     single-use pairing code → access token (5 min) + rotating refresh token
                         │ POST /v1/prompts   access token           GET /v1/game/poll (long-poll) for events
                         ▼
          https://<words>.trycloudflare.com  (Cloudflare Quick Tunnel, no account)
                         ▼
   typetorch-dev-server remote-claude  ─►  127.0.0.1:<random port>
        queue (1 run at a time) ─► claude -p in ../<repo>-remote-claude
             live: Read/Glob/Grep + game tools        code: edit + build ─► git commit ─► proposal ─► (Deploy) typetorch deploy
```

## Install
The dev-server runs on **Node 20+** (npm, npx) or **Bun 1.3+**.

```sh
npm i -g @typetorch/dev-server           # then: typetorch-dev-server remote-claude --users ...
npx @typetorch/dev-server remote-claude --users ...
typetorch remote-claude --users ...      # through the TypeTorch CLI (it runs this package; install both)
bun src/index.ts remote-claude --users ...   # from a checkout of this repo
```

`typetorch remote-claude` finds this package installed next to the CLI (globally, in the game repo's
`node_modules`, or both in one `npx -p @typetorch/cli -p @typetorch/dev-server typetorch remote-claude ...`) or a
sibling `../dev-server` checkout. The [template](https://github.com/typetorch/template) has both packages in its
devDependencies, so in a game made from it `bun install` is enough: `bun run typetorch remote-claude --users ...`.

**Bun is still needed for Code mode:** the game repo is a Bun project, so the worktree install (`bun install`), Claude's
one allowed command (`bun run build`) and the deploy's build run Bun. Under Node the dev-server puts the `bun` on PATH
first on Claude's PATH, and warns at startup when there is none (Live mode works without it). Images Claude shows in the
chat and zstd screenshots need zstd: Bun, or Node 22.15+ (the dev-server warns when it is missing).

## Requirements
- [Claude Code](https://claude.com/claude-code) (`claude`), installed and logged in **with your Claude subscription**
  (`claude auth login`, Claude.ai account). An API-key, Bedrock, Vertex or Foundry login is refused at startup
- `cloudflared` (installed automatically with winget on Windows when missing; macOS `brew install cloudflared`)
- A TypeTorch game repo (`typetorch.json`) and an Open Cloud API key that can publish MessagingService messages
  (`OPENCLOUD_DEPLOY_KEY`, else the shared `TYPETORCH_API_KEY`, `OPENCLOUD_API_KEY` or `ROBLOX_API_KEY`). It is used to tell
  game servers where the session is. When you play on another PC, screenshots come as CaptureService uploads, and
  `OPENCLOUD_ASSETS_KEY` (else the shared key) downloads them (Open Cloud asset delivery; untested live, the key may
  need `legacy-asset:manage`).
  Keys are read like the TypeTorch CLI reads them: the environment first, then the env file (`--env-file <path>`, else
  `TYPETORCH_ENV_FILE`, from the environment or declared in the nearest `.env`; the recommended place is outside the
  repo, e.g. `~/.config/typetorch/<game>.env`), then `.env` files in the repo and its parents. File values never go
  into `process.env`: Claude, git and the tunnel never see them; only the deploy gets the keys it needs (and the env file
  path).
- Optional: `ffmpeg` on PATH (or `TT_FFMPEG`) for JPEG, WebP, GIF, BMP and 16-bit or interlaced PNG images. Plain
  8-bit PNGs (Roblox screenshots) are decoded without it.

There is nothing to set up in Roblox: no secrets, no settings. (Optional: Toolbox inserts into a live server need
"Allow Loading Third Party Assets", above.) For images Claude shows in the chat (EditableImage),
the experience needs its **Allow Mesh / Image APIs** setting on (Creator Hub, or Studio Game Settings → Security), and
its owner must be 13+ and ID-verified. Without them the chat shows one dim line instead of the image.

## Usage
```sh
typetorch-dev-server remote-claude --users 1,2,56 [--repo <dir>] [--branch <name>] [--port <n>]
                                   [--max-prompts 50] [--no-deploy] [--cli <typetorch cli entry>] [--env-file <path>]
```
Once the tunnel is up it prints one line:
```
pairing code: ABCD-EFGH-JKLM-NPQR-STUV-7QX2  (valid until 18:02, paste it into DEV > Claude in game)
```
The code is also copied to the clipboard and saved, with its expiry time, to `<repo>/.typetorch/remote-claude.code`
(git-ignored through `.git/info/exclude`, deleted when the session ends). Paste it into **DEV > Claude** in game; that
game server is then paired and renews its tokens on its own for up to 3 hours, then asks for a code again.

**Each code pairs one user on one game server, once.** The first successful pairing uses it up, and the next code is
printed (and copied and saved) right away; pairing a second server or a second user takes that next code. Unused
codes expire after **3 hours** (`--code-ttl <minutes>`) and are replaced too. A tunnel restart (new URL) also prints a
new code, and every game server must pair again (see "Tunnel binding" below).

- `--users` (required): Roblox user ids allowed to prompt. No default, no wildcard.
- `--branch`: the git branch (default: the repo's current branch), mapped to a TypeTorch branch by `typetorch.json`
  (`branches`). It must be on the **dev** channel (`channels`; `defaultBranch` is prod). Prod branches are refused,
  with no override.
- `--no-deploy` stops code runs after the commit (no proposal). `--cli` points at the TypeTorch CLI used for `deploy`
  (default: a CLI next to this package: `../cli` from a checkout, which is also where npm puts `@typetorch/cli` beside
  this package (Bun runs `src/index.ts`, Node `dist/index.js`); then `typetorch` on PATH; without one, code runs stop
  at `committed`).
- `--env-file <path>`: the env file with the Open Cloud key (see Requirements); the environment wins over it, it wins
  over `.env` files.
- `--protect <globs>`: extra files Claude may not edit (for example files your build script runs); a change to one is
  committed but never proposed for deploy.
- `--code-ttl <minutes>`: lifetime of each pairing code (default 180). Refresh tokens never outlive it (12 h at most).
- Also: `--model <name>`, `--max-budget-usd <n>` (a per-run cap on Claude Code's own cost estimate; runs are always
  billed to your subscription), `--no-announce` (local testing), `--no-install`.

Terminal commands while it runs:

| Command | Effect |
|---|---|
| `code` | Prints the current pairing code again and re-copies it |
| `revoke <userId>` | Removes the user for this session: their access and refresh tokens die, their pending proposals are discarded and they can't pair again |
| `users` | Lists users, revoked or not, and their token version |
| `rotate` | New signing key, no refresh tokens, new pairing code: every game server must pair again |
| `status` | Session, tunnel, queue, how long the pairing code is still valid (not the code), wrong codes and locked user+server pairs, paired servers |
| `cancel <promptId>` | Cancels a prompt (discards a pending proposal) |
| `quit` / Ctrl+C | Tells game servers the session closed, discards pending proposals, stops the tunnel and exits |

The library entry exports `startRemoteClaude(options)` (the TypeTorch CLI's `typetorch remote-claude` runs this
package's bin with the same arguments) and `createRemoteClaudeServer(options)` (just the HTTP server, for embedding and
tests; since 0.2 it resolves once the server listens).

## Pairing code format
`XXXX-XXXX-XXXX-XXXX-XXXX-FFFF`: 24 symbols from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O, 1/I), case, spaces and
dashes don't matter.
- The first 20 symbols are random (100 bits).
- The last 4 (`FFFF`) are the **tunnel fingerprint**: the first 20 bits of
  `HMAC-SHA256(key = the 20 random symbols, message = the tunnel hostname in lowercase)`, as 4 symbols of the same
  alphabet (bits 23..19, 18..14, 13..9, 8..4 of the first 3 MAC bytes).

The game server recomputes the fingerprint from the code and the URL the session was announced with, and refuses to
send a code whose fingerprint doesn't match ("this code is for another tunnel"). So a code only ever travels to the
tunnel it was printed for. The key is the code's secret part, so nobody can search for a matching hostname without the
code. Known answer: `fingerprint("ABCDEFGHJKLMNPQRSTUV", "abc-def.trycloudflare.com") = "T4SP"` (both implementations
are tested against it: `test/security.test.ts` and `framework/scripts/test-sha256.luau`).

## Security model
The Quick Tunnel URL is public, so the server authenticates everything itself:

| Layer | What it does |
|---|---|
| Loopback bind | The HTTP server listens on `127.0.0.1` only; the LAN can't reach it, only the tunnel |
| Pairing code | 100 random bits plus the tunnel fingerprint (above). **Single use**: the first good redemption spends it and the next code is printed. Every code expires after 3 hours (`--code-ttl`). Shown only on your terminal, your clipboard and a git-ignored file; never announced, logged elsewhere or committed. Compared in constant time |
| Wrong codes | Counted per (user, job) only: 5 wrong codes within 10 minutes lock that user on that game server for 15 minutes (`429`). Nothing global: failures never block other users or servers and never rotate the code, so someone who knows a user id can't lock you out. Attempts only count once `sid`, branch and an allowed user id are right |
| Tunnel binding | Game servers accept only `https://<name>.trycloudflare.com` URLs, bind a session id to the first URL they hear for it and ignore later messages that change it; a `closed` message counts only with the matching session id and URL. The pairing code carries the URL's fingerprint, refresh tokens are bound to the URL they were issued through, and the game never sends a token or code to another URL. When the tunnel restarts with a new URL, the dev server starts a **new session id** (new signing key, no refresh tokens, new code), closes the old session on game servers and announces the new one: every game server pairs again |
| Refresh token | 32 random bytes, stored only as a SHA-256 hash, bound to one user, one game server (`job`), this session, the tunnel URL and the user's token version. **It rotates on every use**: a refresh grant returns a new refresh token and the old one stops working. Presenting a rotated-out token again revokes that whole pairing (reuse detection; the terminal says so and the server must pair again). A pairing lasts as long as a code (3 hours by default, 12 hours at most) counted from pairing; rotation never extends it. A new pairing of the same user on the same server replaces the old one |
| Job binding | What is verified: the job is fixed when the single-use code is redeemed, every refresh must present the same job, the JWT carries it, every request's `X-TT-Job` must equal it, and game-tool requests are bound to it. What isn't: the dev server can't prove a caller really is that JobId's server (Roblox doesn't sign or attest outgoing HttpService requests), so whoever holds a valid refresh token can claim its job. Tokens stay in the game server's memory, and rotation turns a copied token into a revoked pairing as soon as both copies are used |
| Access token | HS256 JWT (jose), 5 minutes, bound to one user, one game server (`job`), this session (`aud`, `sid`) and this branch, with scopes. Signed with a 256-bit key generated in memory per session (never written or logged); Ctrl+C or `rotate` kills every token |
| Verification | `algorithms: ["HS256"]` only (so `alg: none` and algorithm confusion fail), issuer, audience, `clockTolerance: 30`, `maxTokenAge: "5m"`, required claims; then **at use time**: `sid`, user still allowed and not revoked, `ver` current, `X-TT-Job` = `job`, branch, scope, prompt ownership |
| Replay | Every POST (create, cancel, deploy, attachments) needs a unique `X-TT-Nonce` and an `X-TT-Timestamp` within ±300 s |
| Limits | Headers ≤ 2 KB (Cloudflare's own `cf-*`/`x-forwarded-*` excluded; ≤ 8 KB in all), prompt body ≤ 480 KB (room for three ~64 KB log attachments; token body ≤ 1 KB, attachment body ≤ 3 MB, capture and asset requests ≤ 160 KB with their marks), strict JSON schemas (unknown fields rejected), ≤ 6 tokens per user per minute (checked before a refresh token rotates, so a `429` never strands the game with a dead token), one Claude run at a time, a queue of 5, one code run or pending proposal at a time, `--max-prompts` |
| Responses | `Cache-Control: no-store`; errors are bare status codes with no body. The terminal logs `sub`, the first 8 characters of `jti` and the decision, never a token, code or key |
| Modes | **Live** runs get `--tools Read,Glob,Grep` and every game tool; **code** runs get `Read,Edit,Write,Glob,Grep` plus exactly `Bash(bun run build)`, and the read-only game tools. The MCP server enforces it too: in code mode it doesn't list `run_luau` and refuses it. A live run never commits; if files change anyway they are dropped |
| Toolbox | The Creator Store tools exist only for a prompt sent with the "Toolbox" chip (`toolbox: true`, kept immutable on the record): without it all three are in `--disallowedTools`, MCP `tools/list` doesn't list them and every `tools/call` is refused; with it, live runs get `toolbox_search` + `toolbox_insert`, code runs `toolbox_search` + `toolbox_add`, and the other one stays denied. Search runs here, unauthenticated, free assets only, 1 request/s, 10-minute cache, back-off after 429; store text is cleaned (hidden/bidi characters, length caps) and reaches Claude only inside `<untrusted-toolbox-data>`. Insert and add take only ids from this conversation's searches; the game gets the dev server's snapshot, not Claude's text. The game re-checks (the prompt was sent with the chip there, the id came through its own relayed results, dev channel) and asks the dev on a per-insert card (Insert / Deny, no "always"). `toolbox.lock.toml` is protected; only the dev server's own write (byte for byte) is accepted in a deploy proposal. Limits per message: 10 searches, 3 inserts, 5 adds |
| Claude | `claude -p --restricted` in a dedicated worktree; `WebFetch`/`WebSearch` denied; anything else denied without asking (Claude Code still auto-allows its read-only commands such as `git status` inside the worktree). File tools can't leave the worktree (plus the run's log folder, below). `bun` is put first on Claude's PATH so `bun run build` always resolves. Edits to build/tool configuration (package.json, lockfiles, tsconfig, `*.project.json`, `typetorch.json`, scripts, hooks, `.github`, `.claude`, `.typetorch`, `.env`, plus `--protect`) are denied, and if one changes anyway the commit is kept but **no deploy is offered** |
| Deploy approval | A code run that changed files is committed by the dev server (`remote-claude: <summary>` + `Requested-By: roblox:<userId>`, hooks disabled) and proposed, never deployed on its own. Only the requesting dev can deploy or discard it; Discard (or 15 minutes without an answer, or the session ending) resets the worktree to the commit before the run (the dropped commit stays in the reflog). Deploy and Discard refuse when the worktree moved since the proposal. Nothing is ever pushed |
| Untrusted context | The game's `context` (paths, error lines, artifact id; players can influence it) is JSON-escaped inside `<untrusted-game-context>` and the system prompt tells Claude it is data, never instructions |
| Attached logs | "My logs", "Server logs" and "Player logs" (another player's client log history, fetched by the game from that player's client) may hold other players' names and chat. They are kept in memory only until the run starts, then written to `<temp>/tt-rc-logs-*/{client,server,player}-logs.txt` (outside the worktree, owner-only, with a header saying they are untrusted), given to Claude by path with `--add-dir`, and the folder is deleted when the run ends. They are never logged, relayed or kept with the prompt (the terminal says only "client + player logs attached"). A player name must be a Roblox username (letters, digits, `_`) |
| Secrets in children | Env-file (`--env-file` / `TYPETORCH_ENV_FILE`) and `.env` values stay in a private map, and values Bun auto-loads from `.env` files are stripped: Claude, git and builds never inherit the API key or other local secrets (the deploy gets the API key only) |
| Subscription only | `claude auth status` must report `loggedIn`, `authMethod: "claude.ai"`, `apiProvider: "firstParty"` or the session doesn't start. Child processes never get `ANTHROPIC_*`, `CLAUDE_CODE_USE_*` or `AWS_BEARER_TOKEN_BEDROCK` (the host app's `ANTHROPIC_BASE_URL` included), no `--settings`/`apiKeyHelper` is passed, and a run whose stream-json `init` event has an `apiKeySource` other than `"none"` is killed before it publishes anything (`error: "api_billing_refused"`). Costs shown are Claude Code's estimates (`est.`), not charges |
| Conversations | Per user and private: a follow-up must name a conversation the caller owns (else `404`) and runs `claude -p --resume <session>` in the same worktree; one prompt at a time per conversation, including a proposal waiting for its decision (`409`) |
| What reaches games | Everything relayed (events, summaries, errors, status lines) is redacted: the pairing code, the API key, `.env` values, JWT/Bearer shapes, tunnel URLs, and **local paths**: worktree files become relative (`src/a.ts`), the repo becomes `<repo>/`, the home folder `~/`, the temp folder `<tmp>/`, any other absolute path (`C:\...`, `/Users/...`, `\\server\...`, `file://`) `<path>`, and the OS username `<user>`. Streamed text holds back any tail that could be the start of one of these, so nothing is ever published in part. Tool results are one line (a count or a status), never file contents. The prompt's `log` holds only short status lines (≤ 120 characters); raw deploy output and Claude's stderr go to the terminal only |
| Attachments | Screenshots can show other players, so they stay on this PC and are deleted after use. Three ways in: raw RGBA8 from the game (≤ 1024 px per side, ≤ 4 MB raw, ≤ 2 MB decoded data, zstd frames must declare exactly `width × height × 4` and are inflated with that hard cap); the **capture pickup** (main path: the file Roblox wrote on this PC, only the requesting user's, see below); the **asset fallback** (a CaptureService upload, downloaded with the Open Cloud key). Captures and downloads are decoded (PNG in TS, other formats with ffmpeg and a fixed input format), get the dev's marks drawn on them (`strokes`, capped: see below), are cropped to the dev's selection and downscaled to ≤ 1568 px on the long side. Copies are owner-only PNGs in the session's temp folder `<temp>/tt-rc-att-<session>` (never in the worktree), moved into the run's folder when their prompt runs and deleted when it ends; unsent ones are deleted after 30 minutes, everything when the session ends, and folders a crashed session left are swept at the next start. Roblox's own files are only read. ≤ 4 per prompt, ≤ 8 unsent and ≤ 40 per user per session, ≤ 10 pickups/downloads per user per minute (one at a time), only the uploader can use one, once. Pixels and base64 are never logged. Claude is told the images are game data, not instructions |
| Images to the game | Claude shows a worktree image with `![caption](path)`. Only regular image files inside the worktree (links resolved; not `.git`, not `.env*`), ≤ 25 MB, ≤ 4 per prompt. The dev server decodes it to RGBA8 ≤ 1024² (smaller if zstd would pass 2 MB), keeps it in memory (≤ 64 MB, 3 h) and serves it in chunks only to the prompt's requester on the game server that sent it. Refused references become a short `status` line |

## HTTP contract (v1)
Everything else is `404`. Every response has `Cache-Control: no-store`; error responses have no body.

### `POST /v1/token`
No `Authorization` header. `Content-Type: application/json`, body ≤ 1 KB, exactly one of:
- **Pairing:** `{"grant":"code","sid":"<session id>","user":<Roblox user id>,"job":"<game.JobId>","branch":"<TypeTorch branch>","code":"<pairing code>"}`
  (the code is normalized: case, spaces and dashes don't matter). The code is spent on success.
- **Refresh:** `{"grant":"refresh","sid","user","job","branch","refresh_token":"<43 chars>"}`

`200` → `{"access_token":"<JWT>","expires_in":300,"refresh_token":"<43 chars>","refresh_expires_in":<seconds>}`.
`refresh_expires_in` is what is left of the pairing (at most the code lifetime, 10800 s by default, counted from
pairing). **Every refresh returns a new refresh token; store it and forget the old one** (using the old one again
revokes the pairing).
`401` for every failure (schema, sid, branch, user not allowed or revoked, wrong/used/expired code, refresh token
unknown, expired, reused or not bound to this user/job/session/URL); `429` when this user is locked on this job (5 wrong
codes) or hit 6 tokens per minute.

Game servers keep the refresh token in server memory only, refresh the access token when it is under 60 s from expiry
or after a `401`, and ask the dev for a new code when the refresh grant answers `401`.

### Studio
In Studio `game.JobId` is `""`: send `job: ""`. Roblox may drop an empty header, so a missing `X-TT-Job` counts as
`""` and matches only tokens whose `job` is `""`.

### `POST /v1/prompts`
- `Authorization: Bearer <JWT>`, `X-TT-Job: <game.JobId>`, `X-TT-Nonce: <unique, 8–128 chars [A-Za-z0-9._:{}-]>`,
  `X-TT-Timestamp: <unix seconds, ±300 s>`, `Content-Type: application/json`
- Body (≤ 480 KB): `{"prompt": "<1–4000 chars>", "mode"?: "live" | "code", "context"?: {"path"?: string ≤1024, "errors"?: string[] (≤50 × ≤4000), "artifact"?: string ≤128, "logs"?: {"client"?: string, "server"?: string, "player"?: {"name": "<Roblox username>", "text": string}} (each text ≤ 66000 chars)}, "conversationId"?: "<22 chars>", "attachments"?: ["<32 hex>", ...] (≤ 4, distinct), "toolbox"?: boolean}`
  - `mode` (default `"live"`) picks the run's tools (see the security model). A conversation can switch modes between
    prompts; the follow-up resumes the same Claude Code session with the new tools.
  - `toolbox` (default `false`): the dev picked "Toolbox" for this message; only then does the run get the Creator
    Store tools. A follow-up needs it again.
  - No `conversationId`: a new conversation (a new Claude Code session). With one: a follow-up in that conversation;
    Claude runs `claude -p --resume <its session>` in the same worktree and keeps the context. It must be the caller's
    own conversation (`404` otherwise) with no prompt still running or waiting for a deploy decision (`409`). If Claude
    Code lost that session, the run starts fresh and says so in a `status` event.
  - A code prompt while another code prompt is queued or running, or a proposal is undecided: `423`.
  - `attachments`: ids from `POST /v1/attachments[/capture|/asset]`, made by the caller and not used by another
    prompt (`400` otherwise). When the run starts they move into its temp folder and Claude gets their paths
    (`Attached screenshot: <temp>/tt-rc-logs-*/screenshot-<id8>.png (WxH)`, readable through `--add-dir`); they are
    deleted when the run ends (or when a queued prompt is cancelled).
  - `context.logs`: the requester's client log history, the server's, and/or another player's (`player`: that
    player's username and client log text, which the game fetched from that player's client). The game keeps the
    newest ~64 KB of each and notes how many older lines it dropped. See "Attached logs" above: files for the run
    only, never logged.
- `200` → `{"id": "<22 chars>", "state": "queued", "conversationId": "<22 chars>"}`

### `GET /v1/prompts/:id[?since=<n>]`
- `Authorization: Bearer <JWT>`, `X-TT-Job` (reads need no nonce)
- `200` → `{"id", "state", "mode", "conversationId", "summary"?, "commit"?, "artifactId"?, "error"?, "costUsd"?, "attachments"?: [{"id","width","height"}], "proposal"?: {"status", "commit", "expiresAt", "files": [{"path","added","removed"}], "error"?}, "log": string[] (last 20 short status lines), "queuedAt", "startedAt"?, "finishedAt"?}`
  (times are unix seconds; `costUsd` is Claude Code's estimate, shown as "est.", never a charge: runs use the
  subscription). Any allowed user of the session may read any prompt of the session.
- With `?since=<n>` (0–9999999; start at 0) the reply also has `"events": [...]` (the events with `i >= n`, at most
  300), `"next"` (pass it as `since` next time) and `"more"` (another page is ready now). Each event is
  `{"i", "kind", "text", "tool"?, "target"?, "block"?, "state"?, "detail"?, "ref"?, "commit"?, "files"?, "expiresAt"?, "image"?}`:

  | `kind` | `text` | extra |
  |---|---|---|
  | `assistant_text` | a chunk of Claude's reply (Markdown) | `block`: consecutive chunks with the same block form one text block |
  | `tool_use` | `Edit src/server/x.ts`, `Bash bun run build`, `Grep foo in src` | `tool`, `target` (path relative to the worktree, command or pattern), `ref` (the tool_use id), `detail` (game tools: the input) |
  | `tool_result` | one line: `120 lines`, `3 files`, `done`, `error: ...` (never file contents) | `tool`, `ref` (pairs it with its `tool_use`, even when Claude runs several tools at once), `detail` (game tools: the full result, capped) |
  | `deploy_proposal` | the SUMMARY line | `commit`, `files` (≤ 50, `added`/`removed` line counts, -1 for binary), `expiresAt` |
  | `image` | the caption (or the file's path) | `image`: `{"id", "width", "height", "bytes", "chunks"}`, fetched with `GET /v1/images/:id?chunk=n`; it comes before the final status |
  | `toolbox_results` | `<query> (<type>): <count>` | `tiles` (≤ 10): `[{"id", "type", "name", "creator", "verified", "scripts"?, "upPercent"?, "voteCount"?, "triangles"?, "seconds"?}]`, the Creator Store results Claude got (strangers' text, cleaned; the game re-checks every field) |
  | `status` | the new state (`queued`, `running`, `committed abc1234`, `proposed`, `building`, `deployed`, `discarded`, `answered`, ...) or a note | `state` when it is a state change |
  | `error` | why the run failed (e.g. `api_billing_refused`, `claude timed out`, `deploy failed (exit 1)`) | |
- `state`: `queued` → `running` → `answered` (no file changes: a question, an explanation, a live action; `summary` is
  the first line or the SUMMARY line) | `failed` | `cancelled`; code mode with changes: `running` → `committed` →
  `proposed` → `building` → `deployed` (or `failed`), or `proposed` → `discarded`. A prompt is finished when
  `finishedAt` is set; `proposed` and `building` are not finished. `committed` is final with `--no-deploy`, without a
  CLI, or when protected files changed. Terminal states: `deployed | discarded | committed | answered | failed | cancelled`.

### `POST /v1/prompts/:id/deploy`
- Headers like every POST (JWT, `X-TT-Job`, nonce, timestamp, JSON); body `{"decision": "deploy" | "discard"}`.
- Only the requester (`403` otherwise), only while the proposal is `pending` (`409` otherwise; `404` without one).
- `deploy` → `200 {"ok": true, "state": "building"}` at once; progress arrives as events (`building`, then `deployed`
  with `artifactId`, or `failed`). `discard` → `200 {"ok": true, "state": "discarded"}` after the worktree reset.

### `POST /v1/prompts/:id/cancel`
- `Authorization: Bearer <JWT>`, `X-TT-Job`, `X-TT-Nonce`, `X-TT-Timestamp` (like every POST); no body or Content-Type
  needed (a body is ignored). Only the requester (or the dev at the terminal) may cancel. A pending proposal is
  discarded.
- `200` → `{"ok": true}` (also when it was already cancelled); `409` when it already finished.

### `POST /v1/attachments`
- Headers like `POST /v1/prompts` (JWT with `prompt:create`, nonce, timestamp, JSON); body ≤ 3 MB:
  `{"width": 1–1024, "height": 1–1024, "format": "rgba8", "compression": "zstd" | "none", "data": "<base64>"}`.
  `data` is the RGBA8 pixels, rows top to bottom (`width × height × 4` bytes, ≤ 4 MB), compressed with zstd (one frame
  that declares that size, as Roblox `EncodingService:CompressBuffer(..., Enum.CompressionAlgorithm.Zstd)` writes) or
  not; decoded `data` is ≤ 2 MB either way.
- `200` → `{"id": "<32 hex>", "width", "height"}`. `400` for any size or format mismatch, `429` when the user holds 8
  unsent attachments or made 40 this session.

### `POST /v1/attachments/capture` (main path for screenshots)
- Headers like every POST; body ≤ 160 KB (`413` above):
  `{"captureTime": <unix ms>, "localId"?: "<Capture.LocalId>", "placeId"?: <game.PlaceId>, "crop"?: {"x", "y", "w", "h"}, "strokes"?: [...]}`.
  `captureTime` is the client's clock (`ScreenshotCapture.CaptureTime.UnixTimestampMillis`, or `DateTime.now()` in the
  `CaptureScreenshot` callback): it is this PC's clock when the dev plays here. `crop` is the dev's selection in
  normalized coordinates (0..1 from the top left, `w`/`h` > 0, inside the image).
- `strokes` are the marks the dev drew (the crop view's Draw mode):
  `[{"color": "red" | "yellow" | "white" | "black", "width": <(0, 0.04]>, "points": [x0, y0, x1, y1, ...]}]`.
  - `points` are flat pairs normalized to the **full capture** (0..1 from the top left, not the crop), 1–400 per stroke
    (one point is a dot); `width` is the pen's thickness as a fraction of the capture's height.
  - Caps: ≤ 30 strokes and ≤ 3000 points in all, every number finite and in range, no other keys (`400` otherwise);
    the body cap above. An empty list is no strokes.
  - They are drawn onto the decoded capture **before** the crop and the downscale: each segment is a capsule (pixel
    centers within the pen's radius of it), opaque, round ends and joins, colors `#FF3B30`, `#FFD60A`, `#FFFFFF`,
    `#000000`. Crafted strokes past an ink budget (64 M tested pixels) are refused (`422`).
  - Claude's `<attachments>` line says the developer drew N colored marks on that screenshot.
- The dev server looks in `%LOCALAPPDATA%\Roblox\tmp-capture-storage` (`TT_CAPTURE_DIR` overrides it) for
  `<userId>_<placeId>_<unixMs>.png` where `userId` is the **JWT's user** (never anyone else's file) and `placeId`
  matches (0 = any): a LocalId that names a file stem picks that file; otherwise the closest time within 5 s, waiting
  up to about 5 s for Roblox to finish writing it (size settled, PNG trailer present). It only reads Roblox's file.
- `200` → `{"id", "width", "height"}` (the cropped copy, ≤ 1568 px on the long side). `404`: no such file (the dev plays
  on another PC: use the asset fallback). `422`: not a readable image. `429`: quota, or a pickup already running for
  this user, or 10 pickups/downloads this minute.

### `POST /v1/attachments/asset` (fallback)
- Headers like every POST; body ≤ 160 KB `{"assetId": <id>, "crop"?: {...}, "strokes"?: [...]}`: the asset id from `CaptureService:UploadCaptureAsync` /
  `StartUploadCaptureAsync`. Downloaded with the Open Cloud key (`apis.roblox.com/asset-delivery-api`; a Decal is followed
  to its image once), then like a capture.
- `200` as above; `502` the download failed; `503` the dev server has no Open Cloud key; `422`, `429` as above.

### `GET /v1/images/:id?chunk=<n>`
- `Authorization: Bearer <JWT>`, `X-TT-Job`. An image Claude showed (an `image` event). Only the prompt's requester on
  the game server that sent it (`404` otherwise, also once it expired after 3 h or was evicted).
- `200` → `{"id", "chunk", "chunks", "bytes", "width", "height", "data": "<base64>"}`: chunk `n` (from 0) of the zstd
  data (64 KB raw per chunk) of `width × height × 4` RGBA8 bytes, rows top to bottom. Concatenate all chunks, then
  `EncodingService:DecompressBuffer(..., Zstd)` → `EditableImage:WritePixelsBuffer`.

### `GET /v1/conversations`
- `Authorization: Bearer <JWT>`, `X-TT-Job`. The caller's own conversations, latest activity first (at most 20):
  `{"conversations": [{"id", "title", "createdAt", "updatedAt", "prompts": <count>, "state": "<last prompt's state>"}]}`.

### `GET /v1/conversations/:id`
- `Authorization: Bearer <JWT>`, `X-TT-Job`. Only the caller's own (`404` otherwise):
  `{"id", "title", "createdAt", "updatedAt", "prompts", "state", "truncated": bool, "messages": [{"id", "prompt", "state", "mode", "summary"?, "commit"?, "artifactId"?, "error"?, "costUsd"?, "proposal"?, "attachments", "queuedAt", "startedAt"?, "finishedAt"?, "events": [...], "next"}]}`
  (the last 30 prompts; `events` with the chunks of each text block merged; continue a running prompt with
  `GET /v1/prompts/:id?since=<next>`). Use it to reopen a chat after a swap or a rejoin.

### Game tools (MCP, for Claude)
Every run gets an MCP server named `typetorch-game` (`--mcp-config`, a per-run bearer token, loopback only: requests
that came through the tunnel are refused). Its tools act only on the game server that sent the prompt (the JWT's
`job`) and only for the user who sent it. In code mode `run_luau` is neither listed nor served.

| Tool | What it does |
|---|---|
| `run_luau {code, description?, timeoutSeconds?}` | Live mode only. Luau on the server (`player` = the requester). `game:GetService` refuses MessagingService, DataStoreService, MemoryStoreService and HttpService, and the TypeTorch kernel isn't in scope (defense in depth, not a sandbox). The dev approves each snippet in the chat (or "Always in this chat"); every run leaves a durable audit record in the game (who, when, description, SHA-256 of the code, outcome; never the code), and the terminal logs the same SHA-256 prefix; needs `ServerScriptService.LoadStringEnabled` |
| `game_logs {realm?, since?, filter?, limit?}` | Server logs, or the requester's client logs (`realm: "client"`) |
| `inspect {realm?, path, depth?, properties?}` | Class, properties, attributes, tags, children |
| `find {realm?, query, under?, limit?}` | Instances whose Name or ClassName contains the query |
| `game_status {}` | Artifact, generation, branch, channel, uptime, players with positions |
| `screenshot {}` | What the requester sees now: the game asks their client to capture and answers `{captureTime, placeId, localId?}` (or `{assetId}` after an upload); the dev server picks up the file like `POST /v1/attachments/capture` and returns it to Claude as an MCP image block (≤ 1568 px; never written to disk by the dev server) |
| `toolbox_search {query, type?, verifiedOnly?, noScripts?, sort?, limit?, page?, audioMinSeconds?, audioMaxSeconds?}` | Toolbox chip only, both modes. Runs here: `GET apis.roblox.com/toolbox-service/v2/assets:search` (no key, no cookie, free only, Full view). `type` Model (default), MeshPart, Decal, Audio; `verifiedOnly` default true; `limit` 1–10 (default 6). Returns ids, names, creators (verified), votes, script and instance counts, triangles, inside `<untrusted-toolbox-data>`; the chat gets a `toolbox_results` event |
| `toolbox_insert {id, place?, position?, parent?, name?, anchor?, reason?}` | Toolbox chip only, Live mode. A game request (`tool: "toolbox_insert"`, `args` with the dev server's `asset` snapshot). The game loads it into nothing (`AssetService:LoadAssetAsync`), removes scripts, remotes, bindables, explosions and spawns, shows the dev an approval card (Insert / Deny, Anchor, Keep scripts off by default) and places it in `Workspace.TypeTorchToolbox` in front of the dev. Wait: approval 60 s + load 20 s + 20 s |
| `toolbox_add {id, path, reason?}` | Toolbox chip only, Code mode. The dev server writes `toolbox.lock.toml` (`[assets."toolbox/<...>"]`: kind image/sound/mesh/model, storeId, assetId, name, creator, verified, scripts, updated, addedBy, added); the asset is referenced by id, never re-uploaded |

Delivery: the game server's long-poll (`GET /v1/game/poll?since=<cursor>`, JWT, held up to 20 s) carries this server's
prompt events and its tool requests; results go to `POST /v1/game/tool-result {id, ...}`. When no poll is open the dev
server publishes `{"v":1,"s":<session>,"j":<JobId>,"x":<request id>,"u":<user id>}` on topic `TypeTorch/tool` (never
the code), and the game server fetches the request:
- `GET /v1/game/pending` (JWT) → `{"requests": [{"id", "tool"}]}`: this user's requests for this job;
- `GET /v1/game/requests/:id` (JWT) → `{"id", "tool", "args", "description", "timeoutSeconds", "conversationId", "promptId"}`;
  `404` unless the token's user AND job match the request, `410` once it expired or was answered;
- `POST /v1/game/requests/:id/result` (JWT, nonce, timestamp) `{"ok", "output"?: string[], "returned"?, "error"?, "data"?, "ms"?, "denied"?}`
  (≤ 80 KB) → `{"ok": true}`; once only.

Claude gets the result capped at 64 KB inside `<untrusted-game-data>`; with no answer in time (approval 60 s + timeout
+ 20 s) it gets a clear error.

### Status codes
| Code | Meaning | Game server should |
|---|---|---|
| `401` | Token endpoint: any failed grant. Other endpoints: missing/invalid access token (signature, alg, iss, aud, expiry, sid, user not allowed/revoked, stale `ver`) | Other endpoints: refresh once; token endpoint: ask for a new code |
| `403` | Valid token, wrong `X-TT-Job`, branch or scope; cancel or deploy decision by a non-requester | Give up |
| `400` | Bad body/schema/unknown field, missing or invalid `X-TT-Nonce`/`X-TT-Timestamp`, timestamp outside ±300 s, bad `since`, an attachment that isn't the caller's or was used, an image whose sizes don't match | Fix the request |
| `404` | Unknown prompt, conversation (or someone else's), proposal, image (or someone else's) or route; no capture file for `POST /v1/attachments/capture` | Capture: use the asset fallback |
| `409` | Nonce already used; cancel of a finished prompt; a deploy decision on a settled proposal; a follow-up while the conversation's last prompt runs or waits for a deploy decision | |
| `413` / `431` | Body over 480 KB (3 MB for attachments) / headers over 2 KB | |
| `423` | A code prompt while another code run or an undecided proposal holds the worktree | Wait for it, or decide the proposal |
| `429` | This user locked on this job (5 wrong codes), token rate limit, queue full (5), `--max-prompts` reached, 8 unsent or 40 attachments, a pickup running or 10 pickups/downloads this minute | Back off |
| `422` / `502` | A capture or asset that isn't a readable image / the asset download failed | |
| `503` | Session shutting down; `POST /v1/attachments/asset` without an Open Cloud key | |

### Registration (Open Cloud MessagingService)
Topic `TypeTorch/remote-claude`, every 60 s (and right away when a user is revoked):
`{"v":1,"s":"<session id>","b":"<branch>","u":[<user ids>],"url":"https://<words>.trycloudflare.com","exp":<unix now+120>}`.
On exit: `{"v":1,"s":"<session id>","url":"<the same URL>","closed":true}`. When the tunnel restarts with a new URL the
old session is closed that way and a new session id is announced with the new URL. Game servers only take
`https://<name>.trycloudflare.com` URLs, keep the first URL they hear for a session id, and honor `closed` only with
the matching URL. Messages are under 1 KiB and never contain the pairing code.

## Worktree
Claude works in `<repo>/../<repo-name>-remote-claude`, never in your working copy. Git can't check out one branch twice,
so when the session branch is checked out elsewhere (the usual case) the worktree uses `remote-claude/<branch>`: it is
fast-forwarded (or merged) to the branch head before every run, commits land there, and you bring them home with
`git merge remote-claude/<branch>`. Leftovers of a failed or cancelled run are reset before the next one. While a deploy
proposal waits, runs only clean the worktree (no merge), so it stays exactly at the proposed commit.

Attachments (screenshots) are never in the worktree: they live in `<temp>/tt-rc-att-<session>` and, while their prompt
runs, in that run's temp folder (see the security model). An old `.typetorch/attachments` folder in the worktree is
deleted at startup.
Claude Code keeps its sessions under `~/.claude/projects/`, which is what lets a conversation resume (what Claude read
during a run, attached logs and screenshots included, is part of that session's local transcript, and the screenshot
tool's image too).

## Tests
```sh
bun test                 # security, relay (paths, status lines, logs), modes + deploy approval, chat, game-tool and
                         # image tests (PNG decode, downscale, crop, capture pickup, asset fallback, Claude → game),
                         # strokes tests (marks at the right pixels, crop + marks, the caps, both endpoints),
                         # Toolbox tests (a recorded Creator Store response in test/fixtures/toolbox, the chip gate
                         # end to end, toolbox.lock.toml; no live search calls),
                         # all on 127.0.0.1 (a fake claude drives the real runner), and one real Quick Tunnel
                         # (TT_SKIP_TUNNEL=1 to skip it)
bun test/e2e.ts          # a real two-message conversation with an image attachment through the tunnel and Claude,
                         # in test-fixture/ (--no-deploy)
bun run test:node-http   # the whole suite against the node:http server (what Node runs) instead of Bun.serve
bun run build            # tsc -p tsconfig.build.json: src/*.ts -> dist/*.js + .d.ts (ESM for Node 20+)
bun run smoke            # node scripts/smoke.mjs: the compiled bin, runtime and HTTP server under plain Node
bun run smoke:pack       # + npm pack: file list, a scan for keys/local paths/user names, npx <tarball> --help (offline)
```

Runtime differences live in `src/runtime.ts`, on Node's own modules: child processes (PATH lookup; on Windows npm
`.cmd` shims run their JS target with node, other `.cmd` scripts go through cmd.exe quoted and escaped and refuse
arguments with a double quote or a line break; kill-tree with `taskkill /T`), zstd, and the HTTP server: **Bun.serve
under Bun, node:http under Node**, behind one contract (`scripts/http-check.mjs`, run on both by `test/http.test.ts`
and under Node by the smoke test): bound to 127.0.0.1, 413 for an oversized body (declared or streamed), 431 for big
headers, a 10 s idle timeout with per-request overrides (the long-poll, captures, MCP calls), `req.signal` aborted when
the client leaves, and only our headers (Node adds Date and Connection/Keep-Alive): no CORS. `src/glob.ts` replaces
Bun.Glob for the protected paths (`test/glob.test.ts` checks it against Bun.Glob). The build compiles with
`types: ["node"]`, so a Bun global in `src/` doesn't compile. `prepublishOnly` runs the build, `bun test` and the
pack smoke test; publishing is done by hand (`npm publish`, 2FA).

## License
MIT
