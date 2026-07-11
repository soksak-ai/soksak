# soksak 플러그인 — 제작·설치 메뉴얼 (soksak-plugin-spec v1)

soksak 의 기능을 JS 플러그인으로 확장한다. 플러그인은 뷰(우측/좌측 사이드바·콘텐츠 탭)를
띄울 수도 있고, 뷰 없이 기능(포메터·에디터 확장·명령)만 제공할 수도 있다.
스펙의 단일진실은 코드다: [`src/plugins/spec.ts`](../src/plugins/spec.ts) (매니페스트·권한·원칙 §0),
[`src/plugins/api.ts`](../src/plugins/api.ts) (API 표면). 이 문서는 그 안내서다.

## 원칙 (스펙 §0 요약)

1. **단일진실 = Command Registry.** 플러그인이 등록한 명령은 즉시 `sok` CLI·MCP·문서에 자동 노출된다.
2. **전체신뢰 + 정직한 고지.** main.js 는 앱 메인 컨텍스트에서 그대로 실행된다. 샌드박스 없음.
   권한은 API 표면 게이트(미선언 권한의 API 는 `undefined`)이지 격리가 아니다.
   **신뢰할 수 있는 소스만 설치·활성화하라.**
3. **검증은 all-or-nothing.** 불량 매니페스트는 부분 수용 없이 사유와 함께 거부된다(관리 패널의 "검증 거부").
4. **플러그인 실패는 호스트를 죽이지 못한다.** activate/mount/포맷/이벤트 콜백 실패는 격리되고 상태로 표시된다.
5. **활성화 동의는 사람만 한다.** 원격(`sok`/MCP) `plugin.enable` 은 기록된 동의가 없으면
   `CONSENT_REQUIRED` 로 거부된다. 동의는 앱 UI(동의 모달)가 유일한 통로다.
6. **뷰 구현과 배치는 직교.** `registerView` 하나로 등록하고, 우측/좌측 사이드바·콘텐츠 탭이 같은 뷰를 소비한다.
7. **에디터 확장은 호스트의 CodeMirror 모듈만.** `@codemirror/*` 를 자체 번들하면 인스턴스
   이중화로 동작이 깨진다 — 반드시 `app.editor.modules` 를 사용한다.
8. **선언 ≡ 실제 (conformance).** 매니페스트 선언과 런타임 실제 배선은 양방향으로 일치해야 한다 —
   미선언을 코드에서 바인딩하면 거부, 선언했는데 배선이 없으면 감지된다. 외부 런타임 의존성
   (`libraries`)도 같은 법칙의 한 종류 — `observe`(실제 실행)가 그 "실제"를 관찰한다.

## 빠른 시작

플러그인 = git 레포(또는 디렉토리) 하나. 루트에 `plugin.json` + `main.js`.

```
my-plugin/
├── plugin.json   # 매니페스트(아래 레퍼런스)
├── main.js       # 단일 파일 ESM — import 문 사용 불가(번들 필요 시 esbuild 등으로 1파일로)
└── README.md
```

`plugin.json`:

```json
{
  "spec": "soksak-plugin-spec@1",
  "id": "my-plugin",
  "name": "내 플러그인",
  "version": "0.1.0",
  "description": "한 줄 설명",
  "permissions": ["ui"],
  "contributes": {
    "views": [{ "id": "panel", "title": "내 패널", "icon": "★" }]
  }
}
```

`main.js`:

```js
export default {
  activate(ctx) {
    ctx.app.ui.registerView("panel", {
      mount(el, { projectId, root }) {
        el.innerHTML = `<div style="padding:12px">안녕, ${root ?? "(루트 없음)"}</div>`;
      },
    });
  },
  deactivate() {},
};
```

**TS+번들**로 짜면 `npm i -D @soksak-ai/plugin-api` 로 `ctx.app`·`Plugin`·`PluginContext` 타입을
받는다(선택, 타입 전용 — 런타임 0). 코어가 `SoksakPluginApi ≡ 패키지` 양방향
호환을 컴파일로 강제하므로 타입이 코어와 어긋나지 않는다. JS `main.js` 한 파일이면 불필요.

