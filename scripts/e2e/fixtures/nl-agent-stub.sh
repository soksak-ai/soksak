#!/bin/sh
# NL 콘솔 E2E 스텁 에이전트 — settings orchestratorAgent 에 주입되어 claude 대역을 맡는다.
# 각본된 stream-json 을 뱉으며 실제 `sok` 명령을 1회 실행한다: 스폰 env(SOKSAK_PARENT/
# SOKSAK_SOCKET) 상속으로 그 실행의 활동 엔트리에 parentId 가 실리는지가 검증 대상.
# 받은 인자(-p·플래그·프롬프트)는 각본이므로 무시한다.
echo '{"type":"system","subtype":"init","session_id":"stub-session-1"}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"창을 확인하는 중"}}}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"sok window.list"}}]}}'
sok window.list >/dev/null 2>&1
echo '{"type":"result","subtype":"success","result":"창 목록을 확인했어요"}'
