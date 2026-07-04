# soksak 명령 레퍼런스

> 자동 생성 문서 — 원천은 앱 Command Registry(`sok docs` 로 재생성).

모든 명령: `sok <command> ['{JSON}']`. 대상 id 생략 시 호출 컨텍스트($SOKSAK_PANE) 기본.

코어 명령만 수록한다. 플러그인 기여 명령(`plugin.<플러그인id>.*`)은 설치본마다 다르므로 `sok commands` 또는 각 플러그인 스킬에서 조회한다.

## `activity.recent`

Query the app-wide activity stream (P12 execution visibility): registry command executions (command/source/danger/duration/outcome — param keys only, no values), terminal command start/finish, AI turn ends, view activations. Cursor with since (exclusive seq) to fetch only new entries; entries carry monotonic seq + epoch-ms ts. Same answer from any window (process-wide singleton hub). | 활동 피드 실행 기록 최근 명령 스트림 조회 오케스트레이터

| Parameter | Type | Required | Description |
|---|---|---|---|
| `limit` | number |  | Maximum entries to return (default 200) [default 200] |
| `since` | number |  | Return entries with seq greater than this (backfill cursor). Omit for latest. |

**Returns**: { entries: [{ seq, ts, kind, source, payload }] }

```bash
sok activity.recent '{"limit":20}'
sok activity.recent '{"since":1234}'
```

## `ai.session.detect`

Detect whether a shell command launches a tracked AI agent (claude or codex). Returns the agent kind or null. Used to tag terminal command blocks with agentKind. | 에이전트탐지 세션탐지 ai탐지

| Parameter | Type | Required | Description |
|---|---|---|---|
| `command` | string | ✓ | The shell command line to classify |

**Returns**: { kind }
**Errors**: INVALID_PARAMS

```bash
sok ai.session.detect '{"command":"claude --resume"}'
```

## `ai.session.find`

Find the most recent claude session for a working directory by reading its session folder (~/.claude/projects/<encoded-cwd>/). Returns sessionId and cwd, or null. Used to tag a terminal's command block with the session it launched (on-demand, no live watch). codex uses date folders and is resolved later. | 세션찾기 세션조회 현세션

| Parameter | Type | Required | Description |
|---|---|---|---|
| `cwd` | string | ✓ | Working directory the agent ran in |

**Returns**: { session }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok ai.session.find '{"cwd":"/Users/me/proj"}'
```

## `ai.session.inspect`

Read a claude/codex session jsonl file's header and return its sessionId and cwd. Only paths under ~/.claude/projects or ~/.codex/sessions are allowed; arbitrary file reads are rejected. The sessionId is validated against a UUID whitelist. | 세션점검 세션식별 세션정보

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✓ | Path to the session .jsonl file |

**Returns**: { session }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok ai.session.inspect '{"path":"~/.claude/projects/-Users-me-proj/<id>.jsonl"}'
```

## `ai.session.lineage`

Read the session-transition history for a working directory (and optionally one viewId), oldest first. Each row is {viewId, fromSession, toSession, kind, time} — the time-ordered from→to chain is the flow, and one fromSession branching to several toSession is a fork. This is what we observe via watch since claude doesn't record /clear·/resume branches itself. | 세션계보 세션흐름 세션분기 lineage

| Parameter | Type | Required | Description |
|---|---|---|---|
| `cwd` | string | ✓ | Working directory (scope) to read lineage for |
| `viewId` | string |  | Limit to one terminal view; omit for all in this cwd |

**Returns**: { rows }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok ai.session.lineage '{"cwd":"/Users/me/proj"}'
```

## `bookmark.add`

Add a URL to browser bookmarks. | 즐겨찾기 추가 북마크 저장

| Parameter | Type | Required | Description |
|---|---|---|---|
| `title` | string |  | Display name (omit = hostname) |
| `url` | string | ✓ | URL |

**Returns**: {}

```bash
sok bookmark.add '{"url":"https://example.com"}'
```

## `bookmark.list`

List saved browser bookmarks. | 즐겨찾기 목록 북마크

**Returns**: { bookmarks: [{url,title}] }

```bash
sok bookmark.list
```

## `bookmark.remove`

Remove a URL from browser bookmarks. | 즐겨찾기 삭제 북마크 제거

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | ✓ | URL |

**Returns**: {}

```bash
sok bookmark.remove '{"url":"https://example.com"}'
```

## `clipboard.read`

Read the current text from the system clipboard. Returns an empty string when the clipboard holds non-text content. Use to inspect a command result or the last copied value. | 클립보드 읽기 복사내용 붙여넣기확인

**Returns**: { text }
**Errors**: INTERNAL

```bash
sok clipboard.read
```

## `clipboard.write`

Write text to the system clipboard, overwriting existing content. The core suppresses the self-write echo event once to prevent feedback loops. | 클립보드 쓰기 복사 클립보드저장

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | ✓ | Text to place in the clipboard |

**Returns**: { ok }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok clipboard.write '{"text":"복사할 내용"}'
```

## `content.activate`

