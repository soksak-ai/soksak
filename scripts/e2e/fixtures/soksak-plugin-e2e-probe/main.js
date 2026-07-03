// E2E 이벤트 프로브 — 권한 불요 호스트 이벤트를 링버퍼에 기록하고 커맨드로 노출한다.
// e2e 스크립트 전용 픽스처(plugin.dev.load 로 적재, 설치 배포 안 함). 이벤트 채널
// 마일스톤(layout.resize-gesture 등)의 "수신 사실"을 소켓에서 단언하는 관찰 표면.
const CAP = 200;

// 권한 불요(비민감 라이프사이클) 이벤트만 구독한다 — command.*/turn.ended 는 terminal
// 권한이 필요하므로 프로브 범위 밖(그 채널의 E2E 는 소유 플러그인 경로로 검증).
const EVENTS = [
  "layout.resize-gesture",
  "window.live-resize",
  "app.focus",
  "view.activated",
  "project.changed",
  "theme.changed",
];

export default {
  activate(ctx) {
    const ring = [];
    const push = (event, payload) => {
      ring.push({ event, payload, time: Date.now() });
      if (ring.length > CAP) ring.shift();
    };
    for (const e of EVENTS) {
      ctx.subscriptions.push(
        ctx.app.events.on(e, (payload) => push(e, payload)),
      );
    }
    ctx.subscriptions.push(
      ctx.app.commands.register("events", {
        description:
          "Recorded host events (ring, oldest first). Params: event = filter by event name.",
        params: {
          event: { type: "string", description: "filter: exact event name" },
        },
        returns: "{ events: [{event,payload,time}] }",
        handler: (p) => ({
          events: p.event ? ring.filter((r) => r.event === p.event) : [...ring],
        }),
      }),
    );
    ctx.subscriptions.push(
      ctx.app.commands.register("clear", {
        description: "Clear the recorded event ring.",
        params: {},
        returns: "{ cleared }",
        handler: () => {
          const n = ring.length;
          ring.length = 0;
          return { cleared: n };
        },
      }),
    );

    // DOM 히트 체인 — elementFromPoint(x,y)의 태그.클래스 체인(위→root). 네이티브 브리지
    // E2E 에서 "그 좌표에 정말 divider 가 있는가"를 소켓에서 단언하는 관찰 표면.
    ctx.subscriptions.push(
      ctx.app.commands.register("hit", {
        description: "elementFromPoint(x,y) ancestor chain (tag.class list).",
        params: {
          x: { type: "number", required: true },
          y: { type: "number", required: true },
        },
        returns: "{ chain: string[] }",
        handler: (p) => {
          const el = document.elementFromPoint(Number(p.x), Number(p.y));
          const chain = [];
          for (let n = el; n && chain.length < 12; n = n.parentElement) {
            chain.push(
              n.tagName.toLowerCase() +
                (n.className && typeof n.className === "string"
                  ? "." + n.className.split(/\s+/).filter(Boolean).join(".")
                  : ""),
            );
          }
          return { chain };
        },
      }),
    );

    // window 레벨 마우스 이벤트 카운터 — 합성 이벤트(mousemove/up)가 window 리스너에
    // 실제 도달하는지 단언(네이티브 브리지 재생 경로 검증).
    const mouseLog = { mousemove: 0, mouseup: 0, mousedown: 0, lastX: null };
    const onAny = (e) => {
      mouseLog[e.type] += 1;
      mouseLog.lastX = e.clientX;
    };
    for (const t of ["mousedown", "mousemove", "mouseup"]) {
      window.addEventListener(t, onAny, true);
      ctx.subscriptions.push({
        dispose: () => window.removeEventListener(t, onAny, true),
      });
    }
    ctx.subscriptions.push(
      ctx.app.commands.register("mouselog", {
        description: "Window-level mouse event counters since load (+ last clientX).",
        params: {},
        returns: "{ mousedown, mousemove, mouseup, lastX }",
        handler: () => ({ ...mouseLog }),
      }),
    );
  },
};
