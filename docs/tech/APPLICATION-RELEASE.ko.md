# 애플리케이션 릴리스

Core 애플리케이션 버전의 정본은 루트 `VERSION` 하나입니다. `frontend/package.json`과 Windows,
macOS, Linux package metadata는 test가 검사하는 정확한 projection입니다. Release matrix는
Windows x86_64, macOS universal, Linux x86_64, Linux arm64이며 packager는 일부 target만 있는
matrix를 거부하고 archive를 만들기 전에 PE, fat Mach-O, ELF architecture를 검사합니다.

각 저장소의 Go version 정본은 `go.mod`의 정확한 `go` directive 하나입니다. Docker, Actions,
shell gate는 literal을 복사하지 않고 이를 읽습니다. Frontend Node와 pnpm version은
`frontend/package.json`에 있으며 pinned frontend container 하나가 `dist` 옆에 input digest를
기록합니다. 모든 target은 동일한 frontend byte를 사용합니다. Cross image는 target architecture별
image입니다. Linux는 선언된 Ubuntu 24.04 GTK4/WebKit 6.0 SDK를 사용하고 관측한 GLIBC 최댓값을
release record에 기록합니다.

macOS application은 native x86_64와 arm64 slice로 빌드한 뒤 universal app으로 합치고 ad-hoc
sign합니다. Intel slice는 macOS 10.15, Apple Silicon slice는 macOS 11.0을 target으로 합니다. Go
control client는 Go 1.26 internal linker 기준인 macOS 12.0을 두 slice에 사용합니다. Native command는
linker warning을 거부하고 deployment target과 signature를 모두 검사합니다.

각 platform archive는 native system run, architecture, inventory, signing 상태를 기록합니다.
`SHA256SUMS`는 네 archive, provenance, 두 release note를 모두 포함합니다. 일부 matrix 또는 기존 tag는
발행할 수 없고 owner-enforced immutable release가 필수입니다. Windows와 Linux는 unsigned이고
macOS는 ad-hoc signed이며 Developer ID signed 또는 notarized 상태가 아닙니다.

macOS link gate는 빈 Go cache에서 시작하고 linker warning을 거부합니다. 여러 framework 기반
cgo package가 Objective-C runtime을 함께 전달할 수 있으므로 각 slice를 선언된 target으로 유지한
상태에서 해당 duplicate-library 진단만 비활성화합니다.

## 발행된 v0.0.2 증거

Tag `v0.0.2`는 source commit `badc426cff97cca1b8dd9b2e67e31e62c11fe40e`를 가리킵니다. Native
system run `32644742653`은 Windows x86_64, macOS, Linux x86_64, Linux arm64에서 installed fleet을
build하고 통과했습니다. Release run `32645366005`는 이 검증된 artifact만 사용해 네 archive,
`SHA256SUMS`, provenance, 영어/한글 release note를 immutable release로 발행했습니다.

## 발행된 v0.0.3 증거

Tag `v0.0.3`은 source commit `1d140596d9a0c54f14ecb998ae0cce2c4a156f7e`를 가리킵니다.
Native system run `32673034161`은 Windows x86_64, macOS, Linux x86_64, Linux arm64에서 인증된
Registry 14 fleet을 build하고 통과했습니다. Release run `32673381309`는 이 검증된 artifact만
사용해 네 archive, `SHA256SUMS`, provenance, 영어/한글 release note를 owner-enforced immutable
release로 발행했습니다. 다운로드한 `SHA256SUMS`는 모든 archive, provenance, 두 note에서
검증됐고 provenance는 네 target과 위 system run을 정확히 기록합니다.
