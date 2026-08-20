package sidecar

import "github.com/soksak/soksak-core/core/i18n"

// The refusals this package answers a caller with.
//
// Each states what is missing and who has to act on it. A caller reads these over the command
// registry, so they are declared here rather than formatted at the call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
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
		"sidecar.undeclared": {
			EN: "sidecar {name} is not declared by this plugin's manifest — a unit nobody declared is a process nobody consented to",
			KO: "사이드카 {name} 은(는) 이 플러그인의 매니페스트가 선언하지 않았습니다 — 아무도 선언하지 않은 유닛은 아무도 동의하지 않은 프로세스입니다",
		},
		"sidecar.payloadNotARequest": {
			EN: "the payload for sidecar {name} is not a request envelope: {reason}",
			KO: "사이드카 {name} 에 보낼 payload 가 요청 봉투가 아닙니다: {reason}",
		},
		"sidecar.contractMismatch": {
			EN: "sidecar {name} implements {found} and the manifest requires {wanted} — a unit answering another contract does not fail, it answers with something else's meaning",
			KO: "사이드카 {name} 은(는) {found} 을(를) 구현하고 매니페스트는 {wanted} 을(를) 요구합니다 — 다른 계약을 답하는 유닛은 실패하지 않고 다른 의미로 응답합니다",
		},
		"sidecar.versionMismatch": {
			EN: "sidecar {name} implements {wanted} at {found} and the manifest requires exactly {wanted2} — an unstable contract is consumed at one version, never across a range",
			KO: "사이드카 {name} 이(가) 구현하는 판은 {found} 이고 매니페스트는 정확히 {wanted2} 를 요구합니다 — 불안정 계약은 범위가 아니라 한 판으로만 소비합니다",
		},
		"sidecar.noRelease": {
			EN: "sidecar {name} states no contract: {path} is missing — an installed unit declares what it implements beside its binary, and without it nothing can be checked against what was asked for",
			KO: "사이드카 {name} 이(가) 어떤 계약도 밝히지 않습니다 — {path} 이(가) 없습니다. 설치된 유닛은 무엇을 구현하는지를 바이너리 옆에 선언하며, 그것이 없으면 요구한 것과 대조할 수 없습니다",
		},
		"sidecar.releaseUnreadable": {
			EN: "sidecar {name}: {path} is not a release manifest: {reason}",
			KO: "사이드카 {name}: {path} 이(가) 릴리스 매니페스트가 아닙니다: {reason}",
		},
		"sidecar.releaseDeclaresNoInterface": {
			EN: "sidecar {name}: {path} names no interface — a unit that states no contract cannot be matched to one",
			KO: "사이드카 {name}: {path} 이(가) 인터페이스를 밝히지 않습니다 — 계약을 밝히지 않는 유닛은 어떤 계약과도 대조할 수 없습니다",
		},
		"sidecar.releaseNamesAnotherUnit": {
			EN: "sidecar {name}: {path} names unit {found} — the install put one unit's release under another's name, and opening it would run something nobody asked for",
			KO: "사이드카 {name}: {path} 이(가) 유닛 {found} 을(를) 가리킵니다 — 설치가 한 유닛의 릴리스를 다른 이름 아래 두었고, 여는 것은 아무도 요청하지 않은 것을 실행하는 일입니다",
		},
		"sidecar.greetingRefused": {
			EN: "sidecar {name} refused the greeting: {reason} — nothing was sent on this connection, so no command ran against a protocol neither side agreed",
			KO: "사이드카 {name} 이(가) 그리팅을 거절했습니다: {reason} — 이 연결로 아무것도 보내지 않았으므로, 양쪽이 합의하지 않은 프로토콜로 실행된 명령은 없습니다",
		},
		"sidecar.noAnswer": {
			EN: "sidecar {name} took the request and answered nothing: {reason}",
			KO: "사이드카 {name} 이(가) 요청을 받고 아무 응답도 하지 않았습니다: {reason}",
		},
	})
}
