// 플러그인 스펙 — soksak-plugin-spec v1.
//
// ── §0 불변 원칙 ─────────────────────────────────────────────────────────────
// 1. 단일진실 = Command Registry. 플러그인 명령은 기존 registry 에 등록되고 그 즉시
//    sok CLI/MCP/문서에 자동 노출된다. 플러그인 전용 호출 경로를 만들지 않는다.
// 2. 전체신뢰 + 정직한 고지. main.js 는 메인 윈도우 컨텍스트에서 그대로 실행된다.
//    샌드박스는 없다. 권한은 API 표면 게이트(미선언 권한의 API 는 제공되지 않음)이지
//    격리가 아니다. 이 사실을 사용자 동의 화면에 그대로 알린다.
// 3. 검증은 all-or-nothing. 불량 매니페스트는 부분 수용 없이 사유와 함께 거부된다
//    (테마 모델과 동일). 침묵 실패 금지 — 거부는 rejected 목록으로 노출된다.
// 4. 플러그인 실패는 호스트를 죽이지 못한다. activate/mount/format/이벤트 콜백은
//    전부 try/catch 경계 안에서 실행되고, 실패는 status:"error" + 사유로 표시된다.
// 5. 활성화 동의는 사람만 한다. 원격(sok/MCP)의 plugin.enable 은 기록된 동의가
//    없으면 CONSENT_REQUIRED 로 거부된다. 플러그인 API 에서는 plugin.* 관리 명령
//    호출 자체가 차단된다(자기증식 금지). 유일한 예외 = dev 소스: 개발자가 로컬에서
//    직접 지정한 자기 작업물은 동의 게이트 밖이다(제3자 위험 고지 대상이 아님). dev 판정은
//    두 경로 모두 로컬 사용자 행위다 — (a) ~/.soksak/plugins/<id>/.soksak.json 의
//    version="dev" 마커(단일 폴더 모델: 폴더가 자기 상태 기술), (b) plugin.dev.load 로
//    폴더 밖 경로 적재(danger:"inject"). 어느 쪽도 원격이 만들 수 없으므로 게이트는 로컬에 있다.
// 6. 뷰 구현과 배치는 직교한다. 뷰 등록 API 는 registerView 하나이고, 우측/좌측
//    사이드바·콘텐츠 영역 배치는 동일한 provider 를 소비한다.
// 7. 콘텐츠 렌더 엔진은 코어가 소유하지 않는다(엔진 중립 A13). 에디터(CodeMirror/Monaco)·
//    터미널(xterm)·브라우저(webview)는 교체 가능한 플러그인 선택이다. 코어는 raw 원시
//    (파일 IO·PTY·webview 호스팅·content slot)만 노출하고, 엔진-특정 capability 는 두지 않는다.
// 8. 기준 불변. 테스트/검증 기준 미달이면 코드를 고친다. 기준 자체가 잘못이면
//    기준을 낮추는 대신 열린 질문으로 기록해 정정한다.
//
// ── 배포 모델 — 코어·플러그인·레지스트리 분리 (P1~P5, 불변) ───────────────────
// 플러그인 = 독립 git repo 하나. 루트에 plugin.json + 단일 번들 entry(기본 main.js).
// entry 는 ESM 단일 파일이어야 한다(Blob import 는 상대 import 를 해석 못 함 — 외부
// 라이브러리는 저자가 번들에 포함). 설치는 ~/.soksak/plugins/<id>/ 로 clone — 테마
// (~/.soksak/themes)와 동일한 외부 파일 모델이다.
//
// P1. 코어는 플러그인을 모른다. 코어 repo 는 플러그인 소스·디렉토리 목록·발행 도구를
//     보유하지 않는다. 코어가 아는 단 하나는 레지스트리 카탈로그 URL 이다.
// P2. 레지스트리 카탈로그가 단일 진실. 설치 가능 목록은 별도 repo 의 registry.json
//     하나다(soksak-registry spec). 코어는 그것을 fetch 해 소비할 뿐, 생산하지 않는다.
// P3. 플러그인은 독립 repo 가 단일 진실. 소스·매니페스트·테스트·발행이 전부 자기 repo
//     안에서 끝난다. 코어 repo 하위에 플러그인 소스를 두지 않는다.
// P4. 설치는 git clone. 카탈로그 엔트리의 repo → ~/.soksak/plugins/<id> 로 clone 한다.
// P5. 코어 검증은 카탈로그 무결성과 매니페스트 파서뿐. 개별 플러그인의 스펙 준수는 각
//     repo 가 보증한다 — 코어는 플러그인을 나열·검사하지 않는다.

// ── §1 권한 ──────────────────────────────────────────────────────────────────

export type PluginPermission =
  // [RULE] UI 영역 권한 분리 — 플러그인이 건드리는 UI 영역은 명확히 구분되며 각각 별도
  // 권한으로 선언한다(타이틀바·상태바·콘텐츠·전체화면은 서로 다른 영역). 사용자가 어느
  // 영역에 영향받는지 동의 화면에서 정확히 알도록 — 영역이 다르면 권한도 다르다.
  | "ui" // 콘텐츠/사이드바 뷰 등록(호스트가 배치 소유 — 안전) + 아이콘 셋
  | "ui:statusbar" // 상태바에 항목 추가(크롬 영역)
  | "ui:titlebar" // 타이틀바 우측 컨트롤 그룹에 토글 아이콘 추가(크롬 영역)
  // 오버레이 패밀리 — 둘 다 본문 위에 그리지만 스코프가 다르므로 변종으로 분리한다.
  | "ui:overlay:pane" // 콘텐츠 패널 하나를 덮는 오버레이(그 패널 본문만 가림 — 패널 위 GUI)
  | "ui:overlay:screen" // 앱 전체를 덮는 레이어(크롬·전 패널 위 — 마스코트 효과 등 가장 침습적)
  | "programs" // + 메뉴 프로그램 등록(선택 시 터미널 명령 자동 실행 포함)
  | "commands" // registry 명령 실행(danger 없는 것) + 자기 명령 등록
  | "commands:destructive" // danger:"destructive" 명령 실행(닫기·제거)
  | "commands:inject" // danger:"inject" 명령 실행(term.send/exec, browser.eval …)
  | "process" // 외부 서브프로세스 spawn + 양방향 raw stdio(범용 — LSP/MCP/ACP/임의 CLI 통합)
  | "webview" // 코어가 임베드한 child webview(WKWebView) 구동 — 브라우저류 콘텐츠 뷰(네이티브 페이지 로드·eval·inject)
  | "pty" // PTY 백드 터미널 세션 spawn+IO(flow control+셸 env 주입 — process 의 raw stdio 와 구분)
  | "sidecar" // 공유 네이티브 엔진 모듈(dylib)을 앱 프로세스에 로드 + 불투명 채널(sidecars[] 선언 필수 — docs/SIDECARS.md)
  | "storage" // 전용 저장소(~/.soksak/plugins-data/<id>/)
  | "data" // 범용 임베디드 DB(app.data — 네임스페이스 격리·CJK 검색·전 창 watch)
  | "secrets" // 암호화 볼트(app.secrets — API 키/토큰 봉인 저장, 평문 readback 불가·주입 전용)
  | "notify" // OS 알림(푸시)+인앱 배너·소리·딥링크(알림 = 푸시 동급 1급 객체)
  | "schedule" // 범용 스케줄러(app.scheduler — at/every/cron/reconcile 트리거로 명령 자동 발화·영속)
  | "fs:read" // 임의 경로 파일 읽기
  | "fs:write" // 임의 경로 파일 쓰기
  | "clipboard:read" // 시스템 클립보드 텍스트 읽기 + 변경 구독(감시는 읽기의 일부)
  | "clipboard:write" // 시스템 클립보드에 텍스트 쓰기(다른 앱이 붙여넣게 됨)
  | "terminal" // 터미널 명령 생명주기 관찰(command.started/finished — 명령라인·cwd)
  | "terminal:read" // 터미널 화면 버퍼 내용 읽기·변경 구독(명령 메타보다 강함 — 전 화면 텍스트)
  | "terminal:write" // 터미널 PTY 에 입력 전송(키 주입 — 관찰보다 강함, 별도 권한)
  | "git:read" // git log/show/diff/status (읽기 전용)
  | "network"; // fetch 사용 고지 — 기술적 강제 불가(§0-2 전체신뢰), 동의 화면 고지용

export const PERMISSIONS: readonly PluginPermission[] = [
  "ui",
  "ui:statusbar",
  "ui:titlebar",
  "ui:overlay:pane",
  "ui:overlay:screen",
  "programs",
  "commands",
  "commands:destructive",
  "commands:inject",
  "process",
  "webview",
  "pty",
  "sidecar",
  "storage",
  "data",
  "secrets",
  "notify",
  "schedule",
  "fs:read",
  "fs:write",
  "clipboard:read",
  "clipboard:write",
  "terminal",
  "terminal:read",
  "terminal:write",
  "git:read",
  "network",
];

// 동의 화면용 권한 설명(§0-2 정직한 고지). caution = 강조 표시 대상.
export const PERMISSION_INFO: Record<
  PluginPermission,
  { label: string; detail: string; caution?: true }
