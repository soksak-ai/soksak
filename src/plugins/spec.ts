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
// 7. 에디터 확장은 호스트의 CodeMirror 모듈만 사용한다. @codemirror/* 를 플러그인이
//    자체 번들하면 인스턴스 이중화로 동작이 깨진다 — api.editor.modules 로 호스트
//    모듈을 제공받아 사용한다(번들 금지).
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
  | "editor" // CM6 확장/언어 매핑/포매터 + 활성 버퍼 읽기/쓰기
  | "storage" // 전용 저장소(~/.soksak/plugins-data/<id>/)
  | "data" // 범용 임베디드 DB(app.data — 네임스페이스 격리·CJK 검색·전 창 watch)
  | "secrets" // 암호화 볼트(app.secrets — API 키/토큰 봉인 저장, 평문 readback 불가·주입 전용)
  | "notify" // OS 알림(푸시)+인앱 배너·소리·딥링크(알림 = 푸시 동급 1급 객체)
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
  "editor",
  "storage",
  "data",
  "secrets",
  "notify",
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
  editor: {
    label: "에디터 확장",
    detail: "에디터 확장·문법 매핑·포매터를 등록하고 열린 파일 내용을 읽고 바꿉니다.",
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
}

export interface ContributedCommand {
  name: string; // 등록명은 plugin.<pluginId>.<name> — 선언 외 등록은 거부됨
  title: LocalizedText;
}

export interface ContributedFormatter {
  id: string;
  title: LocalizedText;
  languages: string[]; // 확장자 목록(점 없이): ["json","ts",…]
}

export interface ContributedLanguage {
  ext: string; // 확장자(점 없이)
  lang: string; // CM6 언어 키(@uiw/codemirror-extensions-langs)
}

export interface ContributedIconSet {
  id: string; // 플러그인 내 고유. 전역 키는 "<pluginId>.<id>"
  title: LocalizedText; // 설정 드롭다운 표시 이름
}

// DOM 노출 노드 — 플러그인이 자기 뷰 안에서 외부(주소 클릭/측정)에 노출하는 요소 "종류"의 선언.
// command 노출 패턴과 동일: 선언하면 동의 화면에 자동 표기(정직한 고지 §0-2). 실제 DOM 요소는 data-node
// 속성으로 인스턴스 부여(동적 목록은 "<id>/<key>"). 선언된 id 기반만 유효 — 미선언은 경고(침묵 금지).
export interface ContributedNode {
  id: string; // 뷰 내 고유 노드 종류. 전역 주소는 ".../view/<pluginId.viewId>/node/<id>[/<key>]"
  description?: LocalizedText; // 동의 화면 설명(무엇을 노출하는지)
  danger?: true; // 민감 노출(동의 화면 ⚠ 강조)
}

// ── §2.6 프로그램 ────────────────────────────────────────────────────────────
// 프로그램 = 새 탭(+) 메뉴의 항목 하나 = 새 뷰를 여는 방법. 내장 프로그램은
// 없다 — 터미널·에이전트·브라우저 전부 플러그인이 기여한다(메뉴·목록에
// 하드코딩 항목 없음). 코어가 소유하는 것은 뷰 능력(terminal/browser kind)
// 뿐이다. 프로그램 id 는 전역 평탄(사용자-facing 인터페이스 — 명령 파라미터·
// 설정값에 그대로 쓰임). 충돌은 등록 시점 에러(§0-3 침묵 실패 금지).
// 미등록 id 사용 시 코어는 능력명("browser")이면 그 능력, 아니면 터미널 뷰로
// 폴백한다(상태·코어 명령의 동작 보장 — 메뉴 항목과는 무관).
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
  // 동작: terminal = 터미널 뷰(+command 자동 실행), browser = 브라우저 뷰(+url),
  // view = 이 플러그인의 contributes.views 중 하나를 콘텐츠 탭으로 연다(+view).
  kind: "terminal" | "browser" | "view";
  command?: string; // kind=terminal 한정: 자동 실행할 셸 명령(생략 = 맨 터미널)
  url?: string; // kind=browser 한정: 시작 URL(생략 = 설정 homeUrl)
  view?: string; // kind=view 한정: 열 플러그인 내 뷰 id(contributes.views[].id)
  // kind=terminal 한정 — 선행 바이너리 보장: 사용자 셸 PATH 에서 bin 을 확인하고
  // 미설치면 공식 설치 명령을 같은 터미널에서 가시 실행한다(은폐 금지).
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
export interface LibraryDep {
  name: string; // 패키지/도구 식별(예: "@google/gemini-cli")
  bin: string; // 설치 후 실행 bin 이름(글로벌 bin 에서 확인·실행)
  install: Partial<Record<ProgramPlatform, string>>; // 플랫폼별 설치 명령(원문 그대로 고지)
  label?: LocalizedText; // 동의 화면 표시명(생략 시 name)
}