Switch to a specific content tab, making it active. | 탭 이동 전환 바꾸기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `content` | string | ✓ | Target content tab id |
| `project` | string |  | Target project id (omit = caller's context project) |

**Returns**: {}
**Errors**: TARGET_NOT_FOUND

```bash
sok content.activate '{"content":"c2"}'
```

## `content.close`

Close a content tab. Refuses to close the last remaining content. | 탭 닫기 컨텐츠

| Parameter | Type | Required | Description |
|---|---|---|---|
| `content` | string | ✓ | Target content tab id |
| `project` | string |  | Target project id (omit = caller's context project) |

**Returns**: { activeContentId }
**Errors**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok content.close '{"content":"c2"}'
```

## `content.create`

Create a new content tab. Program priority: explicit > project setting > global setting. | 새 탭 콘텐츠 추가 새로 열기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `program` | string |  | Program id — plugin-registered only (see program.list; no built-in default). Unregistered id falls back to terminal view |
| `project` | string |  | Target project id (omit = caller's context project) |

**Returns**: { contentId, groupId, viewId, paneId? }
**Errors**: TARGET_NOT_FOUND

```bash
sok content.create '{"program":"browser"}'
```

## `content.list`

List content tabs in a project.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Target project id (omit = caller's context project) |

**Returns**: { contents: [{id,title,program,active}] }
**Errors**: TARGET_NOT_FOUND

```bash
sok content.list
```

## `content.rename`

Rename a content tab.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `content` | string | ✓ | Target content tab id |
| `project` | string |  | Target project id (omit = caller's context project) |
| `title` | string | ✓ | New name |

**Returns**: {}
**Errors**: TARGET_NOT_FOUND

```bash
sok content.rename '{"content":"c1","title":"빌드"}'
```

## `content.switchScan`

Measure a content-tab switch as the user sees it: record the switch and report whether the new content lands in a single clean frame or smears across several (jank), via per-frame pixel change in the content area. Detects same-color switches that brightness can't. Restores the original tab. Replaces ad-hoc capture scripts. | 탭 전환 측정 깜빡임 jank 콘텐츠 검사 단일프레임

| Parameter | Type | Required | Description |
|---|---|---|---|
| `applyAtMs` | number |  | Delay after recording starts before switching (default 250) |
| `frames` | number |  | Frames to capture (default 30) |
| `from` | string |  | Content id to start on (default: current active) |
| `intervalMs` | number |  | Frame interval ms (default 16) |
| `project` | string |  | Target project id (omit = caller's context project) |
| `region` | json |  | Content area fractional rect {x0,y0,x1,y1} (0..1). Default covers the main content pane. |
| `settleMs` | number |  | Settle wait on the start content (default 600) |
| `threshold` | number |  | Noise floor (changed-pixel fraction) below which no switch is reported (default 0.003). Detection above the floor is peak-relative, so it adapts to the switch's magnitude. |
| `to` | string | ✓ | Target content tab id |

**Returns**: { frames, frameMs, switchFrame, switchFrames (consecutive changed = jank spread), clean, diffsPct }

```bash
sok content.switchScan '{"from":"c1","to":"c3"}'
sok content.switchScan '{"to":"c3","frames":40}'
```

## `data.backup`

Snapshot the entire data store to a single .db file via VACUUM INTO (absorbs WAL). Omit path to write a timestamped file under ~/.soksak/backups/. | 백업 스냅샷 데이터백업

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string |  | Destination path; defaults to backup folder |

**Returns**: { path }
**Errors**: INTERNAL

```bash
sok data.backup
sok data.backup '{"path":"/tmp/soksak.db"}'
```

## `data.count`

Count records in a collection (read-only). Narrow the count with an optional where filter. | 카운트 개수 레코드수 건수

| Parameter | Type | Required | Description |
|---|---|---|---|
| `coll` | string | ✓ | Collection name |
| `ns` | string | ✓ | Namespace: plugin id or 'core' |
| `scope` | string |  | Scope partition key |
| `where` | json |  | Filter condition (same shape as data.query where) |

**Returns**: { count }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok data.count '{"ns":"soksak-plugin-mailbox","coll":"messages"}'
```

## `data.encrypt.convert`

Seal records already stored plaintext in a scope under the active key (one transaction per record, idempotent, resumable). Run after data.encrypt.enable to protect pre-existing data. | 암호화변환 봉인변환 기존암호화

| Parameter | Type | Required | Description |
|---|---|---|---|
| `coll` | string | ✓ | Collection name |
| `ns` | string | ✓ | Namespace: plugin id or 'core' |
| `scope` | string | ✓ | Scope partition key to convert |

**Returns**: { converted }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok data.encrypt.convert '{"ns":"soksak-plugin-terminal","coll":"command_blocks","scope":"projA"}'
```

## `data.encrypt.enable`

Enable encryption for a scope: generate an X25519 keypair, wrap the private key in the vault (requires the vault to be unlocked first) AND under a one-time recovery code, then register the public key so every subsequent write is sealed. Returns the recovery code ONCE — store it safely; it is the only way to recover the data if the passphrase is lost, and it is never retrievable again. Run data.encrypt.convert afterward to seal records already stored. | 암호화활성 암호화켜기 봉인활성

| Parameter | Type | Required | Description |
|---|---|---|---|
| `scope` | string | ✓ | Scope partition key to encrypt |

**Returns**: { keyId, recoveryCode }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok data.encrypt.enable '{"scope":"projA"}'
```

## `data.encrypt.recover`

Recover a scope's encryption private key from its one-time recovery code after a lost passphrase. Unlock the vault with a NEW passphrase first; this re-stores the recovered key under it. The recovered key must match the registered public key or recovery is refused. After success the scope's sealed records decrypt again. | 암호화복구 키복구 복구코드

| Parameter | Type | Required | Description |
|---|---|---|---|
| `recoveryCode` | string | ✓ | The recovery code issued at enable |
| `scope` | string | ✓ | Scope partition key to recover |

**Returns**: { ok }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok data.encrypt.recover '{"scope":"projA","recoveryCode":"XXXX-XXXX-..."}'
```

## `data.encrypt.rotate`

Rotate a scope's encryption key: generate a new keypair, re-seal every record from the old key to the new one (one transaction each, resumable), then dispose the old key only once nothing references it. Requires the vault unlocked. | 키회전 키교체 암호화회전

| Parameter | Type | Required | Description |
|---|---|---|---|
| `scope` | string | ✓ | Scope partition key to rotate |

**Returns**: { oldKeyId, newKeyId, rekeyed, oldDisposed }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok data.encrypt.rotate '{"scope":"projA"}'
```

## `data.encrypt.status`

Report encryption state for a scope: enabled (an active key = sealing trigger), keyId, algo, whether the vault is unlocked (decryption possible), tampered (publicKey no longer matches the vault private key), and keyMissing (the public key exists but its private key is gone from the vault — sealed records are unrecoverable). | 암호화상태 암호화확인 봉인상태

| Parameter | Type | Required | Description |
|---|---|---|---|
| `scope` | string | ✓ | Scope partition key (e.g. projectId) |

**Returns**: { enabled, keyId, algo, unlocked, tampered, keyMissing }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok data.encrypt.status '{"scope":"projA"}'
```

## `data.export`

Export data as JSONL (meta + record + kv rows). Scope by ns/coll; omit both for a full export. Use for partial backups or migrating data between instances. | 내보내기 익스포트 데이터이식

| Parameter | Type | Required | Description |
|---|---|---|---|
| `coll` | string |  | Limit to this collection; omit for all |
| `ns` | string |  | Limit to this namespace; omit for all |

**Returns**: { jsonl }
**Errors**: INTERNAL

```bash
sok data.export '{"ns":"soksak-plugin-mailbox"}'
```

## `data.import`

Import JSONL produced by data.export: meta rows call define, record rows upsert, kv rows set. Existing ids are overwritten. | 가져오기 임포트 데이터이식 복구

| Parameter | Type | Required | Description |
|---|---|---|---|
| `jsonl` | string | ✓ | JSONL string output from data.export |

**Returns**: { applied }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok data.import '{"jsonl":"..."}'
```

## `data.query`

Query a collection (read-only). Filter fields must be declared as indexes in define. Use to read or filter stored records. | 데이터 조회 쿼리 검색 목록

| Parameter | Type | Required | Description |
|---|---|---|---|
| `coll` | string | ✓ | Collection name |
| `desc` | boolean |  | Sort descending (default true) |
| `limit` | number |  | Max rows to return (default 200) |
| `ns` | string | ✓ | Namespace: plugin id or 'core' |
| `offset` | number |  | Rows to skip |
| `order` | string |  | Sort field: created, updated, or any index field |
| `scope` | string |  | Scope partition key (e.g. projectId) |
| `where` | json |  | {field: value} or {field: {op, value}} |

**Returns**: { rows }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok data.query '{"ns":"soksak-plugin-mailbox","coll":"messages","scope":"projA"}'
```

## `data.restore`

Restore the entire data store from a backup .db file: validates, safely copies the current store, then atomically swaps. Irreversible — use with caution. | 복원 데이터복원 되돌리기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✓ | Path to the backup .db file to restore from |

**Returns**: { ok }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok data.restore '{"path":"/tmp/soksak.db"}'
```

## `data.search`

Full-text search a collection using FTS5 trigram (CJK-aware). Queries shorter than 3 code points fall back to LIKE. | 검색 전문검색 찾기 텍스트검색

| Parameter | Type | Required | Description |
|---|---|---|---|
| `coll` | string | ✓ | Collection name |
| `limit` | number |  | Max rows to return (default 50) |
| `ns` | string | ✓ | Namespace: plugin id or 'core' |
| `query` | string | ✓ | Search query string |
| `scope` | string |  | Scope partition key |

**Returns**: { rows }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok data.search '{"ns":"soksak-plugin-mailbox","coll":"messages","query":"빌드 실패"}'
```

## `editor.close`

Close an editor view (same as view.close).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `view` | string | ✓ | Target view id (omit = caller's context view) |

**Returns**: { activeGroupId, activeViewId }
**Errors**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok editor.close '{"view":"v4"}'
```

## `editor.open`

Open a file in an editor view. If already open, activates that tab instead. | 파일 열기 에디터 편집 코드

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✓ | Absolute file path |
| `project` | string |  | Target project id (omit = caller's context project) |

**Returns**: { viewId, groupId, existing }
**Errors**: TARGET_NOT_FOUND

```bash
sok editor.open '{"path":"/Users/me/work/src/main.rs"}'
```

## `explorer.git`

Get git change status for a directory (matches file-tree decoration). | git 상태 변경 파일 수정됨

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string |  | Git repo directory (omit = project root) |
| `project` | string |  | Target project id (omit = caller's context project) |

**Returns**: { entries: [{path,status}] } — empty list if not a repo
**Errors**: TARGET_NOT_FOUND, INTERNAL

```bash
sok explorer.git
```

## `explorer.list`

List direct children of a directory (same view as the file tree). Omit path to use the project root (falls back to HOME). | 파일 목록 디렉토리 폴더 내용 탐색

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string |  | Absolute directory path |
| `project` | string |  | Target project id (omit = caller's context project) |

**Returns**: { root, children: [{name,dir}] }
**Errors**: TARGET_NOT_FOUND, INTERNAL

```bash
sok explorer.list
sok explorer.list '{"path":"/tmp"}'
```

## `git.diff`

Return the raw unified diff for the working tree (default), the index when staged=true, or a specific commit's patch when commit is supplied. Use to inspect uncommitted or committed changes. | 깃 diff 변경 차이 수정내용 스테이지

| Parameter | Type | Required | Description |
|---|---|---|---|
| `commit` | string |  | Commit hash or HEAD reference |
| `file` | string |  | Limit diff to this file (repository-relative path) |
| `path` | string |  | Repository path (defaults to active project root when omitted) |
| `staged` | boolean |  | Diff the index (staged changes) instead of the working tree [default false] |

**Returns**: { diff: string }
**Errors**: TARGET_NOT_FOUND, INTERNAL

```bash
sok git.diff
sok git.diff '{"file":"src/main.ts","staged":true}'
```

## `git.init`

Run git init in a directory if .git is absent (no-op when already initialized, idempotent). Use with project.created event in a git-init policy plugin to auto-initialize repos on project creation. | 깃 초기화 저장소 생성 init

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string |  | Repository path (defaults to active project root when omitted) |

**Returns**: { initialized: whether init was performed, path }
**Errors**: TARGET_NOT_FOUND, INTERNAL

```bash
sok git.init '{"path":"/Users/me/work"}'
```

## `git.log`

Retrieve commit history in reverse-chronological order. Supports pagination via limit (default 50, max 500) and skip. | 깃 로그 커밋 이력 히스토리

| Parameter | Type | Required | Description |
|---|---|---|---|
| `limit` | number |  | Maximum number of commits to return (default 50, max 500) |
| `path` | string |  | Repository path (defaults to active project root when omitted) |
| `skip` | number |  | Number of commits to skip for pagination |

**Returns**: { commits: [{hash, short, author, date, subject}] }
**Errors**: TARGET_NOT_FOUND, INTERNAL

```bash
sok git.log
sok git.log '{"limit":10,"skip":10}'
```

## `git.show`

Show a single commit in full: metadata, changed file list, and the raw patch. Use to inspect what a specific commit introduced. | 깃 커밋 상세 패치 변경내용 보기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `commit` | string | ✓ | Commit hash (4–40 hex) or symbolic ref such as HEAD, HEAD~N, or HEAD^ |
| `path` | string |  | Repository path (defaults to active project root when omitted) |

**Returns**: { meta, files: [{status, path}], patch }
**Errors**: TARGET_NOT_FOUND, INTERNAL

```bash
sok git.show '{"commit":"HEAD"}'
```

## `layout.suggest`

Suggest window placements from current monitor/window facts (pure strategy — nothing moves). strategy spread: orchestrator windows take a workspace-free monitor whole (or the right third alongside on a single monitor); workspaces fill their own monitor. strategy grid: tile all windows on the first monitor. Feed each placement to window.place to execute. | 창 배치 제안 전략 모니터 분배 오케스트레이터

| Parameter | Type | Required | Description |
|---|---|---|---|
| `roles` | json |  | Optional label→role map, e.g. {"orch-1":"orchestrator"} — unlisted windows count as workspaces |
| `strategy` | string |  | Placement strategy (spread|grid) [default "spread"] |

**Returns**: { placements: [{label,monitor,x,y,w,h}] }

```bash
sok layout.suggest '{"strategy":"spread","roles":{"orch-1":"orchestrator"}}'
```

## `media.proxy.info`

Return the local media-stream proxy endpoint { base, port, token }. The proxy fetches Referer/CORS-protected media (HLS .m3u8/.ts, ranged .mp4) the webview cannot fetch cross-origin: it injects caller-supplied headers, streams binary with Range support, rewrites m3u8 segment/key URLs, and sets permissive CORS for hls.js / <video>. Build URLs as {base}/m3u8?url=&referer=&ua= or {base}/stream?url=&referer=&ua=. | 미디어 프록시 스트리밍 엔드포인트 HLS 재생 Referer CORS

**Returns**: { base, port, token }
**Errors**: INTERNAL

```bash
sok media.proxy.info
```

## `media.proxy.playlist`

Build a proxied URL for an HLS playlist (.m3u8). The proxy fetches the playlist with the given Referer/User-Agent and rewrites every segment/key URL back through the proxy so hls.js can play it. Returns { url }. Generic: no site knowledge. | 미디어 프록시 HLS 플레이리스트 m3u8 URL

| Parameter | Type | Required | Description |
|---|---|---|---|
| `referer` | string |  | Referer header to inject (origin is derived from it) |
| `url` | string | ✓ | Upstream .m3u8 playlist URL to proxy |
| `userAgent` | string |  | User-Agent header to inject (defaults to a browser UA) |

**Returns**: { url }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok media.proxy.playlist '{"url":"https://cdn.example/play.m3u8","referer":"https://page.example/"}'
```

## `media.proxy.stream`

Build a proxied URL for a single binary media resource (a .ts/fMP4 segment, key, or ranged .mp4). The proxy forwards Range and injects the given Referer/User-Agent. Returns { url } for use as a <video> src or hls.js segment. Generic: no site knowledge. | 미디어 프록시 세그먼트 바이너리 스트림 URL

| Parameter | Type | Required | Description |
|---|---|---|---|
| `referer` | string |  | Referer header to inject (origin is derived from it) |
| `url` | string | ✓ | Upstream media URL to proxy |
| `userAgent` | string |  | User-Agent header to inject (defaults to a browser UA) |

**Returns**: { url }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok media.proxy.stream '{"url":"https://cdn.example/seg0.ts","referer":"https://page.example/"}'
```

## `net.http.request`

Send an arbitrary-origin HTTP request (method/url/headers/query/body) → {status,headers,body}. Core handles cross-origin requests that webview fetch cannot. Secrets are substituted at the Rust boundary from the ns vault (secretSubst: placeholder→secretKey, plaintext never exposed). ns must be explicit from CLI/E2E; plugin runtime uses app.network.http which injects ns automatically. impersonate:"chrome" routes the request through the browser-fingerprint (JA3/JA4) backend; "off" (default) uses the plain native-tls backend. | HTTP 요청 API호출 웹요청 GET POST 임퍼소네이션 핑거프린트

| Parameter | Type | Required | Description |
|---|---|---|---|
| `body` | string |  | Request body as a string |
| `contentType` | string |  | Content-Type header value |
| `headers` | json |  | Request headers map |
| `impersonate` | string |  | Transport backend: "off" (default, plain native-tls) or "chrome" (browser JA3/JA4 fingerprint via the wreq backend, to pass fingerprint-blocking CDNs). Same response shape, secret/ns/danger gates either way. |
| `method` | string | ✓ | HTTP method: GET, POST, PUT, DELETE, PATCH, etc. |
| `ns` | string |  | Secret resolution namespace (required when secretSubst is provided) |
| `query` | json |  | Query parameter map |
| `secretSubst` | json |  | placeholder→secretKey map; values are resolved from the ns vault at the Rust boundary, never exposed as plaintext |
| `url` | string | ✓ | Request URL |

**Returns**: { status, headers, body }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok net.http.request '{"method":"GET","url":"https://api.example.com/v1/ping"}'
sok net.http.request '{"method":"GET","url":"https://blocked.example.com","impersonate":"chrome"}'
```

## `net.udp.request`

UDP request-response on a single socket: send data (hex) to host:port, then collect replies for timeoutMs (SSDP discover, mDNS, DNS, etc.). Unicast replies return to the sending port. Each packet includes hex and decoded text. | UDP 요청 SSDP mDNS 디스커버리 네트워크검색

| Parameter | Type | Required | Description |
|---|---|---|---|
| `data` | string | ✓ | Bytes to send as a hex string |
| `host` | string | ✓ | Target host (e.g. 239.255.255.250 for SSDP) |
| `maxPackets` | number |  | Max packets to collect (default 64) |
| `port` | number | ✓ | Target port (e.g. 1900 for SSDP) |
| `timeoutMs` | number |  | Response collection window in ms (default 3000) |

**Returns**: { packets: [{ address, port, data(hex), text }] }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok net.udp.request '{"host":"239.255.255.250","port":1900,"data":"...","timeoutMs":3000}'
```

## `net.udp.send`

Send a UDP datagram to any host:port, including broadcast addresses (e.g. Wake-on-LAN). data must be a hex string. Core handles raw UDP that webview JS cannot perform. | UDP 전송 네트워크 브로드캐스트 WOL

| Parameter | Type | Required | Description |
|---|---|---|---|
| `broadcast` | boolean |  | Allow broadcast addresses (255.255.255.255 etc.) |
| `data` | string | ✓ | Bytes to send as a hex string (e.g. ffffffffffff...) |
| `host` | string | ✓ | Target host or broadcast address (e.g. 255.255.255.255) |
| `port` | number | ✓ | Target UDP port (e.g. 9) |

**Returns**: { bytesSent }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok net.udp.send '{"host":"255.255.255.255","port":9,"data":"ffffffffffff","broadcast":true}'
```

## `notify.show`

Show an OS desktop notification (title + body). Behaves like a push notification when the window is not focused. To trigger a command on click, embed a deep-link URL (soksak://run?cmd=<command>&p=<JSON>) in the body or follow-up message. | 알림 보내기 푸시 통지 데스크톱알림

| Parameter | Type | Required | Description |
|---|---|---|---|
| `body` | string | ✓ | Notification body text |
| `title` | string | ✓ | Notification title |

**Returns**: { ok }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok notify.show '{"title":"배포 완료","body":"prod 배포가 끝났습니다"}'
```

## `panel.close`

Close a panel and all its tabs. Refuses to close the last panel. | 패널 닫기 제거

| Parameter | Type | Required | Description |
|---|---|---|---|
| `group` | string | ✓ | Target panel (group) id (omit = caller's context panel) |

**Returns**: { activeGroupId }
**Errors**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok panel.close '{"group":"g2"}'
```

## `panel.equalize`

Equalize split ratios — with index, halves the two areas at that divider (same as double-clicking the divider); without index, distributes all children equally. | 패널 균등 같은 크기 반반 균등화

| Parameter | Type | Required | Description |
|---|---|---|---|
| `index` | number |  | Divider index (0 = first boundary). Omit to equalize all children. |
| `project` | string |  | Target project id (omit = caller's context project) |
| `split` | string | ✓ | Split node id (e.g. s1) |

**Returns**: { sizes }
**Errors**: TARGET_NOT_FOUND, INVALID_PARAMS

```bash
sok panel.equalize '{"split":"s1"}'
sok panel.equalize '{"split":"s1","index":0}'
```

## `panel.focus`

Focus (activate) a panel, making it the active group. | 패널 포커스 활성화 선택

| Parameter | Type | Required | Description |
|---|---|---|---|
| `group` | string | ✓ | Target panel (group) id (omit = caller's context panel) |

**Returns**: {}
**Errors**: TARGET_NOT_FOUND

```bash
sok panel.focus '{"group":"g2"}'
```

## `panel.list`

List panels (split panes) in a content area, including their rect (%) and the split tree.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `content` | string |  | Target content tab id |
| `project` | string |  | Target project id (omit = caller's context project) |

**Returns**: { activeGroupId, layout, panels[] }
**Errors**: TARGET_NOT_FOUND

```bash
sok panel.list
```

## `panel.merge`

Merge panels — move all tabs from src into dst; empty src panel is removed automatically. | 패널 합치기 병합 탭 이동 합병

| Parameter | Type | Required | Description |
|---|---|---|---|
| `dst` | string | ✓ | Destination panel id |
| `project` | string |  | Target project id (omit = caller's context project) |
| `src` | string | ✓ | Source panel id |

**Returns**: { groupId(merged panel) }
**Errors**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok panel.merge '{"src":"g2","dst":"g1"}'
```

## `panel.move`

Reposition a panel — move the entire src panel to the zone position relative to dst. | 패널 이동 재배치 위치 옮기기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `dst` | string | ✓ | Destination panel id |
| `project` | string |  | Target project id (omit = caller's context project) |
| `src` | string | ✓ | Source panel id |
| `zone` | string | ✓ | Drop zone (center = move/merge; others = split in that direction) (center|left|right|top|bottom) |

**Returns**: { groupId }
**Errors**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok panel.move '{"src":"g2","dst":"g1","zone":"left"}'
```

## `panel.resize`

Adjust split ratios — provide the splitId (layout.split.id from state.tree) and an array of sizes that sum to 1. | 패널 크기 조절 비율 분할 조정 바꾸기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Target project id (omit = caller's context project) |
| `sizes` | number[] | ✓ | Child ratios array summing to 1 (e.g. [0.7,0.3]) |
| `split` | string | ✓ | Split node id (e.g. s1) |

**Returns**: {}
**Errors**: TARGET_NOT_FOUND, INVALID_PARAMS

```bash
sok panel.resize '{"split":"s1","sizes":[0.7,0.3]}'
```

## `panel.split`

Split a panel — add a new panel beside the target on a given side (optionally running a program). Use when arranging the layout or opening something side by side. | 패널 나누기 분할 화면 옆에 열기 나란히

| Parameter | Type | Required | Description |
|---|---|---|---|
| `group` | string |  | Target panel (group) id (omit = caller's context panel) |
| `program` | string |  | Program id — plugin-registered only (see program.list; no built-in default). Unregistered id falls back to terminal view [default "terminal"] |
| `project` | string |  | Target project id (omit = caller's context project) |
| `side` | string | ✓ | Split direction (left|right|top|bottom) |

**Returns**: { groupId(new panel), viewId, paneId? }
**Errors**: TARGET_NOT_FOUND

```bash
sok panel.split '{"side":"right"}'
sok panel.split '{"side":"bottom","program":"browser"}'
```

## `plugin.conformance`

Report a plugin's declared-vs-actual conformance: manifest declarations vs what is actually registered/exposed at runtime, across every register-gated contribution (commands/views/fileViewers/iconSets) plus DOM nodes. Read-only diagnosis. The publish-time schema gate is soksak-validate (headless, @soksak-ai/plugin-spec); this is the in-app runtime surface. | 플러그인 정합성 선언 실제 conformance

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | 플러그인 id |

**Returns**: { id, commands/views/fileViewers/iconSets: { declared, registered, missing }, nodes: { declared, wired, missing, orphan } }

```bash
sok plugin.conformance soksak-plugin-terminal
```

## `plugin.consent.chain`

Return the ordered list of plugins still needing consent before the target plugin can be activated (dependencies first). Dev-sourced and already-consented plugins are excluded. An empty pending array means the plugin can be activated immediately. | 동의 체인 미동의 순서 활성화 전

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id |

**Returns**: { id, pending }
**Errors**: TARGET_NOT_FOUND

```bash
sok plugin.consent.chain '{"id":"soksak-plugin-acp-studio"}'
```

## `plugin.consent.preview`

Open the consent modal for inspection without activating the plugin. Use when a human wants to review permissions, contributions, and dependencies before deciding to consent. Idempotent — call again or pass an empty id to close. | 동의 모달 미리보기 확인 권한 검사

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string |  | Plugin id. Empty string or omit to close the modal. |

**Returns**: { id, shown }
**Errors**: TARGET_NOT_FOUND

```bash
sok plugin.consent.preview '{"id":"soksak-plugin-acp-orchestra"}'
sok plugin.consent.preview '{"id":""}'  # 닫기
```

## `plugin.consent.revoke`

Revoke a recorded consent, putting the plugin back into a re-consent-required state. If active, the plugin and all transitive dependents are disabled first. Safe because it only reduces permissions. | 동의 철회 취소 revoke 권한 제거

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id |

**Returns**: { id }
**Errors**: TARGET_NOT_FOUND

```bash
sok plugin.consent.revoke '{"id":"soksak-plugin-acp-core"}'
```

## `plugin.consent.summary`

Fetch the consent display data for a plugin — permissions, contribution counts, and dependency tree (plugins + libraries). Same single source used by the consent modal. Use to inspect what the user will be asked to consent to. | 플러그인 동의 요약 권한 확인

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id |

**Returns**: { id, version, permissions, contributes, dependencies:{plugins,libraries} }
**Errors**: TARGET_NOT_FOUND

```bash
sok plugin.consent.summary '{"id":"soksak-plugin-acp-orchestra"}'
```

## `plugin.deps`

Inspect the plugin dependency graph. With an id, returns that plugin's dependencies, dependents, reference count, and cascade impact. Without an id, returns all version integrity issues across installed plugins. | 플러그인 의존성 의존 그래프 종속

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string |  | Plugin id. Omit to list all version integrity issues. |

**Returns**: { summary?, issues? }
**Errors**: TARGET_NOT_FOUND

```bash
sok plugin.deps
sok plugin.deps '{"id":"soksak-plugin-acp-core"}'
```

## `plugin.dev.load`

Development mode: load a plugin from any directory without installing it. Dev-sourced plugins bypass the consent gate (spec §0-5 exception). The inject danger policy governs this command itself. | 플러그인 개발 로드 dev 임시 적재

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✓ | Absolute path to the plugin directory |

**Returns**: { id, dir }
**Errors**: TARGET_NOT_FOUND, INVALID_PARAMS

```bash
sok plugin.dev.load '{"path":"/path/to/my-plugin"}'
```

## `plugin.dev.new`

Scaffold a new dev plugin in place at ~/.soksak/plugins/<id>/. Creates the minimum plugin.json, main.js, and .soksak.json (version=dev), then runs git init. No external path or dev.load needed — the folder is the working artifact. Reloads plugins automatically after scaffolding. | 플러그인 개발 새로 만들기 스캐폴드 scaffold 생성

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id (must match ^[a-z0-9][a-z0-9-]*$) |

**Returns**: { ok, dir, pluginId }
**Errors**: INVALID_PARAMS

```bash
sok plugin.dev.new '{"id":"soksak-plugin-myapp"}'
```

## `plugin.disable`

Deactivate a plugin and revoke all of its registered commands, views, and extensions (spec §0-4). Use when you want to stop a plugin without removing it. | 플러그인 비활성화 끄기 disable

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id |

**Returns**: { id, status }
**Errors**: TARGET_NOT_FOUND

```bash
sok plugin.disable '{"id":"soksak-plugin-memo"}'
```

## `plugin.enable`

Activate a plugin so its code begins executing. Returns CONSENT_REQUIRED if the user has not yet consented via the UI consent modal — remote enable without recorded consent is always blocked. | 플러그인 활성화 켜기 enable

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id |

**Returns**: { id, status }
**Errors**: TARGET_NOT_FOUND, CONSENT_REQUIRED, INTERNAL

```bash
sok plugin.enable '{"id":"soksak-plugin-memo"}'
```

## `plugin.install`

Install a plugin from a git source into ~/.soksak/plugins/<id>. Accepts a "user/repo" shorthand, a full git URL, or a local path. Use when adding a new plugin for the first time. | 플러그인 설치 추가 install

| Parameter | Type | Required | Description |
|---|---|---|---|
| `ref` | string |  | Branch, tag, or commit to pin |
| `source` | string | ✓ | GitHub "user/repo" shorthand, git URL, or local directory path |

**Returns**: { id, dir }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok plugin.install '{"source":"user/soksak-plugin-memo"}'
sok plugin.install '{"source":"/path/to/repo","ref":"v1.0.0"}'
```

## `plugin.list`

List all installed and dev plugins with their runtime status, permissions, and rejection reasons. Use to check which plugins exist and whether any failed to load. | 플러그인 목록 설치된 확장 상태

**Returns**: { plugins: [{id, name, version, status, permissions, …}], rejected }

```bash
sok plugin.list
```

## `plugin.reload`

Rescan the plugins directory and reactivate all plugins whose consent is still valid. Use after manually editing plugin files or adding new plugin folders. | 플러그인 재적재 리로드 새로고침

**Returns**: { count, rejected }

```bash
sok plugin.reload
```

## `plugin.remove`

Remove a plugin and its directory. Plugin-owned data (plugins-data) is preserved. Blocked with CASCADE_REQUIRED if dependents exist unless cascade:true is passed to remove them transitively. | 플러그인 제거 삭제 uninstall

| Parameter | Type | Required | Description |
|---|---|---|---|
| `cascade` | boolean |  | When true, also removes all transitive dependents. Omit to block if any dependents exist. |
| `id` | string | ✓ | Plugin id |

**Returns**: { id, removed: [removed ids …] }
**Errors**: TARGET_NOT_FOUND, CASCADE_REQUIRED, INTERNAL

```bash
sok plugin.remove '{"id":"soksak-plugin-memo"}'
sok plugin.remove '{"id":"soksak-plugin-acp-core","cascade":true}'
```

## `plugin.settings.get`

Read plugin setting values at a given scope. Scope 'effective' (default) merges global defaults with project overrides. Omit key to retrieve all settings at once. | 플러그인 설정 조회 읽기 값 확인

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id |
| `key` | string |  | Setting key. Omit to return all settings. |
| `project` | string |  | Project id. Defaults to active project. Applies to project and effective scopes. |
| `scope` | string |  | effective (default, merges global+project) | global | project (effective|global|project) |

**Returns**: { id, scope, values } or { id, scope, key, value }
**Errors**: TARGET_NOT_FOUND, INVALID_PARAMS

```bash
sok plugin.settings.get '{"id":"soksak-plugin-acp-orchestra"}'
sok plugin.settings.get '{"id":"soksak-plugin-acp-orchestra","key":"defaultAgent","scope":"global"}'
```

## `plugin.settings.open`

Open the unified settings modal. With a plugin id, navigates directly to that plugin's settings panel. Omit id for the general preferences section. Pass an empty string to close the modal. Idempotent. | 설정 열기 환경설정 모달 플러그인 패널

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string |  | Plugin id (omit for general preferences, empty string to close) |

**Returns**: { section }
**Errors**: TARGET_NOT_FOUND

```bash
sok plugin.settings.open
sok plugin.settings.open '{"id":"soksak-plugin-acp-orchestra"}'
```

## `plugin.settings.reset`

Remove a setting override and restore the default value. Scope defaults to global. Omit key to reset all settings at once. | 플러그인 설정 초기화 리셋 기본값

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id |
| `key` | string |  | Setting key. Omit to reset all settings. |
| `project` | string |  | Project id. Defaults to active project. Applies when scope=project. |
| `scope` | string |  | global (default) | project (global|project) |

**Returns**: { id, scope, key, project? }
**Errors**: TARGET_NOT_FOUND, INVALID_PARAMS

```bash
sok plugin.settings.reset '{"id":"soksak-plugin-acp-orchestra","key":"defaultAgent"}'
```

## `plugin.settings.schema`

Return the plugin's settings schema from its manifest configuration block. This is the single source of truth from which both UI and CLI derive setting fields and validation rules. | 플러그인 설정 스키마 구성 항목

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id |

**Returns**: { id, configuration: ConfigSetting[] }
**Errors**: TARGET_NOT_FOUND

```bash
sok plugin.settings.schema '{"id":"soksak-plugin-acp-orchestra"}'
```

## `plugin.settings.set`

Write a plugin setting value after schema validation. Scope defaults to global; use project to override per-project. Validation failures are rejected without saving. | 플러그인 설정 변경 저장 set 값 지정

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id |
| `key` | string | ✓ | Setting key |
| `project` | string |  | Project id. Defaults to active project. Applies when scope=project. |
| `scope` | string |  | global (default) | project (global|project) |
| `value` | json | ✓ | Value to set (boolean | number | string — must match schema type) |

**Returns**: { id, scope, key, value, project? }
**Errors**: TARGET_NOT_FOUND, INVALID_PARAMS

```bash
sok plugin.settings.set '{"id":"soksak-plugin-acp-orchestra","key":"defaultAgent","value":"codex"}'
sok plugin.settings.set '{"id":"soksak-plugin-acp-orchestra","key":"defaultAgent","value":"gemini","scope":"project"}'
```

## `plugin.update`

Update an installed plugin via git pull --ff-only. Re-consent is required after update because permissions may have changed. | 플러그인 업데이트 갱신 최신화

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Plugin id |

**Returns**: { id, version }
**Errors**: TARGET_NOT_FOUND, INVALID_PARAMS, INTERNAL

```bash
sok plugin.update '{"id":"soksak-plugin-memo"}'
```

## `plugin.view.close`

Close a plugin view. Sidebar placements are deselected and revert to the file tree. Content placements close the tab in every editor group where the view is open. | 플러그인 뷰 닫기 사이드바 탭 제거

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Project id. Defaults to the active project. |
| `view` | string | ✓ | Global view key in the form "<pluginId>.<viewId>" |

**Returns**: { view, closed: [placement list] }
**Errors**: TARGET_NOT_FOUND

```bash
sok plugin.view.close '{"view":"soksak-plugin-memo.panel"}'
```

## `plugin.view.open`

Open a plugin view in the specified placement. Defaults to the view's declared defaultPlacement when placement is omitted. View implementation and placement are orthogonal (spec §0-6). | 플러그인 뷰 열기 사이드바 패널 탭 보기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `placement` | string |  | Where to place the view. Defaults to the view's defaultPlacement. (sidebar-right|sidebar-left|sidebar-footer|content) |
| `project` | string |  | Project id. Defaults to the active project. |
| `view` | string | ✓ | Global view key in the form "<pluginId>.<viewId>" |

**Returns**: { view, placement, projectId }
**Errors**: TARGET_NOT_FOUND, INVALID_PARAMS

```bash
sok plugin.view.open '{"view":"soksak-plugin-memo.panel"}'
sok plugin.view.open '{"view":"soksak-plugin-git-diff.view","placement":"content"}'
```

## `program.list`

List all programs available in the new-tab menu. Every entry is plugin-registered; nothing is built-in. Use to discover launchable programs and their menu category paths. | 프로그램 목록 앱 메뉴 새탭

**Returns**: { programs: [{ id, title, path?, kind, pluginId }] }

```bash
sok program.list
```

## `project.activate`

Switch to a different project, making it active. | 프로젝트 전환 바꾸기 이동

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string | ✓ | Target project id (omit = caller's context project) |

**Returns**: {}
**Errors**: TARGET_NOT_FOUND

```bash
sok project.activate '{"project":"t2"}'
```

## `project.close`

Close a project. Refuses to close the last remaining project. | 프로젝트 닫기 제거

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string | ✓ | Target project id (omit = caller's context project) |

**Returns**: { activeProjectId }
**Errors**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok project.close '{"project":"t2"}'
```

## `project.color`

Set the accent color for a project (rail chip and tab highlight). Omit color to remove. | 프로젝트 색 색상 탭 색깔

| Parameter | Type | Required | Description |
|---|---|---|---|
| `color` | string |  | CSS color (e.g. #4a8fe8). Omit to revert to default. |
| `project` | string | ✓ | Target project id (omit = caller's context project) |

**Returns**: {}
**Errors**: TARGET_NOT_FOUND

```bash
sok project.color '{"project":"t1","color":"#4a8fe8"}'
```

## `project.create`

Create a new project. When root is omitted, folder (slug) is required — creates and uses ~/.soksak/projects/<folder>. Home (~) and root (/) are forbidden as root. Duplicate root activates the existing project instead. | 프로젝트 만들기 새 생성 열기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `alias` | string |  | Tab alias (omit = folder name) |
| `folder` | string |  | Required when root is omitted — ^[a-z0-9][a-z0-9-]*$, used as ~/.soksak/projects/<folder> |
| `program` | string |  | Initial view program (omit = empty content tab) |
| `root` | string |  | Project root directory (absolute path — home/root forbidden) |
| `shell` | string |  | Terminal shell path (omit = global setting → $SHELL) |

**Returns**: { projectId, contentId, groupId, viewId, paneId?, existing? } | { existingWindow } (already open in another window — that window is focused instead)
**Errors**: INVALID_PARAMS

```bash
sok project.create '{"root":"/Users/me/work","program":"claude"}'
sok project.create '{"folder":"my-project"}'
```

## `project.list`

List all projects with id, title, root path, and active state. | 프로젝트 목록 리스트 열린

**Returns**: { projects: [{id,title,root,active}] }

```bash
sok project.list
```

## `project.rename`

Rename a project tab. | 프로젝트 이름 바꾸기 변경 제목

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string | ✓ | Target project id (omit = caller's context project) |
| `title` | string | ✓ | New project name |

**Returns**: {}
**Errors**: TARGET_NOT_FOUND

```bash
sok project.rename '{"project":"t1","title":"백엔드"}'
```

## `project.rightbar.toggle`

Toggle the right plugin sidebar (⌥⌘B). Provide open to set state explicitly (idempotent). | 우측 사이드바 오른쪽 패널 플러그인 바 열기 닫기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `open` | boolean |  | When provided, force open or closed |
| `project` | string |  | Target project id (omit = caller's context project) |

**Returns**: { rightOpen }
**Errors**: TARGET_NOT_FOUND

```bash
sok project.rightbar.toggle
sok project.rightbar.toggle '{"open":true}'
```

## `project.sidebar.toggle`

Toggle the file-tree sidebar for a project. | 사이드바 파일트리 열기 닫기 토글

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Target project id (omit = caller's context project) |

**Returns**: { sidebarOpen }
**Errors**: TARGET_NOT_FOUND

```bash
sok project.sidebar.toggle
```

## `project.update`

Batch-update project settings. Omitted fields are preserved; "" removes the override. root is immutable.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `color` | string |  | Accent color ("" = remove) |
| `project` | string | ✓ | Target project id (omit = caller's context project) |
| `shell` | string |  | Terminal shell path ("" = default) |
| `title` | string |  | Alias (empty string is ignored) |

**Returns**: {}
**Errors**: TARGET_NOT_FOUND

```bash
sok project.update '{"project":"t1","title":"백엔드","program":"claude"}'
```

## `remote.confirm`

Show the desktop human confirm modal for a destructive remote action and await the decision (approve/deny). Called by the remote-iroh sidecar over the socket: the sidecar owns the confirm authority (parking, TTL, token issuance) and delegates only the human decision here. The phone cannot self-approve — the decision comes only from this desktop modal. Returns { approve }. | 원격 destructive 데스크톱 사람 confirm 모달 승인 거부

| Parameter | Type | Required | Description |
|---|---|---|---|
| `command` | string | ✓ | Human-readable command summary to show (e.g. panel.close). |
| `danger` | boolean |  | Always true on this path (destructive only). |
| `device_id` | string | ✓ | Requesting remote device label to show. |
| `params` | string |  | Optional params summary string to show. |
| `request_id` | number | ✓ | Sidecar-issued confirm id (the sidecar resolves its PendingConfirms with this). |
| `ttl_secs` | number |  | Countdown seconds before auto-deny (mirrors sidecar TTL). |

**Returns**: { approve }

## `schedule.cancel`

Cancel a pending schedule by id. Returns removed=true if the schedule existed. | 스케줄 취소 삭제 예약취소 cancel

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✓ | Schedule id issued by schedule.set |

**Returns**: { removed }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok schedule.cancel '{"id":"sch-3"}'
```

## `schedule.list`

List all jobs sorted by next fire time ascending. Each: { id, trigger, command, params, next_at, running, concurrency }. next_at=null means waiting (reconcile/event) or running. running=true means a fire is in flight (lease held). | 스케줄 목록 예약 리스트 조회

**Returns**: { schedules: [{ id, trigger, command, params, next_at, running, concurrency }] }
**Errors**: INTERNAL

```bash
sok schedule.list
```

## `schedule.poke`

Fire a job immediately (completion trigger / external change). id given = that job; omitted = all reconcile jobs. Running jobs coalesce (re-fire once after completion). | 스케줄 깨우기 poke 재평가 reconcile 틱

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string |  | Job id (omit = all reconcile jobs) |

**Returns**: { ok }
**Errors**: INTERNAL

```bash
sok schedule.poke
sok schedule.poke '{"id":"sch-3"}'
```

## `schedule.register`

Register a scheduler job (trigger + registry command to fire). trigger = { kind:'at', at } | { kind:'every', every_ms, anchor? } | { kind:'cron', expr } | { kind:'reconcile' }. process_lease=true holds the lease until the fired command's process exits (no kill while running, zombie_backstop_ms cap, default 3h). retry = { max, base_ms, max_ms } for ok:false backoff. Returns the assigned id. Generalizes schedule.set. | 스케줄 등록 register 트리거 reconcile cron every 프로세스

| Parameter | Type | Required | Description |
|---|---|---|---|
| `command` | string | ✓ | Registry command name to fire |
| `concurrency` | number |  | Reserved (per-job lease is always single) |
| `id` | string |  | Existing job id to replace (new id issued when omitted) |
| `params` | json |  | Command parameters (fired with the command) |
| `process_lease` | boolean |  | Hold lease until fired process exits (exec-one) |
| `retry` | json |  | { max, base_ms, max_ms } — backoff on ok:false |
| `timeout_ms` | number |  | Non-process wait cap (ms). Ignored when process_lease. |
| `trigger` | json | ✓ | { kind:'at'|'every'|'cron'|'reconcile', ... } |
| `zombie_backstop_ms` | number |  | Process-lease zombie cap (ms). null=infinite, default 3h |

**Returns**: { jobId }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok schedule.register '{"trigger":{"kind":"every","every_ms":60000},"command":"notify.show","params":{"title":"틱","body":"1분"}}'
sok schedule.register '{"trigger":{"kind":"reconcile"},"command":"plugin.soksak-plugin-workflow.workflow.reconcile","process_lease":true,"retry":{"max":5,"base_ms":2000,"max_ms":60000}}'
```

## `schedule.set`

Schedule a registry command to fire once at an absolute epoch-ms timestamp. Generates a new id if omitted; replaces an existing schedule when id is supplied. For recurrence, re-arm after the command fires; compose with notify.show for reminders. | 스케줄 예약 타이머 알람 일정 등록

| Parameter | Type | Required | Description |
|---|---|---|---|
| `at` | number | ✓ | Fire time as epoch milliseconds |
| `command` | string | ✓ | Registry command name to fire |
| `id` | string |  | Existing schedule id to replace (a new id is issued when omitted) |
| `params` | json |  | Command parameters (defaults to empty object when omitted) |

**Returns**: { scheduleId }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok schedule.set '{"at":1750000000000,"command":"notify.show","params":{"title":"알림","body":"시간!"}}'
```

## `secret.autolock`

Set the idle auto-lock timeout in milliseconds (0 disables). When the vault stays idle past this, it locks itself and broadcasts secrets-locked to every window. Activity resets the timer via secret_touch. | 자동잠금 유휴잠금 오토락 잠금시간

| Parameter | Type | Required | Description |
|---|---|---|---|
| `ms` | number | ✓ | Idle timeout in milliseconds; 0 disables auto-lock |

**Returns**: { ms }
**Errors**: INVALID_PARAMS

```bash
sok secret.autolock '{"ms":300000}'
```

## `secret.backend`

Query the vault backend type and current lock state. Use to check whether the vault is open before performing secret operations. | 시크릿 볼트 상태 백엔드 잠금여부

**Returns**: { backend, unlocked }
**Errors**: INTERNAL

```bash
sok secret.backend
```

## `secret.delete`

Delete ns/key from the vault (removed=true if the key existed). Rejected if the vault is locked. | 시크릿 삭제 제거 지우기 delete

| Parameter | Type | Required | Description |
|---|---|---|---|
| `key` | string | ✓ | Secret key name (alphanumeric, -, _, .) |
| `ns` | string | ✓ | Namespace (plugin id or core) |

**Returns**: { removed }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok secret.delete '{"ns":"soksak-plugin-acp","key":"anthropicKey"}'
```

## `secret.has`

Check whether ns/key exists in the vault without exposing the value (plaintext readback is blocked by the core). | 시크릿 존재 확인 있는지 has 체크

| Parameter | Type | Required | Description |
|---|---|---|---|
| `key` | string | ✓ | Secret key name (alphanumeric, -, _, .) |
| `ns` | string | ✓ | Namespace (plugin id or core) |

**Returns**: { has }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok secret.has '{"ns":"soksak-plugin-acp","key":"anthropicKey"}'
```

## `secret.keys`

List the secret key names stored under a namespace (values are never returned). Use to audit what is stored in a namespace. | 시크릿 목록 키 리스트 조회

| Parameter | Type | Required | Description |
|---|---|---|---|
| `ns` | string | ✓ | Namespace (plugin id or core) |

**Returns**: { keys: string[] }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok secret.keys '{"ns":"soksak-plugin-acp"}'
```

## `secret.lock`

Lock the secret vault by zeroing the in-memory KEK. All subsequent operations are rejected until unlock is called again. | 시크릿 볼트 잠금 lock 닫기

**Returns**: { ok }
**Errors**: INTERNAL

```bash
sok secret.lock
```

## `secret.set`

Store a sensitive value under ns/key using envelope encryption (per-item DEK wrapped by the KEK). Overwrites the existing value if the key already exists. Rejected if the vault is locked. | 시크릿 저장 설정 키 값 set 보관

| Parameter | Type | Required | Description |
|---|---|---|---|
| `key` | string | ✓ | Secret key name (alphanumeric, -, _, .) |
| `ns` | string | ✓ | Namespace (plugin id or core) |
| `value` | string | ✓ | Sensitive value to store |

**Returns**: { ok }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok secret.set '{"ns":"soksak-plugin-acp","key":"anthropicKey","value":"sk-ant-..."}'
```

## `secret.unlock`

Unlock the secret vault with a master passphrase (creates a new vault if one does not exist). Keeps the KEK in memory only — only ciphertext is on disk. For headless use, set SOKSAK_VAULT_KEY env to auto-unlock. | 시크릿 볼트 열기 잠금해제 unlock 마스터키

| Parameter | Type | Required | Description |
|---|---|---|---|
| `passphrase` | string | ✓ | Master passphrase for the vault |

**Returns**: { ok }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok secret.unlock '{"passphrase":"correct horse battery staple"}'
```

## `settings.get`

Retrieve all application settings. | 설정 확인 앱 조회 환경설정

**Returns**: { language, projectTabPosition, iconSet, iconBox, focusIndicator, appFontFamily, appFontSize, bg }

```bash
sok settings.get
```

## `settings.set`

Change an application setting. key: language|projectTabPosition|iconSet|iconBox|focusIndicator|appFontFamily|appFontSize | 설정 변경 바꾸기 환경설정 폰트 크기 언어

| Parameter | Type | Required | Description |
|---|---|---|---|
| `key` | string | ✓ | Setting key (language|projectTabPosition|iconSet|iconBox|focusIndicator|appFontFamily|appFontSize) |
| `value` | json | ✓ | Value — language:ko|en, projectTabPosition:top|left, iconSet:string (registered set id — unregistered falls back to lucide), iconBox:boolean, focusIndicator:outline|corners, appFontFamily:string (CSS font-family stack), appFontSize:number (6-40) |

**Returns**: { key, value }
**Errors**: INVALID_PARAMS

```bash
sok settings.set '{"key":"projectTabPosition","value":"left"}'
sok settings.set '{"key":"iconBox","value":true}'
```

## `sidebar.left.move`

Drag-merge a left sidebar view — into=merge as a tab, left/right=horizontal split, top/bottom=vertical split (same 4 directions as the content area). viewKeys/targets come from sidebar.left.tree. | 좌측 사이드바 탭 이동 합치기 분할 드래그 머지

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Target project id (omit = caller's context project) |
| `target` | string | ✓ | target viewKey (a view in the target group) |
| `view` | string | ✓ | viewKey to move |
| `zone` | string | ✓ | into | left | right | top | bottom (4-direction, same as content area) (into|left|right|top|bottom) |

**Returns**: {}
**Errors**: TARGET_NOT_FOUND, INVALID_PARAMS

```bash
sok sidebar.left.move '{"view":"soksak-plugin-folderpop.folders","target":"soksak-plugin-file-tree.tree","zone":"right"}'
```

## `sidebar.left.resize`

Resize a left sidebar split by ratio — sizes parallel to the split's children (sum 1). Split ids from sidebar.left.tree. | 좌측 사이드바 분할 비율 크기 조절

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Target project id (omit = caller's context project) |
| `sizes` | number[] | ✓ | Ratio per child, sum 1 |
| `split` | string | ✓ | Sidebar split id |

**Returns**: {}
**Errors**: TARGET_NOT_FOUND

```bash
sok sidebar.left.resize '{"split":"s7","sizes":[0.6,0.4]}'
```

## `sidebar.left.tree`

Return the left sidebar layout tree (SplitTree of tab groups) — split ids, sizes, each leaf's viewKeys + active. Source for sidebar.left.move/resize targets. | 좌측 사이드바 레이아웃 트리 탭 분할 구조

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Target project id (omit = caller's context project) |

**Returns**: { projectId, layout }
**Errors**: TARGET_NOT_FOUND

```bash
sok sidebar.left.tree
```

## `sidebar.right.mode`

Right sidebar layout mode — overlay (floats over content) or push (occupies area like the left sidebar). Global setting; omit mode to query current. | 우측 사이드바 밀기 영역차지 오버레이 모드 도킹

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mode` | string |  | overlay | push — omit to query current |

**Returns**: { mode }
**Errors**: INVALID_PARAMS

```bash
sok sidebar.right.mode
sok sidebar.right.mode '{"mode":"push"}'
```

## `state.commands`

Full command catalog with parameter schemas, returns, errors, and examples — the source of truth for all available commands.

**Returns**: { commands: [{name,description,params,returns,errors,examples}] }

```bash
sok commands
```

## `state.context`

Resolve the caller's position: project/content/panel/view that $SOKSAK_PANE belongs to (falls back to active chain when called outside a terminal).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pane` | string |  | Target pane id (omit = caller's context pane, $SOKSAK_PANE) |

**Returns**: { projectId, contentId, groupId, viewId, paneId? }
**Errors**: TARGET_NOT_FOUND

```bash
sok state.context
```

## `state.tree`

Full layout snapshot (address book): all ids and active state across project → content → panel (rect %) → view → pane. Use to discover ids before targeting other commands.

**Returns**: { activeProjectId, projects[] } — panels[].rect is % of the content area

```bash
sok state.tree
```

## `status.query`

Query the status each view reports (R8 회신) — what setStatus / file dirty / terminal running pushed. Omit view to list all reporting views. | 상태 조회 뷰 status 무엇이 도는지

| Parameter | Type | Required | Description |
|---|---|---|---|
| `view` | string |  | Target view id (omit = caller's context view) |

**Returns**: { statuses: Array<{ viewId, code, message? }> }

```bash
sok status.query
sok status.query '{"view":"v3"}'
```

## `term.cwd`

Get the current working directory of a terminal pane (requires shell integration). | 현재 디렉토리 cwd 작업 폴더 터미널 경로

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pane` | string |  | Target pane id (omit = caller's context pane, $SOKSAK_PANE) |

**Returns**: { paneId, cwd|null }
**Errors**: TARGET_NOT_FOUND

```bash
sok term.cwd
```

## `term.exec`

Execute a shell command in the terminal (sends text + Enter). Check output with term.read. | 명령 실행 터미널 셸 커맨드

| Parameter | Type | Required | Description |
|---|---|---|---|
| `cmd` | string | ✓ | Shell command to run |
| `pane` | string |  | Target pane id (omit = caller's context pane, $SOKSAK_PANE) |

**Returns**: { paneId }
**Errors**: TARGET_NOT_FOUND

```bash
sok term.exec '{"cmd":"git status"}'
```

## `term.read`

Read terminal screen and scrollback text (TUI shows current screen only). Use to check command output. | 터미널 읽기 출력 확인 결과 보기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `lines` | number |  | Last N lines only (omit = all) |
| `pane` | string |  | Target pane id (omit = caller's context pane, $SOKSAK_PANE) |

**Returns**: { paneId, text }
**Errors**: TARGET_NOT_FOUND

```bash
sok term.read
sok term.read '{"lines":50}'
```

## `term.send`

Inject raw key input into a terminal (for TUI control). Pass control characters via JSON escapes: \r=Enter, \u0003=^C, \u001b[A=↑. | 터미널 입력 키 주입 TUI 조작 보내기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pane` | string |  | Target pane id (omit = caller's context pane, $SOKSAK_PANE) |
| `text` | string | ✓ | Bytes to inject (escapes allowed) |

**Returns**: { paneId }
**Errors**: TARGET_NOT_FOUND

```bash
sok term.send '{"text":"ls\r"}'
sok term.send '{"text":"\u0003"}'
```

## `theme.apply`

Apply a theme (replaces all token slots). Omit mode to keep the current mode. | 테마 적용 바꾸기 다크 모드 라이트 색

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mode` | string |  | Color mode (light|dark) |
| `name` | string | ✓ | Theme name (see theme.list) |

**Returns**: { name, mode }
**Errors**: TARGET_NOT_FOUND

```bash
sok theme.apply '{"name":"Paper"}'
sok theme.apply '{"name":"Midnight","mode":"light"}'
```

## `theme.install`

Install a theme JSON file into ~/.soksak/themes (immediately usable if validation passes). | 테마 설치 추가 외부

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✓ | Absolute path to theme .json file |

**Returns**: { installed(install path), rejected? }
**Errors**: INTERNAL

```bash
sok theme.install '{"path":"/tmp/dracula.json"}'
```

## `theme.list`

List available themes (built-in + external ~/.soksak/themes), including files that failed validation and their reasons. | 테마 목록 보기 사용 가능

**Returns**: { current, mode, themes:[{name,defaultMode,modes,source,warnings}], rejected }

```bash
sok theme.list
```

## `theme.reload`

Re-scan the external theme directory (~/.soksak/themes) and re-apply the current theme. | 테마 새로고침 리로드 외부 재스캔

**Returns**: { count, rejected }

```bash
sok theme.reload
```

## `turn.idleDetection`

Toggle the idle-output heuristic turn.ended provider (off by default). When enabled, a pane with no output for N ms is treated as a completed turn; false positives are possible. | 유휴감지 턴감지 아이들 idle 자동턴종료

| Parameter | Type | Required | Description |
|---|---|---|---|
| `enabled` | boolean | ✓ | Enable or disable idle detection |
| `ms` | number |  | No-output threshold in ms (default 2000, minimum 250) |

**Returns**: { enabled, ms }
**Errors**: INVALID_PARAMS, INTERNAL

```bash
sok turn.idleDetection '{"enabled":true,"ms":1500}'
```

## `turn.signal`

Emit a turn.ended event (open signal). Use when any provider — ACP, external tool, or test harness — needs to signal that a turn has finished; subscribers such as the mailbox plugin react to this event. | 턴 종료 신호 발행 턴완료 acp

| Parameter | Type | Required | Description |
|---|---|---|---|
| `command` | string |  | Description of the completed task or command (optional, enriches event body) |
| `paneId` | string |  | Related pane id (optional) |
| `project` | string |  | Project id (optional) |
| `root` | string |  | Project root path — scope key used by subscribers to filter events |
| `source` | string |  | Signal origin (shell / idle / acp — defaults to acp) |

**Returns**: { emitted }
**Errors**: INTERNAL

```bash
sok turn.signal '{"source":"acp","root":"/Users/me/proj","command":"claude 응답 완료"}'
```

## `ui.expect`

Look up which border rules apply to a given DOM selector according to the contract table. Returns matched rules and their expected edge configuration; no matching rule is also a valid answer (add to the contract table if coverage is needed). | 보더기대 계약조회 border expect ui계약

| Parameter | Type | Required | Description |
|---|---|---|---|
| `selector` | string | ✓ | CSS selector |

**Returns**: { matchedElements, rules: [{id, active, kind, edges?, seam?, note}] }

```bash
sok ui.expect '{"selector":".egroup-status"}'
```

## `ui.hit`

Return the topmost DOM element at viewport x,y (tag, classes, data-* attrs, rect) — hit-test diagnostics for drag/click E2E (what would elementFromPoint see?).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `x` | number | ✓ | viewport x |
| `y` | number | ✓ | viewport y |

**Returns**: { tag, className, data, rect } | { tag: null }

## `ui.input.click`

Dispatch a click event to an exposed node (E2E injection). Use to drive UI flows programmatically or in tests. Unexposed addresses return NOT_EXPOSED — no guessing. | 클릭 주입 ui클릭 버튼클릭 E2E

| Parameter | Type | Required | Description |
|---|---|---|---|
| `address` | string | ✓ | Exposed node address from ui.tree |

**Returns**: { clicked, address }
**Errors**: NOT_EXPOSED, INVALID_PARAMS

```bash
sok ui.input.click '{"address":"win/main/chrome/modal/consent/agree"}'
```

## `ui.input.dblclick`

Dispatch a double-click (two clicks + a dblclick event) to an exposed node (E2E injection). Use to drive double-click UI flows like inline tab/label rename. Unexposed addresses return NOT_EXPOSED — no guessing. | 더블클릭 두번클릭 이름변경 rename 주입 E2E

| Parameter | Type | Required | Description |
|---|---|---|---|
| `address` | string | ✓ | Exposed node address from ui.tree |

**Returns**: { dblclicked, address }
**Errors**: NOT_EXPOSED, INVALID_PARAMS

```bash
sok ui.input.dblclick '{"address":"win/main/chrome/tab/left/a.x"}'
```

## `ui.input.drag`

Drive a pointer drag (mousedown on `from` -> mousemove -> mouseup). Two modes: (1) drop onto a target — give `to` (+ optional zone: center default, left/right/top/bottom edge for directional split), drives drag-merge tab UIs; (2) drag by a pixel delta — give `dx`/`dy` instead of `to`, grabs `from` at its center and drags that many CSS px (for resize handles / split dividers). mousemove+mouseup dispatch on window so window-level drag listeners (divider resize) receive them. Unexposed addresses return NOT_EXPOSED. | 드래그 주입 드롭 탭이동 분할 합치기 리사이즈 디바이더 E2E 포인터드래그

| Parameter | Type | Required | Description |
|---|---|---|---|
| `dx` | number |  | Horizontal drag distance in CSS px from `from` center (mode 2 — resize/divider). Alternative to `to`. |
| `dy` | number |  | Vertical drag distance in CSS px from `from` center (mode 2). |
| `from` | string | ✓ | Source node address (the tab / divider / element to grab) |
| `to` | string |  | Target node address to drop onto (mode 1). Omit when using dx/dy. |
| `zone` | string |  | center | left | right | top | bottom — point within the target rect (mode 1) (center|left|right|top|bottom) |

**Returns**: { dragged, from, to?, zone?, dx?, dy? }
**Errors**: NOT_EXPOSED, INVALID_PARAMS

```bash
sok ui.input.drag '{"from":"win/main/chrome/tab/left/a.x","to":"win/main/chrome/tab/left/b.y","zone":"center"}'
sok ui.input.drag '{"from":"win/main/chrome/divider/s0/0","dx":120}'
```

## `ui.input.fill`

Set the value of an exposed input/textarea node and dispatch input+change events (E2E injection). Uses the native value setter so React controlled inputs pick the value up. Unexposed addresses return NOT_EXPOSED. | 입력 주입 값입력 텍스트입력 폼입력 E2E

| Parameter | Type | Required | Description |
|---|---|---|---|
| `address` | string | ✓ | Exposed node address from ui.tree |
| `value` | string | ✓ | Value to set into the field |

**Returns**: { filled, address }
**Errors**: NOT_EXPOSED, INVALID_PARAMS

```bash
sok ui.input.fill '{"address":"win/main/content/view/x/node/url-input","value":"/path/clip.mp4"}'
```

## `ui.measure`

Measure an exposed node — returns its viewport rect (px) and key computed style values. Use for pixel-alignment diagnostics. Accepts structural addresses from ui.tree only; CSS selectors are rejected. | DOM 측정 레이아웃 rect 크기 스타일

| Parameter | Type | Required | Description |
|---|---|---|---|
| `address` | string | ✓ | Exposed node address from ui.tree |

**Returns**: { address, rect:{x,y,w,h}, style }
**Errors**: NOT_EXPOSED, INVALID_PARAMS

```bash
sok ui.measure '{"address":"content/view/soksak-plugin-acp-studio.studio/node/send"}'
```

## `ui.slot`

Measure a content view's slot rectangle — the bare host container a view renders into (viewport px + devicePixelRatio). Use so an engine plugin learns its present-target rect (device px = css px * dpr) to align a native/offscreen surface, and so AI can verify placement. Address is a VIEW container (no /node): win/<label>/<region>/view/<pluginId.viewId>. Unexposed returns NOT_EXPOSED. | 슬롯 뷰컨테이너 rect present타깃 dpr 측정

| Parameter | Type | Required | Description |
|---|---|---|---|
| `address` | string | ✓ | View container address (win/<label>/<region>/view/<pluginId.viewId>, no node) |

**Returns**: { address, rect:{x,y,w,h}, dpr }
**Errors**: NOT_EXPOSED, INVALID_PARAMS

```bash
sok ui.slot '{"address":"win/main/content/view/soksak-plugin-browser-native.content"}'
```

## `ui.tree`

Return the exposed DOM address tree — absolute addresses of nodes declared via data-node by plugin views and host-chrome elements. Use to discover addressable targets before calling ui.measure or ui.input.click; unexposed elements are absent and unreachable. | DOM 트리 주소목록 노드목록 ui트리

**Returns**: { window, count, nodes: [{ address, nodePath }] }

```bash
sok ui.tree
```

## `ui.validate`

Validate the border ownership contract (docs/UI.md §B) against the live DOM. Compares computed border values on all four edges with the contract table and reports violations. Use as the single RED/GREEN gate for border rules. | 보더검증 테두리확인 ui검증 border contract

| Parameter | Type | Required | Description |
|---|---|---|---|
| `rule` | string |  | Rule id or selector substring filter (omit to check all rules) |

**Returns**: { pass, rulesActive, elementsChecked, violations: [{rule, selector, index, edge, expected, actual}] }

```bash
sok ui.validate
sok ui.validate '{"rule":"status"}'
```

## `view.activate`

Activate (switch to) a specific view tab. | 탭 전환 선택 뷰 활성화

| Parameter | Type | Required | Description |
|---|---|---|---|
| `view` | string | ✓ | Target view id (omit = caller's context view) |

**Returns**: {}
**Errors**: TARGET_NOT_FOUND

```bash
sok view.activate '{"view":"v3"}'
```

## `view.close`

Close a view tab — if it was the last view in a panel, the panel is also removed. Refuses to close the last view in a content area. | 탭 닫기 뷰

| Parameter | Type | Required | Description |
|---|---|---|---|
| `view` | string | ✓ | Target view id (omit = caller's context view) |

**Returns**: { activeGroupId, activeViewId }
**Errors**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok view.close '{"view":"v3"}'
```

## `view.label.get`

Get the custom tab label override for a sidebar view (empty = none, caller falls back to manifest title). Omit view to list all overrides. | 사이드바 탭 라벨 조회 뷰 제목

| Parameter | Type | Required | Description |
|---|---|---|---|
| `view` | string |  | viewKey; omit to list all overrides |

**Returns**: { labels } or { view, label }

```bash
sok view.label.get
sok view.label.get '{"view":"x.y"}'
```

## `view.label.set`

Set a custom tab label for a sidebar view (overrides the manifest title). Empty label clears the override (manifest fallback). viewKey = '<pluginId>.<viewId>' from ui.tree (tab/left/<key>). | 사이드바 탭 이름변경 라벨 뷰 제목 변경

| Parameter | Type | Required | Description |
|---|---|---|---|
| `label` | string | ✓ | Custom label; empty to clear |
| `view` | string | ✓ | viewKey '<pluginId>.<viewId>' |

**Returns**: { view, label }
**Errors**: INVALID_PARAMS

```bash
sok view.label.set '{"view":"soksak-plugin-folderpop.folders","label":"폴더팝"}'
```

## `view.list`

List the views (tabs) inside a panel.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `group` | string |  | Target panel (group) id (omit = caller's context panel) |

**Returns**: { groupId, activeViewId, views[] }
**Errors**: TARGET_NOT_FOUND

```bash
sok view.list
```

## `view.maximize`

Maximize a view to fill the entire content area. The split tree is preserved; only the display is toggled. Same as double-clicking a tab. Omit view to maximize the active view. | 최대화 전체화면 탭 크게 보기

| Parameter | Type | Required | Description |
|---|---|---|---|
| `view` | string |  | Target view id (omit = caller's context view) |

**Returns**: { viewId }
**Errors**: TARGET_NOT_FOUND

```bash
sok view.maximize '{"view":"v3"}'
sok view.maximize
```

## `view.move`

Move a view tab to the zone position of dst panel (center = move into panel; other = split and create new panel). | 탭 이동 뷰 다른 패널로

| Parameter | Type | Required | Description |
|---|---|---|---|
| `dst` | string | ✓ | Destination panel id |
| `view` | string | ✓ | Target view id (omit = caller's context view) |
| `zone` | string | ✓ | Drop zone (center = move/merge; others = split in that direction) (center|left|right|top|bottom) |

**Returns**: { groupId(moved or created panel) }
**Errors**: TARGET_NOT_FOUND, LAST_ITEM

```bash
sok view.move '{"view":"v3","dst":"g1","zone":"right"}'
```

## `view.open`

Open a new view tab in a panel by program id (terminal / claude / codex / a plugin view program). | 뷰 열기 탭 추가 claude 터미널

| Parameter | Type | Required | Description |
|---|---|---|---|
| `group` | string |  | Target panel (group) id (omit = caller's context panel) |
| `program` | string | ✓ | Program id — plugin-registered only (see program.list; no built-in default). Unregistered id falls back to terminal view |

**Returns**: { groupId, viewId, paneId? }
**Errors**: TARGET_NOT_FOUND

```bash
sok view.open '{"program":"claude"}'
```

## `view.restore`

Exit view maximize mode and restore the original split layout for the active content. | 최대화 해제 원래대로 레이아웃 복원

| Parameter | Type | Required | Description |
|---|---|---|---|
| `project` | string |  | Target project id (omit = caller's context project) |

**Returns**: { viewId(restored view | null = was not maximized) }

```bash
sok view.restore
```

## `webview.emitNative`

Emit a native mouse-bridge event (native-mousedown/move/up) at viewport x,y — drives divider drag/resize over a native child (browser) without a real mouse, for E2E. Pair with ui.input.drag (DOM path); this is the native path.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `kind` | string | ✓ | native-mousedown | native-mousemove | native-mouseup |
| `x` | number | ✓ | viewport x |
| `y` | number | ✓ | viewport y |

**Returns**: { ok, kind }

## `window.close`

Close a specific window. | 창 닫기 윈도우

| Parameter | Type | Required | Description |
|---|---|---|---|
| `label` | string |  | Window label |

**Returns**: { ok }

```bash
sok window.close '{"label":"win-1"}'
```

## `window.focus`

Bring a specific window to the front (focus it). | 창 포커스 활성화 앞으로

| Parameter | Type | Required | Description |
|---|---|---|---|
| `label` | string |  | Window label (see window.list) |

**Returns**: { ok }

```bash
sok window.focus '{"label":"win-1"}'
```

## `window.info`

Get window screen position, size, and scale factor (for automation validation — outerPosition is physical pixels).

**Returns**: { x, y, w, h, scale }

```bash
sok window.info
```

## `window.layers`

Dump the window's native view hierarchy (class / frame / hidden, indented text). Ground truth for layer diagnostics — verify a native child webview's actual bounds and z-order against the DOM slot (e.g. divider-drag freeze, hole-punch mismatch). | 네이티브 뷰 계층 레이어 덤프 child 위치 진단

**Returns**: { hierarchy } — indented text, one view per line

```bash
sok window.layers
```

## `window.list`

List open window labels. Use to discover targets for commands that accept a window argument. | 창 목록 윈도우 열린

**Returns**: { labels }

```bash
sok window.list
```

## `window.monitors`

Monitor and window placement facts (physical px): every monitor's rect/scale/name and every window's rect, focus state, and owning monitor index. Facts only — placement strategy is layout.suggest, execution is window.place (same coordinate space). | 모니터 목록 해상도 창 배치 현황 듀얼 파악

**Returns**: { monitors: [{index,name,x,y,w,h,scale}], windows: [{label,title,x,y,w,h,focused,monitor}] }

```bash
sok window.monitors
```

## `window.move`

Move the window to a screen position in physical pixels (for automation and multi-monitor validation).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `x` | number | ✓ | Physical x coordinate |
| `y` | number | ✓ | Physical y coordinate |

**Returns**: { x, y }

```bash
sok window.move '{"x":0,"y":0}'
```

## `window.new`

Open a new OS window (independent workspace). Without root it opens to the project picker. With root it boots straight into that project (P6: if the root is already open in some window, no window is created — that window is focused and returned as existingWindow). mode orchestrator opens the orchestrator window (activity feed + window/monitor map + command console; label orch-<n>, idempotent — an existing orchestrator window is focused and returned as existingWindow) and immediately places it via the spread strategy: a workspace-free monitor whole, or the right third beside the workspace on a single monitor. | 새 창 열기 윈도우 프로젝트 오케스트레이터

| Parameter | Type | Required | Description |
|---|---|---|---|
| `mode` | string |  | Window mode. orchestrator = the observation/control window (no workspace). Mutually exclusive with root. (orchestrator) |
| `root` | string |  | Project root to open in the new window (absolute path). Omit = picker. |

**Returns**: { label } | { existingWindow } (root already open — focused instead)
**Errors**: INVALID_PARAMS

```bash
sok window.new
sok window.new '{"root":"/Users/me/work"}'
sok window.new '{"mode":"orchestrator"}'
```

## `window.occlusion`

Toggle occlusion detection. When false, rendering continues even when fully covered by other apps (for continuous background capture — note battery cost). Not needed for normal use; snapshot/record disable it automatically during capture.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `enabled` | boolean | ✓ | Occlusion detection on (default) / off |

**Returns**: { occlusion }

```bash
sok window.occlusion '{"enabled":false}'
```

## `window.place`

Place a window at an exact frame (physical px — the window.monitors coordinate space). Position and size applied once. Use layout.suggest output directly. The OS may clamp frames into the usable area (e.g. below the macOS menu bar) — read back window.monitors for the settled frame. | 창 배치 이동 모니터로 옮기기 위치 지정

| Parameter | Type | Required | Description |
|---|---|---|---|
| `h` | number | ✓ | Height (physical px) |
| `label` | string | ✓ | Window label (window.list) |
| `w` | number | ✓ | Width (physical px) |
| `x` | number | ✓ | Left edge (physical px) |
| `y` | number | ✓ | Top edge (physical px) |

**Returns**: { ok }

```bash
sok window.place '{"label":"orch-1","x":2560,"y":0,"w":2560,"h":1440}'
```

## `window.record`

Capture the window as a sequence of PNGs (dir/f0000.png ...) for use as a video source. All frames are rendered even when occluded (occlusion detection disabled for the duration). Folder is created automatically. | 녹화 연속 캡처 프레임 저장 동영상 소스

| Parameter | Type | Required | Description |
|---|---|---|---|
| `dir` | string | ✓ | Output directory for frames |
| `frames` | number |  | Number of frames (default 40, max 600) |
| `intervalMs` | number |  | Interval between frames in ms (default 40) |

**Returns**: { dir, frames }

```bash
sok window.record '{"dir":"/tmp/rec"}'
sok window.record '{"dir":"/tmp/rec","frames":120,"intervalMs":33}'
```

## `window.reload`

Fully reload the app webview (location.reload). Picks up core/plugin code changes during development — including modules HMR misses (e.g. already-activated plugin API surfaces). Active plugins are re-activated automatically after reload (install and consent are persisted). | 앱 리로드 새로고침 플러그인 재시작 코드 반영

**Returns**: { reloaded: true }

```bash
sok window.reload
```

## `window.resize`

Resize the window to a physical pixel size (for automation and resize-path E2E — drives the native window resize, the same path as edge-drag, which panel.resize does not exercise).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `h` | number | ✓ | Physical height |
| `w` | number | ✓ | Physical width |

**Returns**: { w, h }

```bash
sok window.resize '{"w":1200,"h":800}'
```

## `window.snapshot`

Capture the window contents to a PNG. Captures even when fully occluded by other apps (occlusion detection is temporarily disabled during capture). Includes WebGL terminal. Parent folder is created automatically. Pass base64:true to get the PNG inline instead of a file; rect (CSS px, window coords — same space as ui.measure) crops to a region and implies base64. | 스크린샷 캡처 화면 저장 PNG 스냅샷 부분 영역

| Parameter | Type | Required | Description |
|---|---|---|---|
| `base64` | boolean |  | Return the PNG as base64 instead of writing a file |
| `path` | string |  | Output .png path (file mode). Omit to use a temp folder. |
| `rect` | json |  | Crop region {x,y,w,h} in CSS px, window coordinates (ui.measure space). Implies base64 mode. |

**Returns**: { saved } (file mode) | { pngBase64 } (base64/rect mode)
**Errors**: INVALID_PARAMS

```bash
sok window.snapshot
sok window.snapshot '{"path":"/tmp/shot.png"}'
sok window.snapshot '{"rect":{"x":100,"y":80,"w":400,"h":300},"base64":true}'
```

## `window.themeScan`

Measure whether a dark/light theme transition is atomic across screen regions. Records the toggle, then reports each region's transition frame and how many frames they are out of sync (a torn frame is chrome already switched while content has not). Idempotent — replaces ad-hoc capture scripts. Restores the original theme when done. | 테마 전환 검사 원자성 깜빡임 tear 측정 다크 라이트 토글 회귀

| Parameter | Type | Required | Description |
|---|---|---|---|
| `applyAtMs` | number |  | Delay after recording starts before toggling (default 250) |
| `frames` | number |  | Frames to capture (default 40) |
| `from` | string |  | Starting mode (default dark) (light|dark) |
| `intervalMs` | number |  | Frame interval in ms (default 16 ≈ one display frame) |
| `regions` | json |  | Named fractional rects {name:{x0,y0,x1,y1}} (0..1). Default samples chrome top bar, center content, and left sidebar. |
| `settleMs` | number |  | Settle wait after setting the start mode (default 800) |
| `skipCapture` | boolean |  | Measure latency only (applyJsMs, applyReflowMs) and skip frame capture — fast, robust even when the window is backgrounded. For A/B latency tuning. |
| `theme` | string |  | Theme name to scan (default: current theme) |
| `to` | string |  | Ending mode (default light) (light|dark) |

**Returns**: { frames, frameMs (measured capture interval), spreadFrames, spreadMs, atomic, regions:[{name,start,end,transitionFrame}] }

```bash
sok window.themeScan
sok window.themeScan '{"theme":"Midnight","frames":48}'
```