> = {
  ui: {
    label: "콘텐츠 뷰",
    detail: "사이드바·콘텐츠 영역에 자체 화면을 띄웁니다(호스트가 배치 소유 — 안전).",
  },
  "ui:statusbar": {
    label: "상태바 항목",
    detail: "상태바에 항목(버튼)을 추가합니다(크롬 영역).",
  },
  "ui:titlebar": {
    label: "헤더 아이콘",
    detail:
      "타이틀바 우측 컨트롤(사이드바·다크모드·설정) 옆에 토글 아이콘을 추가합니다(크롬 영역).",
  },
  "ui:overlay:pane": {
    label: "패널 오버레이",
    detail:
      "콘텐츠 패널 하나를 덮는 오버레이를 띄웁니다(그 패널의 본문만 가림 — 다른 패널·크롬은 그대로).",
    caution: true,
  },
  "ui:overlay:screen": {
    label: "전체화면 레이어",
    detail:
      "앱 전체를 덮는 레이어를 띄웁니다(크롬·모든 패널 위 — 가장 침습적). 마스코트 효과 등.",
    caution: true,
  },
  programs: {
    label: "프로그램 등록",
    detail:
      "새 탭(+) 메뉴에 프로그램을 추가합니다. 선택하면 터미널에서 그 프로그램의 명령(미설치 시 설치 명령 포함)이 자동 실행됩니다.",
    caution: true,
  },
  commands: {
    label: "명령 실행·등록",
    detail: "앱 명령을 실행하고 자기 명령을 등록합니다(위험 분류 명령 제외).",
  },
  "commands:destructive": {
    label: "파괴적 명령",
    detail: "탭·패널 닫기, 항목 제거 등 파괴적 명령을 실행할 수 있습니다.",
    caution: true,
  },
  "commands:inject": {
    label: "입력 주입",
    detail: "터미널 입력 전송·브라우저 스크립트 실행 등 주입 명령을 쓸 수 있습니다.",
    caution: true,
  },
  process: {
    label: "외부 프로그램 실행",
    detail:
      "임의 외부 프로그램을 서브프로세스로 띄우고 입출력(stdin/stdout/stderr)을 주고받습니다(가장 강력 — 사실상 임의 코드 실행). LSP·MCP·ACP 등 외부 도구 통합용.",
    caution: true,
  },
  webview: {
    label: "내장 브라우저(webview)",
    detail:
      "코어가 임베드한 네이티브 webview 를 띄워 임의 웹페이지를 로드하고 그 페이지에서 스크립트를 실행·주입합니다(브라우저류 콘텐츠 뷰).",
    caution: true,
  },
  sidecar: {
    label: "네이티브 엔진 모듈 로드",
    detail:
      "공유 네이티브 엔진 모듈(사이드카 dylib)을 앱 프로세스 안에 로드하고 메시지를 주고받습니다(네이티브 코드 실행 — 가장 강력한 부류). 매니페스트 sidecars[] 에 선언된 모듈만 열 수 있습니다.",
    caution: true,
  },
  pty: {
    label: "터미널 세션 실행",
    detail:
      "PTY 백드 셸/터미널 세션을 띄우고 입출력을 주고받습니다(flow control·셸 환경 주입 포함 — 사실상 임의 셸 명령 실행).",
    caution: true,
  },
  storage: {
    label: "전용 저장소",
    detail: "이 플러그인 전용 폴더(~/.soksak/plugins-data)에 데이터를 저장합니다.",
  },
  data: {
    label: "데이터베이스",
    detail:
      "공용 임베디드 DB(SQLite)의 이 플러그인 전용 네임스페이스에 레코드를 저장·검색합니다(CJK 전문검색 포함). 다른 플러그인 데이터에는 접근하지 못합니다.",
  },
  secrets: {
    label: "시크릿 저장",
    detail:
      "API 키·토큰 같은 민감값을 암호화 볼트에 저장합니다. 평문은 앱 데이터·백업·로그에 남지 않으며, 저장한 값을 평문으로 되읽을 수 없습니다(주입 전용).",
    caution: true,
  },
  notify: {
    label: "알림·푸시",
    detail:
      "OS 알림(앱이 비활성일 때 모바일식 푸시)과 인앱 배너를 띄우고 소리를 재생합니다. 알림 클릭 시 앱 내 위치로 이동(딥링크)합니다.",
    caution: true,
  },
  schedule: {
    label: "스케줄러",
    detail:
      "정해진 시각·간격·cron 또는 상태 변화에 맞춰 앱 명령을 자동 실행하도록 예약합니다(앱 재시작 후에도 복구). 사용자 조작 없이 명령이 실행됩니다.",
    caution: true,
  },
  "fs:read": {
    label: "파일 읽기",
    detail: "디스크의 임의 경로 파일을 읽을 수 있습니다.",
    caution: true,
  },
  "fs:write": {
    label: "파일 쓰기",
    detail: "디스크의 임의 경로 파일을 쓸 수 있습니다.",
    caution: true,
  },
  "clipboard:read": {
    label: "클립보드 읽기",
    detail:
      "다른 앱에서 복사한 내용을 포함해 시스템 클립보드의 텍스트를 읽고, 클립보드가 바뀔 때마다 그 내용을 받습니다. 어느 앱이 복사했는지는 알 수 없습니다.",
    caution: true,
  },
  "clipboard:write": {
    label: "클립보드 쓰기",
    detail: "시스템 클립보드 내용을 덮어씁니다(다른 앱이 그 값을 붙여넣게 됩니다).",
    caution: true,
  },
  terminal: {
    label: "터미널 명령 관찰",
    detail:
      "터미널에서 어떤 명령이 실행/종료되는지(명령라인·작업 디렉토리 포함) 받습니다.",
    caution: true,
  },
  "terminal:read": {
    label: "터미널 화면 읽기",
    detail:
      "터미널 패널의 화면 텍스트(실행 중 프로그램의 출력 전체)를 읽고 갱신을 구독합니다(명령 관찰보다 강함).",
    caution: true,
  },
  "terminal:write": {
    label: "터미널 입력 전송",
    detail:
      "터미널 패널에 키 입력을 주입합니다(실행 중인 프로그램에 타이핑 — 셸 명령 실행 가능).",
    caution: true,
  },
  "git:read": {
    label: "git 읽기",
    detail: "저장소의 커밋 이력·변경 내용을 읽습니다(쓰기 없음).",
  },
  network: {
    label: "네트워크",
    detail:
      "외부 네트워크 요청을 사용한다고 밝힌 플러그인입니다. 전체신뢰 모델에서 기술적으로 막을 수는 없습니다.",
    caution: true,
  },
};

// ── §3.5 플러그인 텍스트 다국어 ──────────────────────────────────────────────
// 텍스트 소유권: 호스트 화면 텍스트 = 호스트 i18n, 플러그인 텍스트 = 플러그인
// 소유. 매니페스트의 사용자-노출 문자열(name/description/기여 title/프로그램
// path)은 단일 문자열 또는 언어 맵 — 호스트가 현재 언어로 resolve 한다.
// 뷰 내부 텍스트는 플러그인 코드 소유 — 호스트는 app.locale 과 locale.changed
// 이벤트(권한 불요 컨텍스트)만 제공한다.

export type LocalizedText = string | Record<string, string>;

const LANG_KEY_RE = /^[a-z]{2}(-[A-Za-z0-9]{2,8})*$/;

// 현재 언어로 resolve — 정확 일치 없으면 선언된 첫 값 폴백(언어 누락이 표시
// 공백이 되지 않게). string 단일형은 그대로.
export function resolveText(t: LocalizedText, lang: string): string {
  if (typeof t === "string") return t;
  if (t[lang] !== undefined) return t[lang];
  const first = Object.values(t)[0];
  return first ?? "";
}

function validateLocalizedText(
  v: unknown,
  label: string,
  errors: string[],
): v is LocalizedText {
  if (typeof v === "string") {
    if (!v.trim()) {
      errors.push(`${label}: 비공백 문자열 필수`);
      return false;
    }
    return true;
  }
  if (!isRecord(v)) {
    errors.push(`${label}: 문자열 또는 언어 맵({ko: …, en: …})이어야 함`);
    return false;
  }
  const entries = Object.entries(v);
  if (entries.length === 0) {
    errors.push(`${label}: 언어 맵은 최소 1개 언어 필요`);
    return false;
  }
  for (const [k, val] of entries) {
    if (!LANG_KEY_RE.test(k)) {
      errors.push(`${label}: 언어 키 형식 위반("${k}" — 예: ko, en, zh-Hans)`);
      return false;
    }
    if (typeof val !== "string" || !val.trim()) {
      errors.push(`${label}.${k}: 비공백 문자열 필수`);
      return false;
    }
  }
  return true;
}

// 정규화(trim) — string 은 trim, 맵은 값 trim.
function normalizeText(t: LocalizedText): LocalizedText {
  if (typeof t === "string") return t.trim();
  return Object.fromEntries(
    Object.entries(t).map(([k, v]) => [k, v.trim()]),
  );
}

// ── §2 뷰 배치 ───────────────────────────────────────────────────────────────
// 뷰 구현(provider)과 배치는 직교(§0-6). placements = 지원 배치, 기본 우측 사이드바.

export type ViewPlacement =
  | "sidebar-right"
  | "sidebar-left"
  | "sidebar-footer"
  | "content";

export const VIEW_PLACEMENTS: readonly ViewPlacement[] = [
  "sidebar-right",
  "sidebar-left",
  "sidebar-footer",
  "content",
];

export interface ContributedView {
  id: string; // 플러그인 내 고유. 전역 키는 "<pluginId>.<id>"
  title: LocalizedText;
  icon: string; // 아이콘 레일용 짧은 글리프(문자 1~2개/이모지). v1 은 SVG 미지원
  placements: ViewPlacement[]; // 파싱 시 기본 ["sidebar-right"] 로 채움
  defaultPlacement: ViewPlacement; // 파싱 시 placements[0] 으로 채움
  // 콘텐츠 뷰 아래 네이티브 레이어(임베드 webview 등)가 비쳐야 함 — 코어가 그 셀을 투명 홀로 처리한다.
  // 브라우저류 뷰(child webview 임베드)가 선언한다(코어 하드 체크 없음 — 데이터 주도). 기본 false.
  transparent: boolean; // 파싱 시 기본 false
  // 이 뷰가 코어 호스팅 native child surface(app.webview 의 child webview)를 소유함 — "수명주기"
  // 선언. transparent(합성 — 셀을 홀로 뚫음)와 별개 축. 코어 webviewGc 가 이 선언에서 고아 회수
  // 대상을 파생한다(코어에 플러그인 id 하드코딩 금지 — 데이터 주도). 기본 false.
  nativeSurface: boolean; // 파싱 시 기본 false
}