개발 중 적재(설치 없이):

```bash
sok plugin.dev.load '{"path":"/abs/path/my-plugin"}'
# 앱 우측 사이드바(⌥⌘B) → ⚙ 관리 → 활성화(권한 동의)
# 코드 수정 후: sok plugin.reload
```

## 설치·배포

설치 위치는 `~/.soksak/plugins/<id>/` (테마와 같은 외부 파일 모델).

```bash
sok plugin.install '{"source":"user/repo"}'              # GitHub 단축형
sok plugin.install '{"source":"https://…/repo.git"}'     # 임의 git URL
sok plugin.install '{"source":"/abs/local/repo"}'        # 로컬 레포
sok plugin.install '{"source":"user/repo","ref":"v1.2.0"}'  # 태그/브랜치/커밋 핀
sok plugin.update  '{"id":"my-plugin"}'                  # git pull --ff-only
sok plugin.remove  '{"id":"my-plugin"}'                  # 전용 저장소 데이터는 보존
sok plugin.list
sok plugin.reload
```

규칙:

- 매니페스트 `id` 는 **설치 디렉토리명과 일치**해야 한다(불일치 = 거부).
- `entry`(기본 `main.js`)는 디렉토리 내부 상대경로만, `.js`/`.mjs` 단일 ESM 번들.
  blob import 방식이라 **상대/bare import 는 해석되지 않는다** — 외부 라이브러리는 번들에 포함하라.
- ref 핀으로 설치한 플러그인의 `plugin.update`(ff-only pull)는 detached HEAD 에서 실패한다
  — v1 정책: 핀 설치는 갱신 대신 재설치.
- 활성화에는 사람의 동의가 필요하다. **버전 또는 권한이 바뀌면 재동의**를 요구한다.

### 매니페스트 검증 — 단일진실 + 코어 경계 강제

매니페스트 검증의 **유일 권위는 `@soksak-ai/plugin-spec`**(= 코어 `parseManifest`)다. 자체 스키마
재구현·우회는 금지. **강제는 코어가 소유한 경계에서만** — 플러그인의 git·npm·빌드 환경과 무관하다.
폴더로만 배포하든, git 을 안 쓰든, main.js 한 파일이든, 매니페스트가 이 검증을 통과해야 존재한다:

1. **런타임**(설치/로드) — 코어가 `parseManifest` 로 검증. 미통과 매니페스트는 설치·활성화 거부.
   우회 불가 — 이게 절대 게이트다.
2. **등재**(레지스트리) — 카탈로그 집계가 `parseManifest` 통과만 등재한다. 우회 불가.

저자는 발행 전에 같은 검증을 손수 돌릴 수 있다(선택, 배선 0):

```bash
npx soksak-validate plugin.json   # exit 0 = 통과, 1 = 거부(사유 출력), 2 = 사용법 오류
```

`@soksak-ai/plugin-spec` 패키지가 코어와 **같은** `parseManifest` 를 싣는다(사본/vendoring 금지).
한 줄이면 끝 — 그걸 git hook 에 넣을지 CI 에 넣을지는 *저자의 선택*이지 코어가 git·npm·빌드를
강요하지 않는다. 런타임 conformance(선언 ≡ 실제 배선)는 앱이 필요하므로 `sok plugin.conformance` 로 확인한다.

## 매니페스트 레퍼런스

