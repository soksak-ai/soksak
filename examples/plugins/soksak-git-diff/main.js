// 깃 변경 — 변경 파일 목록 + 클릭 시 unified diff 뷰어 (soksak-plugin-spec v1).
// 권한 근거: ui(뷰 등록) / commands(explorer.git 실행) / git:read(app.git.diff).
// 외부 데이터(경로/디프 본문)는 전부 textContent 로만 삽입 — innerHTML 미사용.

// explorer.git 의 status 문자열 → 배지 글자/색 (fs.rs classify_git 와 동일 집합)
const STATUS = {
  modified: { ch: "M", color: "var(--acc)" },
  added: { ch: "A", color: "var(--ok)" },
  deleted: { ch: "D", color: "#e5534b" },
  renamed: { ch: "R", color: "var(--fg2)" },
  untracked: { ch: "?", color: "var(--fg3)" },
};

// 요소 생성 헬퍼 — text 는 textContent 로만(이스케이프 보장)
function h(tag, style, text) {
  const el = document.createElement(tag);
  if (style) el.style.cssText = style;
  if (text !== undefined) el.textContent = text;
  return el;
}

// diff 한 줄의 착색 규칙
function lineStyle(line) {
  if (line.startsWith("@@")) return "color:var(--acc);opacity:.7";
  if (line.startsWith("+")) return "color:var(--ok)";
  if (line.startsWith("-")) return "color:#e5534b";
  return "color:var(--fg2)";
}