export interface ContributedCommand {
  name: string; // 등록명은 plugin.<pluginId>.<name> — 선언 외 등록은 거부됨
  title: LocalizedText;
  // 위험 분류(설치·동의 시점 가시성). "destructive"=닫기/제거, "inject"=term.send/browser.eval 류.
  // 매니페스트 선언이 권위 — 런타임 register({danger}) 가 불일치하면 거부된다(api.ts). 동의 요약이 노출.
  danger?: "destructive" | "inject";
}

export interface ContributedIconSet {
  id: string; // 플러그인 내 고유. 전역 키는 "<pluginId>.<id>"
  title: LocalizedText; // 설정 드롭다운 표시 이름
}

// 파일 뷰어 — 파일을 콘텐츠로 열 때 확장자로 라우팅되는 렌더러(에디터=코드/텍스트, 미디어=이미지/영상…).
// 엔진 중립(A13): 코어는 매칭·호스팅만, 렌더 엔진(CodeMirror/Monaco/…)은 플러그인 소유. provider 는
// 런타임 app.ui.registerFileViewer 로 바인딩(선언 외 거부 §0-3).
export interface ContributedFileViewer {
  id: string; // 플러그인 내 고유. 전역 키는 "<pluginId>.<id>"
  extensions: string[]; // 처리할 확장자(점 없이). "*" = 폴백(더 구체적 매칭이 없을 때)
  priority?: number; // 겹칠 때 높은 값 우선(기본 0). 동일 priority 는 등록 순서
}

// DOM 노출 노드 — 플러그인이 자기 뷰 안에서 외부(주소 클릭/측정)에 노출하는 요소 "종류"의 선언.
// command 노출 패턴과 동일: 선언하면 동의 화면에 자동 표기(정직한 고지 §0-2). 실제 DOM 요소는 data-node
// 속성으로 인스턴스 부여(동적 목록은 "<id>/<key>"). 선언된 id 기반만 유효 — 미선언은 경고(침묵 금지).
export interface ContributedNode {
  id: string; // 뷰 내 고유 노드 종류. 전역 주소는 ".../view/<pluginId.viewId>/node/<id>[/<key>]"
  description?: LocalizedText; // 동의 화면 설명(무엇을 노출하는지)
  danger?: true; // 민감 노출(동의 화면 ⚠ 강조)
}

// 이 플러그인이 동봉하는 도메인 스킬(선언형, 단일). 존재 = "per-command description 으로 못 가르치는
// 시스템 절차지식이 있다"는 자기기술(docs/I18N.md §5). `sok skill install` 이 이 선언을 보유한 플러그인의
// SKILL.md 를 .claude/skills/<id>·.agents/skills/<id> 로 균일 설치 — 코어는 플러그인 하드코딩 목록을 들지
// 않는다(contributes.commands/views/nodes 와 같은 매니페스트 선언 패턴). 스킬 내용은 플러그인 repo 가 단일진실.
export interface ContributedSkill {
  path: string; // 플러그인 디렉토리 내부 SKILL.md 상대경로(예: "skill/SKILL.md"). 디렉토리 탈출(..) 금지.
}

// ── §2.6 프로그램 ────────────────────────────────────────────────────────────
// 프로그램 = 새 탭(+) 메뉴의 항목 하나 = 새 뷰를 여는 방법. 내장 프로그램은
// 없다 — 터미널·에이전트 전부 플러그인이 기여한다(메뉴·목록에 하드코딩 항목
// 없음). 코어가 소유하는 것은 터미널 뷰 능력(terminal kind)뿐이다. 프로그램 id
// 는 전역 평탄(사용자-facing 인터페이스 — 명령 파라미터·설정값에 그대로 쓰임).
// 충돌은 등록 시점 에러(§0-3 침묵 실패 금지). 미등록 id 사용 시 코어는 터미널
// 뷰로 폴백한다(상태·코어 명령의 동작 보장 — 메뉴 항목과는 무관).
//
// 프로그램은 완전 선언형이다(languages 와 동형 — 코드 바인딩 불요, 자동 적용).
// 동작 전체(실행 명령·설치 명령)가 매니페스트에 있어야 동의 화면이 플러그인의
// 역할을 명령 그대로 보여줄 수 있다(§0-2 정직한 고지): "코어 기능 연결만"인지
// "명령 실행"인지 "미설치 시 설치까지"인지가 기계 검증되는 선언으로 드러난다.

export type ProgramPlatform = "darwin" | "linux" | "win32";
export const PROGRAM_PLATFORMS: readonly ProgramPlatform[] = [
  "darwin",
  "linux",
  "win32",
];

export interface ContributedProgram {
  id: string; // 전역 프로그램 id(평탄). ^[a-z0-9][a-z0-9-]*$
  title: LocalizedText; // 메뉴 표시명
  // 메뉴 카테고리 경로 — "/" 구분으로 뎁스 지정(예: "에이전트", "에이전트/실험").
  // 같은 경로끼리 서브메뉴로 묶인다(플러그인 간 병합 — 표시 언어 기준).
  path?: LocalizedText;
  // 동작: view = 콘텐츠 탭으로 뷰를 연다(+view). 코어는 터미널 뷰를 소유하지 않는다 —
  // 터미널도 플러그인 뷰다(soksak-plugin-terminal.content). 따라서 kind 는 view 하나로 수렴.
  kind: "view";
  view: string; // 열 뷰 id(contributes.views[].id). viewPlugin 미지정이면 자기 플러그인 뷰.
  // 뷰 소유 플러그인(크로스 플러그인 참조) — 다른 플러그인의 뷰를 열 때 명시(예: 에이전트
  // 프로그램이 soksak-plugin-terminal 의 content 뷰를 연다). 미지정 = 자기 플러그인(this).
  viewPlugin?: string;
  // 연 뷰에 흘려보낼 자동 실행 명령(에이전트 프로그램: 터미널 뷰가 마운트 시 PTY 로 1회 실행).
  // 뷰 종류에 무관한 일반 채널(PluginViewContext.command) — 터미널 뷰만 이를 자동 실행한다.
  command?: string;
  // 선행 바이너리 보장: 사용자 셸 PATH 에서 bin 을 확인하고 미설치면 공식 설치 명령을
  // 활성화 시점에 가시 실행한다(은폐 금지). 뷰 종류 무관 — 활성화 시점에 동작한다.
  ensure?: {
    bin: string;
    install: Partial<Record<ProgramPlatform, string>>;
  };
}

// path → 세그먼트(빈 세그먼트 거부는 검증이). "a/b" → ["a","b"].
export function programPathSegments(path: string): string[] {
  return path.split("/").map((s) => s.trim());
}

// ── §3 매니페스트 ────────────────────────────────────────────────────────────

export const SPEC_VERSION = "soksak-plugin-spec@1";
export const DEFAULT_ENTRY = "main.js";

// 외부 CLI/라이브러리 종속성 — 플러그인이 process 로 실행하는 외부 도구(npm 글로벌 CLI 등).
// 플러그인↔플러그인 dependencies 와 별개 축. 동의 후 미설치면 강제 설치(install 명령 원문 고지).
// 공급(reach) 전략 — 외부 도구를 목표 상태로 만드는 법. 정확히 하나의 variant.
//   vendor = 저자 번들 바이트 + sha256 무결성 핀, fetch = 코어 다운로드 + 플랫폼별 sha256,
//   command = 레거시 설치 명령(검증 불가). 미선언이면 install(레거시)로 폴백.
export type ReachStrategy =
  | { vendor: { path: string; sha256: string } }
  | {
      fetch: {
        url: Partial<Record<ProgramPlatform, string>>;
        sha256: Partial<Record<ProgramPlatform, string>>;
      };
    }
  | { command: Partial<Record<ProgramPlatform, string>> };

// 외부 런타임 의존성 = 4-tuple: identity(name·bin) + observe(작동 관찰) + accept(수용 술어) + reach(공급).
// observe/accept/reach 는 선택 — 미선언이면 레거시 동작(존재=수용, install=공급). reconcile 엔진(M3)이 실행.
// 사이드카(engine 모델) 의존 선언 — 플러그인이 열 공유 네이티브 모듈. name 은 사이드카 이름
// (soksak-sidecar-<name> 의 <name>), interface 는 메시지 프로토콜 id@major. 코어가 로드 시 바이너리
// 자기보고(soksak_sidecar_abi)와 대조한다 — 불일치는 거부(선언≡실물). 분류·ABI 정본 docs/SIDECARS.md.
export interface SidecarDep {
  name: string; // ^[a-z0-9][a-z0-9-]*$
  interface: string; // ^[a-z0-9][a-z0-9.-]*@[0-9]+$ (예: "soksak-browser-engine@1")
  // 공급(선택) — 미설치 시 sha256 핀 아카이브(dist tar.gz)를 받아 ~/.soksak/sidecars/에 설치.
  // fetch 전용(사이드카는 command/vendor 비적용). 미선언이면 dev 스테이징(make) 전제.
  reach?: {
    fetch: {
      url: Partial<Record<ProgramPlatform, string>>;
      sha256: Partial<Record<ProgramPlatform, string>>;
    };
  };
}

export interface LibraryDep {
  name: string; // identity — 패키지/도구 식별(예: "@google/gemini-cli")
  bin: string; // PATH/probe 대상 실행 bin
  install: Partial<Record<ProgramPlatform, string>>; // 레거시 공급(= reach.command 동치). reach 미선언 시 사용.
  label?: LocalizedText; // 동의 화면 표시명(생략 시 name)
  observe?: { probe: string[]; versionRe?: string }; // 작동 관찰: probe argv(exit0=작동) + 버전 추출 정규식
  accept?: { minVersion?: string }; // 수용 술어: 최소 SemVer(미선언이면 probe 성공만)
  reach?: ReachStrategy; // 공급 전략(미선언이면 install 폴백)
}

