// §1 권한 — 플러그인 권한 어휘와 동의 화면 고지문의 단일진실.
// 권한은 opaque sandbox와 native host 사이 capability broker의 허용 목록이다. 매니페스트
// 동의와 런타임 principal 검증을 모두 통과한 명시 operation만 호스트가 실행한다.
// PERMISSION_INFO 는 동의 화면용 정직한 고지 — caution = 강조 표시 대상.

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
  | "service" // 상주 plugin service — 코어가 스폰·라우팅하는 커맨드 소유 프로세스(service 선언 필수 — docs/PLUGIN-SERVICE.md)
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
  | "network"; // sandbox 직접 네트워크는 차단; brokered network operation만 허용

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
  "service",
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
    detail: "상태바에 정적 선언 항목을 추가하고, 클릭하면 선언된 자기 명령을 실행합니다(크롬 영역).",
  },
  "ui:titlebar": {
    label: "헤더 아이콘",
    detail:
      "타이틀바 우측에 정적 선언 액션을 추가하고, 클릭하면 선언된 자기 명령을 실행합니다(크롬 영역).",
  },
  "ui:overlay:pane": {
    label: "패널 오버레이",
    detail:
      "콘텐츠 패널 하나를 덮는 격리 오버레이를 제공할 수 있습니다. 처음에는 숨김이며 표시·입력 허용은 호스트가 제어합니다.",
    caution: true,
  },
  "ui:overlay:screen": {
    label: "전체화면 레이어",
    detail:
      "앱 전체를 덮는 격리 레이어를 제공할 수 있습니다. 처음에는 숨김이며 표시·입력 허용은 호스트가 제어합니다(가장 침습적).",
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
  service: {
    label: "상주 서비스 실행",
    detail:
      "이 플러그인의 커맨드를 구현하는 상주 네이티브 프로세스를 앱이 스폰하고 커맨드를 그 프로세스로 라우팅합니다(네이티브 코드 실행 — 앱이 켜져 있는 동안 상주). 매니페스트 service 선언의 사이드카 바이너리만 실행됩니다.",
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
  network: {
    label: "네트워크",
    detail:
      "격리 문서의 직접 네트워크는 차단되며, 허용된 호스트 네트워크 작업으로 외부 요청을 보낼 수 있습니다.",
    caution: true,
  },
};