// 플러그인 설정 스키마 — 사용자 구성 옵션의 단일 진실. UI(자동 컨트롤)·저장 기본값·검증·CLI/MCP·문서가
// 전부 이 선언에서 파생(선언형 configuration 스키마). 무해(선언형) → 권한 불요. 저장은
// 글로벌(앱 전역)·프로젝트별 오버라이드 2계층(effective = 프로젝트 ?? 글로벌 ?? default).
export type ConfigType = "boolean" | "number" | "string" | "enum";
export const CONFIG_TYPES: readonly ConfigType[] = ["boolean", "number", "string", "enum"];
export interface ConfigSetting {
  key: string; // ^[a-zA-Z][a-zA-Z0-9]*$ — 플러그인 네임스페이스 안에서 유일
  type: ConfigType;
  default: boolean | number | string;
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
  // 사용자 구성 설정 스키마(선택). 글로벌+프로젝트별 오버라이드. 무해(선언형) → 권한 불요.
  configuration?: ConfigSetting[];
  permissions: PluginPermission[];
  contributes: {
    views: ContributedView[]; // "ui" 권한 필수
    commands: ContributedCommand[]; // "commands" 권한 필수
    formatters: ContributedFormatter[]; // "editor" 권한 필수
    languages: ContributedLanguage[]; // "editor" 권한 필수
    iconSets: ContributedIconSet[]; // "ui" 권한 필수
    programs: ContributedProgram[]; // "programs" 권한 필수
    // 이 플러그인이 발행하는 이벤트 토픽(정보용 — 발견성). 런타임 강제 없음(bus/events 는 그대로
    // 동작). 다른 플러그인 작성자가 구독할 토픽을 매니저에서 볼 수 있게 하는 오픈 카탈로그.
    events: string[];
    // DOM 노출 노드 종류(선언). 동의 화면에 표기 — 사용자가 무엇이 외부 클릭 가능한지 보고 동의. "ui" 권한 필수.
    nodes: ContributedNode[];
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
): Record<string, boolean | number | string> {
  const out: Record<string, boolean | number | string> = {};
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
): { ok: true; value: boolean | number | string } | { ok: false; error: string } {
  const k = setting.key;
  switch (setting.type) {
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
        checkKnownKeys(item, ["name", "bin", "install", "label"], `libraries[${i}]`, errors);
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
        const lib: LibraryDep = { name: item.name.trim(), bin: item.bin.trim(), install };
        if (item.label !== undefined) lib.label = normalizeText(item.label as LocalizedText);
        libraries.push(lib);
      });
      checkDuplicates(libraries.map((l) => l.bin), "libraries[].bin", errors);
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
          (type === "enum" && typeof d === "string" && enumVals!.includes(d));
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
          default: d as boolean | number | string,
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
  let formatters: ContributedFormatter[] = [];
  let languages: ContributedLanguage[] = [];
  let iconSets: ContributedIconSet[] = [];
  let nodes: ContributedNode[] = [];
  let programs: ContributedProgram[] = [];
  let events: string[] = [];
  if (raw.contributes !== undefined) {
    if (!isRecord(raw.contributes)) {
      errors.push("contributes: 객체여야 함");
    } else {
      const c = raw.contributes;
      checkKnownKeys(
        c,
        ["views", "commands", "formatters", "languages", "iconSets", "nodes", "programs", "events"],
        "contributes",
        errors,
      );

      views = parseEntries(c.views, {
        label: "contributes.views",
        required: ["id", "title", "icon"],
        optional: ["placements", "defaultPlacement"],
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
          return {
            id: v.id.trim(),
            title: normalizeText(v.title as LocalizedText),
            icon: (v.icon as string).trim(),
            placements,
            defaultPlacement,
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
        parse: (v, errs) => {
          if (!isNonEmptyString(v.name) || !COMMAND_NAME_RE.test(v.name)) {
            errs.push(
              "contributes.commands: name 은 ^[a-z0-9][a-z0-9-]*(.[a-z0-9][a-z0-9-]*)*$",
            );
            return null;
          }
          if (!validateLocalizedText(v.title, "contributes.commands.title", errs))
            return null;
          return {
            name: v.name.trim(),
            title: normalizeText(v.title as LocalizedText),
          };
        },
      }, errors);
      checkDuplicates(commands.map((v) => v.name), "contributes.commands.name", errors);
      if (commands.length > 0 && !has("commands")) {
        errors.push('contributes.commands: "commands" 권한 선언 필요');
      }

      formatters = parseEntries(c.formatters, {
        label: "contributes.formatters",
        required: ["id", "title", "languages"],
        parse: (v, errs) => {
          if (!isNonEmptyString(v.id) || !VIEW_ID_RE.test(v.id)) {
            errs.push("contributes.formatters: id 는 ^[a-z0-9][a-z0-9-]*$");
            return null;
          }
          if (!validateLocalizedText(v.title, "contributes.formatters.title", errs))
            return null;
          if (
            !Array.isArray(v.languages) ||
            v.languages.length === 0 ||
            v.languages.some((l) => typeof l !== "string" || !EXT_RE.test(l))
          ) {
            errs.push(
              `contributes.formatters["${v.id}"].languages: 확장자(점 없이) 비어있지 않은 배열`,
            );
            return null;
          }
          return {
            id: v.id.trim(),
            title: normalizeText(v.title as LocalizedText),
            languages: v.languages as string[],
          };
        },
      }, errors);
      checkDuplicates(formatters.map((v) => v.id), "contributes.formatters.id", errors);
      if (formatters.length > 0 && !has("editor")) {
        errors.push('contributes.formatters: "editor" 권한 선언 필요');
      }

      languages = parseEntries(c.languages, {
        label: "contributes.languages",
        required: ["ext", "lang"],
        parse: (v, errs) => {
          if (!isNonEmptyString(v.ext) || !EXT_RE.test(v.ext)) {
            errs.push("contributes.languages: ext 는 확장자(점 없이, 소문자/숫자)");
            return null;
          }
          if (!isNonEmptyString(v.lang)) return null;
          return { ext: v.ext.trim(), lang: (v.lang as string).trim() };
        },
      }, errors);
      checkDuplicates(languages.map((v) => v.ext), "contributes.languages.ext", errors);
      if (languages.length > 0 && !has("editor")) {
        errors.push('contributes.languages: "editor" 권한 선언 필요');
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

      programs = parseEntries(c.programs, {
        label: "contributes.programs",
        required: ["id", "title", "kind"],
        optional: ["path", "command", "url", "view", "ensure"],
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
          if (v.kind !== "terminal" && v.kind !== "browser" && v.kind !== "view") {
            errs.push(`contributes.programs["${id}"].kind: terminal|browser|view`);
            return null;
          }
          const kind = v.kind;
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
          // kind 정합: 동의 화면이 보여줄 동작 선언이 모호하면 거부.
          if (v.command !== undefined) {
            if (kind !== "terminal" || !isNonEmptyString(v.command)) {
              errs.push(
                `contributes.programs["${id}"].command: kind=terminal 한정 비공백 문자열`,
              );
              return null;
            }
          }
          if (v.url !== undefined) {
            if (kind !== "browser" || !isNonEmptyString(v.url)) {
              errs.push(
                `contributes.programs["${id}"].url: kind=browser 한정 비공백 문자열`,
              );
              return null;
            }
          }
          if (v.view !== undefined && (kind !== "view" || !isNonEmptyString(v.view))) {
            errs.push(
              `contributes.programs["${id}"].view: kind=view 한정 비공백 문자열`,
            );
            return null;
          }
          if (kind === "view" && !isNonEmptyString(v.view)) {
            errs.push(
              `contributes.programs["${id}"].view: kind=view 는 view(뷰 id) 필수`,
            );
            return null;
          }
          let ensure: ContributedProgram["ensure"];
          if (v.ensure !== undefined) {
            if (kind !== "terminal" || !isRecord(v.ensure)) {
              errs.push(
                `contributes.programs["${id}"].ensure: kind=terminal 한정 객체`,
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
            kind,
            ...(path !== undefined ? { path } : {}),
            ...(v.command !== undefined ? { command: (v.command as string).trim() } : {}),
            ...(v.url !== undefined ? { url: (v.url as string).trim() } : {}),
            ...(v.view !== undefined ? { view: (v.view as string).trim() } : {}),
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
      ...(configuration.length > 0 ? { configuration } : {}),
      permissions,
      contributes: { views, commands, formatters, languages, iconSets, nodes, programs, events },
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