// 플러그인 설정 스키마 — 사용자 구성 옵션의 단일 진실. UI(자동 컨트롤)·저장 기본값·검증·CLI/MCP·문서가
// 전부 이 선언에서 파생(선언형 configuration 스키마). 무해(선언형) → 권한 불요. 저장은
// 글로벌(앱 전역)·프로젝트별 오버라이드 2계층(effective = 프로젝트 ?? 글로벌 ?? default).
// list = 문자열 리스트, map = 키-값 쌍 리스트(원본→미러 같은 2칸 매핑 테이블). 둘 다 설정 모달이
// 행별 추가/삭제로 렌더 — 스칼라 4종으로 못 그리는 가변 목록/매핑용.
export type ConfigType = "boolean" | "number" | "string" | "enum" | "list" | "map";
export const CONFIG_TYPES: readonly ConfigType[] = ["boolean", "number", "string", "enum", "list", "map"];
// map 값은 {key,value} 쌍 배열(삽입 순서·빈 행 보존 — Record 는 순서/중복키 못 지킴).
export interface MapEntry {
  key: string;
  value: string;
}
export type ConfigValue = boolean | number | string | string[] | MapEntry[];
export interface ConfigSetting {
  key: string; // ^[a-zA-Z][a-zA-Z0-9]*$ — 플러그인 네임스페이스 안에서 유일
  type: ConfigType;
  default: ConfigValue;
  title: LocalizedText;
  description?: LocalizedText;
  enum?: string[]; // type=enum 필수
  enumLabels?: LocalizedText[]; // 선택 — 있으면 enum 과 길이 일치(표시명)
  min?: number; // type=number 선택
  max?: number; // type=number 선택
}
export const CONFIG_KEY_RE = /^[a-zA-Z][a-zA-Z0-9]*$/;

export interface PluginManifest {
  spec: typeof SPEC_VERSION; // 필수 — 불일치 시 거부
  id: string; // ^[a-z0-9][a-z0-9-]*$ + 설치 디렉토리명과 일치 강제
  name: LocalizedText;
  version: string; // semver(major.minor.patch)
  description: LocalizedText;
  author?: string;
  // 이 플러그인의 git 레포(설치 source). 공식 레지스트리 생성이 추출하는 필드 — 저자가 자기
  // 레포를 명시한다. 임의 git URL(github/gitlab/self-host 다). plugin.install 이 이걸로 clone.
  repo?: string;
  entry: string; // 파싱 시 기본 main.js 로 채움. 디렉토리 내부 상대경로만
  minAppVersion?: string;
  template?: boolean; // true = 개발 템플릿(읽기 전용). 활성화 대상이 아니다 — 목록·상세만 노출하고 토글을 주지 않는다.
  // 플러그인↔플러그인 의존(라이브러리 플러그인). pluginId → semver 범위(예: "^0.1.0").
  // 설치 시 미설치 의존을 전이적으로 동반 설치(동의 게이트), 삭제 시 의존자 cascade(고아 방지).
  // 코어 권한(permissions)과 별개 축 — 이건 다른 플러그인에 대한 의존. 범용(어떤 플러그인↔플러그인).
  dependencies?: Record<string, string>;
  // 외부 CLI/라이브러리 종속성 — 동의 후 미설치면 강제 설치. dependencies(플러그인↔플러그인)와 별개 축.
  libraries?: LibraryDep[];
  // 사이드카(engine 모듈) 의존 — 선언된 것만 app.sidecar.open 가능. "sidecar" 권한 필수.
  sidecars?: SidecarDep[];
  // 사용자 구성 설정 스키마(선택). 글로벌+프로젝트별 오버라이드. 무해(선언형) → 권한 불요.
  configuration?: ConfigSetting[];
  permissions: PluginPermission[];
  contributes: {
    views: ContributedView[]; // "ui" 권한 필수
    commands: ContributedCommand[]; // "commands" 권한 필수
    iconSets: ContributedIconSet[]; // "ui" 권한 필수
    fileViewers: ContributedFileViewer[]; // "ui" 권한 필수 — 확장자별 콘텐츠 뷰어(A13 엔진 중립)
    programs: ContributedProgram[]; // "programs" 권한 필수
    // 이 플러그인이 발행하는 이벤트 토픽(정보용 — 발견성). 런타임 강제 없음(bus/events 는 그대로
    // 동작). 다른 플러그인 작성자가 구독할 토픽을 매니저에서 볼 수 있게 하는 오픈 카탈로그.
    events: string[];
    // DOM 노출 노드 종류(선언). 동의 화면에 표기 — 사용자가 무엇이 외부 클릭 가능한지 보고 동의. "ui" 권한 필수.
    nodes: ContributedNode[];
    // 동봉 도메인 스킬(선택, 단일). 선언 = 전용 스킬 필요 자기기술(docs/I18N.md §5). 권한 불요(무해·선언형).
    skill?: ContributedSkill;
  };
}

export interface ManifestValidation {
  ok: boolean;
  errors: string[]; // 거부 사유(§0-3: 부분 수용 금지)
  warnings: string[];
}

// 전역 키 규칙 — 산문이 아니라 함수가 단일진실.
export function qualifiedViewId(pluginId: string, viewId: string): string {
  return `${pluginId}.${viewId}`;
}
export function pluginCommandName(pluginId: string, name: string): string {
  return `plugin.${pluginId}.${name}`;
}

// 설정 스키마 → 기본값 맵(key → default). 저장소/effective 해석의 바닥값(단일 진실은 스키마).
export function configDefaults(
  manifest: PluginManifest,
): Record<string, ConfigValue> {
  const out: Record<string, ConfigValue> = {};
  for (const c of manifest.configuration ?? []) out[c.key] = c.default;
  return out;
}

// 설정 키의 스키마 항목 조회(검증/컨트롤 생성용). 없으면 undefined.
export function configSettingOf(
  manifest: PluginManifest,
  key: string,
): ConfigSetting | undefined {
  return (manifest.configuration ?? []).find((c) => c.key === key);
}

// 설정 값을 스키마에 대해 검증 — type 정합·enum 멤버십·min/max. set 경로의 게이트(저장 전).
export function validateSettingValue(
  setting: ConfigSetting,
  value: unknown,
): { ok: true; value: ConfigValue } | { ok: false; error: string } {
  const k = setting.key;
  switch (setting.type) {
    case "list":
      return Array.isArray(value) && value.every((x) => typeof x === "string")
        ? { ok: true, value: value as string[] }
        : { ok: false, error: `${k}: 문자열 배열 필요` };
    case "map":
      return Array.isArray(value) &&
        value.every(
          (x) =>
            !!x &&
            typeof x === "object" &&
            typeof (x as MapEntry).key === "string" &&
            typeof (x as MapEntry).value === "string",
        )
        ? { ok: true, value: value as MapEntry[] }
        : { ok: false, error: `${k}: {key,value} 배열 필요` };
    case "boolean":
      return typeof value === "boolean"
        ? { ok: true, value }
        : { ok: false, error: `${k}: boolean 필요` };
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) {
        return { ok: false, error: `${k}: number 필요` };
      }
      if (setting.min !== undefined && value < setting.min) {
        return { ok: false, error: `${k}: 최소 ${setting.min}` };
      }
      if (setting.max !== undefined && value > setting.max) {
        return { ok: false, error: `${k}: 최대 ${setting.max}` };
      }
      return { ok: true, value };
    case "string":
      return typeof value === "string"
        ? { ok: true, value }
        : { ok: false, error: `${k}: string 필요` };
    case "enum":
      return typeof value === "string" && (setting.enum ?? []).includes(value)
        ? { ok: true, value }
        : { ok: false, error: `${k}: ${(setting.enum ?? []).join("|")} 중 하나` };
  }
}

export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const VIEW_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
// 사이드카 이름(soksak-sidecar-<name> 의 <name>) — 경로 조립에 쓰이므로 traversal 안전 형식.
const SIDECAR_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
// 사이드카 interface id — "<protocol-id>@<major>" (예: soksak-browser-engine@1).
const SIDECAR_INTERFACE_RE = /^[a-z0-9][a-z0-9.-]*@[0-9]+$/;
const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;
const EXT_RE = /^[a-z0-9]+$/;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;
// 의존 범위(npm 류 부분집합): * | x.y.z | ^x.y.z | ~x.y.z | >=x.y.z. 락인 0(표준 의미론).
const SEMVER_RANGE_RE = /^(?:\*|[\^~]?\d+\.\d+\.\d+|>=\d+\.\d+\.\d+)$/;
// git URL: 스킴형(https/http/git/ssh ://…) 또는 scp-유사(git@host:path). clone 가능한 형태만.
const GIT_URL_RE = /^(?:https?|git|ssh):\/\/\S+|^[\w.-]+@[\w.-]+:\S+/;

// a ≥ b (major.minor.patch 비교, pre-release 무시). 형식 불량이면 null.
export function semverGte(a: string, b: string): boolean | null {
  const ma = SEMVER_RE.exec(a);
  const mb = SEMVER_RE.exec(b);
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i++) {
    const da = Number(ma[i]);
    const db = Number(mb[i]);
    if (da !== db) return da > db;
  }
  return true;
}

