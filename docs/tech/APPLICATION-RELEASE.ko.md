# 애플리케이션 릴리스

Core 애플리케이션 버전의 정본은 `frontend/package.json` 하나입니다. 일치하는 `v*` tag를
push하면 해당 tag commit의 Wails release workflow가 실행됩니다. Workflow는 정확히 같은
commit을 성공 판정한 `windows-terminal-system` run을 찾고, 그 run이 실제로 테스트한
`soksak.exe`와 `sok.exe` 바이트를 다운로드합니다. Native 검증 뒤에 다른 바이트를 다시
빌드해 바꾸지 않습니다.

Packager는 결정적인 Windows x86_64 ZIP, `SHA256SUMS`, source commit, native system run, platform,
architecture, archive inventory, Authenticode 상태를 기록한 provenance document를 만듭니다.
Version과 tag는 source package file에서 파생합니다. Workflow는 이미 존재하는 tag를 거부하고
발행 전에 owner-enforced immutable releases를 요구합니다.

Version `0.0.1`에는 Windows Authenticode credential이 없습니다. 따라서 provenance와 release
note에 `unsigned`를 명시하며 식별된 publisher인 것처럼 표현하지 않습니다. Authenticode
certificate를 추가하려면 새 version, signed byte 검증, provenance 상태 변경이 필요합니다.

macOS Go command는 모든 cgo compile과 최종 link에 하나의 10.15 deployment target을
사용합니다. Link gate는 빈 Go cache에서 시작하고 linker warning을 거부합니다. 여러 framework
기반 cgo package가 Objective-C runtime을 함께 전달할 수 있으므로 모든 object의 deployment
target을 통일한 뒤 해당 duplicate-library 진단만 비활성화합니다.
