#!/bin/bash
# 자연어 콘솔 E2E — 대화 세트(parentId 상관)의 회귀 가드(MESSAGE-PROTOCOL §4).
#   orchestrator.ask(스텁 에이전트) 1턴이 활동 스트림에 한 세트를 남긴다:
#     chat.prompt{turnId} → command.progress{parentId}(델타·도구줄)
#     → command.executed{parentId}(스텁이 실행한 실제 sok 명령) → chat.answer{parentId}
#   자식 명령은 tts 스펙(기본 낭독)을 그대로 갖고, prompt/answer/델타는 tts 없음(침묵).
#   에이전트 바이너리는 settings orchestratorAgent 로 주입·복원(유일한 E2E seam).
#
# 전제: debug 앱 실행 중 + `sok` 이 로그인셸 PATH 에 존재(스텁이 실행).
# 사용: bash scripts/e2e/nl-console.sh [--identity debug]
set -uo pipefail
IDENTITY=debug
[ "${1:-}" = "--identity" ] && IDENTITY="$2"
if [ "$IDENTITY" = "app" ]; then SOKSAK_E2E_HOME="$HOME/.soksak"; else SOKSAK_E2E_HOME="$HOME/.soksak-$IDENTITY"; fi

export NL_SOCK="$SOKSAK_E2E_HOME/com.soksak.$IDENTITY.sock"
export NL_STUB="$(cd "$(dirname "$0")" && pwd)/fixtures/nl-agent-stub.sh"
export NL_STUB_SLOW="$(cd "$(dirname "$0")" && pwd)/fixtures/nl-agent-stub-slow.sh"
chmod +x "$NL_STUB" "$NL_STUB_SLOW"

python3 - <<'PYEOF'
import json, os, socket, sys, threading, time
SOCK = os.environ["NL_SOCK"]
STUB = os.environ["NL_STUB"]
STUB_SLOW = os.environ["NL_STUB_SLOW"]
PASS = []; FAIL = []
def ok(m): PASS.append(m); print(f"  ✓ {m}")
def ng(m): FAIL.append(m); print(f"  ✗ {m}")
def rpc(method, params=None, window="main", t=25):
    s = socket.socket(socket.AF_UNIX); s.settimeout(t); s.connect(SOCK)
    req = {"id":1,"method":method,"params":params or {},"window":window}
    if t > 25: req["timeoutMs"] = int(t*1000) - 3000
    s.sendall((json.dumps(req)+"\n").encode())
    buf=b""
    while b"\n" not in buf:
        chunk=s.recv(1<<20)
        if not chunk: raise ConnectionError("소켓 EOF(응답 없이 닫힘)")
        buf+=chunk
    s.close()
    resp = json.loads(buf.split(b"\n")[0])
    if isinstance(resp, dict) and isinstance(resp.get("data"), dict):
        return {**resp["data"], **{k: v for k, v in resp.items() if k != "data"}}
    return resp

try: rpc("window.list", t=5)
except Exception: print("FAIL: 앱 소켓 없음 — debug 앱 실행 필요"); sys.exit(1)

# 신규 표면 존재(구코드 조기 탈락)
r = rpc("window.projects")
ok("window.projects 응답") if r.get("ok") else ng(f"window.projects: {r}")

# 에이전트 스텁 주입(끝나면 복원)
prev = rpc("settings.get").get("orchestratorAgent") or "claude"
r = rpc("settings.set", {"key":"orchestratorAgent","value":STUB})
ok("orchestratorAgent 스텁 주입") if r.get("ok") else ng(f"settings.set: {r}")

recent = rpc("activity.recent", {"limit":1})
base = (recent.get("entries") or [{}])[-1].get("seq", 0)