// version 이 range 를 만족하는가(npm 류 부분집합: * | x.y.z | ^x.y.z | ~x.y.z | >=x.y.z).
// 의존 시스템이 설치 버전 ↔ 의존 범위 매칭에 쓴다. 형식 불량이면 null(호출부가 거부 처리).
export function semverSatisfies(version: string, range: string): boolean | null {
  const v = SEMVER_RE.exec(version);
  if (!v) return null;
  const r = range.trim();
  if (r === "*") return true;
  const num = (m: RegExpExecArray, i: number) => Number(m[i]);
  // lower(포함) ≤ version < upper(미포함). caret/tilde 상한 계산은 npm 의미론.
  const lt = (a: string, b: string): boolean => semverGte(a, b) === false;
  const cmp = />=(\d+\.\d+\.\d+)$/.exec(r);
  if (cmp) return semverGte(version, cmp[1]) === true;
  const exact = /^(\d+\.\d+\.\d+)$/.exec(r);
  if (exact) return `${num(v, 1)}.${num(v, 2)}.${num(v, 3)}` === exact[1];
  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(r);
  if (caret) {
    const [maj, min, pat] = [1, 2, 3].map((i) => Number(caret[i]));
    const base = `${maj}.${min}.${pat}`;
    const upper = maj > 0 ? `${maj + 1}.0.0` : min > 0 ? `0.${min + 1}.0` : `0.0.${pat + 1}`;
    return semverGte(version, base) === true && lt(version, upper);
  }
  const tilde = /^~(\d+)\.(\d+)\.(\d+)$/.exec(r);
  if (tilde) {
    const [maj, min, pat] = [1, 2, 3].map((i) => Number(tilde[i]));
    const base = `${maj}.${min}.${pat}`;
    const upper = `${maj}.${min + 1}.0`;
    return semverGte(version, base) === true && lt(version, upper);
  }
  return null;
}

// ── §4 검증 ──────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

// 선언 안 된 키는 거부(registry.validate 와 동일 철학 — 오타 조기 발견).
function checkKnownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  errors: string[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${label}: 알 수 없는 키 "${key}"`);
  }
}

// 플랫폼별 값 맵 검증(reach.command·fetch.url/sha256 공통) — 키는 PROGRAM_PLATFORMS, 값 비공백, 최소 1개.
// true 반환 = 에러(호출자 return).
function validatePlatformMap(m: unknown, label: string, errors: string[]): boolean {
  if (!isRecord(m)) {
    errors.push(`${label}: 플랫폼별 객체 필요`);
    return true;
  }
  let count = 0;
  for (const [k, val] of Object.entries(m)) {
    if (!PROGRAM_PLATFORMS.includes(k as ProgramPlatform)) {
      errors.push(`${label}: 플랫폼 키는 ${PROGRAM_PLATFORMS.join("|")}`);
      return true;
    }
    if (!isNonEmptyString(val)) {
      errors.push(`${label}.${k}: 비공백 문자열`);
      return true;
    }
    count++;
  }
  if (count === 0) {
    errors.push(`${label}: 최소 1개 플랫폼 필요`);
    return true;
  }
  return false;
}

// reach 전략 검증 — vendor|fetch|command 중 정확히 하나, vendor/fetch 는 sha256 무결성 핀 필수. true = 에러.
function validateReach(reach: unknown, label: string, errors: string[]): boolean {
  if (!isRecord(reach)) {
    errors.push(`${label}: 객체(vendor|fetch|command)`);
    return true;
  }
  const variants = (["vendor", "fetch", "command"] as const).filter((k) => k in reach);
  if (variants.length !== 1) {
    errors.push(`${label}: vendor|fetch|command 중 정확히 하나`);
    return true;
  }
  const v = variants[0];
  if (v === "vendor") {
    const o = reach.vendor;
    if (!isRecord(o) || !isNonEmptyString(o.path) || !isNonEmptyString(o.sha256)) {
      errors.push(`${label}.vendor: { path, sha256 } 비공백 문자열 필수`);
      return true;
    }
    return false;
  }
  if (v === "fetch") {
    const o = reach.fetch;
    if (!isRecord(o)) {
      errors.push(`${label}.fetch: { url, sha256 } 객체 필요`);
      return true;
    }
    return (
      validatePlatformMap(o.url, `${label}.fetch.url`, errors) ||
      validatePlatformMap(o.sha256, `${label}.fetch.sha256`, errors)
    );
  }
  return validatePlatformMap(reach.command, `${label}.command`, errors);
}

interface EntryRule<T> {
  label: string;
  required: readonly string[];
  optional?: readonly string[];
  parse: (v: Record<string, unknown>, errors: string[]) => T | null;
}

// 배열 항목 공통 검증: 객체 + 키 화이트리스트 + 항목 파서.
function parseEntries<T>(
  raw: unknown,
  rule: EntryRule<T>,
  errors: string[],
): T[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${rule.label}: 배열이어야 함`);
    return [];
  }
  const out: T[] = [];
  raw.forEach((item, i) => {
    const label = `${rule.label}[${i}]`;
    if (!isRecord(item)) {
      errors.push(`${label}: 객체가 아님`);
      return;
    }
    checkKnownKeys(item, [...rule.required, ...(rule.optional ?? [])], label, errors);
    for (const key of rule.required) {
      if (item[key] === undefined) errors.push(`${label}.${key}: 필수`);
    }
    const parsed = rule.parse(item, errors);
    if (parsed !== null) out.push(parsed);
  });
  return out;
}

function checkDuplicates(
  values: string[],
  label: string,
  errors: string[],
): void {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) errors.push(`${label}: 중복 "${v}"`);
    seen.add(v);
  }
}

