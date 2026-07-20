import { execute } from "./commands/registry";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import { listenThisWindow } from "./lib/windowEvents";
import { addProjectClaimed, closeProjectReleased, useOtherWindowProjects } from "./state/projectRegistry";
import { removeRecentProject, useRecentProjects } from "./state/recentProjects";
import { rafThrottle } from "./lib/rafThrottle";
import { parkedStyle } from "./lib/layerPark";
import { emitPluginEvent } from "./plugins/hooks";
import { resolveTerminalProgram } from "./plugins/terminalEngine";
import {
  activeSessionViewId,
  startViewFocusSync,
  transferViewFocus,
} from "./plugins/viewFocus";
import { LeftSidebarHost } from "./components/LeftSidebarHost";
import { PluginSidebar } from "./components/PluginSidebar";
import { ContentTabs } from "./components/ContentTabs";
import { GroupArea } from "./components/GroupArea";
import { NewProjectModal } from "./components/NewProjectModal";
import { ProjectSettingsModal } from "./components/ProjectSettingsModal";
import { Icon } from "./ui/icons/Icon";
import { validateProjectRoot } from "./lib/projectRoot";
// 워드마크 로고 — fill 이 currentColor 상속이라 테마를 자동 추종(정적 신뢰 에셋).
import logoRaw from "./assets/soksak_logo.svg?raw";
import { SettingsModal } from "./components/SettingsModal";
import { ConfirmCloseModal } from "./components/ConfirmCloseModal";
import { RemoteConfirmModal } from "./components/RemoteConfirmModal";
import { RecoverySetupModal } from "./components/RecoverySetupModal";
import { RecoveryEnterModal } from "./components/RecoveryEnterModal";
import { wireRemoteConfirm } from "./state/remoteConfirmWire";
import { installRemoteConfirmDevTrigger } from "./state/remoteConfirmDev";
import { ConsentPreviewHost } from "./components/ConsentPreviewHost";
import { NotifyHost } from "./ui/NotifyHost";
import { PluginHeaderActions } from "./ui/PluginHeaderActions";
import { useUi } from "./state/ui";
import { useDividerHover } from "./state/dividerHover";
import { useT } from "./i18n";
import {
  allGroups,
  cwdPaneOf as resolveCwdPane,
  useSessions,
  webviewDisplayName,
  type ProjectTab,
} from "./state/sessions";
import {
  useSettings,
  type TabPosition,
  type RightSidebarMode,
} from "./state/settings";
import { useTheme } from "./state/theme";
import { getPtyIo, hasPtyObservation } from "./terminal/ptyObservationStore";
import "./App.css";

// 파일 경로를 셸·Claude Code 양쪽에서 안전하게: 영숫자와 안전문자 외에는 백슬래시
// 이스케이프(공백 포함). 결과가 ...img.png 처럼 따옴표 없이 확장자로 끝나 Claude Code
// 의 이미지 확장자 정규식과 셸 둘 다에 맞는다.
const shellEscape = (p: string) => p.replace(/[^A-Za-z0-9_./@%+:,=-]/g, "\\$&");

// 좌측 사이드바(파일 트리) 폭 범위(CSS px). 실제 폭은 드래그로 조절(전역, localStorage 영속).
const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 640;
const SIDEBAR_DEFAULT = 320;
// 우측 플러그인 사이드바 폭 범위.
const RIGHT_MIN = 200;
const RIGHT_MAX = 640;
const RIGHT_DEFAULT = 300;
// 좌측 프로젝트 레일 폭.
// 레퍼런스(soksak_final): 프로젝트 레일 기본 54px, 드래그 44–110px.
const RAIL_MIN = 44;
const RAIL_MAX = 110;
const RAIL_DEFAULT = 54;