| 필드 | 필수 | 설명 |
|---|---|---|
| `spec` | ✓ | `"soksak-plugin-spec@1"` 고정 |
| `id` | ✓ | `^[a-z0-9][a-z0-9-]*$` + 설치 디렉토리명과 일치 |
| `name` / `description` | ✓ | 표시명 / 기능을 적은 한 줄 설명 — 문자열 또는 언어 맵 `{"ko": …, "en": …}`(§3.5, 현재 언어 resolve·첫 값 폴백) |
| `version` | ✓ | semver(`major.minor.patch`) |
| `author` | | 표시용 |
| `entry` | | 기본 `main.js`. 내부 상대경로만(`..` 금지) |
| `minAppVersion` | | 요구 앱 최소 버전(미달 시 거부) |
| `permissions` | ✓ | 아래 권한 표. 빈 배열도 명시 필수 |
| `contributes.views[]` | | `{id, title, icon, placements?, defaultPlacement?, status?}` — `"ui"` 권한 필요. `status` = 이 뷰가 `setStatus` 로 보고하는 상태 코드 목록(C2 status 축 선언). **콘텐츠 배치 뷰는 선언 의무 — 무상태면 `[]` 를 명시**(부재는 C2 `content-view-status` 판정 위반) |
| `contributes.commands[]` | | `{name, title}` — `"commands"` 권한 필요. 등록명은 `plugin.<id>.<name>` |
| `contributes.formatters[]` | | `{id, title, languages[]}` — `"editor"` 권한 필요. languages = 확장자(점 없이) |
| `contributes.languages[]` | | `{ext, lang}` — `"editor"` 권한 필요. **선언만으로 자동 적용**(코드 불필요) |
| `contributes.programs[]` | | `{id, title, path?, kind, command?, url?, ensure?}` — `"programs"` 권한 필요. id 는 전역 평탄, path 는 "/" 구분 메뉴 카테고리(다단) |
| `contributes.nodes[]` | | `{id, description?, danger?}` — `"ui"` 권한 필요. **DOM 노출 노드 종류** 선언(외부 주소 클릭/측정). 실제 요소엔 `data-node="<id>"`(동적 목록은 `<id>/<안정키>`). 선언하면 동의 화면에 표기, `danger:true` 는 ⚠ 강조 |
| `libraries[]` | | 외부 CLI 종속성 — **top-level**(`contributes` 밖). 4-tuple `{name, bin, install, observe?, accept?, reach?}`. 권한 불요(설치는 활성화 동의가 게이트). → 아래 「외부 런타임 의존성」 |
| `dependencies` | | 플러그인↔플러그인 의존 — **top-level**. `{pluginId: semver}`. 전이 동반 설치(동의 게이트)·삭제 cascade. `libraries`(외부 CLI)와는 별개 축 |

기여 `title`/프로그램 `path` 도 전부 문자열 또는 언어 맵(§3.5). 뷰 내부 텍스트의
다국어는 플러그인 소유 — `app.locale()`(권한 불요)로 현재 언어를 읽고
`locale.changed` 이벤트로 변경을 구독한다.

알 수 없는 키/권한/배치는 전부 거부된다(오타 조기 발견). `contributes` 에 선언하지 않은
명령/뷰/포매터를 코드에서 바인딩하면 activate 시 예외가 난다 — **매니페스트가 선언의 단일진실**.

**선언 ≡ 실제 (양방향).** 코어는 선언과 런타임 실제 배선이 맞물리는지 양방향으로 본다:
미선언을 바인딩하면 거부(undeclared), 선언했는데 등록/배선이 없으면 감지한다(activate 후
inventory + `nodeScan` 의 `data-node` diff). `sok plugin.conformance` 가 register-gated 기여
(commands·views·fileViewers·iconSets)와 nodes 의 declared vs actual diff 를 돌려준다 — actual 은
각 registry 의 이 플러그인 등록분에서 관찰한다(앱 필요 — 런타임 게이트).

### 외부 런타임 의존성 (`libraries` — 4-tuple)

플러그인이 `process` 로 실행하는 외부 CLI(예: `gemini`, `yt-dlp`)를 선언한다. 코어가
**관찰 → 결정 → 공급**(reconcile)으로 목표 상태에 수렴시킨다 — "존재"가 아니라 *작동*을 기준으로.