// 외부 JSON(unknown) → 검증된 PluginManifest. 실패 시 errors 에 전체 사유(§0-3).
// dirName = 설치 디렉토리명 — id 와 불일치하면 거부(스캔/설치 경로의 단일진실).
export function parseManifest(
  raw: unknown,
  dirName: string,
): { manifest: PluginManifest | null; validation: ManifestValidation } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const reject = () => ({
    manifest: null,
    validation: { ok: false, errors, warnings },
  });

  if (!isRecord(raw)) {
    errors.push("매니페스트가 JSON 객체가 아님");
    return reject();
  }

  checkKnownKeys(
    raw,
    [
      "spec",
      "id",
      "name",
      "version",
      "description",
      "author",
      "repo",
      "entry",
      "minAppVersion",
      "template",
      "dependencies",
      "libraries",
      "sidecars",
      "configuration",
      "permissions",
      "contributes",
    ],
    "manifest",
    errors,
  );

  if (raw.spec !== SPEC_VERSION) {
    errors.push(`spec: "${SPEC_VERSION}" 필수(현재 앱이 아는 유일한 스펙)`);
  }
  if (!isNonEmptyString(raw.id) || !PLUGIN_ID_RE.test(raw.id)) {
    errors.push("id: ^[a-z0-9][a-z0-9-]*$ 필수");
  } else if (raw.id !== dirName) {
    errors.push(`id: 설치 디렉토리명("${dirName}")과 일치해야 함`);
  }
  validateLocalizedText(raw.name, "name", errors);
  if (!isNonEmptyString(raw.version) || !SEMVER_RE.test(raw.version)) {
    errors.push("version: semver(major.minor.patch) 필수");
  }
  validateLocalizedText(raw.description, "description", errors);
  if (raw.author !== undefined && !isNonEmptyString(raw.author)) {
    errors.push("author: 문자열이어야 함");
  }
  // repo: git URL(스킴 또는 scp-유사 git@host:path). 빈 문자열·비URL 거부.
  if (raw.repo !== undefined && (!isNonEmptyString(raw.repo) || !GIT_URL_RE.test(raw.repo))) {
    errors.push("repo: git URL(https://… 또는 git@…) 이어야 함");
  }
  if (
    raw.minAppVersion !== undefined &&
    (!isNonEmptyString(raw.minAppVersion) || !SEMVER_RE.test(raw.minAppVersion))
  ) {
    errors.push("minAppVersion: semver 형식이어야 함");
  }
  if (raw.template !== undefined && typeof raw.template !== "boolean") {
    errors.push("template: true/false 여야 함");
  }

  // dependencies: 플러그인↔플러그인 의존(pluginId → semver 범위). 선택. 자기 의존 금지·빈 객체 무해.
  const dependencies: Record<string, string> = {};
  if (raw.dependencies !== undefined) {
    if (!isRecord(raw.dependencies)) {
      errors.push("dependencies: 객체(pluginId → semver 범위)여야 함");
    } else {
      for (const [depId, range] of Object.entries(raw.dependencies)) {
        if (!PLUGIN_ID_RE.test(depId)) {
          errors.push(`dependencies: 키 "${depId}" 는 플러그인 id 형식(^[a-z0-9][a-z0-9-]*$)`);
        } else if (isNonEmptyString(raw.id) && depId === raw.id) {
          errors.push(`dependencies: 자기 자신("${depId}") 의존 금지`);
        } else if (!isNonEmptyString(range) || !SEMVER_RANGE_RE.test((range as string).trim())) {
          errors.push(
            `dependencies["${depId}"]: semver 범위(예: ^0.1.0, ~1.2.0, >=1.0.0, 1.2.3, *)`,
          );
        } else {
          dependencies[depId] = (range as string).trim();
        }
      }
    }
  }

  // libraries: 외부 CLI/라이브러리 종속성(name·bin·install). 선택. 동의 후 미설치면 강제 설치.
  // dependencies(플러그인↔플러그인)와 별개 축 — 외부 도구(npm 글로벌 CLI 등)에 대한 의존.
  const libraries: LibraryDep[] = [];
  if (raw.libraries !== undefined) {
    if (!Array.isArray(raw.libraries)) {
      errors.push("libraries: 배열(외부 CLI 종속성)이어야 함");
    } else {
      raw.libraries.forEach((item, i) => {
        if (!isRecord(item)) {
          errors.push(`libraries[${i}]: 객체여야 함`);
          return;
        }
        checkKnownKeys(
          item,
          ["name", "bin", "install", "label", "observe", "accept", "reach"],
          `libraries[${i}]`,
          errors,
        );
        if (!isNonEmptyString(item.name)) {
          errors.push(`libraries[${i}].name: 비공백 문자열 필수`);
          return;
        }
        if (!isNonEmptyString(item.bin)) {
          errors.push(`libraries[${i}].bin: 비공백 문자열 필수`);
          return;
        }
        if (!isRecord(item.install)) {
          errors.push(`libraries[${i}].install: 객체(플랫폼별 설치 명령) 필수`);
          return;
        }
        const install: Partial<Record<ProgramPlatform, string>> = {};
        let installBad = false;
        for (const [k, val] of Object.entries(item.install)) {
          if (!PROGRAM_PLATFORMS.includes(k as ProgramPlatform)) {
            errors.push(`libraries[${i}].install: 플랫폼 키는 ${PROGRAM_PLATFORMS.join("|")}`);
            installBad = true;
            break;
          }
          if (!isNonEmptyString(val)) {
            errors.push(`libraries[${i}].install.${k}: 비공백 문자열`);
            installBad = true;
            break;
          }
          install[k as ProgramPlatform] = val.trim();
        }
        if (installBad) return;
        if (Object.keys(install).length === 0) {
          errors.push(`libraries[${i}].install: 최소 1개 플랫폼 명령 필요`);
          return;
        }
        if (item.label !== undefined && typeof item.label !== "string" && !isRecord(item.label)) {
          errors.push(`libraries[${i}].label: 문자열 또는 {언어:문자열}`);
          return;
        }
        // [4-tuple] observe/accept/reach — 선택. 선언 시 형식 검증(미선언이면 레거시 동작).
        if (item.observe !== undefined) {
          const o = item.observe as Record<string, unknown>;
          if (
            !isRecord(o) ||
            !Array.isArray(o.probe) ||
            o.probe.length === 0 ||
            !(o.probe as unknown[]).every((s) => isNonEmptyString(s))
          ) {
            errors.push(`libraries[${i}].observe.probe: 비공백 문자열 배열(argv) 필수`);
            return;
          }
          if (o.versionRe !== undefined && !isNonEmptyString(o.versionRe)) {
            errors.push(`libraries[${i}].observe.versionRe: 문자열`);
            return;
          }
        }
        if (item.accept !== undefined) {
          const a = item.accept as Record<string, unknown>;
          if (
            !isRecord(a) ||
            (a.minVersion !== undefined &&
              (!isNonEmptyString(a.minVersion) || !SEMVER_RE.test(a.minVersion as string)))
          ) {
            errors.push(`libraries[${i}].accept.minVersion: semver 형식`);
            return;
          }
        }
        if (
          item.reach !== undefined &&
          validateReach(item.reach, `libraries[${i}].reach`, errors)
        ) {
          return;
        }
        const lib: LibraryDep = { name: item.name.trim(), bin: item.bin.trim(), install };
        if (item.label !== undefined) lib.label = normalizeText(item.label as LocalizedText);
        if (item.observe !== undefined) lib.observe = item.observe as LibraryDep["observe"];
        if (item.accept !== undefined) lib.accept = item.accept as LibraryDep["accept"];
        if (item.reach !== undefined) lib.reach = item.reach as ReachStrategy;
        libraries.push(lib);
      });
      checkDuplicates(libraries.map((l) => l.bin), "libraries[].bin", errors);
    }
  }

  // sidecars: 사이드카(engine 모듈) 의존 선언(선택). 선언된 것만 app.sidecar.open 가능(코어가
  // 로드 시 interface 를 바이너리 자기보고와 대조). "sidecar" 권한 필수. 정본 docs/SIDECARS.md.
  const sidecars: SidecarDep[] = [];
  if (raw.sidecars !== undefined) {
    if (!Array.isArray(raw.sidecars)) {
      errors.push("sidecars: 배열(사이드카 의존 선언)이어야 함");
    } else {
      raw.sidecars.forEach((item, i) => {
        if (!isRecord(item)) {
          errors.push(`sidecars[${i}]: 객체여야 함`);
          return;
        }
        checkKnownKeys(item, ["name", "interface", "reach"], `sidecars[${i}]`, errors);
        if (!isNonEmptyString(item.name) || !SIDECAR_NAME_RE.test(item.name)) {
          errors.push(`sidecars[${i}].name: ^[a-z0-9][a-z0-9-]*$ 필수`);
          return;
        }
        if (!isNonEmptyString(item.interface) || !SIDECAR_INTERFACE_RE.test(item.interface)) {
          errors.push(`sidecars[${i}].interface: ^[a-z0-9][a-z0-9.-]*@[0-9]+$ 필수(예: soksak-browser-engine@1)`);
          return;
        }
        const dep: SidecarDep = { name: item.name.trim(), interface: item.interface.trim() };
        if (item.reach !== undefined) {
          // 사이드카 공급은 fetch 전용 — command/vendor 는 라이브러리 축의 개념(사이드카 비적용).
          if (
            !isRecord(item.reach) ||
            !("fetch" in item.reach) ||
            Object.keys(item.reach).length !== 1 ||
            !isRecord(item.reach.fetch) ||
            validatePlatformMap(item.reach.fetch.url, `sidecars[${i}].reach.fetch.url`, errors) ||
            validatePlatformMap(item.reach.fetch.sha256, `sidecars[${i}].reach.fetch.sha256`, errors)
          ) {
            if (!isRecord(item.reach) || !("fetch" in item.reach) || Object.keys(item.reach).length !== 1) {
              errors.push(`sidecars[${i}].reach: { fetch: { url, sha256 } } 만 허용(fetch 전용)`);
            }
            return;
          }
          dep.reach = item.reach as SidecarDep["reach"];
        }
        sidecars.push(dep);
      });
      checkDuplicates(sidecars.map((s) => s.name), "sidecars[].name", errors);
      if (sidecars.length > 0 && !(raw.permissions as unknown[] | undefined)?.includes("sidecar")) {
        errors.push('sidecars: "sidecar" 권한 선언 필요');
      }
    }
  }

  // configuration: 사용자 설정 스키마(선택). key·type·default 정합 + enum/enumLabels/min·max 검증.
  // 단일 진실 — UI·저장 기본값·CLI/MCP 가 전부 여기서 파생.
  const configuration: ConfigSetting[] = [];
  if (raw.configuration !== undefined) {
    if (!Array.isArray(raw.configuration)) {
      errors.push("configuration: 배열(설정 스키마)이어야 함");
    } else {
      raw.configuration.forEach((item, i) => {
        if (!isRecord(item)) {
          errors.push(`configuration[${i}]: 객체여야 함`);
          return;
        }
        checkKnownKeys(
          item,
          ["key", "type", "default", "title", "description", "enum", "enumLabels", "min", "max"],
          `configuration[${i}]`,
          errors,
        );
        if (!isNonEmptyString(item.key) || !CONFIG_KEY_RE.test(item.key)) {
          errors.push(`configuration[${i}].key: ^[a-zA-Z][a-zA-Z0-9]*$ 필수`);
          return;
        }
        if (typeof item.type !== "string" || !CONFIG_TYPES.includes(item.type as ConfigType)) {
          errors.push(`configuration[${i}].type: ${CONFIG_TYPES.join("|")}`);
          return;
        }
        const type = item.type as ConfigType;
        if (item.title === undefined || (typeof item.title !== "string" && !isRecord(item.title))) {
          errors.push(`configuration[${i}].title: 문자열 또는 {언어:문자열} 필수`);
          return;
        }
        let enumVals: string[] | undefined;
        if (type === "enum") {
          if (
            !Array.isArray(item.enum) ||
            item.enum.length === 0 ||
            !item.enum.every((x) => isNonEmptyString(x))
          ) {
            errors.push(`configuration[${i}].enum: type=enum 은 비공백 문자열 배열 필수`);
            return;
          }
          enumVals = (item.enum as string[]).map((x) => x.trim());
        } else if (item.enum !== undefined) {
          errors.push(`configuration[${i}].enum: type=enum 에서만 허용`);
          return;
        }
        if (item.enumLabels !== undefined) {
          if (
            type !== "enum" ||
            !Array.isArray(item.enumLabels) ||
            item.enumLabels.length !== (enumVals?.length ?? -1)
          ) {
            errors.push(`configuration[${i}].enumLabels: enum 과 같은 길이여야 함`);
            return;
          }
        }
        const d = item.default;
        const defOk =
          (type === "boolean" && typeof d === "boolean") ||
          (type === "number" && typeof d === "number") ||
          (type === "string" && typeof d === "string") ||
          (type === "enum" && typeof d === "string" && enumVals!.includes(d)) ||
          (type === "list" && Array.isArray(d) && d.every((x) => typeof x === "string")) ||
          (type === "map" &&
            Array.isArray(d) &&
            d.every(
              (x) =>
                !!x &&
                typeof x === "object" &&
                typeof (x as MapEntry).key === "string" &&
                typeof (x as MapEntry).value === "string",
            ));
        if (!defOk) {
          errors.push(
            `configuration[${i}].default: type(${type}) 와 일치${type === "enum" ? "(enum 값 중 하나)" : ""}해야 함`,
          );
          return;
        }
        if (type === "number") {
          if (item.min !== undefined && typeof item.min !== "number") {
            errors.push(`configuration[${i}].min: 숫자`);
            return;
          }
          if (item.max !== undefined && typeof item.max !== "number") {
            errors.push(`configuration[${i}].max: 숫자`);
            return;
          }
          if (typeof item.min === "number" && typeof item.max === "number" && item.min > item.max) {
            errors.push(`configuration[${i}]: min > max`);
            return;
          }
        } else if (item.min !== undefined || item.max !== undefined) {
          errors.push(`configuration[${i}]: min/max 는 type=number 에서만`);
          return;
        }
        const setting: ConfigSetting = {
          key: item.key.trim(),
          type,
          default: d as ConfigValue,
          title: normalizeText(item.title as LocalizedText),
        };
        if (item.description !== undefined) {
          setting.description = normalizeText(item.description as LocalizedText);
        }
        if (enumVals) setting.enum = enumVals;
        if (item.enumLabels !== undefined) {
          setting.enumLabels = (item.enumLabels as LocalizedText[]).map((x) => normalizeText(x));
        }
        if (typeof item.min === "number") setting.min = item.min;
        if (typeof item.max === "number") setting.max = item.max;
        configuration.push(setting);
      });
      checkDuplicates(configuration.map((c) => c.key), "configuration[].key", errors);
    }
  }

  // entry: 디렉토리 내부 상대경로만(탈출 금지), ESM 단일 번들.
  let entry = DEFAULT_ENTRY;
  if (raw.entry !== undefined) {
    if (!isNonEmptyString(raw.entry)) {
      errors.push("entry: 문자열이어야 함");
    } else {
      const e = raw.entry.trim();
      if (e.startsWith("/") || e.startsWith("\\") || /^[a-zA-Z]:/.test(e)) {
        errors.push("entry: 절대경로 금지(디렉토리 내부 상대경로만)");
      } else if (e.split(/[\\/]/).includes("..")) {
        errors.push('entry: ".." 금지(디렉토리 탈출)');
      } else if (!e.endsWith(".js") && !e.endsWith(".mjs")) {
        errors.push("entry: .js/.mjs ESM 단일 번들이어야 함");
      } else {
        entry = e;
      }
    }
  }

  // permissions: 필수 배열(빈 배열 허용 — 아무 API 도 안 쓰는 플러그인).
  const permissions: PluginPermission[] = [];
  if (!Array.isArray(raw.permissions)) {
    errors.push("permissions: 배열 필수(없으면 [])");
  } else {
    for (const p of raw.permissions) {
      if (typeof p !== "string" || !PERMISSIONS.includes(p as PluginPermission)) {
        errors.push(`permissions: 알 수 없는 권한 "${String(p)}"`);
      } else {
        permissions.push(p as PluginPermission);
      }
    }
    checkDuplicates(permissions, "permissions", errors);
  }
  const has = (p: PluginPermission) => permissions.includes(p);

  // contributes — 권한-기여 정합성: 기여가 요구하는 권한이 선언되어야 한다.
  let views: ContributedView[] = [];
  let commands: ContributedCommand[] = [];
  let iconSets: ContributedIconSet[] = [];
  let fileViewers: ContributedFileViewer[] = [];
  let nodes: ContributedNode[] = [];
  let programs: ContributedProgram[] = [];
  let events: string[] = [];
  let skill: ContributedSkill | undefined;
  if (raw.contributes !== undefined) {
    if (!isRecord(raw.contributes)) {
      errors.push("contributes: 객체여야 함");
    } else {
      const c = raw.contributes;
      checkKnownKeys(
        c,
        ["views", "commands", "iconSets", "fileViewers", "nodes", "programs", "events", "skill"],
        "contributes",
        errors,
      );

      views = parseEntries(c.views, {
        label: "contributes.views",
        required: ["id", "title", "icon"],
        optional: ["placements", "defaultPlacement", "transparent", "nativeSurface"],
        parse: (v, errs) => {
          if (!isNonEmptyString(v.id) || !VIEW_ID_RE.test(v.id)) {
            errs.push("contributes.views: id 는 ^[a-z0-9][a-z0-9-]*$");
            return null;
          }
          if (!validateLocalizedText(v.title, "contributes.views.title", errs)) return null;
          if (!isNonEmptyString(v.icon)) return null;
          let placements: ViewPlacement[] = ["sidebar-right"];
          if (v.placements !== undefined) {
            if (
              !Array.isArray(v.placements) ||
              v.placements.length === 0 ||
              v.placements.some(
                (p) => !VIEW_PLACEMENTS.includes(p as ViewPlacement),
              )
            ) {
              errs.push(
                `contributes.views["${v.id}"].placements: ${VIEW_PLACEMENTS.join("|")} 의 비어있지 않은 배열`,
              );
              return null;
            }
            placements = v.placements as ViewPlacement[];
          }
          let defaultPlacement = placements[0];
          if (v.defaultPlacement !== undefined) {
            if (!placements.includes(v.defaultPlacement as ViewPlacement)) {
              errs.push(
                `contributes.views["${v.id}"].defaultPlacement: placements 에 포함되어야 함`,
              );
              return null;
            }
            defaultPlacement = v.defaultPlacement as ViewPlacement;
          }
          let transparent = false;
          if (v.transparent !== undefined) {
            if (typeof v.transparent !== "boolean") {
              errs.push(`contributes.views["${v.id}"].transparent: boolean`);
              return null;
            }
            transparent = v.transparent;
          }
          let nativeSurface = false;
          if (v.nativeSurface !== undefined) {
            if (typeof v.nativeSurface !== "boolean") {
              errs.push(`contributes.views["${v.id}"].nativeSurface: boolean`);
              return null;
            }
            nativeSurface = v.nativeSurface;
          }
          return {
            id: v.id.trim(),
            title: normalizeText(v.title as LocalizedText),
            icon: (v.icon as string).trim(),
            placements,
            defaultPlacement,
            transparent,
            nativeSurface,
          };
        },
      }, errors);
      checkDuplicates(views.map((v) => v.id), "contributes.views.id", errors);
      if (views.length > 0 && !has("ui")) {
        errors.push('contributes.views: "ui" 권한 선언 필요');
      }

      commands = parseEntries(c.commands, {
        label: "contributes.commands",
        required: ["name", "title"],
        optional: ["danger"],
        parse: (v, errs) => {
          if (!isNonEmptyString(v.name) || !COMMAND_NAME_RE.test(v.name)) {
            errs.push(
              "contributes.commands: name 은 ^[a-z0-9][a-z0-9-]*(.[a-z0-9][a-z0-9-]*)*$",
            );
            return null;
          }
          if (!validateLocalizedText(v.title, "contributes.commands.title", errs))
            return null;
          let danger: "destructive" | "inject" | undefined;
          if (v.danger !== undefined) {
            if (v.danger !== "destructive" && v.danger !== "inject") {
              errs.push('contributes.commands.danger 는 "destructive" | "inject"');
              return null;
            }
            danger = v.danger;
          }
          return {
            name: v.name.trim(),
            title: normalizeText(v.title as LocalizedText),
            ...(danger ? { danger } : {}),
          };
        },
      }, errors);
      checkDuplicates(commands.map((v) => v.name), "contributes.commands.name", errors);
      if (commands.length > 0 && !has("commands")) {
        errors.push('contributes.commands: "commands" 권한 선언 필요');
      }

      iconSets = parseEntries(c.iconSets, {
        label: "contributes.iconSets",
        required: ["id", "title"],
        parse: (v, errs) => {
          if (!isNonEmptyString(v.id) || !VIEW_ID_RE.test(v.id)) {
            errs.push("contributes.iconSets: id 는 ^[a-z0-9][a-z0-9-]*$");
            return null;
          }
          if (!validateLocalizedText(v.title, "contributes.iconSets.title", errs))
            return null;
          return {
            id: v.id.trim(),
            title: normalizeText(v.title as LocalizedText),
          };
        },
      }, errors);
      checkDuplicates(iconSets.map((v) => v.id), "contributes.iconSets.id", errors);
      if (iconSets.length > 0 && !has("ui")) {
        errors.push('contributes.iconSets: "ui" 권한 선언 필요');
      }

      // 파일 뷰어(선언) — id 정규식·중복 거부, extensions 검증("*" 폴백 허용), ui 권한 필수.
      fileViewers = parseEntries(c.fileViewers, {
        label: "contributes.fileViewers",
        required: ["id", "extensions"],
        optional: ["priority"],
        parse: (v, errs) => {
          if (!isNonEmptyString(v.id) || !VIEW_ID_RE.test(v.id)) {
            errs.push("contributes.fileViewers: id 는 ^[a-z0-9][a-z0-9-]*$");
            return null;
          }
          if (
            !Array.isArray(v.extensions) ||
            v.extensions.length === 0 ||
            v.extensions.some(
              (e) => typeof e !== "string" || (e !== "*" && !EXT_RE.test(e)),
            )
          ) {
            errs.push(
              `contributes.fileViewers["${v.id}"].extensions: 확장자(점 없이) 또는 "*"(폴백)의 비어있지 않은 배열`,
            );
            return null;
          }
          if (v.priority !== undefined && typeof v.priority !== "number") {
            errs.push(`contributes.fileViewers["${v.id}"].priority: number`);
            return null;
          }
          return {
            id: v.id.trim(),
            extensions: v.extensions as string[],
            ...(typeof v.priority === "number" ? { priority: v.priority } : {}),
          };
        },
      }, errors);
      checkDuplicates(fileViewers.map((v) => v.id), "contributes.fileViewers.id", errors);
      if (fileViewers.length > 0 && !has("ui")) {
        errors.push('contributes.fileViewers: "ui" 권한 선언 필요');
      }

      // DOM 노출 노드(선언) — command/view 패턴 미러. id 정규식·중복 거부, ui 권한 필수.
      nodes = parseEntries(c.nodes, {
        label: "contributes.nodes",
        required: ["id"],
        optional: ["description", "danger"],
        parse: (v, errs) => {
          if (!isNonEmptyString(v.id) || !VIEW_ID_RE.test(v.id)) {
            errs.push("contributes.nodes: id 는 ^[a-z0-9][a-z0-9-]*$");
            return null;
          }
          if (v.description !== undefined &&
              !validateLocalizedText(v.description, "contributes.nodes.description", errs)) {
            return null;
          }
          if (v.danger !== undefined && v.danger !== true) {
            errs.push("contributes.nodes.danger: true 만 허용");
            return null;
          }
          return {
            id: v.id.trim(),
            ...(v.description !== undefined
              ? { description: normalizeText(v.description as LocalizedText) }
              : {}),
            ...(v.danger === true ? { danger: true as const } : {}),
          };
        },
      }, errors);
      checkDuplicates(nodes.map((v) => v.id), "contributes.nodes.id", errors);
      if (nodes.length > 0 && !has("ui")) {
        errors.push('contributes.nodes: "ui" 권한 선언 필요');
      }

      // 동봉 스킬(단일 객체, 선언형). path = 디렉토리 내부 SKILL.md 상대경로. 탈출(..)·절대경로 거부.
      if (c.skill !== undefined) {
        if (!isRecord(c.skill) || !isNonEmptyString((c.skill as { path?: unknown }).path)) {
          errors.push("contributes.skill: { path: string } 이어야 함");
        } else {
          const p = ((c.skill as { path: string }).path).trim();
          if (p.startsWith("/") || p.split("/").includes("..")) {
            errors.push("contributes.skill.path: 플러그인 디렉토리 내부 상대경로만(절대경로·.. 금지)");
          } else {
            skill = { path: p };
          }
        }
      }

      programs = parseEntries(c.programs, {
        label: "contributes.programs",
        required: ["id", "title", "kind"],
        optional: ["path", "command", "view", "viewPlugin", "ensure"],
        parse: (v, errs) => {
          if (!isNonEmptyString(v.id) || !VIEW_ID_RE.test(v.id)) {
            errs.push("contributes.programs: id 는 ^[a-z0-9][a-z0-9-]*$");
            return null;
          }
          const id = v.id.trim();
          if (
            !validateLocalizedText(
              v.title,
              `contributes.programs["${id}"].title`,
              errs,
            )
          ) {
            return null;
          }
          // kind 는 view 하나로 수렴(코어 터미널 제거 — 터미널도 플러그인 뷰).
          if (v.kind !== "view") {
            errs.push(`contributes.programs["${id}"].kind: "view"`);
            return null;
          }
          let path: LocalizedText | undefined;
          if (v.path !== undefined) {
            if (
              !validateLocalizedText(
                v.path,
                `contributes.programs["${id}"].path`,
                errs,
              )
            ) {
              return null;
            }
            const pathText = v.path as LocalizedText;
            const values =
              typeof pathText === "string" ? [pathText] : Object.values(pathText);
            if (values.some((p) => programPathSegments(p).some((seg) => !seg))) {
              errs.push(
                `contributes.programs["${id}"].path: "/" 구분 카테고리 경로(빈 세그먼트 금지)`,
              );
              return null;
            }
            path =
              typeof pathText === "string"
                ? programPathSegments(pathText).join("/")
                : Object.fromEntries(
                    Object.entries(pathText).map(([k, val]) => [
                      k,
                      programPathSegments(val).join("/"),
                    ]),
                  );
          }
          // view(뷰 id) 필수 — 코어 터미널 제거 후 모든 프로그램은 뷰를 연다.
          if (!isNonEmptyString(v.view)) {
            errs.push(
              `contributes.programs["${id}"].view: 열 뷰 id(contributes.views[].id) 필수`,
            );
            return null;
          }
          // viewPlugin(크로스 플러그인 뷰 소유자) — 선택, 플러그인 id 형식.
          if (v.viewPlugin !== undefined && (!isNonEmptyString(v.viewPlugin) || !PLUGIN_ID_RE.test(v.viewPlugin))) {
            errs.push(
              `contributes.programs["${id}"].viewPlugin: 플러그인 id 형식(^[a-z0-9][a-z0-9-]*$)`,
            );
            return null;
          }
          // command(자동 실행, 선택) — 비공백 문자열. 터미널 뷰가 마운트 시 1회 실행한다.
          if (v.command !== undefined && !isNonEmptyString(v.command)) {
            errs.push(
              `contributes.programs["${id}"].command: 비공백 문자열`,
            );
            return null;
          }
          let ensure: ContributedProgram["ensure"];
          if (v.ensure !== undefined) {
            if (!isRecord(v.ensure)) {
              errs.push(
                `contributes.programs["${id}"].ensure: 객체(bin/install)`,
              );
              return null;
            }
            const e = v.ensure;
            checkKnownKeys(
              e,
              ["bin", "install"],
              `contributes.programs["${id}"].ensure`,
              errs,
            );
            if (!isNonEmptyString(e.bin)) {
              errs.push(`contributes.programs["${id}"].ensure.bin: 필수`);
              return null;
            }
            if (!isRecord(e.install)) {
              errs.push(`contributes.programs["${id}"].ensure.install: 객체 필수`);
              return null;
            }
            const install: Partial<Record<ProgramPlatform, string>> = {};
            for (const [k, val] of Object.entries(e.install)) {
              if (!PROGRAM_PLATFORMS.includes(k as ProgramPlatform)) {
                errs.push(
                  `contributes.programs["${id}"].ensure.install: 플랫폼 키는 ${PROGRAM_PLATFORMS.join("|")}`,
                );
                return null;
              }
              if (!isNonEmptyString(val)) {
                errs.push(
                  `contributes.programs["${id}"].ensure.install.${k}: 비공백 문자열`,
                );
                return null;
              }
              install[k as ProgramPlatform] = val.trim();
            }
            if (Object.keys(install).length === 0) {
              errs.push(
                `contributes.programs["${id}"].ensure.install: 최소 1개 플랫폼 명령 필요`,
              );
              return null;
            }
            ensure = { bin: e.bin.trim(), install };
          }
          return {
            id,
            title: normalizeText(v.title as LocalizedText),
            kind: "view" as const,
            view: (v.view as string).trim(),
            ...(path !== undefined ? { path } : {}),
            ...(v.viewPlugin !== undefined ? { viewPlugin: (v.viewPlugin as string).trim() } : {}),
            ...(v.command !== undefined ? { command: (v.command as string).trim() } : {}),
            ...(ensure !== undefined ? { ensure } : {}),
          };
        },
      }, errors);
      checkDuplicates(programs.map((v) => v.id), "contributes.programs.id", errors);

      // events — 발행 토픽 문자열 배열(정보용). 형식 검증만, 권한 불요. §0-3: 불량이면 거부.
      if (c.events !== undefined) {
        if (
          !Array.isArray(c.events) ||
          !c.events.every(
            (e) => isNonEmptyString(e) && COMMAND_NAME_RE.test(e),
          )
        ) {
          errors.push(
            "contributes.events: 발행 토픽 문자열 배열(^[a-z0-9][a-z0-9-]*(.[a-z0-9][a-z0-9-]*)*$)",
          );
        } else {
          events = c.events.map((e) => (e as string).trim());
          checkDuplicates(events, "contributes.events", errors);
        }
      }
      if (programs.length > 0 && !has("programs")) {
        errors.push('contributes.programs: "programs" 권한 선언 필요');
      }
    }
  }

  if (errors.length > 0) return reject();
  return {
    manifest: {
      spec: SPEC_VERSION,
      id: (raw.id as string).trim(),
      name: normalizeText(raw.name as LocalizedText),
      version: (raw.version as string).trim(),
      description: normalizeText(raw.description as LocalizedText),
      author: raw.author !== undefined ? (raw.author as string).trim() : undefined,
      ...(raw.repo !== undefined ? { repo: (raw.repo as string).trim() } : {}),
      entry,
      minAppVersion:
        raw.minAppVersion !== undefined
          ? (raw.minAppVersion as string).trim()
          : undefined,
      ...(raw.template === true ? { template: true } : {}),
      ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
      ...(libraries.length > 0 ? { libraries } : {}),
      ...(sidecars.length > 0 ? { sidecars } : {}),
      ...(configuration.length > 0 ? { configuration } : {}),
      permissions,
      contributes: { views, commands, iconSets, fileViewers, nodes, programs, events, ...(skill ? { skill } : {}) },
    },
    validation: { ok: true, errors, warnings },
  };
}

