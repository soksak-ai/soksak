// Remote confirm serial queue (phone-link safety model) — enqueue/resolve/expire + sink dispatch + idempotence.
// Pure store logic only (no Tauri dependency) — a recorder is injected as the sink to assert the decision dispatch.
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

// Decision recorder — records (request_id, approve) pairs in order.
let resolved: Array<{ id: number; approve: boolean }>;

beforeEach(() => {
  resolved = [];
  useRemoteConfirm.setState({ queue: [] });
  useRemoteConfirm.getState().setSink((id, approve) => {
    resolved.push({ id, approve });
  });
});

describe("remoteConfirm serial queue", () => {
  it("active is null on an empty queue (idle leaves no trace)", () => {
    expect(activeRequest(useRemoteConfirm.getState())).toBeNull();
  });

  it("enqueue exposes the head as active", () => {
    useRemoteConfirm.getState().enqueue(mkReq(1, { device_id: "iPhone" }));
    const a = activeRequest(useRemoteConfirm.getState());
    expect(a?.request_id).toBe(1);
    expect(a?.device_id).toBe("iPhone");
  });

  it("requests are serial — one head at a time, each resolve promotes the next (FIFO)", () => {
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

  it("resolve sends the head decision to the sink (core entry point) exactly", () => {
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

  it("resolve on an empty queue is a no-op (sink not called, no crash)", () => {
    useRemoteConfirm.getState().resolve(true);
    expect(resolved).toEqual([]);
    expect(activeRequest(useRemoteConfirm.getState())).toBeNull();
  });

  it("a re-emitted request_id is idempotently ignored (no duplicate prompt)", () => {
    const s = useRemoteConfirm.getState();
    s.enqueue(mkReq(5));
    s.enqueue(mkReq(5)); // duplicate — must be ignored
    s.enqueue(mkReq(6));
    expect(useRemoteConfirm.getState().queue.map((r) => r.request_id)).toEqual([
      5, 6,
    ]);
  });

  it("expire on the head skips the sink (the core already AUTO-DENYs) and promotes the next", () => {
    const s = useRemoteConfirm.getState();
    s.enqueue(mkReq(7));
    s.enqueue(mkReq(8));
    useRemoteConfirm.getState().expire(7);
    expect(resolved).toEqual([]); // a TTL expiry sends no resolve.
    expect(activeRequest(useRemoteConfirm.getState())?.request_id).toBe(8);
  });

  it("expire on a stale non-head id is ignored (a stale timer cannot drop the new head)", () => {
    const s = useRemoteConfirm.getState();
    s.enqueue(mkReq(9));
    s.enqueue(mkReq(10));
    useRemoteConfirm.getState().expire(10); // not the head (9) — ignored
    expect(activeRequest(useRemoteConfirm.getState())?.request_id).toBe(9);
    expect(useRemoteConfirm.getState().queue.length).toBe(2);
  });
});
