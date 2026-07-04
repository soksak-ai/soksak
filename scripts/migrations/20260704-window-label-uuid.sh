#!/bin/bash
# 일회용 마이그레이션 — 창 라벨 세대 이관: win-<seq> → w-<uuid4> (NAMING 4b).
#
# 무엇: app.data core kv 의 창 manifest("windows")와 스냅샷("window/<label>")에서
#   구세대 라벨을 가진 slot 을 새 uuid 라벨로 옮긴다(스냅샷 키 rename + manifest
#   label/focusedLabel 교체). 값(워크스페이스 내용)은 건드리지 않는다.
# 왜: 런타임 창 라벨은 w-<uuid4> 만 존재한다(NAMING 4b). capability windows 스코프도
#   w-* 만 허용하므로, 구세대 slot 은 리스폰이 스폰을 거부한다(workspaceBoot 가드) —
#   이 스크립트가 데이터를 현 세대로 교정한다.
# 사용: bash scripts/migrations/20260704-window-label-uuid.sh [--identity debug|dev|app]
#   기본 debug. 대상 identity 의 앱을 종료한 뒤 실행한다(동시 쓰기 방지 — 실행 중이면 거부).
# 멱등: 이관 대상이 없으면 아무것도 바꾸지 않는다. 실행 전 data/backups 에 백업을 만든다.
set -euo pipefail

IDENTITY=debug
[ "${1:-}" = "--identity" ] && IDENTITY="$2"
if [ "$IDENTITY" = "app" ]; then HOME_DIR="$HOME/.soksak"; else HOME_DIR="$HOME/.soksak-$IDENTITY"; fi
DB="$HOME_DIR/data/soksak.db"
SOCK="$HOME_DIR/com.soksak.$IDENTITY.sock"
[ -f "$DB" ] || { echo "데이터 없음: $DB — 이관 대상 아님"; exit 0; }

# 실행 중 거부 — 소켓이 살아 있으면 그 identity 의 앱이 manifest 를 쓰고 있다.
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

row = con.execute("SELECT v FROM kv WHERE ns='core' AND k='windows'").fetchone()
if not row:
    print("manifest 없음 — 이관 대상 아님"); raise SystemExit
manifest = json.loads(row[0])
legacy = [s for s in manifest.get("slots", [])
          if s.get("label") != "main" and not str(s.get("label", "")).startswith("w-")]
if not legacy:
    print("이관 대상 없음 — 전 slot 이 현 세대(w-*)"); raise SystemExit

backup = os.path.join(os.path.dirname(db), "..", "backups",
                      f"soksak-premigration-{int(time.time()*1000)}.db")
os.makedirs(os.path.dirname(backup), exist_ok=True)
shutil.copy2(db, backup)
print(f"백업: {os.path.normpath(backup)}")

now = int(time.time() * 1000)
for slot in legacy:
    old = slot["label"]; neo = f"w-{uuid.uuid4()}"
    # 스냅샷 키 rename(값 불변). 스냅샷 없는 slot 은 manifest 만 교정(유령 slot 은 부트가 정리).
    con.execute("UPDATE OR REPLACE kv SET k=?, updated=? WHERE ns='core' AND k=?",
                (f"window/{neo}", now, f"window/{old}"))
    slot["label"] = neo
    if manifest.get("focusedLabel") == old:
        manifest["focusedLabel"] = neo
    print(f"이관: {old} → {neo}")
con.execute("UPDATE kv SET v=?, updated=? WHERE ns='core' AND k='windows'",
            (json.dumps(manifest, ensure_ascii=False), now))
con.commit(); con.close()
print(f"완료: slot {len(legacy)}개 이관")
PYEOF
