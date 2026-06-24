// 원격 confirm 직렬 큐(폰-링크 안전모델) — enqueue/resolve/expire + sink 전송 + 멱등.
// 순수 store 로직만(Tauri 비의존) — sink 를 recorder 로 주입해 결정 전송을 단언한다.
import { beforeEach, describe, expect, it } from "vitest";
import {
  useRemoteConfirm,
  activeRequest,
  type RemoteConfirmRequest,
} from "./remoteConfirm";

function mkReq(id: number, over?: Partial<RemoteConfirmRequest>): RemoteConfirmRequest {
  return {
    request_id: id,
    device_id: `dev-${id}`,
    command: "panel.close",
    danger: true,
    ...over,
  };
}

// 결정 recorder — (request_id, approve) 쌍을 순서대로 기록.
let resolved: Array<{ id: number; approve: boolean }>;

beforeEach(() => {
  resolved = [];
  useRemoteConfirm.setState({ queue: [] });
  useRemoteConfirm.getState().setSink((id, approve) => {
    resolved.push({ id, approve });
  });
});

describe("remoteConfirm serial queue", () => {
  it("큐가 비면 active 는 null(idle 무발자국)", () => {
    expect(activeRequest(useRemoteConfirm.getState())).toBeNull();
  });

  it("enqueue → 머리가 active 로 노출", () => {
    useRemoteConfirm.getState().enqueue(mkReq(1, { device_id: "iPhone" }));
    const a = activeRequest(useRemoteConfirm.getState());
    expect(a?.request_id).toBe(1);
    expect(a?.device_id).toBe("iPhone");
  });

  it("여러 요청은 직렬 — 한 번에 머리 하나만, resolve 마다 다음 승급(FIFO)", () => {
    const s = useRemoteConfirm.getState();
    s.enqueue(mkReq(1));
    s.enqueue(mkReq(2));
    s.enqueue(mkReq(3));
    expect(activeRequest(useRemoteConfirm.getState())?.request_id).toBe(1);

    useRemoteConfirm.getState().resolve(true);
    expect(activeRequest(useRemoteConfirm.getState())?.request_id).toBe(2);

    useRemoteConfirm.getState().resolve(false);
    expect(activeRequest(useRemoteConfirm.getState())?.request_id).toBe(3);

    useRemoteConfirm.getState().resolve(true);
    expect(activeRequest(useRemoteConfirm.getState())).toBeNull();
  });

  it("resolve 는 머리 결정을 sink(Rust 진입점)로 정확히 전송", () => {
    const s = useRemoteConfirm.getState();
    s.enqueue(mkReq(11));
    s.enqueue(mkReq(22));
    useRemoteConfirm.getState().resolve(true); // approve 11
    useRemoteConfirm.getState().resolve(false); // deny 22
    expect(resolved).toEqual([
      { id: 11, approve: true },
      { id: 22, approve: false },
    ]);
  });

  it("빈 큐 resolve 는 no-op(sink 미호출, 크래시 0)", () => {
    useRemoteConfirm.getState().resolve(true);
    expect(resolved).toEqual([]);
    expect(activeRequest(useRemoteConfirm.getState())).toBeNull();
  });

  it("같은 request_id 재emit 은 멱등 무시(중복 표시 0)", () => {
    const s = useRemoteConfirm.getState();
    s.enqueue(mkReq(5));
    s.enqueue(mkReq(5)); // 중복 — 무시돼야
    s.enqueue(mkReq(6));
    expect(useRemoteConfirm.getState().queue.map((r) => r.request_id)).toEqual([
      5, 6,
    ]);
  });

  it("expire(머리) 는 sink 안 부르고(Rust 가 이미 AUTO-DENY) 다음 승급", () => {
    const s = useRemoteConfirm.getState();
    s.enqueue(mkReq(7));
    s.enqueue(mkReq(8));
    useRemoteConfirm.getState().expire(7);
    expect(resolved).toEqual([]); // TTL 만료는 resolve 안 보냄.
    expect(activeRequest(useRemoteConfirm.getState())?.request_id).toBe(8);
  });

  it("expire(머리가 아닌 stale id)는 무시(stale 타이머가 새 머리를 못 떨어뜨림)", () => {
    const s = useRemoteConfirm.getState();
    s.enqueue(mkReq(9));
    s.enqueue(mkReq(10));
    useRemoteConfirm.getState().expire(10); // 머리(9)가 아님 — 무시
    expect(activeRequest(useRemoteConfirm.getState())?.request_id).toBe(9);
    expect(useRemoteConfirm.getState().queue.length).toBe(2);
  });
});
