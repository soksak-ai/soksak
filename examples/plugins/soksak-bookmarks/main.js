// 즐겨찾기 플러그인 — 기존 명령만 조합(bookmark.list / bookmark.remove / browser.open).
// 자체 백엔드·자체 명령 0개. 목록은 bookmarks.changed 이벤트로 라이브 갱신.

export default {
  activate(ctx) {
    const app = ctx.app;
    // 뷰는 재마운트될 수 있으므로 이벤트 구독은 activate 에서 1회만 — 현재 마운트만 갱신.
    let current = null;

    // 명령 실행 — 실패(ok:false)는 예외로 승격해 호출부에서 화면에 표시.
    const run = async (name, params) => {
      const r = await app.commands.execute(name, params ?? {});
      if (!r.ok) throw new Error(`${name} 실패: ${r.message ?? r.code}`);
      return r;
    };

    ctx.subscriptions.push(
      app.ui.registerView("list", {
        mount(el) {
          el.textContent = "";

          // 테마 변수 기반 스타일(앱 테마에 자동 추종).
          const style = document.createElement("style");
          style.textContent = [
            ".skbm-root{padding:10px 12px;font-size:12px;color:var(--fg);}",
            ".skbm-err{display:none;margin-bottom:8px;font-size:11px;color:#e5534b;white-space:pre-wrap;word-break:break-all;}",
            ".skbm-row{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:5px;cursor:pointer;}",
            ".skbm-row:hover{background:var(--inset);}",
            ".skbm-main{flex:1;min-width:0;}",
            ".skbm-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
            ".skbm-url{font-size:11px;color:var(--fg3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
            ".skbm-x{flex:none;border:0;background:none;padding:2px 5px;border-radius:4px;font-size:11px;color:var(--fg3);cursor:pointer;}",
            ".skbm-x:hover{color:var(--fg);background:var(--bd);}",
            ".skbm-empty{color:var(--fg2);padding:2px 0;}",
            ".skbm-hint{color:var(--fg3);font-size:11px;margin-top:4px;}",
          ].join("");

          const root = document.createElement("div");
          root.className = "skbm-root";
          const err = document.createElement("div");
          err.className = "skbm-err";
          const list = document.createElement("div");
          root.append(err, list);
          el.append(style, root);

          // 침묵 실패 금지 — 실패는 작은 에러 텍스트로 노출.
          const showError = (e) => {
            err.textContent = String(e && e.message ? e.message : e);
            err.style.display = "block";
          };
          const clearError = () => {
            err.style.display = "none";
          };

          const render = (bookmarks) => {
            list.textContent = "";
            if (!bookmarks.length) {
              const empty = document.createElement("div");
              empty.className = "skbm-empty";
              empty.textContent = "즐겨찾기 없음";
              const hint = document.createElement("div");
              hint.className = "skbm-hint";
              hint.textContent = "브라우저의 ★ 버튼이나 sok bookmark.add 로 추가하세요.";
              list.append(empty, hint);
              return;
            }
            for (const bm of bookmarks) {
              const row = document.createElement("div");
              row.className = "skbm-row";
              row.title = bm.url;
              const main = document.createElement("div");
              main.className = "skbm-main";
              const title = document.createElement("div");
              title.className = "skbm-title";
              // textContent 사용 — 외부 데이터(제목/URL)가 HTML 로 해석되지 않음.
              title.textContent = bm.title || bm.url;
              const url = document.createElement("div");
              url.className = "skbm-url";
              url.textContent = bm.url;
              main.append(title, url);

              const x = document.createElement("button");
              x.className = "skbm-x";
              x.textContent = "✕";
              x.title = "제거";

              // 행 클릭 → 브라우저로 열기.
              row.addEventListener("click", async () => {
                try {
                  clearError();
                  await run("browser.open", { url: bm.url });
                } catch (e) {
                  showError(e);
                }
              });
              // ✕ → 제거(파괴적 — commands:destructive). 목록 갱신은 이벤트가 담당.
              x.addEventListener("click", async (ev) => {
                ev.stopPropagation();
                try {
                  clearError();
                  await run("bookmark.remove", { url: bm.url });
                } catch (e) {
                  showError(e);
                }
              });

              row.append(main, x);
              list.appendChild(row);
            }
          };

          current = { render, showError };

          // 초기 목록 로드.
          (async () => {
            try {
              const r = await run("bookmark.list");
              clearError();
              render(r.bookmarks || []);
            } catch (e) {
              showError(e);
            }
          })();
        },
        unmount(el) {
          current = null;
          el.textContent = "";
        },
      }),
    );

    // 라이브 갱신 — 즐겨찾기 변경 시 최신 목록으로 재그림(마운트 중일 때만).
    ctx.subscriptions.push(
      app.events.on("bookmarks.changed", (p) => {
        try {
          if (current) current.render(p.bookmarks || []);
        } catch (e) {
          if (current) current.showError(e);
        }
      }),
    );
  },

  deactivate() {
    // 등록물·구독은 ctx.subscriptions/호스트 tracker 가 자동 해제 — 별도 정리 없음.
  },
};