// 드래그로 폭을 조절하는 패널 공용 훅(localStorage 영속). dir = 패널이 붙은 쪽:
// left(기본) 는 우측 핸들을 오른쪽으로 끌면 폭이 늘고, right 는 좌측 핸들이라 부호 반전.
function useResizableWidth(
  key: string,
  def: number,
  min: number,
  max: number,
  dir: "left" | "right" = "left",
) {
  const [w, setW] = useState<number>(() => {
    const v = Number(localStorage.getItem(key));
    return v >= min && v <= max ? v : def;
  });
  // begin 은 참조 안정(useCallback) — memo 된 ProjectPane 에 prop 으로 내려가도
  // 경계를 깨지 않는다(원칙 2). 현재 폭은 ref 로 읽는다.
  const wRef = useRef(w);
  wRef.current = w;
  const begin = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = wRef.current;
    const sign = dir === "left" ? 1 : -1;
    // 폭 상태 갱신은 프레임당 1회(원칙 4) — App 수준 상태라 리렌더 비용이 크다.
    const commitW = rafThrottle((next: number) => setW(next));
    const onMove = (ev: MouseEvent) =>
      commitW(
        Math.min(max, Math.max(min, startW + sign * (ev.clientX - startX))),
      );
    const onUp = () => {
      commitW.flush(); // 리스너 제거 전에 — 마지막 프레임 유실 = 스냅백.
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setW((cur) => {
        localStorage.setItem(key, String(cur));
        return cur;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    // key/min/max/dir 은 호출 지점마다 상수.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, min, max, dir]);
  return [w, begin] as const;
}

// 프로젝트 1개의 본문(좌측 사이드바 + 컨텐츠 + 우측 플러그인 사이드바).
// memo 경계 = project 데이터 경계(원칙 2, docs/PERFORMANCE.md): 프로젝트 X 의
// store 쓰기는 프로젝트 Y 의 객체 정체성을 보존(mapProject)하므로 Y 서브트리는
// 리렌더되지 않는다. 모든 prop 은 참조/값 안정이어야 한다 — 커스텀 비교자 금지.
const ProjectPane = memo(function ProjectPane({
  project,
  isActiveProject,
  sidebarW,
  rightW,
  rightMode,
  contentTabPosition,
  startResize,
  startRightResize,
}: {
  project: ProjectTab;
  isActiveProject: boolean;
  sidebarW: number;
  rightW: number;
  rightMode: RightSidebarMode;
  contentTabPosition: TabPosition;
  startResize: (e: React.MouseEvent) => void;
  startRightResize: (e: React.MouseEvent) => void;
}) {
  const t = useT();
  // 콘텐츠 탭 전환 시 비활성 슬롯은 화면 밖으로 파킹된다(parkedStyle transform). 그 파킹/언파킹은
  // 이 렌더 커밋에서 DOM 에 반영되므로, 커밋 직후(useLayoutEffect, paint 전) 코어가 layout.reflow 를
  // 발화한다 → 네이티브 webview 를 소유한 플러그인(브라우저)이 최종 앵커로 bounds 를 1회 재스냅해
  // 클릭에 즉시 반응한다. 전환 신호(view.activated)는 store diff 마이크로태스크라 커밋 전이라 여기서
  // 못 쓴다(그걸로 측정하면 옛 위치를 읽어 webview 가 한 박자 늦는다).
  useLayoutEffect(() => {
    emitPluginEvent("layout.reflow", { activeSpaceId: project.activeContentId });
  }, [project.activeContentId, isActiveProject]);
  return (
    <div
      className="terminal-pane"
      // 비활성 프로젝트도 화면 밖으로 파킹한다(R12 단일 진실) — visibility:hidden 은 DOM 만 감추고
      // GPU 레이어(터미널 WebGL)와 네이티브 child(브라우저 webview)는 그대로 합성된다. 콘텐츠·뷰 슬롯과
      // 같은 헬퍼를 쓰는 이유가 그것이다(층 간 일치). 프로젝트를 전환해도 이전 브라우저가 화면에
      // 남던 결함이 이 층의 누락이었다.
      style={parkedStyle(isActiveProject)}
    >
      {/* 좌측 파일 트리 사이드바. 닫히면 width 0(언마운트 X → 상태 유지).
          닫힐 때 우측 보더도 함께 제거 — 0폭이어도 보더는 1px 선으로 남아
          사이드바 밖에 보더가 걸린 것처럼 보이기 때문. */}
      <div
        className="sidebar"
        style={{
          width: project.sidebarOpen ? sidebarW : 0,
          borderRightWidth: project.sidebarOpen ? 1 : 0,
        }}
      >
        <LeftSidebarHost
          project={project}
          paneId={cwdPaneOf(project) ?? ""}
        />
      </div>
      {project.sidebarOpen && (
        <div
          className="sidebar-resizer"
          onMouseDown={startResize}
          title="사이드바 폭 조절"
        />
      )}

      {/* 콘텐츠 영역: 컨텐츠 탭 바 + 각 컨텐츠의 에디터 그룹 그리드.
          탭 위치 left 면 가로(행)로 배치해 좌측 세로 스트립 + 본문. */}
      <div
        className={`content${contentTabPosition === "left" ? " ctabs-left" : ""}`}
      >
        {project.rootMissing && (
          <div className="root-missing-banner" data-node="banner/root-missing">
            {t("project.rootMissing", { root: project.root })}
          </div>
        )}
        <ContentTabs
          project={project}
          vertical={contentTabPosition === "left"}
        />
        <div className="content-body">
          {project.contents.map((c) => {
            const isActiveContent = c.id === project.activeContentId;
            return (
              <div
                key={c.id}
                className="content-pane"
                // 비활성 콘텐츠는 화면 밖으로 파킹(R12 단일 진실) — visibility:hidden 만으로는 그 안의
                // 터미널 WebGL 캔버스가 GPU 레이어로 합성돼 활성 콘텐츠의 브라우저 홀로 비친다. 뷰 슬롯
                // (GroupArea)과 동일 규칙을 같은 헬퍼로 적용(층 간 일치).
                style={parkedStyle(isActiveContent)}
              >
                <GroupArea
                  content={c}
                  projectId={project.id}
                  surfaceActive={isActiveProject && isActiveContent}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* 우측 플러그인 사이드바(⌥⌘B). 닫히면 width 0(언마운트 X — keep-alive). */}
      {project.rightOpen && (
        <div
          className="sidebar-right-resizer"
          style={{ right: rightW - 2 }}
          onMouseDown={startRightResize}
          title={t("plugin.sidebar.resize")}
        />
      )}
      <div
        className={`sidebar-right${project.rightOpen ? " open" : ""}${rightMode === "push" ? " push" : ""}`}
        style={{
          width: project.rightOpen ? rightW : 0,
          borderLeftWidth: project.rightOpen ? 1 : 0,
        }}
      >
        <PluginSidebar projectId={project.id} />
      </div>
    </div>
  );
});

// 프로젝트의 사이드바(파일트리)가 따라갈 터미널 pane(= 현재 cwd 출처). 순수 resolver 는
// sessions.cwdPaneOf — 여기서는 PTY 관찰 predicate(hasPtyObservation)를 주입해 호출한다.
// 코어/플러그인 터미널 구분 없음 — PTY substrate 를 구동하는(관찰을 가진) 뷰면 따라간다.
const cwdPaneOf = (project: ProjectTab): string | undefined =>
  resolveCwdPane(project, hasPtyObservation);

// 빌드 정체성 배지: DEV(HMR 개발 서버) / DEBUG(디버그 번들 soksak-debug) / 없음(릴리스).
// HMR 은 import.meta.env.DEV 로 즉시 알고, 빌드 번들(DEV=false)은 둘을 앱 이름(getName)
// 으로 가른다 — productName 이 soksak-dev / soksak-debug / soksak 로 정체성을 인코딩한다.
function BuildBadge() {
  const [label, setLabel] = useState<string | null>(
    import.meta.env.DEV ? "DEV" : null,
  );
  useEffect(() => {
    if (import.meta.env.DEV) return;
    let alive = true;
    import("@tauri-apps/api/app")
      .then((m) => m.getName())
      .then((name) => {
        if (alive && name.includes("debug")) setLabel("DEBUG");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (!label) return null;
  return (
    <span className={`dev-badge${label === "DEBUG" ? " debug" : ""}`}>
      {label}
    </span>
  );
}

// webview 복구 소진 배지 — 코어(webview_health)가 이 창에 emit_to 한 건강 전이 중
// open(자동 복구 상한 소진)만 비차단 배지로 알린다. 블로킹 다이얼로그 금지 — 멀티윈도우에서
// 한 child 의 크래시가 전체를 모달로 막지 못하게 한다. "다시 불러오기" = webview.recover
// 와 동일 코어 경로(브레이커 reset + 제자리 reload). recovering/closed 전이가 오면 그
// label 의 배지를 걷는다(정상 복귀·복구 재개 모두 배지 사유 소멸).
function WebviewHealthBadges() {
  const t = useT();
  // 배지는 사용자 표면 — raw label(b-<창>-<viewId>) 대신 탭 표시명으로 해소한다
  // (webviewDisplayName). 식별(key·data-node·recover 인자)은 label 유지 — 기계 경로 불변.
  const tabs = useSessions((s) => s.tabs);
  const [openLabels, setOpenLabels] = useState<string[]>([]);
  useEffect(() => {
    return listenThisWindow<{ label: string; state: string }>(
      "webview-health",
      (e) => {
        const { label, state } = e.payload;
        setOpenLabels((prev) =>
          state === "open"
            ? prev.includes(label)
              ? prev
              : [...prev, label]
            : prev.filter((l) => l !== label),
        );
      },
    );
  }, []);
  if (openLabels.length === 0) return null;
  return (
    <div className="webview-health-badges">
      {openLabels.map((label) => (
        <div key={label} className="webview-health-badge">
          <span>
            {t("webview.exhausted", { label: webviewDisplayName(label, tabs) })}
          </span>
          <button
            type="button"
            data-node={`webview/recover/${label}`}
            onClick={() => {
              void invoke("webview_recover", { label }).catch((err) =>
                console.error("webview 수동 복구 실패:", err),
              );
            }}
          >
            {t("webview.recoverAction")}
          </button>
          <button
            type="button"
            aria-label={t("common.cancel")}
            onClick={() =>
              setOpenLabels((prev) => prev.filter((l) => l !== label))
            }
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function App() {
  const t = useT();
  const settingsSection = useUi((s) => s.settingsSection);
  const setSettingsSection = useUi((s) => s.setSettingsSection);
  const projectTabPosition = useSettings((s) => s.projectTabPosition);
  const contentTabPosition = useSettings((s) => s.contentTabPosition);
  const rightSidebarMode = useSettings((s) => s.rightSidebarMode);

  // 테마 시스템(토큰 슬롯)이 단일 소스 — CSS 변수/구조 속성은 테마 엔진이 적용한다.
  const effectiveMode = useTheme((s) => s.effectiveMode);
  const toggleMode = useTheme((s) => s.toggleMode);
  const reloadThemes = useTheme((s) => s.reload);
  const isDark = effectiveMode === "dark";

  // 시작 시 외부 테마(~/.soksak/themes) 1회 스캔.
  useEffect(() => {
    reloadThemes().catch((e) => console.error("테마 스캔 실패:", e));
  }, [reloadThemes]);

  // 아이콘 버튼 라운드박스 — 루트 어트리뷰트로 CSS 분기(data-pane-style 과 동형).
  const iconBox = useSettings((s) => s.iconBox);
  useEffect(() => {
    document.documentElement.dataset.iconBox = iconBox ? "on" : "off";
  }, [iconBox]);

  // 포커스 그룹 표시 스타일(outline|corners) — 루트 어트리뷰트로 CSS 분기.
  const focusIndicator = useSettings((s) => s.focusIndicator);
  useEffect(() => {
    document.documentElement.dataset.focusInd = focusIndicator;
  }, [focusIndicator]);

  // 원격 destructive confirm 배선(폰-링크 안전모델) — Rust app.emit("remote-confirm-request")를
  // store 큐에 잇고, 결정 sink 를 remote_confirm_resolve 로 잇는다(데스크톱 단일 권위). 부팅 1회.
  useEffect(() => wireRemoteConfirm(), []);

  // 활성 project/space/panel/view 체인과 실제 키보드 포커스는 하나의 계약이다.
  // 마운트 시 자동포커스하지 않고, 최신 활성 뷰 의도만 provider 에 전달한다.
  useEffect(() => startViewFocusSync(), []);

  // dev 전용 mock 트리거 — 라이브 폰 없이 모달을 띄워 시각 검증(import.meta.env.DEV 게이트). 프로덕션
  // 번들(DEV=false)에선 아무것도 설치 안 한다. window.__soksakMockRemoteConfirm() 으로 mock 요청 emit.
  useEffect(() => installRemoteConfirmDevTrigger(), []);

  // 앱 UI(앱 크롬) 전역 폰트 — 코어 소유. 터미널 폰트와 무관(터미널 플러그인 별도 소유).
  // appFontFamily → --app-font(루트 font-family), appFontSize → --app-font-size(루트 font-size).
  const appFontFamily = useSettings((s) => s.appFontFamily);
  const appFontSize = useSettings((s) => s.appFontSize);
  useEffect(() => {
    document.documentElement.style.setProperty("--app-font", appFontFamily);
  }, [appFontFamily]);
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--app-font-size",
      `${appFontSize}px`,
    );
  }, [appFontSize]);

  // 네이티브 child webview(브라우저) 위 클릭은 메인 DOM 에 이벤트가 오지 않아
  // 포커스 추적이 끊긴다 — 네이티브 모니터(browser.rs)가 emit 한 좌표를
  // elementFromPoint 로 판정해 그룹을 활성화한다. 모달 등이 위에 떠 있으면
  // 그 요소가 잡혀 자연 차단되고, DOM 클릭과 중복돼도 같은 결과라 무해.
  useEffect(() => {
    // 이 창에 emit_to 된 native-mouse* 만 받는다(전역 listen 이면 다른 창 이벤트도 받아 엉뚱한 창을
    // 건드림). lib/windowEvents 머리말 참조.
    //
    // 두 역할: (1) 포커스 — mousedown 좌표의 그룹 활성화. (2) 분할 divider 리사이즈 — 네이티브 child
    // (브라우저 등)는 OS 뷰라 그 위의 mousedown/move/up 이 DOM 에 오지 않아, 그 위를 지나는 divider 를
    // 드래그로 못 잡는다. 좌표의 divider(elementFromPoint 는 DOM 만 보므로 네이티브 위여도 divider 반환)
    // 에 합성 마우스 이벤트를 재생해 기존 드래그 로직(GroupArea 의 window mousemove/up 리스너)을 그대로
    // 구동한다 → gap 이나 child 숨김 없이, 화면을 꽉 채운 채 리사이즈. GroupArea 가 중복 시작을 가드한다
    // (divider 가 gap 위면 실제 DOM 이벤트와 이 합성이 겹칠 수 있음).
    const fire = (target: EventTarget, type: string, x: number, y: number) =>
      target.dispatchEvent(
        new MouseEvent(type, {
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: type === "mouseup" ? 0 : 1,
          view: window, // React 위임이 SyntheticEvent 를 만들려면 view(defaultView)가 필요할 수 있다.
        }),
      );
    let dragging = false;
    const offDown = listenThisWindow<{ x: number; y: number }>("native-mousedown", (e) => {
      const { x, y } = e.payload;
      const el = document.elementFromPoint(x, y);
      // 네이티브 child 위 드래그 중계 대상: 분할 divider + [data-native-drag] 선언 요소(범용 계약 —
      // 플러그인 내부 리사이저 등). 드래그가 child 영역에 들어가면 실 이벤트는 child 가 삼키므로,
      // 여기서 mousedown 을 쏘고 move/up 을 window 로 중계해야 DOM 드래그가 이어진다.
      const divider = el?.closest<HTMLElement>(".egroup-divider, [data-native-drag]");
      if (divider) {
        dragging = true;
        fire(divider, "mousedown", x, y);
        return;
      }
      const slot = el?.closest<HTMLElement>("[data-group-id]");
      const { groupId, projectId } = slot?.dataset ?? {};
      if (groupId && projectId) {
        const state = useSessions.getState();
        const project = state.tabs.find((item) => item.id === projectId);
        const space = project?.contents.find(
          (item) => item.id === project.activeContentId,
        );
        const group = space
          ? allGroups(space.layout).find((item) => item.id === groupId)
          : null;
        const targetViewId = group?.activeViewId;
        if (targetViewId) {
          transferViewFocus(activeSessionViewId(), targetViewId, () =>
            state.setActiveGroup(projectId, groupId),
          );
        } else {
          state.setActiveGroup(projectId, groupId);
        }
      }
    });
    const offMove = listenThisWindow<{ x: number; y: number }>("native-mousemove", (e) => {
      if (dragging) {
        fire(window, "mousemove", e.payload.x, e.payload.y);
        return;
      }
      // hover(버튼 안 누름) — 네이티브 child 위에선 divider :hover 가 발동하지 않으므로, 좌표의 divider
      // (elementFromPoint 는 DOM 만 보므로 네이티브 밑의 divider 를 반환)를 store 에 기록한다. GroupArea 가
      // 그걸 강조 + 좌우 셀을 잠깐 물려 divider 를 드러낸다. divider 아니면 null(강조 해제).
      const el = document.elementFromPoint(e.payload.x, e.payload.y);
      const div = el?.closest<HTMLElement>(".egroup-divider");
      useDividerHover.getState().set(div?.dataset.dividerKey ?? null);
    });
    const offUp = listenThisWindow<{ x: number; y: number }>("native-mouseup", (e) => {
      if (!dragging) return;
      dragging = false;
      fire(window, "mouseup", e.payload.x, e.payload.y);
    });
    return () => {
      offDown();
      offMove();
      offUp();
    };
  }, []);

  // hover/드래그 중인 divider → 코어가 그 화면 rect 에 accent 바를 브라우저 위(네이티브)에 그린다.
  // 네이티브 child 위에선 DOM 강조가 안 보이므로 유일한 길. rAF 추적 루프: 드래그(리사이즈)로 DOM
  // divider 가 움직이면 매 프레임 rect 를 재측정해 네이티브 바가 정확히 따라간다 — 1회성 배치는 드래그
  // 중 바가 제자리에 남는다(회귀). rect 가 안 변한 프레임은 IPC 를 보내지 않는다(변화시에만 invoke).
  const dividerHoverKey = useDividerHover((s) => s.key);
  useEffect(() => {
    const send = (rect: { x: number; y: number; w: number; h: number } | null) => {
      void invoke("webview_divider_highlight", { rect }).catch(() => {});
    };
    if (!dividerHoverKey) {
      send(null);
      return;
    }
    const sel = `.egroup-divider[data-divider-key="${CSS.escape(dividerHoverKey)}"]`;
    let raf = 0;
    let last = "";
    const tick = () => {
      const el = document.querySelector(sel);
      if (el instanceof HTMLElement) {
        const r = el.getBoundingClientRect();
        const sig = `${r.left.toFixed(1)},${r.top.toFixed(1)},${r.width.toFixed(1)},${r.height.toFixed(1)}`;
        if (sig !== last) {
          last = sig;
          send({ x: r.left, y: r.top, w: r.width, h: r.height });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      send(null);
    };
  }, [dividerHoverKey]);

  // 구독 최소 원칙(docs/PERFORMANCE.md 1): 필드/액션별 셀렉터만 — bare 훅 금지.
  // zustand 액션은 create() 시점에 고정되는 안정 참조라 액션 셀렉터는 리렌더 없음.
  const tabs = useSessions((s) => s.tabs);
  const activeId = useSessions((s) => s.activeId);
  const setActive = useSessions((s) => s.setActive);
  const toggleSidebar = useSessions((s) => s.toggleSidebar);
  const toggleRightSidebar = useSessions((s) => s.toggleRightSidebar);
  const addViewToGroup = useSessions((s) => s.addViewToGroup);
  const closeView = useSessions((s) => s.closeView);
  // 프로젝트 설정 모달(이름/색) 대상 프로젝트 id.
  const [projectSettingsFor, setProjectSettingsFor] = useState<string | null>(
    null,
  );
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const activeProject = tabs.find((t) => t.id === activeId);

  // spawn 옵션 provider 는 main.tsx 부트(렌더 전)가 등록한다 — effect(마운트
  // 후)는 자식 PaneLeaf ref 의 첫 spawn 보다 늦어 첫 터미널이 cwd 없이(홈)
  // 시작하던 잠복 버그의 원인이었다.

  // 드래그로 조절되는 패널 폭들(전역, localStorage 영속).
  const [sidebarW, startResize] = useResizableWidth(
    "sidebarW",
    SIDEBAR_DEFAULT,
    SIDEBAR_MIN,
    SIDEBAR_MAX,
  );
  const [railW, startRailResize] = useResizableWidth(
    "railW",
    RAIL_DEFAULT,
    RAIL_MIN,
    RAIL_MAX,
  );
  const [rightW, startRightResize] = useResizableWidth(
    "rightSidebarW",
    RIGHT_DEFAULT,
    RIGHT_MIN,
    RIGHT_MAX,
    "right",
  );

  // 우측 사이드바(.sidebar-right)는 풀사이즈 브라우저 webview 위에 뜬 DOM 오버레이다
  // (position:absolute, z-index 20). 그 사각형을 네이티브 hit_test 의 "홀"로 보고하면
  // 그 영역의 스크롤/클릭이 아래 브라우저로 새지 않고 DOM(사이드바)이 받는다. webview 는
  // 풀사이즈 그대로 유지된다(과거의 webview 폭 클램프 우회는 폐지 — browser.rs 참조).
  // push 모드면 사이드바가 in-flow로 영역을 차지(콘텐츠·webview가 이미 좁아짐) → 오버레이 홀 불필요.
  const rightRect =
    activeProject?.rightOpen && rightSidebarMode !== "push" ? rightW : 0;
  useLayoutEffect(() => {
    // 닫힘(rightOpen false 또는 폭 0)이면 홀 비움.
    if (!activeProject?.rightOpen || rightW <= 0) {
      invoke("webview_dom_holes", { holes: [] }).catch(() => {});
      return;
    }
    // 폭 변경 등 레이아웃이 커밋된 *다음* 프레임에 측정한다 — rAF 전엔 사이드바 폭이
    // 아직 반영 전이라 rect 가 어긋난다.
    const report = () => {
      const sb = document.querySelector(".sidebar-right.open");
      if (!sb) {
        invoke("webview_dom_holes", { holes: [] }).catch(() => {});
        return;
      }
      const r = sb.getBoundingClientRect();
      invoke("webview_dom_holes", {
        holes: [{ x: r.left, y: r.top, w: r.width, h: r.height }],
      }).catch(() => {});
    };
    const raf = requestAnimationFrame(report);
    // 창 리사이즈도 사이드바 rect(우변 고정·높이)를 옮긴다 — 다시 측정.
    const onWinResize = () => requestAnimationFrame(report);
    window.addEventListener("resize", onWinResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onWinResize);
    };
    // rightRect = rightOpen·rightW 의 단일 파생 — 둘 중 무엇이 바뀌어도 재측정.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightRect]);

  // 터미널 테마·세션 폐기는 코어가 소유하지 않는다 — 터미널 플러그인이 자기 뷰의 xterm 테마를
  // app 테마 토큰으로 적용하고, 뷰 언마운트(PluginViewHost) 시 PTY 세션을 스스로 정리한다.

  // 키보드 단축키(캡처 단계 → xterm 보다 먼저). 활성 프로젝트의 활성 뷰 기준.
  // ⌘D 좌우분할 / ⌘⇧D 상하분할 / ⌘W pane→뷰 닫기 / ⌘T 새 터미널 / ⌘B 사이드바.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      const key = e.key.toLowerCase();
      // ⌘N 새 창(독립 작업공간) — 프로젝트 무관이라 가장 먼저 처리.
      if (key === "n" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        invoke("window_create").catch((err) => console.error("새 창 실패:", err));
        return;
      }
      // ⌘+ 앱 글자 크게 / ⌘- 작게 / ⌘0 기본(13). 앱 UI(앱 크롬) 전역 폰트만 — 코어 소유.
      // 터미널 폰트는 터미널 플러그인이 별도로 소유한다(여기서 건드리지 않음).
      if (key === "=" || key === "+") {
        e.preventDefault();
        const st = useSettings.getState();
        st.setAppFontSize(st.appFontSize + 1);
        return;
      } else if (key === "-") {
        e.preventDefault();
        const st = useSettings.getState();
        st.setAppFontSize(st.appFontSize - 1);
        return;
      } else if (key === "0") {
        e.preventDefault();
        useSettings.getState().setAppFontSize(13);
        return;
      }
      const s = useSessions.getState();
      const project = s.tabs.find((t) => t.id === s.activeId);
      if (!project) return;
      const content =
        project.contents.find((c) => c.id === project.activeContentId) ??
        project.contents[0];
      if (!content) return;
      // ⌥⌘B 우측 플러그인 사이드바. ⌥ 조합은 e.key 가 합성문자("∫")라 e.code 로 판정.
      if (e.altKey && !e.shiftKey && e.code === "KeyB") {
        e.preventDefault();
        toggleRightSidebar(project.id);
        return;
      }
      const groups = allGroups(content.layout);
      const grp =
        groups.find((g) => g.id === content.activeGroupId) ?? groups[0];
      const view = grp?.views.find((v) => v.id === grp.activeViewId);
      if (key === "w" && !e.shiftKey) {
        // ⌘W 활성 뷰 닫기(코어 터미널 pane 분할 제거 — 뷰 단위 닫기만).
        e.preventDefault();
        if (view) closeView(project.id, view.id);
      } else if (key === "t" && !e.shiftKey) {
        e.preventDefault();
        // ⌘T = 새 터미널 탭. 코어는 특정 엔진을 모른다 — 설정된 터미널 엔진(계약 해소)으로 연다.
        // 활성 터미널 엔진이 없으면 아무것도 열지 않는다(빈 탭 남발 금지 — ⌘T 는 터미널 전용 의도).
        const terminalProgram = resolveTerminalProgram();
        if (terminalProgram) addViewToGroup(project.id, terminalProgram);
      } else if (key === "b" && !e.shiftKey) {
        e.preventDefault();
        toggleSidebar(project.id);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [closeView, addViewToGroup, toggleSidebar, toggleRightSidebar]);

  // 파일 드래그&드롭: 활성 프로젝트의 터미널 pane(플러그인 터미널, PTY substrate)에 이스케이프
  // 경로를 주입한다. 코어가 터미널 host-div 를 소유하지 않으므로 substrate IO(getPtyIo)로 보낸다.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const { paths } = event.payload;
      if (!paths || paths.length === 0) return;
      const s = useSessions.getState();
      const proj = s.tabs.find((t) => t.id === s.activeId);
      const paneId = proj ? cwdPaneOf(proj) : undefined;
      if (!paneId) return;
      getPtyIo(paneId)?.sendInput(paths.map(shellEscape).join(" "));
    });
    return () => {
      unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

  // 프로젝트 탭 목록(상단 가로 / 좌측 세로 양쪽에서 같은 마크업 재사용).
  // 더블클릭 = 프로젝트 설정 모달(이름 + 식별 색 — 인라인 rename 대체).
  const projectTabsList = (
    <>
      {tabs.map((proj) => (
        <div
          key={proj.id}
          className={`tab${proj.id === activeId ? " active" : ""}`}
          onClick={() => setActive(proj.id)}
          onDoubleClick={() => setProjectSettingsFor(proj.id)}
        >
          {proj.color && (
            <span className="tab-dot" style={{ background: proj.color }} />
          )}
          <span className="tab-title">{proj.title}</span>
          {tabs.length > 1 && (
            <button
              type="button"
              className="icon-btn icon-btn--mini tab-close"
              title={t("project.close")}
              onClick={(e) => {
                e.stopPropagation();
                void closeProjectReleased(proj.id); // P6: 닫기 성공 시 전역 점유 해제
              }}
            >
              <Icon name="close" size="md" />
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        className="icon-btn tab-add"
        title={t("project.new")}
        onClick={() => setNewProjectOpen(true)}
      >
        <Icon name="add" />
      </button>
    </>
  );

  // 좌측 레일: 칩 폭 = 레일 폭 추종(적응형). 라벨은 말줄임, 최소폭(RAIL_MIN)까지
  // 줄이면 첫 글자만(말줄임 없음). 더블클릭=프로젝트 설정(이름/색), 우클릭=닫기.
  const railAtMin = railW <= RAIL_MIN;
  const otherProjects = useOtherWindowProjects();
  const recentAll = useRecentProjects();
  // 어디에도 안 열린 최근 = 전체 최근 − 내 창 root − 타창 root.
  const openRoots = new Set([
    ...tabs.map((p) => p.root),
    ...otherProjects.map((o) => o.root),
  ]);
  const recentClosed = recentAll.filter((r) => !openRoots.has(r.root));
  const projectRailList = (
    <>
      {tabs.map((proj) => (
        <div
          key={proj.id}
          className={`rail-chip${proj.id === activeId ? " active" : ""}`}
          title={proj.title}
          style={
            proj.color
              ? { borderColor: proj.color, color: proj.color }
              : undefined
          }
          onClick={() => setActive(proj.id)}
          onDoubleClick={() => setProjectSettingsFor(proj.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            if (tabs.length > 1) void closeProjectReleased(proj.id); // P6 해제 동반
          }}
        >
          <span className="rail-chip-label">
            {railAtMin ? ([...proj.title][0] ?? "") : proj.title}
          </span>
        </div>
      ))}
      {/* 다른 창의 프로젝트(전역 레지스트리) — 전 프로젝트가 한 목록으로 나열된다(내 것
          다음, "+" 앞 — 사용자 확정 순서 s,p,+). 점선·감쇠 스타일이 구분을 담당한다.
          클릭 = 소유 창 포커스(P6: 중복 오픈 대신 이동). */}
      {otherProjects.map((o) => {
        const name = o.root.split("/").filter(Boolean).pop() ?? o.root;
        return (
          <div
            key={o.root}
            className="rail-chip other"
            data-node={`rail/other/${name}`}
            title={t("project.otherWindow", { window: o.window, root: o.root })}
            onClick={() => void invoke("window_focus", { label: o.window })}
          >
            <span className="rail-chip-label">
              {railAtMin ? ([...name][0] ?? "") : name}
            </span>
          </div>
        );
      })}
      {/* 어디에도 안 열린 최근 프로젝트 — 레일 버튼으로 제공한다.
          클릭 = 이 창에서 열기(P6 게이트 경유). root 소실은 목록에서 자가 치유(제거). */}
      {recentClosed.map((r) => {
        const name = r.alias || (r.root.split("/").filter(Boolean).pop() ?? r.root);
        return (
          <div
            key={r.root}
            className="rail-chip recent"
            data-node={`rail/recent/${name}`}
            title={t("project.recentOpen", { root: r.root })}
            onClick={() => {
              void (async () => {
                try {
                  await validateProjectRoot(r.root);
                } catch {
                  console.warn(`최근 프로젝트 root 소실 — 목록에서 제거: ${r.root}`);
                  void removeRecentProject(r.root);
                  return;
                }
                await addProjectClaimed({ root: r.root, alias: r.alias });
              })();
            }}
          >
            <span className="rail-chip-label">
              {railAtMin ? ([...name][0] ?? "") : name}
            </span>
          </div>
        );
      })}
      <button
        type="button"
        className="rail-add"
        title={t("project.new")}
        onClick={() => setNewProjectOpen(true)}
      >
        <Icon name="add" size="lg" />
      </button>
    </>
  );

  return (
    <div className="app-root">
      {/* 오버레이 타이틀바: 로고(최앞단 고정) + 프로젝트 탭. 빈 영역 드래그로 창 이동. */}
      <div className="titlebar" data-tauri-drag-region>
        {/* 로고는 신호등(82px) 바로 뒤 고정 — 탭은 항상 로고 뒤부터 쌓인다.
            pointer-events:none 으로 창 드래그를 가로채지 않는다. */}
        <span
          className="titlebar-logo"
          aria-hidden
          dangerouslySetInnerHTML={{ __html: logoRaw }}
        />
        {/* 빌드 정체성 배지(DEV=HMR / DEBUG=디버그 번들) — 로고 바로 뒤 고정. 프로젝트
            탭(상단 모드)은 이 뒤부터 쌓인다. 릴리스(soksak)는 배지 없음. */}
        <BuildBadge />
        {projectTabPosition === "top" ? (
          <div className="tabs" data-tauri-drag-region>
            {projectTabsList}
          </div>
        ) : (
          /* 좌측 모드: 타이틀바엔 탭 없이 드래그 영역만(탭은 좌측 레일로). */
          <div className="tabs" data-tauri-drag-region />
        )}
        <div className="titlebar-right">
          <PluginHeaderActions />
          <button
            type="button"
            className={`icon-btn sidebar-toggle${activeProject?.sidebarOpen ? " active" : ""}`}
            title={t("sidebar.toggle")}
            aria-label={t("sidebar.toggle")}
            onClick={() => activeProject && toggleSidebar(activeProject.id)}
          >
            <Icon name="panel-left" />
          </button>
          <button
            type="button"
            className={`icon-btn sidebar-toggle${activeProject?.rightOpen ? " active" : ""}`}
            title={t("plugin.sidebar.toggle")}
            aria-label={t("plugin.sidebar.toggle")}
            onClick={() =>
              activeProject && toggleRightSidebar(activeProject.id)
            }
          >
            <Icon name="panel-right" />
          </button>
          <button
            type="button"
            className="icon-btn orch-open"
            data-node="orch-open"
            title={t("orch.open")}
            aria-label={t("orch.open")}
            onClick={() => void execute("window.open", { mode: "orchestrator" }, { remote: false })}
          >
            <Icon name="browser" />
          </button>
          <button
            type="button"
            className="icon-btn theme-toggle"
            data-node="theme-toggle"
            title={isDark ? t("theme.lightPreset") : t("theme.darkPreset")}
            aria-label={t("theme.toggle")}
            onClick={toggleMode}
          >
            <Icon name={isDark ? "sun" : "moon"} />
          </button>
          <button
            type="button"
            className="icon-btn settings-toggle"
            data-node="settings-open"
            title={t("settings.open")}
            aria-label={t("settings.open")}
            onClick={() => setSettingsSection("general")}
          >
            <Icon name="settings" />
          </button>
        </div>
      </div>

      {settingsSection !== null && (
        <SettingsModal
          initialSection={settingsSection}
          onClose={() => setSettingsSection(null)}
        />
      )}
      <ConsentPreviewHost />
      {newProjectOpen && (
        <NewProjectModal onClose={() => setNewProjectOpen(false)} />
      )}
      {projectSettingsFor && (
        <ProjectSettingsModal
          projectId={projectSettingsFor}
          onClose={() => setProjectSettingsFor(null)}
        />
      )}
      <ConfirmCloseModal />
      <RemoteConfirmModal />
      <RecoverySetupModal />
      <RecoveryEnterModal />

      {/* 본문: 좌측 모드면 세로 프로젝트 레일 + 콘텐츠 행. */}
      <div className={`app-body${projectTabPosition === "left" ? " with-rail" : ""}`}>
        {projectTabPosition === "left" && (
          <>
            <div className="project-rail" style={{ width: railW }}>
              {projectRailList}
            </div>
            <div
              className="project-rail-resizer"
              onMouseDown={startRailResize}
              title={t("sidebar.resize")}
            />
          </>
        )}
        {/* 프로젝트 0개 = 예외 상태(P6 열화·복원 드롭)뿐 — 열기·생성은 컨트롤 플레인의 표면이다.
            빈 워크스페이스 창은 생성 경로가 없으므로(window.new root 필수) 안내만 남긴다. */}
        {tabs.length === 0 && (
          <div className="window-empty" data-node="window/empty">
            {t("window.empty")}
          </div>
        )}
        {/* 모든 프로젝트를 마운트해 세션 유지(비활성은 visibility 로 숨김). */}
        <div className="terminal-stack">
          {tabs.map((project) => (
            <ProjectPane
              key={project.id}
              project={project}
              isActiveProject={project.id === activeId}
              sidebarW={sidebarW}
              rightW={rightW}
              rightMode={rightSidebarMode}
              contentTabPosition={contentTabPosition}
              startResize={startResize}
              startRightResize={startRightResize}
            />
          ))}
        </div>
      </div>
      {/* 인앱 알림 배너(포커스 시) — 앱 루트 최상단 오버레이. */}
      <NotifyHost />
      {/* webview 복구 소진 배지(비차단) — 코어 webview_health 전이 구독. */}
      <WebviewHealthBadges />
    </div>
  );
}

export default App;
