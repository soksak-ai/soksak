import { useCallback, useEffect, useRef, useState } from "react";
import {
  SearchQuery,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  setSearchQuery,
} from "@codemirror/search";
import { EditorView } from "@uiw/react-codemirror";
import type { useT } from "../i18n";

// editor 의 에디터 내 찾기/바꾸기 위젯을 추종. CodeMirror 기본 패널 대신 직접 그린다
// (기본 패널은 텍스트 라벨 체크박스라 editor UI 와 다름). search 상태/하이라이트/명령은
// @codemirror/search 를 그대로 쓰고, 표현만 editor 처럼 한다.

type Tf = ReturnType<typeof useT>;

export function EditorFind({
  view,
  open,
  replaceMode,
  editable,
  focusSignal,
  onClose,
  t,
}: {
  view: EditorView | null;
  open: boolean;
  replaceMode: boolean;
  editable: boolean;
  focusSignal: number;
  onClose: () => void;
  t: Tf;
}) {
  const [query, setQuery] = useState("");
  const [replace, setReplace] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const [showReplace, setShowReplace] = useState(replaceMode);
  const [count, setCount] = useState<{ cur: number; total: number }>({
    cur: 0,
    total: 0,
  });
  const inputRef = useRef<HTMLInputElement>(null);

  const recount = useCallback((v: EditorView, q: SearchQuery) => {
    if (!q.valid) {
      setCount({ cur: 0, total: 0 });
      return;
    }
    let total = 0;
    let cur = 0;
    const sel = v.state.selection.main;
    const it = q.getCursor(v.state);
    let r = it.next();
    while (!r.done) {
      total++;
      if (r.value.from === sel.from && r.value.to === sel.to) cur = total;
      r = it.next();
    }
    setCount({ cur, total });
  }, []);

  // 쿼리/옵션 변경 시 search 상태 갱신 + 매치 수 재계산.
  useEffect(() => {
    if (!view || !open) return;
    const q = new SearchQuery({
      search: query,
      replace,
      caseSensitive,
      regexp,
      wholeWord,
    });
    view.dispatch({ effects: setSearchQuery.of(q) });
    recount(view, q);
  }, [view, open, query, replace, caseSensitive, regexp, wholeWord, recount]);

  // ⌘H/⌘⌥F 로 열면 바꾸기 행을 펼친 채 시작(편집 가능할 때만).
  useEffect(() => {
    if (open && replaceMode && editable) setShowReplace(true);
  }, [open, replaceMode, editable]);

  // 열림(또는 ⌘F 재요청) 시 입력에 포커스 + 에디터 선택영역으로 프리필(editor 동작).
  useEffect(() => {
    if (!open) return;
    if (view) {
      const sel = view.state.selection.main;
      if (!sel.empty) {
        const text = view.state.sliceDoc(sel.from, sel.to);
        if (text && !text.includes("\n")) setQuery(text);
      }
    }
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [focusSignal, open, view]);

  if (!open) return null;

  const run = (cmd: (v: EditorView) => boolean) => {
    if (!view) return;
    cmd(view);
    recount(view, getSearchQuery(view.state));
    inputRef.current?.focus();
  };

  const close = () => {
    onClose();
    view?.focus();
  };

  const noResults = query.length > 0 && count.total === 0;
  const canReplace = editable;

  return (
    <div
      className="cm-find"
      role="search"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      }}
    >
      {canReplace && (
        <button
          type="button"
          className={`cmf-chevron${showReplace ? " open" : ""}`}
          title={t("find.toggleReplace")}
          onClick={() => setShowReplace((s) => !s)}
          tabIndex={-1}
        >
          ❯
        </button>
      )}
      <div className="cmf-rows">
        <div className="cmf-row">
          <div className={`cmf-field${noResults ? " error" : ""}`}>
            <input
              ref={inputRef}
              className="cmf-input"
              value={query}
              placeholder={t("find.placeholder")}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  run(e.shiftKey ? findPrevious : findNext);
                }
              }}
            />
            <div className="cmf-opts">
              <button
                type="button"
                className={`cmf-opt${caseSensitive ? " on" : ""}`}
                title={t("find.matchCase")}
                onClick={() => setCaseSensitive((v) => !v)}
                tabIndex={-1}
              >
                Aa
              </button>
              <button
                type="button"
                className={`cmf-opt cmf-opt-word${wholeWord ? " on" : ""}`}
                title={t("find.wholeWord")}
                onClick={() => setWholeWord((v) => !v)}
                tabIndex={-1}
              >
                ab
              </button>
              <button
                type="button"
                className={`cmf-opt${regexp ? " on" : ""}`}
                title={t("find.regex")}
                onClick={() => setRegexp((v) => !v)}
                tabIndex={-1}
              >
                .*
              </button>
            </div>
          </div>
          <span className="cmf-count">
            {noResults
              ? t("find.noResults")
              : t("find.count", { cur: count.cur, total: count.total })}
          </span>
          <button
            type="button"
            className="cmf-btn"
            title={t("find.prev")}
            onClick={() => run(findPrevious)}
            tabIndex={-1}
          >
            ↑
          </button>
          <button
            type="button"
            className="cmf-btn"
            title={t("find.next")}
            onClick={() => run(findNext)}
            tabIndex={-1}
          >
            ↓
          </button>
          <button
            type="button"
            className="cmf-btn"
            title={t("find.close")}
            onClick={close}
            tabIndex={-1}
          >
            ✕
          </button>
        </div>
        {canReplace && showReplace && (
          <div className="cmf-row">
            <div className="cmf-field">
              <input
                className="cmf-input"
                value={replace}
                placeholder={t("find.replace")}
                spellCheck={false}
                onChange={(e) => setReplace(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    run(replaceNext);
                  }
                }}
              />
            </div>
            <button
              type="button"
              className="cmf-btn"
              title={t("find.replaceOne")}
              onClick={() => run(replaceNext)}
              tabIndex={-1}
            >
              ⇆
            </button>
            <button
              type="button"
              className="cmf-btn"
              title={t("find.replaceAll")}
              onClick={() => run(replaceAll)}
              tabIndex={-1}
            >
              ⇊
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