| 슬롯 | 키 | 의미 |
|---|---|---|
| identity | `name` · `bin` | 패키지/도구 식별 + 실행 bin |
| observe | `observe.probe[]` · `observe.versionRe?` | 작동 관찰: probe argv 를 실제 실행(exit 0 = 작동), stdout 에서 버전 추출 |
| accept | `accept.minVersion?` | 수용 술어: 최소 SemVer(미선언이면 작동만으로 수용) |
| reach | `reach` 또는 `install` | 공급: `vendor`(번들+sha256) / `fetch`(다운로드+플랫폼별 sha256) / `command`(설치 명령). 미선언이면 `install` 폴백 |

```json
"libraries": [{
  "name": "@google/gemini-cli",
  "bin": "gemini",
  "install": { "darwin": "npm i -g @google/gemini-cli", "linux": "npm i -g @google/gemini-cli" },
  "observe": { "probe": ["gemini", "--version"], "versionRe": "(\\d+\\.\\d+\\.\\d+)" },
  "accept": { "minVersion": "0.1.0" },
  "reach": { "fetch": {
    "url":    { "darwin": "https://example.com/gemini-darwin" },
    "sha256": { "darwin": "abc123…" }
  } }
}]
```

코어는 관찰을 5상태로 분류한다: `ABSENT`(없음)·`PARTIAL`(설치 흔적 있으나 bin 미연결 —
EEXIST 류)·`BROKEN`(dangling 심링크/probe 실패)·`VERSION_MISMATCH`(minVersion 미달)·
`HEALTHY`. **`HEALTHY` 만 수용**하고 그 외는 공급(reach)한다 — `PARTIAL`/`BROKEN` 은 stale 을
정리한 뒤 공급(EEXIST 근본 복구). 멱등이다(이미 `HEALTHY` 면 무동작). 실패는 콘솔로만 보고하고
활성화를 막지 않는다(§0-4 비차단).

- `observe` 를 선언하면 존재가 아니라 probe(실제 실행)로 작동을 본다 — 미선언이면 존재를 작동으로 근사한다.
- `accept.minVersion` 을 쓰려면 `observe.versionRe` 가 버전을 뽑아야 한다(없으면 버전 비교를 건너뛴다).
- `vendor`/`fetch` 는 sha256 무결성 핀이 필수 — 불일치 시 대상 파일을 쓰지 않고 실패한다(공급 거부).

### 사이드카 (`sidecars` — engine 모듈 의존)

플러그인이 열 공유 네이티브 엔진 모듈(사이드카 dylib — 예: 번들 Chromium 브라우저 엔진)을
선언한다. 분류·ABI·수명주기 정본은 docs/SIDECARS.md — 여기는 저작자 요약.

```json
"permissions": ["sidecar"],
"sidecars": [
  { "name": "chromium", "interface": "soksak-sidecar-browser-spec@1",
    "reach": { "fetch": { "url": { "darwin": "https://…/dist.tar.gz" },
                           "sha256": { "darwin": "<hex>" } } } }
]
```

- `"sidecar"` 권한(주의 등급) 필수 — 네이티브 코드를 앱 프로세스에 로드한다(동의 화면에
  선언된 사이드카 이름·interface 가 함께 표기된다).
- `app.sidecar.open(name)` 은 **선언된 이름만** 연다(미선언 = throw). 로드 시 코어가 선언
  `interface` 를 바이너리 자기보고(`soksak_sidecar_engine_abi`)와 대조한다 — 불일치는 거부(선언≡실물).
- 채널은 불투명 JSON(`handle.send(msg)` / `handle.on(event, cb)`) — 메시지 의미는 플러그인↔
  사이드카 사적 계약이고 코어는 relay 만 한다. 모듈은 로드 후 상주(`close()`는 채널만 해제).
- `reach` 는 fetch 전용(sha256 핀 아카이브 자동 설치, 실패 시 무기록). 미선언이면 dev
  스테이징(`make sidecar-<name>`) 전제.

```ts
const engine = await app.sidecar!.open("chromium");
const { id } = await engine.send({ type: "create", x, y, w, h, url });
engine.on("popup-url", (p) => openInNewTab(String(p.url)));
```

### 권한

