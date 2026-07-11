// W6 e2e 픽스처 — 네이티브 child webview(b-<win>-<view>) 한 장을 콘텐츠 뷰 슬롯에 임베드한다.
// 코어 webview_health(크래시 서킷 브레이커)의 child 경로·소진 배지 검증 전용.
export default {
  activate(ctx) {
    const app = ctx.app;
    ctx.subscriptions.push(
      app.commands.register("ping", {
        description: "Load check for the W6 surface fixture",
        params: {},
        message: () => "e2e-surface 0.0.1",
        handler: () => ({ ok: true, version: "0.0.1" }),
      }),
      app.ui.registerView("content", {
        mount(el, vctx) {
          if (!vctx.viewId || !app.webview) return;
          const label = app.webview.label(vctx.viewId);
          const url =
            "data:text/html,<body style='background:%23245c3f;color:%23fff;font:28px sans-serif;padding:2em'>W6 surface fixture</body>";
          const place = () => {
            const r = el.getBoundingClientRect();
            return { x: r.left, y: r.top, w: Math.max(r.width, 50), h: Math.max(r.height, 50) };
          };
          const p = place();
          void app.webview.open(label, { url, x: p.x, y: p.y, w: p.w, h: p.h });
          const ro = new ResizeObserver(() => {
            const q = place();
            void app.webview.bounds(label, q.x, q.y, q.w, q.h);
          });
          ro.observe(el);
          el.dataset.node = "surface";
          el.dataset.w6Label = label;
        },
      }),
    );
  },
  deactivate() {},
};
