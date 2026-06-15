// soksak-sakura — 앱 위로 흩날리는 벚꽃 잎(Canvas — 단일 GPU 레이어). (jhammann/sakura 영감)
// 퍼포먼스: 꽃잎 N개를 DOM 레이어 N개 + 3D 회전(rotateX/Y)으로 만들면 N개 합성 레이어 +
//   매 프레임 3D 재합성으로 비싸다(WebContent ~18% @32잎). → 단일 <canvas> 1장에 전부 그려
//   합성 레이어를 1개로 축소. 3D 텀블은 2D scaleX(cos) 플립으로 흉내(GPU 싼값). 60fps 부드러운
//   낙하 + 전체화면 캔버스 재합성 픽셀은 DPR 1(꽃잎은 본래 소프트 — 레티나 불필요)로 절반↓.
//   비포커스/숨김/비가시 시 *완전 정지*(rAF 중단, 0 비용).

export default {
  activate(ctx) {
    const TAU = Math.PI * 2;
    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
    const rand = (a, b) => a + Math.random() * (b - a);
    const HUES = ["#ffd7e6", "#ffc0cf", "#ffb7c5", "#f7a6bf", "#ffcad6"];
    // 노치 있는 벚꽃 잎(위 V홈 + 아래 뾰족) — 100단위 좌표, 중심 약 (50,52).
    const PETAL = new Path2D("M50 96 C22 78 8 50 26 22 C36 8 50 18 50 30 C50 18 64 8 74 22 C92 50 78 78 50 96 Z");

    // 이전 적재 잔재 제거(리로드 누적 방지 — 옛 rAF 루프는 isConnected 로 자가 종료).
    document.querySelectorAll("#soksak-sakura-canvas").forEach((e) => e.remove());
    const cv = document.createElement("canvas");
    cv.id = "soksak-sakura-canvas";
    cv.style.cssText = "position:fixed;inset:0;width:100%;height:100%;z-index:2147483000;pointer-events:none";
    document.body.appendChild(cv);
    const g = cv.getContext("2d");
    ctx.subscriptions.push({ dispose() { cv.remove(); } });

    let VW = 0, VH = 0;
    function resize() {
      VW = window.innerWidth; VH = window.innerHeight;
      const dpr = 1; // 레티나 미사용 — 꽃잎은 소프트라 무관, 전체화면 합성 픽셀 절반↓
      cv.width = Math.round(VW * dpr); cv.height = Math.round(VH * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0); // 논리 px 좌표계로 그린다
    }
    resize();
    window.addEventListener("resize", resize, { passive: true });

    let fallK = 1;
    function reset(p, initial) {
      p.x = rand(-20, VW);
      p.y = initial ? rand(-VH, VH) : rand(-40, -10);
      p.vy = rand(26, 68);                  // 낙하 px/s (배수 fallK 는 매 프레임 적용)
      p.sway = rand(16, 58); p.swP = rand(0, TAU); p.swS = rand(0.5, 1.5); // 좌우 흔들림
      p.rz = rand(0, TAU); p.rzS = rand(-1.2, 1.2);  // 평면 회전(rad)
      p.fp = rand(0, TAU); p.fs = rand(1.1, 2.6);    // 플립 위상/속도
      p.size = rand(9, 20) / 100;           // 9~20px (100단위 패스 스케일)
      p.color = HUES[(Math.random() * HUES.length) | 0];
      p.alpha = rand(0.5, 0.95);
    }
    let petals = [];
    function spawn(n) { petals = []; for (let i = 0; i < n; i++) { const p = {}; reset(p, true); petals.push(p); } }

    let visible = true, density = 32, windK = 0;
    spawn(density);

    let last = 0, acc = 0, raf = 0;
    const FRAME = 1 / 60; // 60fps — 부드러운 낙하
    function draw(dt) {
      g.clearRect(0, 0, VW, VH);
      for (const p of petals) {
        p.y += p.vy * fallK * dt;
        p.x += windK * 36 * dt;
        p.swP += p.swS * dt; p.rz += p.rzS * dt; p.fp += p.fs * dt;
        const dx = p.x + Math.sin(p.swP) * p.sway;
        if (p.y > VH + 30 || dx < -50 || dx > VW + 50) { reset(p, false); continue; }
        g.save();
        g.globalAlpha = p.alpha;
        g.translate(dx, p.y);
        g.rotate(p.rz);
        g.scale(p.size * Math.cos(p.fp), p.size); // 2D 플립(엣지온 일 때 0) = 3D 텀블 illusion
        g.translate(-50, -52);                    // 패스 중심을 (dx,p.y)에 맞춤
        g.fillStyle = p.color;
        g.fill(PETAL);
        g.restore();
      }
    }
    function loop(t) {
      if (!cv.isConnected) { raf = 0; return; }  // 캔버스 제거됨(새 인스턴스) → 옛 루프 자가 종료
      raf = requestAnimationFrame(loop);
      if (!last) last = t;
      let dt = (t - last) / 1000; last = t;
      if (dt > 0.1) dt = 0.1;
      acc += dt;
      if (acc < FRAME) return;
      const gdt = acc; acc = 0;
      draw(gdt);
    }
    function start() { if (!raf) { last = 0; acc = 0; raf = requestAnimationFrame(loop); } }
    function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

    // 보임 && 앱활성 && 비숨김 일 때만 구동(0 비용 정지) — "안 볼 때 멈춘다"의 신호 둘:
    //  ① Page Visibility(가려짐/최소화)  ② 앱활성(코어 app.focus — 메인 창 NSWindow key).
    // DOM blur 는 못 쓴다 — 내장 브라우저(메인과 별개인 child webview)로 포커스만 가도 떠서, 같은
    // soksak 창을 보는데 멈춘다. app.focus 는 창 레벨이라 child 이동엔 불변, 다른 앱 전환에만 false.
    let active = true; // 초기 활성 가정. 코어 app.focus 이벤트가 갱신.
    const sync = () => { if (visible && active && !document.hidden) start(); else stop(); };
    const onVis = sync;
    document.addEventListener("visibilitychange", onVis);
    ctx.subscriptions.push(ctx.app.events.on("app.focus", (p) => { active = !!(p && p.focused); sync(); }));
    sync();

    const reg = (n, params, h) => ctx.subscriptions.push(ctx.app.commands.register(n, { description: n, params, handler: h }));
    reg("toggle", {}, () => { visible = !visible; cv.style.display = visible ? "block" : "none"; if (!visible) g.clearRect(0, 0, VW, VH); onVis(); return { visible }; });
    reg("density", { n: { type: "number", description: "꽃잎 수 5~150(기본 32)" } }, (p) => { density = clamp(Math.round(Number(p && p.n) || 32), 5, 150); spawn(density); return { density }; });
    reg("fall", { speed: { type: "number", description: "낙하 속도 배수 0.3~3" } }, (p) => { fallK = clamp(Number(p && p.speed) || 1, 0.3, 3); return { fall: fallK }; });
    reg("wind", { strength: { type: "number", description: "바람(좌우 흐름) -2~2(음수=왼쪽)" } }, (p) => { windK = clamp(Number(p && p.strength) || 0, -2, 2); return { wind: windK }; });

    ctx.subscriptions.push({ dispose() {
      stop();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVis);
      cv.remove();
    } });
  },
  deactivate() {},
};