export default {
  activate(ctx) {
    const app = ctx.app;
    // mount 별 정리 함수(이벤트 구독 등) — unmount 에서 실행.
    const cleanups = new Map();

    ctx.subscriptions.push(
      app.ui.registerView("view", {
        mount(container, vctx) {
          // mount 단위 closure 상태 — sidebar/content 동시 배치에도 독립 동작
          const root = vctx.root;
          let staged = false;
          let selected = null; // 선택된 파일 경로(root 상대)
          const rows = new Map(); // path → 행 요소(선택 하이라이트용)

          container.replaceChildren();
          const wrap = h(
            "div",
            "display:flex;flex-direction:column;height:100%;min-height:0;font-size:12px;color:var(--fg);background:var(--bg)",
          );

          // ── 상단 바(표준 골격: 정보/컨트롤 좌 · 액션 우, border-bottom)
          const bar = h(
            "div",
            "display:flex;align-items:center;justify-content:space-between;gap:10px;" +
              "padding:4px 10px;border-bottom:1px solid var(--bd);flex:0 0 auto;" +
              "min-height:28px;box-sizing:border-box",
          );
          // 새로고침 아이콘 — 호스트 표준(앱 크롬과 동일한 lucide refresh, 정적
          // 신뢰 마크업이라 innerHTML 안전). 텍스트 글리프(⟳) 크기 불일치 제거.
          const refreshBtn = h(
            "button",
            "display:inline-flex;align-items:center;justify-content:center;" +
              "width:24px;height:22px;padding:0;cursor:pointer;" +
              "border:1px solid var(--bd);background:var(--inset);color:var(--fg2);border-radius:4px",
          );
          refreshBtn.innerHTML =
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
            'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>' +
            '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';
          refreshBtn.title = "새로고침";
          const stagedLabel = h(
            "label",
            "display:flex;align-items:center;gap:5px;cursor:pointer;color:var(--fg2);user-select:none",
          );
          const stagedBox = document.createElement("input");
          stagedBox.type = "checkbox";
          stagedBox.style.cssText = "accent-color:var(--acc);margin:0";
          stagedLabel.append(stagedBox, document.createTextNode("staged"));
          bar.append(stagedLabel, refreshBtn);

          // ── 에러 표시(침묵 실패 금지) / 파일 목록 / diff 영역.
          // 에러 시 목록/디프를 숨겨 빈 칸(잔여 보더)이 남지 않게 한다.
          const errEl = h(
            "div",
            "display:none;padding:8px 10px;color:#e5534b;font-size:11px;" +
              "white-space:pre-wrap;word-break:break-all;flex:0 0 auto",
          );
          const listEl = h(
            "div",
            "flex:0 1 auto;max-height:45%;overflow:auto;padding:5px 0",
          );
          const diffEl = h(
            "div",
            "flex:1 1 auto;min-height:0;overflow:auto;padding:8px 10px;" +
              "border-top:1px solid var(--bd);" +
              "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;white-space:pre",
          );

          wrap.append(bar, errEl, listEl, diffEl);
          container.append(wrap);

          const showError = (e) => {
            errEl.textContent = String(e && e.message ? e.message : e);
            errEl.style.display = "block";
            listEl.style.display = "none";
            diffEl.style.display = "none";
          };
          const clearError = () => {
            errEl.style.display = "none";
            listEl.style.display = "";
            diffEl.style.display = "";
          };
          const highlight = () => {
            for (const [path, row] of rows) {
              row.style.background = path === selected ? "var(--inset)" : "";
            }
          };

          // 선택 파일의 unified diff 렌더 — 줄 단위 착색, 전부 textContent
          async function loadDiff() {
            diffEl.replaceChildren();
            if (!selected) return;
            try {
              const text = await app.git.diff({ path: root, file: selected, staged });
              if (!text.trim()) {
                diffEl.append(h("div", "color:var(--fg3)", "변경 없음"));
                return;
              }
              const frag = document.createDocumentFragment();
              for (const line of text.split("\n")) {
                frag.append(h("div", lineStyle(line), line === "" ? " " : line));
              }
              diffEl.append(frag);
            } catch (e) {
              showError(e);
            }
          }

          // 변경 파일 목록 — explorer.git 명령(파일트리 데코레이션과 동일 소스)
          async function loadList() {
            clearError();
            listEl.replaceChildren();
            rows.clear();
            if (!root) {
              showError("프로젝트 루트 없음 — 폴더가 열린 프로젝트에서 사용하세요");
              return;
            }
            try {
              const out = await app.commands.execute("explorer.git", { path: root });
              if (!out.ok) {
                showError(`${out.code}: ${out.message}`);
                return;
              }
              const entries = out.entries || [];
              if (entries.length === 0) {
                listEl.append(h("div", "padding:4px 12px;color:var(--fg3)", "변경 없음"));
                return;
              }
              for (const ent of entries) {
                const st = STATUS[ent.status] || { ch: "·", color: "var(--fg3)" };
                const row = h(
                  "div",
                  "display:flex;align-items:center;gap:7px;padding:3px 12px;cursor:pointer",
                );
                row.title = ent.path;
                const badge = h(
                  "span",
                  `flex:0 0 12px;text-align:center;font-weight:600;color:${st.color}`,
                  st.ch,
                );
                const pathEl = h(
                  "span",
                  "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg2)",
                  ent.path,
                );
                row.append(badge, pathEl);
                row.onclick = () => {
                  selected = ent.path;
                  highlight();
                  void loadDiff();
                };
                rows.set(ent.path, row);
                listEl.append(row);
              }
              highlight();
            } catch (e) {
              showError(e);
            }
          }

          refreshBtn.onclick = () => {
            void loadList();
            void loadDiff();
          };
          stagedBox.onchange = () => {
            staged = stagedBox.checked;
            void loadDiff(); // working tree ↔ index(--cached) 전환
          };

          void loadList();

          // 자동 갱신: 터미널 명령 종료 이벤트(OSC 탐지 기반 — 폴링 없음) →
          // 300ms 정착 후 재로드. 다른 프로젝트의 명령은 무시. ⟳ 는 수동 보조.
          let reloadTimer = null;
          const sub = app.events.on("command.finished", (e) => {
            if (e.projectId && vctx.projectId && e.projectId !== vctx.projectId)
              return;
            clearTimeout(reloadTimer);
            reloadTimer = setTimeout(() => {
              void loadList();
              void loadDiff();
            }, 300);
          });
          cleanups.set(container, () => {
            clearTimeout(reloadTimer);
            sub.dispose();
          });
        },

        unmount(container) {
          cleanups.get(container)?.();
          cleanups.delete(container);
          container.replaceChildren();
        },
      }),
    );
  },

  deactivate() {
    // 등록 자원은 호스트 tracker + ctx.subscriptions 가 자동 수거
  },
};