| 권한 | 부여 표면 | 주의 |
|---|---|---|
| `ui` | `app.ui` — 뷰 등록/열기 | |
| `programs` | (표면 없음 — 선언만으로 자동 등록) 새 탭(+) 메뉴 프로그램 | ⚠ 선택 시 터미널 명령 자동 실행(설치 명령 포함) |
| `commands` | `app.commands` — 명령 실행(danger 없는 것)+자기 명령 등록 | |
| `commands:destructive` | danger=destructive 명령 실행(닫기·제거) | ⚠ |
| `commands:inject` | danger=inject 명령 실행(term.send/exec, browser.eval…) | ⚠ |
| `editor` | `app.editor` — CM6 확장·언어·포매터·버퍼 읽기/쓰기 | |
| `storage` | `app.storage` — `~/.soksak/plugins-data/<id>/` 전용 저장소 | |
| `fs:read` / `fs:write` | `app.fs.readText·readBinary·url·list` / `app.fs.writeText` — 임의 경로 | ⚠ |
| `terminal` | `app.terminal.runningCommands` — 실행 중 명령 관찰(명령라인·cwd 스냅샷) | ⚠ |
| `terminal:read` | `app.terminal.readBuffer·onOutput` — 화면 버퍼 내용 읽기·갱신 구독(전 화면 텍스트 — 명령 관찰보다 강함) | ⚠ |
| `terminal:write` | `app.terminal.sendText` — PTY 키 주입(실행 중 프로그램에 타이핑) | ⚠ |
| `git:read` | `app.git` — log/show/diff/status(읽기 전용) | |
| `network` | (표면 없음) fetch 사용 **고지** — 기술적 강제 불가 | ⚠ |
| `sidecar` | `app.sidecar` — 선언된 엔진 모듈(dylib)을 앱 프로세스에 로드+불투명 채널 | ⚠ 네이티브 코드 실행(sidecars[] 선언 필수) |

영역/능력별로 권한이 분리된다 — UI: `ui`(콘텐츠)·`ui:statusbar`·`ui:overlay:pane`(패널 덮기)·
`ui:overlay:screen`(앱 전체). 터미널: `terminal`(관찰)·`terminal:read`(화면 내용)·`terminal:write`(입력).

플러그인은 `plugin.*` 관리 명령(install/enable/…)을 호출할 수 없다(자기증식 금지, §0-5).
`plugin.view.open/close` 와 자기·타 플러그인 명령(`plugin.<id>.*`)은 허용.

## API 레퍼런스 (`activate(ctx)`)

```ts
ctx = {
  app: SoksakPluginApi,
  manifest,             // 검증된 매니페스트
  dir,                  // 설치 디렉토리 절대경로
  subscriptions: [],    // Disposable 을 push 하면 비활성화 시 자동 dispose
}
```

`app.ui.registerView` / `app.commands.register` / `app.editor.register*` 가 돌려주는
Disposable 은 **자동 수거**된다(비활성화 시) — 직접 만든 리소스만 `ctx.subscriptions` 에 넣으면 된다.

### app.commands (`"commands"`)

```js
await app.commands.execute("explorer.list", { path: root });  // 기존 앱 명령(63종+)
const d = app.commands.register("hello", {                    // contributes.commands 선언 필수
  description: "인사",
  params: { name: { type: "string", description: "이름" } },
  handler: ({ name }) => ({ msg: `안녕 ${name}` }),
});
// → sok plugin.my-plugin.hello '{"name":"soksak"}' / MCP tool 로 즉시 노출
```

### app.events (권한 불필요)

`project.changed` · `view.activated` · `file.opened` · `file.closed` · `file.saved`
· `theme.changed` · `bookmarks.changed` · `command.finished`

```js
ctx.subscriptions.push(app.events.on("file.saved", ({ path }) => { … }));

// command.finished: 터미널 명령 종료(OSC 133/633 셸 통합 탐지 — 폴링 없음).
// git 뷰 등의 자동 갱신 트리거. payload = { projectId: string | null, paneId }.
// 핸들러는 메인스레드 동기 실행 — 무거운 갱신은 debounce/defer 할 것.
ctx.subscriptions.push(
  app.events.on("command.finished", ({ projectId }) => { /* 갱신 예약 */ }),
);
```

