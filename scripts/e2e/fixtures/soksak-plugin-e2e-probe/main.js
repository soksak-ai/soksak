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
  },
};