try:
    # ── 1턴 실행(스텁: 델타 → 실제 sok window.list → 답) ─────────────────────
    r = rpc("orchestrator.ask", {"text":"E2E 스텁 턴 — 창 확인"}, t=90)
    turn = (r.get("turnId") or "")
    ok("ask ok + 표준 답변") if r.get("ok") and r.get("message") == "창 목록을 확인했어요" else ng(f"ask: {r}")
    ok("turnId 반환") if turn else ng(f"turnId 없음: {r}")

    ents = rpc("activity.recent", {"since": base, "limit": 200}).get("entries") or []
    def find(kind, pred=lambda p: True):
        return [e for e in ents if e.get("kind")==kind and pred(e.get("payload") or {})]

    prompts = find("chat.prompt", lambda p: p.get("turnId")==turn)
    ok("chat.prompt{turnId} 존재") if len(prompts)==1 else ng(f"chat.prompt {len(prompts)}건")
    execs = find("command.executed", lambda p: p.get("parentId")==turn and p.get("command")=="window.list")
    ok("자식 command.executed{parentId} 존재 — SOKSAK_PARENT 관통") if len(execs)==1 else ng(f"자식 실행 {len(execs)}건")
    progress = find("command.progress", lambda p: p.get("parentId")==turn)
    ok("command.progress{parentId} 존재(델타/도구줄)") if progress else ng("progress 델타 없음")
    answers = find("chat.answer", lambda p: p.get("parentId")==turn)
    ok("chat.answer{parentId} 세트 닫음") if len(answers)==1 and answers[0]["payload"].get("text")=="창 목록을 확인했어요" else ng(f"answer: {answers}")

    if prompts and execs and answers:
        s1, s2, s3 = prompts[0]["seq"], execs[0]["seq"], answers[0]["seq"]
        ok("세트 순서 prompt < 자식 < answer") if s1 < s2 < s3 else ng(f"순서: {s1},{s2},{s3}")

    # 낭독 스펙: 자식 명령은 tts(기본 낭독) 보유, prompt/answer/델타는 tts 없음(침묵)
    if execs:
        ok("자식 명령 tts 보유(기본 낭독 스펙)") if execs[0]["payload"].get("tts") else ng(f"자식 tts 누락: {execs[0]['payload']}")
    silent = [e for e in prompts + answers + progress if (e.get("payload") or {}).get("tts")]
    ok("prompt/answer/델타 무tts(침묵)") if not silent else ng(f"tts 실림: {silent}")

    # orchestrator.ask 자체는 trace:false — command.executed 로 중복 계측되지 않는다
    dup = find("command.executed", lambda p: p.get("command")=="orchestrator.ask")
    ok("ask 자체 무계측(trace:false)") if not dup else ng(f"ask 계측 중복 {len(dup)}건")

    # 재턴 = --resume 연속성 경로(세션 id 저장) — 두 번째 세트도 완결돼야 한다
    r2 = rpc("orchestrator.ask", {"text":"E2E 스텁 2턴"}, t=90)
    ok("2턴(resume 경로) ok") if r2.get("ok") else ng(f"2턴: {r2}")

    # ── stop(중지) 경로: 느린 스텁 턴을 걸어두고 stop → CANCELLED 로 세트가 닫혀야 한다 ──
    rpc("settings.set", {"key":"orchestratorAgent","value":STUB_SLOW})
    box = {}
    def slow_ask():
        try: box["r"] = rpc("orchestrator.ask", {"text":"E2E 중지 대상 턴"}, t=90)
        except Exception as e: box["r"] = {"ok": False, "code": "HARNESS", "message": str(e)}
    th = threading.Thread(target=slow_ask); th.start()
    # 진행 중(BUSY) 확인 후 중지 — 스폰·델타가 자리잡을 짧은 유예.
    time.sleep(3)
    busy = rpc("orchestrator.ask", {"text":"동시 턴"})
    ok("진행 중 BUSY 거절") if (not busy.get("ok")) and busy.get("code")=="BUSY" else ng(f"BUSY: {busy}")
    st = rpc("orchestrator.stop", {})
    ok("stop ok") if st.get("ok") else ng(f"stop: {st}")
    th.join(timeout=30)
    r3 = box.get("r") or {}
    ok("중지 턴 CANCELLED 봉투") if (not r3.get("ok")) and r3.get("code")=="CANCELLED" else ng(f"중지 응답: {r3}")
    ents3 = rpc("activity.recent", {"limit":10}).get("entries") or []
    canc = [e for e in ents3 if e.get("kind")=="chat.answer" and (e.get("payload") or {}).get("code")=="CANCELLED"]
    ok("CANCELLED chat.answer 로 세트 닫힘") if canc else ng("CANCELLED answer 없음")
finally:
    rpc("settings.set", {"key":"orchestratorAgent","value":prev})
print(f"\n결과: PASS {len(PASS)} / FAIL {len(FAIL)}")
sys.exit(1 if FAIL else 0)
PYEOF