### 프로그램 기여 (`"programs"`) — 완전 선언형, 코드 불필요

새 탭(+) 메뉴에는 **내장 항목이 없다(§2.6)** — 터미널·에이전트·브라우저 전부
플러그인이 기여한다. 코어가 소유하는 것은 뷰 능력(terminal/browser kind)뿐.
프로그램은 languages 처럼 **매니페스트 선언만으로 자동 등록**된다(명령형 API
없음) — 실행/설치 명령이 전부 선언에 있어 **동의 화면이 플러그인의 역할
(코어 연결만 / 명령 실행 / 미설치 시 설치)을 명령 원문 그대로 고지**한다.

```jsonc
"contributes": {
  "programs": [{
    "id": "claude",            // 전역 프로그램 id(평탄) — 충돌 시 활성화 에러
    "title": "Claude",         // 메뉴 표시명
    "path": "에이전트",         // "/" 구분 다단 카테고리(플러그인 간 병합). 생략=최상위
    "kind": "terminal",        // "terminal" | "browser"
    "command": "claude",       // kind=terminal: 자동 실행 셸 명령(생략=맨 터미널)
    // "url": "https://…",     // kind=browser: 시작 URL(생략=설정 homeUrl)
    "ensure": {                // kind=terminal 한정: 활성화 시점 선행 바이너리 보장
      "bin": "claude",         // 사용자 셸 PATH 에서 확인할 실행 파일명(shell_which)
      "install": {             // 활성화 시 미설치면 새 터미널 탭에서 가시 실행되는 공식 설치 명령
        "darwin": "curl -fsSL https://claude.ai/install.sh | bash",
        "linux": "curl -fsSL https://claude.ai/install.sh | bash",
        "win32": "irm https://claude.ai/install.ps1 | iex"
      }
    }
  }]
}
```

- 등록 즉시 + 메뉴·`program.list`·`view.open '{"program":"<id>"}'` 에 노출(§0-1).
- 미등록 id 를 명령/설정이 참조하면 터미널 뷰 폴백(능력명 "browser" 는 그 능력).
- 등록 프로그램이 0개면 + 버튼 자체가 렌더되지 않는다.

### app.ui (`"ui"`)

```js
app.ui.registerView("panel", {
  mount(el, { projectId, root }) { /* el 에 직접 렌더(React 불요) */ },
  unmount(el) { /* 선택 — 미구현이면 호스트가 DOM 정리 */ },
});
await app.ui.openView("panel", "content");   // 배치: sidebar-right(기본)/sidebar-left/content
```

뷰는 배치와 직교다. 매니페스트 `placements` 에 선언한 곳 어디든 열 수 있다:
우측 사이드바(아이콘 레일), 좌측 사이드바(파일 트리 옆 탭), 콘텐츠 영역(에디터 그룹 탭 —
드래그/분할/닫기 동작 동일). 테마 적용을 위해 CSS 변수(`var(--fg)`, `var(--bd)`,
`var(--inset)`, `var(--acc)` …)로 스타일하라.

#### 아이콘 셋 등록 (`contributes.iconSets` + `app.ui.registerIconSet`)

앱 크롬 아이콘 셋을 플러그인으로 제공할 수 있다(설정 → 아이콘 셋에 나타남).
매니페스트에 선언하지 않은 셋 id 는 등록이 거부된다.

```json
{ "permissions": ["ui"], "contributes": { "iconSets": [{ "id": "tabler", "title": "Tabler Icons" }] } }
```

```js
// data: 시맨틱 이름 전수(close/add/refresh/… — 누락 시 등록 거부) →
//       { v: viewBox, b: SVG 내부 마크업, f: "stroke"|"fill"|"both" }
ctx.subscriptions.push(ctx.app.ui.registerIconSet("tabler", data));
```

