import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useBookmarks } from "../state/bookmarks";
import { useSessions } from "../state/sessions";
import { useUi } from "../state/ui";
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

export function BrowserView({
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
  const suppressed = useUi((s) => s.browserSuppress > 0);
  const suppressBrowser = useUi((s) => s.suppressBrowser);
  const releaseBrowser = useUi((s) => s.releaseBrowser);
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
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
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
        openedRef.current = true;
      })
      .catch((e) => console.error("browser_open:", e));
    return () => {
      openedRef.current = false;
      invoke("browser_close", { label }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  // 본문 영역 rect 를 webview 에 동기화. 매 렌더 후(레이아웃 이동: 분할/이동) +
  // ResizeObserver(창/리사이저로 크기 변화) — 같은 rect 면 skip.
  const syncBounds = () => {
    const el = areaRef.current;
    if (!el || !openedRef.current) return;
    const r = el.getBoundingClientRect();
    const key = `${r.left},${r.top},${r.width},${r.height}`;
    if (key === lastRectRef.current) return;
    lastRectRef.current = key;
    invoke("browser_bounds", {
      label,
      x: r.left,
      y: r.top,
      w: Math.max(1, r.width),
      h: Math.max(1, r.height),
    }).catch(() => {});
  };
  useEffect(() => {
    syncBounds();
  });
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(syncBounds);
    ro.observe(el);
    window.addEventListener("resize", syncBounds);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", syncBounds);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 표시/숨김: 뷰 활성 여부 + 전역 오버레이 suppress.
  const effectiveVisible = visible && !suppressed && !bmOpen;
  useEffect(() => {
    invoke("browser_visible", { label, visible: effectiveVisible }).catch(
      () => {},
    );
  }, [label, effectiveVisible]);

  // 네비게이션(링크 클릭 포함) → URL 상태/탭 제목 동기화.
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
  // suppress/release 를 effect 로 묶어 언마운트 시에도 누수가 없다.
  useEffect(() => {
    if (!bmOpen) return;
    suppressBrowser();
    return () => releaseBrowser();
  }, [bmOpen, suppressBrowser, releaseBrowser]);

  return (
    <div className="browser-view">
      <div className="bv-bar">
        <button
          type="button"
          className="bv-btn"
          title={t("browser.back")}
          onClick={() => invoke("browser_history", { label, delta: -1 })}
        >
          ←
        </button>
        <button
          type="button"
          className="bv-btn"
          title={t("browser.forward")}
          onClick={() => invoke("browser_history", { label, delta: 1 })}
        >
          →
        </button>
        <button
          type="button"
          className="bv-btn"
          title={t("browser.reload")}
          onClick={() => invoke("browser_navigate", { label, url })}
        >
          ⟳
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
            if (e.key === "Enter") {
              e.preventDefault();
              navigate(input);
              e.currentTarget.blur();
            }
          }}
        />
        <button
          type="button"
          className={`bv-btn${isBookmarked ? " on" : ""}`}
          title={t("browser.bookmark")}
          onClick={() => toggleBookmark(url, host)}
        >
          {isBookmarked ? "★" : "☆"}
        </button>
        <button
          type="button"
          className={`bv-btn${bmOpen ? " on" : ""}`}
          title={t("browser.bookmarks")}
          onClick={() => setBmOpen((o) => !o)}
        >
          ☰
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
