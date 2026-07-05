#!/bin/sh
# 일회용 마이그레이션 — 활동 영속의 자기증식 대형 행 제거(2026-07-05).
# 배경: command.executed 기록이 응답 data 전문을 실어 activity.recent 기록이 조회 결과를
# 자기포함(최대 75MB/행, 총 968MB). retention 의 json 파스가 수백 MB malloc 을 유발해
# CEF PartitionAlloc 이 프로세스를 즉사시켰다. 발행측 불변식(PERSIST_DOC_CAP=256KB)과
# 짝으로, 이미 쌓인 초과 행을 제거한다(전부 당일 생성된 자기증식 기록 — 보존 가치 0).
# 사용법: DB 경로 인자(기본 dev 홈). 실행 전 백업을 남긴다.
set -eu
DB="${1:-$HOME/.soksak-dev/data/soksak.db}"
CAP=262144
BACKUP="$(dirname "$DB")/../backups/soksak-premigration-doccap-$(date +%s).db"
mkdir -p "$(dirname "$BACKUP")"
sqlite3 "$DB" ".backup '$BACKUP'"
BEFORE=$(sqlite3 "$DB" "select count(*)||' rows, '||coalesce(sum(length(doc))/1048576,0)||' MB' from records where ns='core' and coll='activity'")
sqlite3 "$DB" "delete from records where ns='core' and coll='activity' and length(doc) > $CAP; vacuum;"
AFTER=$(sqlite3 "$DB" "select count(*)||' rows, '||coalesce(sum(length(doc))/1048576,0)||' MB' from records where ns='core' and coll='activity'")
echo "backup: $BACKUP"
echo "before: $BEFORE"
echo "after : $AFTER"
