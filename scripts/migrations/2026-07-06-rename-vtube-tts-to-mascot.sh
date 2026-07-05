#!/bin/sh
# 일회용 마이그레이션 — 플러그인 개명 soksak-plugin-vtube-tts → soksak-plugin-mascot (2026-07-06).
# id 개명은 kv 네임스페이스·동의(consents)·플러그인 설정 블롭을 격리시킨다(과거 vtuber 개명 때 실측).
# 이전 대상: ① kv ns 통째(큐비즘 캐시 207KB·플러그인 설정) ② core 'plugins' 블롭의 consents 키
# ③ core 'pluginSettings' 블롭의 global/byProject 키 ④ activity 내부 저장키 vtube→mascot.
set -eu
DB="${1:-$HOME/.soksak-dev/data/soksak.db}"
OLD=soksak-plugin-vtube-tts
NEW=soksak-plugin-mascot
BACKUP="$(dirname "$DB")/../backups/soksak-premigration-mascot-$(date +%s).db"
mkdir -p "$(dirname "$BACKUP")"
sqlite3 "$DB" ".backup '$BACKUP'"
sqlite3 "$DB" "update kv set ns='$NEW' where ns='$OLD';"
sqlite3 "$DB" "update kv set k='mascot' where ns='soksak-plugin-activity' and k='vtube';"
python3 - "$DB" "$OLD" "$NEW" <<'PY'
import json, sqlite3, sys
db, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
conn = sqlite3.connect(db)
def rename_in_blob(key, fn):
    row = conn.execute("select v from kv where ns='core' and k=?", (key,)).fetchone()
    if not row: return
    blob = json.loads(row[0])
    if fn(blob):
        conn.execute("update kv set v=? where ns='core' and k=?", (json.dumps(blob, ensure_ascii=False), key))
def mv(d):
    if isinstance(d, dict) and old in d:
        d[new] = d.pop(old); return True
    return False
def plugins_mv(b):
    hit = mv(b.get('consents', {}))
    ids = b.get('enabledIds')
    if isinstance(ids, list) and old in ids:
        b['enabledIds'] = [new if x == old else x for x in ids]; hit = True
    return hit
rename_in_blob('plugins', plugins_mv)
def settings_mv(b):
    hit = mv(b.get('global', {}))
    for bag in b.get('byProject', {}).values():
        hit = mv(bag) or hit
    return hit
rename_in_blob('pluginSettings', settings_mv)
# 폴더 이동에 따른 경로 치환 — 설정 값(modelPath·speechModelDir·emotionMaps 키)이 플러그인
# 폴더 내부 파일을 절대경로로 가리킨다. 문자열 치환은 블롭·플러그인 kv 양쪽에.
oldp, newp = f"/plugins/{old}/", f"/plugins/{new}/"
for ns, k in [('core','pluginSettings'), (new,'settings')]:
    row = conn.execute("select v from kv where ns=? and k=?", (ns,k)).fetchone()
    if row and oldp in row[0]:
        conn.execute("update kv set v=? where ns=? and k=?", (row[0].replace(oldp,newp), ns, k))
conn.commit()
print('blobs migrated')
PY
echo "backup: $BACKUP"
sqlite3 "$DB" "select ns,k from kv where ns='$NEW'; select k from kv where ns='soksak-plugin-activity' and k='mascot';"
