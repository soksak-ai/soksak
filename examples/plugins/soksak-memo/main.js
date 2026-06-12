// soksak-memo — 프로젝트별 메모 패널 (soksak-plugin-spec v1).
// 저장은 전용 저장소(app.storage)만 사용. 키는 프로젝트 루트에서 파생되어
// 프로젝트마다 분리되고, 루트가 없으면 "global" 키 하나를 공유한다.

const DEBOUNCE_MS = 400;

// 루트 경로 → 저장 키(^[A-Za-z0-9._-]+$ 충족).
// 비안전 문자는 "_" 치환 + djb2 해시 접미로 치환 충돌(/a/b vs /a_b)을 방지.
function storageKey(root) {
  if (!root) return "memo.global";
  let h = 5381;
  for (let i = 0; i < root.length; i++) {
    h = ((h * 33) ^ root.charCodeAt(i)) >>> 0;
  }
  const safe = root.replace(/[^A-Za-z0-9._-]/g, "_").slice(-40);
  return `memo.${safe}-${h.toString(16)}`;
}

let app = null;
const mounts = new Map(); // container → { flush } — 비활성화 시 플러시용

function mount(container, viewCtx) {
  const key = storageKey(viewCtx.root);

  // ── DOM(plain) — 앱 CSS 변수로 테마 추종 ──────────────────────────────────
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "display:flex;flex-direction:column;height:100%;box-sizing:border-box;" +
    "padding:10px;gap:6px;font-size:12px;color:var(--fg);background:var(--bg);";

  const ta = document.createElement("textarea");
  ta.placeholder = "이 프로젝트의 메모…";
  ta.spellcheck = false;
  ta.disabled = true; // 로드 완료 전 입력 금지(저장 전 텍스트 유실 방지)
  // 터미널 본문과 같은 결: 테두리/인셋 카드 없이 배경(--bg)에 바로 녹아드는 입력면.
  ta.style.cssText =
    "flex:1;width:100%;box-sizing:border-box;resize:none;padding:2px 0;" +
    "font:inherit;font-size:12px;line-height:1.5;color:var(--fg);" +
    "background:transparent;border:none;outline:none;";

  const status = document.createElement("div");
  status.style.cssText = "min-height:14px;font-size:11px;color:var(--fg3);";

  wrap.append(ta, status);
  container.replaceChildren(wrap);

  // textContent 만 사용 — 외부 데이터(에러 메시지 등) escape 불필요.
  const setStatus = (text, isError) => {
    status.textContent = text;
    status.style.color = isError ? "#e5484d" : "var(--fg3)";
  };

  // ── 저장(400ms 디바운스) — 실패는 상태줄에 정직하게 노출 ───────────────────
  let timer = null;
  let dirty = false;

  const doSave = async () => {
    if (!app?.storage) return;
    dirty = false;
    setStatus("저장 중…");
    try {
      await app.storage.write(key, ta.value);
      if (!dirty) setStatus("저장됨"); // 쓰는 동안 또 입력했으면 유지
    } catch (e) {
      dirty = true;
      setStatus(`저장 실패: ${e?.message ?? e}`, true);
    }
  };

  ta.addEventListener("input", () => {
    dirty = true;
    setStatus("저장 중…");
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void doSave();
    }, DEBOUNCE_MS);
  });

  // 대기 중 저장 즉시 실행(언마운트/비활성화 시).
  const flush = async () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    if (dirty) await doSave();
  };
  mounts.set(container, { flush });

  // ── 초기 로드 ──────────────────────────────────────────────────────────────
  (async () => {
    try {
      const saved = await app?.storage?.read(key);
      if (typeof saved === "string") {
        ta.value = saved;
        setStatus("저장됨");
      }
    } catch (e) {
      setStatus(`불러오기 실패: ${e?.message ?? e}`, true);
    } finally {
      ta.disabled = false;
    }
  })();
}

function unmount(container) {
  const m = mounts.get(container);
  mounts.delete(container);
  if (m) void m.flush(); // 마지막 편집 베스트에포트 저장
  container.replaceChildren();
}

export default {
  activate(ctx) {
    app = ctx.app;
    // 뷰 등록 — 선언된 "panel" 에 바인딩. disposable 은 subscriptions 로 자동 수거.
    ctx.subscriptions.push(ctx.app.ui.registerView("panel", { mount, unmount }));
  },

  deactivate() {
    // 디바운스 대기 중인 저장을 전부 플러시(가능한 만큼).
    const jobs = [...mounts.values()].map((m) => m.flush());
    mounts.clear();
    app = null;
    return Promise.allSettled(jobs);
  },
};
