# 플러그인 테스트 소유권

Core는 사용자의 development home을 테스트 입력으로 읽지 않으며 저장소 사이의 manifest
예외 목록을 관리하지 않습니다. 각 플러그인 저장소가 공개 spec을 기준으로 자신의 manifest를
검증합니다. 설치 acceptance 저장소는 선택된 immutable release를 black-box composition으로
검증합니다.

Core는 자신의 parser facade, 설치 구분, runtime loading과 그 책임을 검증하는 테스트 안의
최소 manifest만 소유합니다. 플러그인 source manifest는 해당 owner 저장소에 남습니다. 과거
corpus 측정은 기록이며 현재 gate나 migration fallback이 아닙니다.
