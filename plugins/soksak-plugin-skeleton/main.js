// soksak 플러그인 스켈레톤 — 동작하는 최소 예제.
// 완전한 설명은 MANUAL.md. 이 파일은 §5(API)·§6(타입)·§7(생명주기)을 코드로 보여준다.
//
// 규율(MANUAL §8):
//  - 단일 ESM, `import` 문 금지(블롭 로드). 필요한 외부 코드는 번들 시점에 인라인.
//  - 모든 등록물/부수효과를 ctx.subscriptions 로 정리 가능하게.
//  - 선언(plugin.json)과 사용 정합. 실패를 침묵하지 말 것.

export default {
  // activate 는 플러그인이 켜질 때 1회 호출된다. ctx = { app, manifest, dir, subscriptions }.
  activate(ctx) {
    const app = ctx.app;

    // ── 명령 등록 (권한 "commands", plugin.json contributes.commands 에 선언 필요) ──
    // 호출: sok plugin.soksak-plugin-skeleton.ping '{"name":"world"}'
    ctx.subscriptions.push(
      app.commands.register("ping", {
        description: "핑 — 인사를 돌려준다(예제)",
        params: {
          name: { type: "string", description: "인사 대상", required: false },
        },
        // handler 의 반환 객체가 명령 결과로 직렬화된다.
        handler: (params) => {
          const who = (params && params.name) || "soksak";
          return { pong: true, hello: who };
        },
      }),
    );

    // ── 뷰 등록 (권한 "ui", contributes.views 에 "panel" 선언 필요) ──
    // 호스트가 준 container DOM 에 직접 그린다(React 비요구). mount 는 재호출될 수 있다.
    let mounted = null; // 현재 마운트 상태(이벤트로 갱신)
    ctx.subscriptions.push(
      app.ui.registerView("panel", {
        mount(container, viewCtx) {
          container.textContent = "";

          // 스타일은 테마 변수로 — 테마 자동 추종(MANUAL §5.3, §8).
          const style = document.createElement("style");
          style.textContent =
            ".skel{padding:12px;font-size:12px;color:var(--fg);line-height:1.7}" +
            ".skel b{color:var(--fg)}" +
            ".skel .row{color:var(--fg3)}" +
            ".skel button{margin-top:8px;padding:5px 10px;border:1px solid var(--bd);" +
            "background:var(--inset);color:var(--fg);border-radius:6px;cursor:pointer}" +
            ".skel .out{margin-top:8px;color:var(--fg2);white-space:pre-wrap;word-break:break-all}";

          const root = document.createElement("div");
          root.className = "skel";

          // 권한 불요 컨텍스트(MANUAL §5.0) + 뷰 컨텍스트(projectId/root).
          const info = document.createElement("div");
          const render = () => {
            info.innerHTML = "";
            const lines = [
              ["plugin", app.pluginId],
              ["appVersion", app.appVersion],
              ["locale", app.locale()],
              ["projectId", viewCtx.projectId],
              ["root", viewCtx.root || "(없음)"],
            ];
            const title = document.createElement("div");
            title.innerHTML = "<b>플러그인 스켈레톤</b>";
            info.appendChild(title);
            for (const [k, v] of lines) {
              const r = document.createElement("div");
              r.className = "row";
              r.textContent = k + ": ";
              const val = document.createElement("span");
              val.style.color = "var(--fg)";
              val.textContent = String(v); // 외부 데이터는 textContent(MANUAL §8)
              r.appendChild(val);
              info.appendChild(r);
            }
          };
          render();

          // 버튼 → 자기 명령 실행(app.commands.execute). 실패는 표면화(침묵 금지).
          const out = document.createElement("div");
          out.className = "out";
          const btn = document.createElement("button");
          btn.textContent = "ping 실행";
          btn.addEventListener("click", async () => {
            try {
              const r = await app.commands.execute(
                "plugin.soksak-plugin-skeleton.ping",
                { name: "click" },
              );
              out.textContent = JSON.stringify(r);
            } catch (e) {
              out.textContent = "에러: " + (e && e.message ? e.message : e);
            }
          });

          root.append(info, btn, out);
          container.append(style, root);
          mounted = { render };
        },
        unmount(container) {
          mounted = null;
          container.textContent = "";
        },
      }),
    );

    // ── 이벤트 구독 (MANUAL §5.2) — locale 바뀌면 뷰 갱신 ──
    // 이벤트 콜백은 호스트 try/catch 안에서 돈다.
    ctx.subscriptions.push(
      app.events.on("locale.changed", () => {
        if (mounted) mounted.render();
      }),
    );

    // ── 직접 만든 리소스도 dispose 로 정리(MANUAL §7) ──
    // (예시: 타이머가 있다면) const t = setInterval(...);
    // ctx.subscriptions.push({ dispose() { clearInterval(t); } });
  },

  // 보통 빈 함수 — subscriptions 는 호스트가 자동 해제한다.
  deactivate() {},
};
