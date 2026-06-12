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

// invoke 거부값은 문자열(Result<_,String>)일 수도 Error 일 수도 — 표시용으로 통일.
function errMsg(e) {
  if (typeof e === "string") return e;
  return (e && e.message) || String(e);
}

function mountHistory(app, container, viewCtx) {
  const root = el(
    "div",
    "display:flex;flex-direction:column;gap:8px;height:100%;box-sizing:border-box;" +
      "padding:10px;font-size:12px;color:var(--fg);background:var(--bg);overflow:auto;",
  );
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
    const bar = el("div", "display:flex;align-items:center;justify-content:space-between;gap:6px;");
    bar.appendChild(el("span", DIM, commits.length ? `커밋 ${commits.length}개` : ""));
    const refresh = button("⟳", "새로고침");
    refresh.addEventListener("click", () => void loadPage(true));
    bar.appendChild(refresh);

    const list = el("div", "display:flex;flex-direction:column;");
    for (const c of commits) list.appendChild(commitRow(c));

    root.replaceChildren(bar, list);
    if (error) root.appendChild(note(error)); // 빈 상태("git 저장소 아님" 류)
    else if (!busy && commits.length === 0) root.appendChild(note("커밋 없음"));

    if (busy) {
      root.appendChild(note("불러오는 중…"));
    } else if (!ended && commits.length > 0) {
      const more = button("더 보기", `다음 ${PAGE}개`);
      more.style.alignSelf = "center";
      more.addEventListener("click", () => void loadPage(false));
      root.appendChild(more);
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
    const body = el("div", "display:flex;flex-direction:column;gap:8px;");
    body.appendChild(note("불러오는 중…"));
    root.replaceChildren(back, body);

    let d;
    try {
      d = await app.git.show(hash, path);
    } catch (e) {
      body.replaceChildren(note(errMsg(e)));
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

    body.replaceChildren(meta, filesTitle, files, patch);
  }

  renderList();
  void loadPage(true);
}

export default {
  activate(ctx) {
    const app = ctx.app;
    // 선언된 "history" 뷰에 바인딩 — disposable 은 subscriptions 로 자동 수거.
    ctx.subscriptions.push(
      app.ui.registerView("history", {
        mount(container, viewCtx) {
          mountHistory(app, container, viewCtx);
        },
        unmount(container) {
          container.replaceChildren();
        },
      }),
    );
  },

  deactivate() {},
};
