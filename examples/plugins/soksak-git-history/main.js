// soksak-git-history — 커밋 이력 사이드바 뷰 (soksak-plugin-spec v1).
// 사용 표면: app.ui.registerView + app.git.log/show (권한: ui, git:read — 읽기 전용).
// 외부 문자열(제목·작성자·경로·패치)은 전부 textContent 로 넣는다 — innerHTML 미사용.

const PAGE = 50;

const MONO = "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;";
const DIM = "color:var(--fg3);";

// DOM 헬퍼 — text 는 textContent 로 들어가 자동 이스케이프.
function el(tag, css, text) {
  const n = document.createElement(tag);
  if (css) n.style.cssText = css;
  if (text !== undefined) n.textContent = text;
  return n;
}

function button(label, title) {
  const b = el(
    "button",
    "font-size:11px;padding:2px 8px;border:1px solid var(--bd);border-radius:4px;" +
      "background:var(--inset);color:var(--fg2);cursor:pointer;",
    label,
  );
  if (title) b.title = title;
  return b;
}

// 새로고침 아이콘 버튼 — 호스트 표준(앱 크롬과 동일한 lucide refresh, 정적 신뢰
// 마크업이라 innerHTML 안전). 텍스트 글리프(⟳)의 크기 불일치 제거.
const REFRESH_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>' +
  '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';

function refreshButton(title) {
  const b = el(
    "button",
    "display:inline-flex;align-items:center;justify-content:center;width:24px;height:22px;" +
      "padding:0;border:1px solid var(--bd);border-radius:4px;" +
      "background:var(--inset);color:var(--fg2);cursor:pointer;",
  );
  b.innerHTML = REFRESH_SVG;
  if (title) b.title = title;
  return b;
}

// invoke 거부값은 문자열(Result<_,String>)일 수도 Error 일 수도 — 표시용으로 통일.
function errMsg(e) {
  if (typeof e === "string") return e;
  return (e && e.message) || String(e);
}

