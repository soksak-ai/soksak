// git.changed 수신 프로브 — git-changed.sh e2e 전용.
// 버스 이벤트는 창-로컬이라 소켓 스트림으로는 관측할 수 없다. 이 프로브가
// 대상 창 안에서 git.changed 를 구독해 기록하고, dump 커맨드로 회신한다.
export function activate(ctx) {
  const app = ctx.app;
  const seen = [];
  ctx.subscriptions.push(app.bus.on("git.changed", (p) => seen.push({ at: Date.now(), payload: p })));
  ctx.subscriptions.push(app.commands.register("dump", {
    description: "Return every git.changed event received on this window's bus since load.",
    message: (d) => `${(d.seen ?? []).length} event(s)`,
    handler: async () => ({ seen }),
  }));
}
