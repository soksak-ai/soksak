package sidecar

import "github.com/soksak-ai/soksak-core/core/i18n"

// The refusals this package answers a caller with.
//
// Each states what is missing and who has to act on it. A caller reads these over the command
// registry, so they are declared here rather than formatted at the call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"sidecar.requirementTrailingData": {
			EN: "sidecar requirement contains trailing JSON data",
			KO: "사이드카 요구사항에 불필요한 JSON 데이터가 있습니다",
		},
		"sidecar.requirementIDRequired": {
			EN: "sidecar requirement id is required",
			KO: "사이드카 요구사항 ID가 필요합니다",
		},
		"sidecar.noResolver": {EN: "sidecar {name} has no installation settings resolver", KO: "사이드카 {name}의 설치 설정 경로를 해석할 수 없습니다"},
		"sidecar.secretSetMismatch": {
			EN: "sidecar {name} is already running with a different declared secret set",
			KO: "sidecar {name} 이(가) 다른 시크릿 선언으로 이미 실행 중입니다",
		},
		"sidecar.noSecretGenerator": {
			EN: "sidecar {name} requires a generated secret and this host has no secret generator",
			KO: "사이드카 {name} 에 생성된 시크릿이 필요하지만 이 호스트에는 시크릿 생성기가 없습니다",
		},
		"sidecar.invalidGeneratedSecret": {
			EN: "sidecar {name} declares an invalid generated secret",
			KO: "사이드카 {name} 이(가) 잘못된 생성 시크릿을 선언했습니다",
		},
		"sidecar.secretModesConflict": {
			EN: "sidecar {name} cannot mix plugin-owned and unit-owned secrets in one open",
			KO: "사이드카 {name} 은(는) 한 번의 열기에서 플러그인 소유 시크릿과 유닛 소유 시크릿을 함께 사용할 수 없습니다",
		},
		"sidecar.noSpawner": {
			EN: "sidecar {name} cannot start: this host was given no spawner",
			KO: "사이드카 {name} 을(를) 시작할 수 없습니다 — 이 호스트에 spawner 가 없습니다",
		},
		"sidecar.noDial": {
			EN: "sidecar {name} cannot be reached: this host was given no way to open its address",
			KO: "사이드카 {name} 에 닿을 수 없습니다 — 이 호스트에 주소를 여는 수단이 없습니다",
		},
		"sidecar.notOpen": {
			EN: "sidecar {name} is not open in this host",
			KO: "사이드카 {name} 이(가) 이 호스트에서 열려 있지 않습니다",
		},
		"sidecar.silent": {
			EN: "sidecar {name} printed nothing within {seconds}s — readiness is its first line, and a process that prints none never becomes ready",
			KO: "사이드카 {name} 이(가) {seconds}초 동안 아무것도 출력하지 않았습니다 — 준비 신호는 첫 줄이며, 아무것도 출력하지 않는 프로세스는 준비되지 않습니다",
		},
		"sidecar.noAnnouncement": {
			EN: "sidecar {name} ended before it printed anything: {reason}",
			KO: "사이드카 {name} 이(가) 아무것도 출력하기 전에 종료되었습니다: {reason}",
		},
		"sidecar.mute": {
			EN: `sidecar {name} announced nothing — its first line was "{line}", and the first line is the only announcement`,
			KO: `사이드카 {name} 이(가) 아무것도 알리지 않았습니다 — 첫 줄이 "{line}" 이었고, 첫 줄만이 announcement 입니다`,
		},
		"sidecar.announcedNoProtocol": {
			EN: "sidecar {name} announced an address and no protocol — there is no way to tell which envelope it speaks",
			KO: "사이드카 {name} 이(가) 주소만 알리고 프로토콜을 알리지 않았습니다 — 어떤 봉투를 말하는지 알 수 없습니다",
		},
		"sidecar.announcedNoAddress": {
			EN: "sidecar {name} announced a protocol and no address — there is nowhere to reach it",
			KO: "사이드카 {name} 이(가) 프로토콜만 알리고 주소를 알리지 않았습니다 — 닿을 곳이 없습니다",
		},
		"sidecar.announcedEmptyAddress": {
			EN: "sidecar {name} announced an empty address",
			KO: "사이드카 {name} 이(가) 빈 주소를 알렸습니다",
		},
		"sidecar.protocolMismatch": {
			EN: "sidecar {name} speaks envelope protocol {theirs} and this build speaks {ours} — refused at the announcement rather than at the first command that would behave differently",
			KO: "사이드카 {name} 은(는) 봉투 프로토콜 {theirs} 을(를) 말하고 이 빌드는 {ours} 를 말합니다 — 다르게 동작할 첫 명령이 아니라 announcement 에서 거절합니다",
		},
		"sidecar.dialFailed": {
			EN: "sidecar {name} announced {address} and nothing is listening there: {reason}",
			KO: "사이드카 {name} 이(가) {address} 를 알렸는데 그곳에서 아무도 듣고 있지 않습니다: {reason}",
		},
		"sidecar.payloadNotARequest": {
			EN: "sidecar {name} request is invalid: {reason}",
			KO: "사이드카 {name} 요청이 올바르지 않습니다: {reason}",
		},
		"sidecar.contractMismatch": {
			EN: "sidecar {name} implements {found}; the plugin requires {wanted}",
			KO: "사이드카 {name}은(는) {found}을(를) 구현하지만 플러그인은 {wanted}을(를) 요구합니다",
		},
		"sidecar.versionMismatch": {
			EN: "sidecar {name} implements {wanted} at {found} and the manifest requires exactly {wanted2}",
			KO: "사이드카 {name} 이(가) 구현하는 버전은 {found} 이고 매니페스트는 정확히 {wanted2} 를 요구합니다",
		},
		"sidecar.greetingRefused": {
			EN: "sidecar {name} refused the greeting: {reason} — nothing was sent on this connection, so no command ran against a protocol neither side agreed",
			KO: "사이드카 {name} 이(가) 그리팅을 거절했습니다: {reason} — 이 연결로 아무것도 보내지 않았으므로, 양쪽이 합의하지 않은 프로토콜로 실행된 명령은 없습니다",
		},
		"sidecar.noAnswer": {
			EN: "sidecar {name} took the request and answered nothing: {reason}",
			KO: "사이드카 {name} 이(가) 요청을 받고 아무 응답도 하지 않았습니다: {reason}",
		},
		"sidecar.invalidAdoptedPID":  {EN: "adopted sidecar process id is invalid: {pid}", KO: "adopt된 sidecar process id가 올바르지 않습니다: {pid}"},
		"sidecar.adoptedStopTimeout": {EN: "adopted sidecar process {pid} did not exit within {seconds}s", KO: "adopt된 sidecar process {pid}가 {seconds}초 안에 종료되지 않았습니다"},
		"sidecar.recordNotRegular":   {EN: "sidecar ownership record is not a regular file: {path}", KO: "sidecar ownership record가 일반 파일이 아닙니다: {path}"},
		"sidecar.recordInvalid":      {EN: "sidecar ownership record is invalid: {path}", KO: "sidecar ownership record가 올바르지 않습니다: {path}"},
	})
}