function mountHistory(app, container, viewCtx) {
  // 표준 골격(예제 공통 패턴): 고정 헤더 행(정보 좌·액션 우, border-bottom) +
  // 스크롤 본문(패딩 소유). 노트/에러는 본문 안에 박스 없이.
  const root = el(
    "div",
    "display:flex;flex-direction:column;height:100%;min-height:0;" +
      "font-size:12px;color:var(--fg);background:var(--bg);",
  );
  const bar = el(
    "div",
    "display:flex;align-items:center;justify-content:space-between;gap:6px;" +
      "padding:4px 10px;border-bottom:1px solid var(--bd);flex:0 0 auto;" +
      "min-height:28px;box-sizing:border-box;",
  );
  const countEl = el("span", DIM, "");
  const refresh = refreshButton("새로고침");
  refresh.addEventListener("click", () => void loadPage(true));
  bar.append(countEl, refresh);
  const body = el(
    "div",
    "flex:1 1 auto;min-height:0;overflow:auto;padding:10px;" +
      "display:flex;flex-direction:column;gap:8px;",
  );
  root.append(bar, body);
  container.replaceChildren(root);

  const path = viewCtx.root || undefined; // 없으면 호스트가 현재 프로젝트 루트로 대체

  // ── 목록 상태 — 누적 커밋 + 다음 페이지 skip. 새로고침 시 초기화 ─────────────
  let commits = [];
  let skip = 0;
  let ended = false; // 마지막 페이지(반환 < PAGE) 도달
  let busy = false;
  let error = null; // 비 git 폴더 등 — 빈 상태에 사유 그대로 노출(침묵 실패 금지)

  const note = (text) =>
    el("div", DIM + "padding:4px 0;white-space:pre-wrap;word-break:break-all;", text);

  // 에러는 빨강 — soksak-git-diff 와 동일한 시각 언어(예제 간 일관성).
  const errNote = (text) =>
    el(
      "div",
      "color:#e5534b;font-size:11px;padding:4px 0;white-space:pre-wrap;word-break:break-all;",
      text,
    );

  function commitRow(c) {
    const r = el("div", "padding:5px 6px;border-radius:5px;cursor:pointer;");
    r.addEventListener("mouseenter", () => (r.style.background = "var(--inset)"));
    r.addEventListener("mouseleave", () => (r.style.background = "transparent"));
    const line1 = el("div", "display:flex;gap:6px;align-items:baseline;min-width:0;");
    line1.appendChild(el("span", MONO + "color:var(--acc);flex:none;", c.short));
    line1.appendChild(
      el("span", "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;", c.subject),
    );
    const line2 = el(
      "div",
      DIM + "font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
      `${c.author} · ${c.date}`,
    );
    r.append(line1, line2);
    r.title = c.subject;
    r.addEventListener("click", () => void renderDetail(c.hash));
    return r;
  }

  function renderList() {
    countEl.textContent = commits.length ? `커밋 ${commits.length}개` : "";

    const list = el("div", "display:flex;flex-direction:column;");
    for (const c of commits) list.appendChild(commitRow(c));

    body.replaceChildren(list);
    if (error) body.appendChild(errNote(error)); // 빈 상태("git 저장소 아님" 류)
    else if (!busy && commits.length === 0) body.appendChild(note("커밋 없음"));

    if (busy) {
      body.appendChild(note("불러오는 중…"));
    } else if (!ended && commits.length > 0) {
      const more = button("더 보기", `다음 ${PAGE}개`);
      more.style.alignSelf = "center";
      more.addEventListener("click", () => void loadPage(false));
      body.appendChild(more);
    }
  }

  async function loadPage(reset) {
    if (busy) return;
    busy = true;
    error = null;
    if (reset) {
      commits = [];
      skip = 0;
      ended = false;
    }
    renderList();
    try {
      const page = await app.git.log({ path, limit: PAGE, skip });
      commits = commits.concat(page);
      skip += PAGE;
      if (page.length < PAGE) ended = true;
    } catch (e) {
      error = errMsg(e);
    }
    busy = false;
    renderList();
  }

  // ── 상세 화면 — 목록을 교체하고 뒤로가기 버튼으로 복귀 ──────────────────────
  async function renderDetail(hash) {
    const back = button("← 목록");
    back.style.alignSelf = "flex-start";
    back.addEventListener("click", renderList);
    const detail = el("div", "display:flex;flex-direction:column;gap:8px;");
    detail.appendChild(note("불러오는 중…"));
    body.replaceChildren(back, detail);

    let d;
    try {
      d = await app.git.show(hash, path);
    } catch (e) {
      detail.replaceChildren(errNote(errMsg(e)));
      return;
    }

    const meta = el("div", "display:flex;flex-direction:column;gap:2px;");
    meta.appendChild(el("div", "font-weight:600;word-break:break-word;", d.meta.subject));
    const hashEl = el("div", MONO + "color:var(--acc);font-size:11px;", d.meta.short);
    hashEl.title = d.meta.hash;
    meta.appendChild(hashEl);
    meta.appendChild(el("div", DIM + "font-size:11px;", `${d.meta.author} · ${d.meta.date}`));

    const filesTitle = el("div", DIM, `변경 파일 ${d.files.length}개`);
    const files = el(
      "div",
      MONO + "font-size:11px;display:flex;flex-direction:column;gap:2px;",
    );
    for (const f of d.files) {
      const line = el("div", "display:flex;gap:6px;min-width:0;");
      line.appendChild(el("span", "flex:none;width:12px;color:var(--acc);", f.status));
      line.appendChild(
        el(
          "span",
          "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg2);",
          f.path,
        ),
      );
      line.title = f.path;
      files.appendChild(line);
    }

    const patch = el(
      "pre",
      "margin:0;padding:8px;border:1px solid var(--bd);border-radius:5px;" +
        "background:var(--inset);color:var(--fg2);" +
        MONO +
        "font-size:11px;line-height:1.45;overflow:auto;max-height:320px;white-space:pre;",
      d.patch,
    );

    detail.replaceChildren(meta, filesTitle, files, patch);
  }

  renderList();
  void loadPage(true);

  // 자동 갱신: 터미널 명령 종료 이벤트(OSC 탐지 기반 — 폴링 없음) → 300ms 정착 후
  // 첫 페이지 재로드. 다른 프로젝트의 명령은 무시. ⟳ 는 수동 보조 수단.
  let reloadTimer = null;
  const sub = app.events.on("command.finished", (e) => {
    if (e.projectId && viewCtx.projectId && e.projectId !== viewCtx.projectId)
      return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void loadPage(true), 300);
  });
  return () => {
    clearTimeout(reloadTimer);
    sub.dispose();
  };
}

export default {
  activate(ctx) {
    const app = ctx.app;
    // 선언된 "history" 뷰에 바인딩 — disposable 은 subscriptions 로 자동 수거.
    // mount 가 반환한 정리 함수(이벤트 구독 등)는 컨테이너별로 보관해 unmount 시 실행.
    const cleanups = new Map();
    ctx.subscriptions.push(
      app.ui.registerView("history", {
        mount(container, viewCtx) {
          cleanups.set(container, mountHistory(app, container, viewCtx));
        },
        unmount(container) {
          cleanups.get(container)?.();
          cleanups.delete(container);
          container.replaceChildren();
        },
      }),
    );
  },

  deactivate() {},
};