시맨틱 이름 목록과 추출 도구는 호스트 레포 `scripts/icons/extract.mjs` 참조
(예제: `soksak-icons-tabler`, `soksak-icons-codicons` — main.js 가 생성물).
전역 셋 id 는 `<pluginId>.<setId>`, 플러그인 비활성화 시 자동 해제되고 선택돼
있던 경우 내장 lucide 로 폴백된다.

### app.editor (`"editor"`)

```js
const { view, state, language } = app.editor.modules;  // 호스트 @codemirror/* (§0-7 — 자체 번들 금지)
app.editor.registerExtension({ extension, languages: ["json"] }); // languages 생략 = 전역
app.editor.registerFormatter({                          // contributes.formatters 의 id 에 바인딩
  id: "json",
  format(text, { path, ext }) { return JSON.stringify(JSON.parse(text), null, 2) + "\n"; },
});
app.editor.getActiveFile();           // { viewId, path, text } | null
app.editor.setFileText(viewId, text); // 통째 치환 — undo 1회로 원복
```

- 언어 매핑(`contributes.languages`)은 선언만으로 활성화 시 자동 적용된다.
- 포매터는 `⇧⌥F` 또는 `sok editor.format` 으로 실행된다. 실패 시(예: JSON 파싱 실패)
  **원본을 보존한 채** 명확한 에러를 던져라 — 깨진 텍스트 반환 금지.
- 확장 등록/해제는 열린 모든 에디터에 즉시 반영된다(재시작 불필요).
- 20MiB/30만 줄 초과 큰 파일에는 보호를 위해 플러그인 확장이 적용되지 않는다(언어 확장과 동일 기준).

### app.storage (`"storage"`)

```js
await app.storage.write("notes", { text: "…" });  // ~/.soksak/plugins-data/<id>/notes.json
await app.storage.read("notes");                  // 없으면 null
await app.storage.list();
```

key 는 `^[A-Za-z0-9._-]+$`. 플러그인 제거 후에도 데이터는 보존된다(재설치 시 복원).

### app.fs / app.git / app.project

```js
await app.fs.readText(path);            // fs:read — { text, truncated }
await app.fs.url(localPath);            // fs:read — 로컬 파일 → webview 로드 URL(영상·이미지). 같은 path 멱등
await app.fs.writeText(path, content);  // fs:write
await app.git.log({ limit: 50, skip: 0 });   // git:read — path 기본값: 현재 프로젝트 루트
await app.git.show(hash);               // { meta, files[{status,path}], patch }
await app.git.diff({ file, staged });   // unified diff 원문
app.project.current();                  // { id, root } | null
```

### app.terminal (`"terminal"` / `"terminal:read"` / `"terminal:write"`)

능력별로 권한이 분리된다 — 선언한 권한의 메서드만 노출(미선언은 `undefined`).

```js
// "terminal" — 실행 중 명령 관찰(command.started/finished 이벤트의 현재-상태 스냅샷)
app.terminal.runningCommands();          // [{ paneId, commandLine, cwd }]

// "terminal:read" — 화면 버퍼 내용(전 화면 텍스트)·갱신 구독(폴링 없음, 프레임당 1회 코얼레스)
app.terminal.readBuffer(paneId, lines);  // string | undefined (끝에서 lines 줄, 생략=전체)
const d = app.terminal.onOutput(paneId, () => { … });  // Disposable — 화면 갱신 시 호출

// "terminal:write" — PTY 에 raw 입력 주입(실행 중 프로그램에 타이핑). 엔터는 "\r"
app.terminal.sendText(paneId, "안녕\r"); // boolean(준비 전 false)
```

readBuffer 는 alternate screen(=TUI 화면)만 본다 — 셸 스크롤백·다른 pane 과 안 섞인다.
`soksak-claude-gui` 가 이 셋으로 claude TUI 의 입력 readiness 를 판별해 입력을 큐잉한다.

## 명령으로 모든 것 (CLI/MCP)