// ── §크롬 표준 게이트 — 플러그인 entry(번들) 정적 스캔 ──────────────────────────
// 호스트가 크롬 행 band(탭/헤더)의 높이·배치를 단독 소유한다(테마별 --chrome-row-h 표준). 플러그인이 자기
// CSS 로 그 셀렉터/변수를 덮으면 좌측 사이드바·컨텐츠 탭 정렬이 깨진다 — 적재(활성화) 시 entry 본문을 스캔해
// 명백한 위반(호스트 크롬 셀렉터/변수에 대한 대입)을 거부한다. 전체신뢰 모델이라 동적 CSS(계산 문자열)로
// 우회는 가능 — 이 게이트는 명백한 정적 위반만 막는다(완벽 방어 아님, 침묵 실패 방지 목적).

// 호스트가 단독 소유하는 크롬 셀렉터·변수. 플러그인 CSS 에 등장하면 위반(자기 본문 슬롯만 스타일링해야 함).
export const HOST_CHROME_TOKENS: readonly string[] = [
  ".left-host-tabs",
  ".left-host-tab",
  ".content-tabs",
  ".view-tabs",
  ".view-tab",
  ".ft-header",
  ".plugin-side-head",
  ".titlebar",
  "--chrome-row-h",
  "--header-h",
  "--status-h",
];

// entry 본문에서 호스트 크롬 토큰 위반을 찾는다. CSS 문맥(뒤에 { 또는 : 가 따르는 대입)만 위반으로 본다 —
// 주석·산문 언급은 오탐하지 않게. 반환 = 발견된 토큰 목록(빈 배열이면 통과).
export function scanHostChromeViolations(entrySource: string): string[] {
  const hits: string[] = [];
  for (const tok of HOST_CHROME_TOKENS) {
    const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 셀렉터: `.left-host-tabs {` / `.left-host-tabs.foo,` 처럼 규칙 머리에 등장 + 선언블록.
    // 변수: `--chrome-row-h:` 처럼 정의/대입.
    const re = tok.startsWith("--")
      ? new RegExp(`${esc}\\s*:`)
      : new RegExp(`${esc}(?![\\w-])[^{}\`]*\\{[^}]*:`);
    if (re.test(entrySource)) hits.push(tok);
  }
  return hits;
}
