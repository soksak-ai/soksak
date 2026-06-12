import { memo, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isComposingEnter } from "../lib/imeKeys";
import { rafThrottle } from "../lib/rafThrottle";
import { Icon } from "../ui/icons/Icon";
import { listen } from "@tauri-apps/api/event";
import { useBookmarks } from "../state/bookmarks";
import { useSessions } from "../state/sessions";
import { useTheme } from "../state/theme";
import { useSuppressBrowser, useUi } from "../state/ui";
import { useT } from "../i18n";

// 브라우저 패널: 메인 창 안의 Tauri child webview(WKWebView)를 이 슬롯의 본문 영역에
// 정렬해 임베드한다(iframe 아님 — 프레이밍 차단 없는 실제 브라우저). 링크 클릭은 webview
// 기본 동작, 이전/이후는 세션 히스토리, URL 변화는 on_navigation 이벤트(폴링 없음).
// DOM 오버레이(드롭 인디케이터/메뉴)가 떠 있는 동안은 useUi.browserSuppress 로 숨긴다.

// 입력을 URL 로 정규화: 스킴 없으면 https://, 공백/점없음은 구글 검색.
function normalizeUrl(input: string): string {
  const s = input.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) return s;
  if (!s.includes(" ") && s.includes(".")) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

function BrowserViewImpl({
  projectId,
  viewId,
  url,
  visible,
}: {
  projectId: string;
  viewId: string;
  url: string;
  visible: boolean;
}) {
  const t = useT();
  const label = `b-${viewId}`;
  const setBrowserUrl = useSessions((s) => s.setBrowserUrl);
  const setBrowserTitle = useSessions((s) => s.setBrowserTitle);
  const suppressed = useUi((s) => s.browserSuppress > 0);
  const bookmarks = useBookmarks((s) => s.list);
  const toggleBookmark = useBookmarks((s) => s.toggle);

  const areaRef = useRef<HTMLDivElement>(null);
  const openedRef = useRef(false);
  const lastRectRef = useRef("");
  const [input, setInput] = useState(url);
  const [bmOpen, setBmOpen] = useState(false);
  const inputFocusRef = useRef(false);

  // URL 상태 변화(네비게이션/외부) → 입력칸 동기화(직접 입력 중엔 방해하지 않음).
  useEffect(() => {
    if (!inputFocusRef.current) setInput(url);
  }, [url]);

  // 최초 1회 webview 생성. 언마운트(뷰 닫힘) 시 정리.
  // 생성은 비동기 — 완료 전에 언마운트되면 cleanup 의 close 가 먼저 실행되고
  // 늦게 생성된 웹뷰가 고아로 남는다(아무도 못 닫는 유령 창). closed 플래그로
  // 늦게 도착한 생성을 즉시 회수한다. 잔여 경쟁은 browserGc 불변식이 보증.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    let closed = false;
    const r = el.getBoundingClientRect();
    invoke("browser_open", {
      label,
      url,
      x: r.left,
      y: r.top,
      w: Math.max(1, r.width),
      h: Math.max(1, r.height),
    })
      .then(() => {
        if (closed) {
          invoke("browser_close", { label }).catch(() => {});
          return;
        }
        openedRef.current = true;
        syncBounds(); // 생성 완료 시점의 최신 rect 로 1회 보정
      })
      .catch((e) => console.error("browser_open:", e));
    return () => {
      closed = true;
      openedRef.current = false;
      invoke("browser_close", { label }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  // §B5 프레임 예산(네이티브): child webview 는 DOM 오버레이(z:5 프레임) 위에
  // 그려지므로 외곽 접변(좌/우)의 1px 을 bounds 로 지불한다 — 안 하면 패널
  // 좌우 프레임 보더가 webview 에 덮여 사라진다. 상/하단은 DOM 크롬(bv-bar/
  // 스테이터스바)이 사이에 있어 비접변. flat 은 프레임 무 → 0.
  // 알려진 한계: 카드 라운드 모서리는 사각 webview 라 미세 노출 — v1 수용.
  const paneStyle = useTheme((s) => s.spec.chrome.paneStyle);
  const frameInsetRef = useRef(0);
  frameInsetRef.current = paneStyle === "flat" ? 0 : 1;

  // 본문 영역 rect 를 webview 에 동기화 — 같은 rect 면 skip.
  // 측정(gBCR=강제 레이아웃)과 IPC(wry set_position/set_size)는 rAF 로 합쳐
  // 프레임당 1회 상한(원칙 4·5) — 렌더 동기 강제 레이아웃 금지.
  const syncBounds = useMemo(
    () =>
      rafThrottle(() => {
        const el = areaRef.current;
        if (!el || !openedRef.current) return;
        const r = el.getBoundingClientRect();
        const inset = frameInsetRef.current;
        const key = `${r.left},${r.top},${r.width},${r.height},${inset}`;
        if (key === lastRectRef.current) return;
        lastRectRef.current = key;
        invoke("browser_bounds", {
          label,
          x: r.left + inset,
          y: r.top,
          w: Math.max(1, r.width - inset * 2),
          h: Math.max(1, r.height),
        }).catch(() => {});
      }),
    [label],
  );
  // inset 변화(테마 paneStyle 전환)도 재동기화 구동원 — rect key 에 inset 이
  // 포함돼 동일 rect skip 에 걸리지 않는다.
  useEffect(() => {
    syncBounds();
  }, [paneStyle, syncBounds]);
  // 구동원 3개가 전부다(매 렌더 effect 금지 — memo 경계와 양립 불가):
  //   1) ResizeObserver — 크기 변화(분할/사이드바/창 리사이즈)
  //   2) sessions transient 구독 — 위치만 바뀌는 레이아웃 이동(동일 크기 그룹 간
  //      이동 등)은 RO 가 못 본다. 레이아웃 변화는 전부 sessions 쓰기이므로 렌더
  //      없이 여기서 잡는다(zustand transient 패턴). rAF 합침 + 동일 rect skip
  //      이라 무관한 쓰기의 비용은 프레임당 gBCR 1회로 끝.
  //   3) window resize — 안전망(RO 와 대부분 중복).
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => syncBounds());
    ro.observe(el);
    const onWinResize = () => syncBounds();
    window.addEventListener("resize", onWinResize);
    const unsub = useSessions.subscribe(() => syncBounds());
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onWinResize);
      unsub();
      syncBounds.cancel();
    };
  }, [syncBounds]);

  // 표시/숨김: 뷰 활성 여부 + 전역 오버레이 suppress.
  const effectiveVisible = visible && !suppressed && !bmOpen;
  useEffect(() => {
    invoke("browser_visible", { label, visible: effectiveVisible }).catch(
      () => {},
    );
  }, [label, effectiveVisible]);

  // 네비게이션(링크 클릭 포함) → URL 상태 동기화.
  useEffect(() => {
    const un = listen<{ label: string; url: string }>("browser-nav", (e) => {
      if (e.payload.label === label) {
        setBrowserUrl(projectId, viewId, e.payload.url);
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, [label, projectId, viewId, setBrowserUrl]);

  // 로드 완료 시 문서 <title> → 탭/타이틀바 제목.
  useEffect(() => {
    const un = listen<{ label: string; title: string }>(
      "browser-title",
      (e) => {
        if (e.payload.label === label) {
          setBrowserTitle(projectId, viewId, e.payload.title);
        }
      },
    );
    return () => {
      void un.then((f) => f());
    };
  }, [label, projectId, viewId, setBrowserTitle]);

  const navigate = (raw: string) => {
    const u = normalizeUrl(raw);
    setBrowserUrl(projectId, viewId, u);
    invoke("browser_navigate", { label, url: u }).catch(() => {});
  };

  const isBookmarked = bookmarks.some((b) => b.url === url);
  const host = (() => {
    try {
      return new URL(url).host || url;
    } catch {
      return url;
    }
  })();

  // 즐겨찾기 드롭다운: 열린 동안 webview 숨김(네이티브 레이어가 메뉴를 가리므로).
  useSuppressBrowser(bmOpen);

  return (
    <div className="browser-view">
      <div className="bv-bar">
        <button
          type="button"
          className="icon-btn bv-btn"
          title={t("browser.back")}
          onClick={() => invoke("browser_history", { label, delta: -1 })}
        >
          <Icon name="arrow-left" />
        </button>
        <button
          type="button"
          className="icon-btn bv-btn"
          title={t("browser.forward")}
          onClick={() => invoke("browser_history", { label, delta: 1 })}
        >
          <Icon name="arrow-right" />
        </button>
        <button
          type="button"
          className="icon-btn bv-btn"
          title={t("browser.reload")}
          onClick={() => invoke("browser_navigate", { label, url })}
        >
          <Icon name="refresh" />
        </button>
        <input
          className="bv-url"
          value={input}
          spellCheck={false}
          onFocus={() => {
            inputFocusRef.current = true;
          }}
          onBlur={() => {
            inputFocusRef.current = false;
            setInput(url);
          }}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (isComposingEnter(e)) return; // IME 조합 확정 Enter 는 이동 아님
            if (e.key === "Enter") {
              e.preventDefault();
              navigate(input);
              e.currentTarget.blur();
            }
          }}
        />
        <button
          type="button"
          className={`icon-btn bv-btn${isBookmarked ? " on" : ""}`}
          title={t("browser.bookmark")}
          onClick={() => toggleBookmark(url, host)}
        >
          <Icon name={isBookmarked ? "star-filled" : "star"} />
        </button>
        <button
          type="button"
          className={`icon-btn bv-btn${bmOpen ? " on" : ""}`}
          title={t("browser.bookmarks")}
          onClick={() => setBmOpen((o) => !o)}
        >
          <Icon name="menu" />
        </button>
      </div>
      {bmOpen && (
        <div className="bv-bm-list">
          {bookmarks.length === 0 && (
            <div className="bv-bm-empty">{t("browser.noBookmarks")}</div>
          )}
          {bookmarks.map((b) => (
            <div
              key={b.url}
              className="bv-bm-item"
              title={b.url}
              onClick={() => {
                navigate(b.url);
                setBmOpen(false);
              }}
            >
              <span className="bv-bm-title">{b.title}</span>
              <span className="bv-bm-url">{b.url}</span>
            </div>
          ))}
        </div>
      )}
      {/* child webview 가 이 영역 위에 정렬된다. */}
      <div className="bv-area" ref={areaRef} />
    </div>
  );
}

// memo 경계(원칙 2). bounds 동기화는 렌더가 아니라 RO + sessions transient 구독이
// 구동하므로(위 주석) memo 로 렌더가 끊겨도 위치 추적은 유지된다.
export const BrowserView = memo(BrowserViewImpl);