플러그인 관리·뷰 배치는 전부 registry 명령이다 — `sok`/MCP 에서 동일하게:

```bash
sok plugin.list / install / update / remove / enable / disable / reload / dev.load
sok plugin.view.open '{"view":"soksak-git-diff.view","placement":"content"}'
sok plugin.view.close '{"view":"soksak-git-diff.view"}'
sok git.log / git.show / git.diff
sok editor.format
```

전체 명령 레퍼런스: [`docs/COMMANDS.md`](./COMMANDS.md) (`make docs` 로 재생성).

## 플러그인 = 독립 repo · 코어 = 플랫폼

코어는 플러그인을 모른다. 각 플러그인은 독립 git repo 가 단일 진실이고, 코어는 레지스트리
카탈로그 하나만 fetch 해 설치 목록을 만든다(스펙 §0 P1~P5).

- **소스·발행**: 각 플러그인 repo 안에서 끝낸다 — 소스·매니페스트·테스트·태그·push 전부 자기 repo.
- **카탈로그**: `soksak-plugin-registry` repo 의 `registry.json` 이 설치 가능 목록의 단일 진실이다.
  그 repo 의 `update.sh` 가 org 의 각 `plugin.json` 을 집계한다(template 제외). 코어의
  `make registry` 는 이 카탈로그를 fetch 해 `src/plugins/registrySnapshot.json`(오프라인 폴백)으로 캐시한다.
- **단일 폴더**: dev·installed·local 이 `~/.soksak/plugins/<id>/` 한 곳에 공존한다. 각 폴더가
  `.soksak.json`(머신-로컬, 플러그인 repo 는 `.gitignore`)로 자기 상태를 기술한다 —
  `{version, repo, branch}`. `version` 3모드: `"local"`(그냥 돌아감·레지스트리 미등록·repo 없음),
  `"dev"`(작업 중·동의 면제), `"<semver>"`(레지스트리 설치본).
- **설치**: 카탈로그 엔트리의 `repo` → `~/.soksak/plugins/<id>` 로 clone, `.soksak.json`(version=semver)
  기록, 읽기전용 잠금. `plugin.update` 는 fetch + reset --hard 후 version 갱신.
- **dev**: `sok plugin.dev.new <id>` 가 단일 폴더에 스캐폴드(plugin.json·main.js·`.soksak.json`(version="dev")·git init)
  한다. 소스 편집은 앱 리로드에 즉시 반영. `dev`·`local` 은 `plugin.update` 가 거부한다(작업물 보호).
  폴더 밖 외부 폴더의 일회 테스트는 `plugin.dev.load`(명시적 명령)로 한다 — 지정 폴더가 유일한
  상시 메커니즘이고, env 주입은 없다(보이지 않는 상태 금지).

## 트러블슈팅

- **`import` 문이 안 먹는다** — 설계다. blob import 는 상대/bare import 를 해석할 수 없다.
  esbuild 등으로 단일 파일로 번들하라: `esbuild src/main.ts --bundle --format=esm --outfile=main.js`
  (`@codemirror/*` 는 external 로 두지 말고 **아예 쓰지 말 것** — `app.editor.modules` 사용).
- **에디터 확장이 무시되거나 예외가 난다** — `@codemirror/*` 를 자체 번들했을 가능성(인스턴스
  이중화). `app.editor.modules` 로 바꿔라.
- **`CONSENT_REQUIRED`** — 원격(`sok`)에선 동의를 부여할 수 없다. 앱 UI(⌥⌘B → ⚙)에서 활성화.
- **검증 거부(rejected)** — 관리 패널과 `sok plugin.list` 에 거부 사유 전문이 나온다.
  매니페스트의 알 수 없는 키/권한, 선언-권한 불일치가 대부분.
- **`plugin.update` 실패** — ff-only 정책. 로컬 수정이 있거나 ref 핀 설치면 재설치하라.
- **뷰가 "플러그인 뷰 없음"** — 플러그인이 비활성/제거됨. 활성화하면 즉시 복구된다.
