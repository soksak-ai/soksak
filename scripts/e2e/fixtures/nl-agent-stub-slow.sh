#!/bin/sh
# NL 콘솔 E2E 느린 스텁 — 델타 하나 뱉고 오래 잔다. orchestrator.stop(중지) 경로 검증용:
# kill 되면 result 없이 종료 → ask 가 CANCELLED 로 세트를 닫아야 한다.
echo '{"type":"system","subtype":"init","session_id":"stub-slow-1"}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"오래 걸리는 작업을 시작"}}}'
sleep 120
echo '{"type":"result","subtype":"success","result":"여기 도달하면 안 됨"}'
