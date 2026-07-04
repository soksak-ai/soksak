#!/bin/bash
# 일회용 마이그레이션 — main = 컨트롤 플레인 예약어 전환(NAMING 4b).
#
# 무엇: main 이 워크스페이스 창이던 세대의 데이터를 교정한다 — app.data core kv 의
#   `window/main` 스냅샷을 새 w-<uuid4> 키로 옮기고, manifest("windows")의 main slot 을
#   같은 라벨로 교체하며(프레임 rect 는 새 워크스페이스 창이 물려받는다), focusedLabel 이
#   main 이면 함께 이관한다. 값(워크스페이스 내용)은 건드리지 않는다.
# 왜: main 은 이제 컨트롤 플레인(오케스트레이터)의 예약어다 — 워크스페이스를 갖지 않는다.
#   워크스페이스 창은 전부 w-<uuid4> 이고, 리스폰은 main slot 을 스폰하지 않는다.
# 사용: bash scripts/migrations/20260705-main-control-plane.sh [--identity debug|dev|app]
#   기본 debug. 대상 identity 의 앱을 종료한 뒤 실행한다(동시 쓰기 방지 — 실행 중이면 거부).
# 멱등: window/main 스냅샷이 없거나 비어 있으면 manifest 의 main slot 잔재만 정리한다.
#   실행 전 data/backups 에 백업을 만든다.
set -euo pipefail

IDENTITY=debug
[ "${1:-}" = "--identity" ] && IDENTITY="$2"
if [ "$IDENTITY" = "app" ]; then HOME_DIR="$HOME/.soksak"; else HOME_DIR="$HOME/.soksak-$IDENTITY"; fi
DB="$HOME_DIR/data/soksak.db"
SOCK="$HOME_DIR/com.soksak.$IDENTITY.sock"
[ -f "$DB" ] || { echo "데이터 없음: $DB — 이관 대상 아님"; exit 0; }

if [ -S "$SOCK" ] && python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.settimeout(1)
try: s.connect('$SOCK'); sys.exit(0)
except Exception: sys.exit(1)
" 2>/dev/null; then
  echo "거부: $IDENTITY 앱이 실행 중 — 종료 후 다시 실행" >&2; exit 1
fi

MIG_DB="$DB" python3 - <<'PYEOF'
import json, os, shutil, sqlite3, time, uuid

db = os.environ["MIG_DB"]
con = sqlite3.connect(db)
con.execute("PRAGMA wal_checkpoint(TRUNCATE)")

snap_row = con.execute("SELECT v FROM kv WHERE ns='core' AND k='window/main'").fetchone()
man_row = con.execute("SELECT v FROM kv WHERE ns='core' AND k='windows'").fetchone()
snap = json.loads(snap_row[0]) if snap_row else None
manifest = json.loads(man_row[0]) if man_row else None
has_workspace = bool(snap and snap.get("projects"))
main_slot = next((s for s in (manifest or {}).get("slots", []) if s.get("label") == "main"), None)

if not has_workspace and not main_slot and not snap_row:
    print("이관 대상 없음 — main 은 이미 컨트롤 플레인"); raise SystemExit

backup = os.path.join(os.path.dirname(db), "..", "backups",
                      f"soksak-premigration-{int(time.time()*1000)}.db")
os.makedirs(os.path.dirname(backup), exist_ok=True)
shutil.copy2(db, backup)
print(f"백업: {os.path.normpath(backup)}")

now = int(time.time() * 1000)
if has_workspace:
    neo = f"w-{uuid.uuid4()}"
    con.execute("UPDATE OR REPLACE kv SET k=?, updated=? WHERE ns='core' AND k='window/main'",
                (f"window/{neo}", now))
    if manifest is None:
        manifest = {"slots": []}
    if main_slot:
        main_slot["label"] = neo
    else:
        manifest.setdefault("slots", []).append(
            {"label": neo, "roots": [p.get("root") for p in snap["projects"] if p.get("root")],
             "activeRoot": None})
    if manifest.get("focusedLabel") == "main":
        manifest["focusedLabel"] = neo
    con.execute("INSERT OR REPLACE INTO kv(ns, k, v, updated) VALUES('core','windows',?,?)",
                (json.dumps(manifest, ensure_ascii=False), now))
    print(f"이관: main 워크스페이스 → {neo}")
else:
    # 빈 스냅샷 잔재 정리 — 워크스페이스가 없던 main 은 옮길 것이 없다.
    if snap_row:
        con.execute("DELETE FROM kv WHERE ns='core' AND k='window/main'")
        print("정리: 빈 window/main 스냅샷 삭제")
    if manifest is not None and main_slot:
        manifest["slots"] = [s for s in manifest["slots"] if s.get("label") != "main"]
        if manifest.get("focusedLabel") == "main":
            manifest.pop("focusedLabel", None)
        con.execute("UPDATE kv SET v=?, updated=? WHERE ns='core' AND k='windows'",
                    (json.dumps(manifest, ensure_ascii=False), now))
        print("정리: manifest 의 main slot 제거")
con.commit(); con.close()
print("완료")
PYEOF
