package control

import "github.com/soksak-ai/soksak-core/core/i18n"

// The refusals this package answers a caller with. A caller reads these over
// the command registry, so they are declared here rather than formatted at the
// call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"control.delegate.noSource": {
			EN: "control: a delegation needs a source",
			KO: "control: 위임에는 출처가 필요합니다",
		},
		"control.delegate.noForwarder": {
			EN: "control: delegation {source} has no forwarder",
			KO: "control: 위임 {source} 에 전달자가 없습니다",
		},
		"control.delegate.emptyCommand": {
			EN: "control: delegation {source} named an empty command",
			KO: "control: 위임 {source} 이(가) 빈 명령 이름을 지정했습니다",
		},
		"control.delegate.servedLocally": {
			EN: "control: {source} cannot delegate {command}; this process serves it",
			KO: "control: {source} 은(는) {command} 을(를) 위임할 수 없습니다 — 이 프로세스가 서빙합니다",
		},
		"control.delegate.alreadyDelegated": {
			EN: "control: {source} cannot delegate {command}; {holder} already does",
			KO: "control: {source} 은(는) {command} 을(를) 위임할 수 없습니다 — {holder} 이(가) 이미 위임했습니다",
		},
	})
}

// The refusals the datagram commands answer a caller with. A caller reads these
// over the command registry, so they are declared here rather than formatted at
// the call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"control.datagram.windowTooSmall": {
			EN: `argument "{name}" is {value}; a collection window is at least 1ms`,
			KO: `인자 "{name}" 이(가) {value} 입니다 — 수집 창은 최소 1ms 입니다`,
		},
		"control.datagram.packetLimitTooSmall": {
			EN: `argument "{name}" is {value}; a collection holds at least one packet`,
			KO: `인자 "{name}" 이(가) {value} 입니다 — 한 번의 수집에는 최소 1개 패킷이 필요합니다`,
		},
		"control.datagram.replyNotUDP": {
			EN: "a reply arrived from {address}, which is not a UDP address",
			KO: "{address} 에서 응답이 도착했으나 UDP 주소가 아닙니다",
		},
		"control.datagram.broadcastRefused": {
			EN: `{address} is a broadcast address and is delivered to every machine on the segment; send "{name}":true to state that`,
			KO: `{address} 는 브로드캐스트 주소이며 세그먼트의 모든 장비로 전달됩니다 — 의도한 것이면 "{name}":true 를 보내십시오`,
		},
		"control.datagram.hostEmpty": {
			EN: `argument "{name}" is empty; name the host to send to`,
			KO: `인자 "{name}" 이(가) 비어 있습니다 — 보낼 호스트를 지정하십시오`,
		},
		"control.datagram.portRange": {
			EN: `argument "{name}" is {value}; a UDP port is 1..65535`,
			KO: `인자 "{name}" 이(가) {value} 입니다 — UDP 포트는 1..65535 입니다`,
		},
		"control.datagram.byteRange": {
			EN: `argument "{name}" element {index} is {value}; a byte is 0..255`,
			KO: `인자 "{name}" 의 {index} 번째 원소가 {value} 입니다 — 바이트는 0..255 입니다`,
		},
	})
}

// The refusals argument decoding answers a caller with. A caller reads these
// over the command registry, so they are declared here rather than formatted at
// the call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"control.arg.missing": {
			EN: `missing argument "{name}"`,
			KO: `인자 "{name}" 이(가) 없습니다`,
		},
		"control.arg.nullValue": {
			EN: `argument "{name}" is null; omit it or send a value`,
			KO: `인자 "{name}" 이(가) null 입니다 — 생략하거나 값을 보내십시오`,
		},
		"control.arg.nullDocument": {
			EN: `argument "{name}" is null; omit it or send a document`,
			KO: `인자 "{name}" 이(가) null 입니다 — 생략하거나 문서를 보내십시오`,
		},
	})
}

// The refusals Invoke answers a caller with. A caller reads these over the
// command registry, so they are declared here rather than formatted at the call
// site. Registration refusals are not here: they are returned to boot code that
// panics, so a developer reads them and they stay plain literals.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"control.invoke.unserved": {
			EN: "command {name} is not served: {reason}",
			KO: "명령 {name} 은(는) 제공되지 않습니다: {reason}",
		},
		"control.invoke.unknown": {
			EN: "command {name} is not registered",
			KO: "명령 {name} 은(는) 등록되어 있지 않습니다",
		},
	})
}

// The refusals the address and notification commands answer a caller with. A
// caller reads these over the command registry, so they are declared here
// rather than formatted at the call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"control.address.clientIsDirectory": {
			EN: "{path} is a directory, not the {name} client",
			KO: "{path} 은(는) 디렉터리이며 {name} 클라이언트가 아닙니다",
		},
		"control.notify.emptyTitle": {
			EN: `argument "{name}" is empty — a notification with no title cannot be attributed to the application that sent it`,
			KO: `인자 "{name}" 이(가) 비어 있습니다 — 제목 없는 알림은 보낸 애플리케이션을 식별할 수 없습니다`,
		},
	})
}

// The refusals stream argument decoding answers a caller with. A caller reads
// these over the command registry, so they are declared here rather than
// formatted at the call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"control.stream.missing": {
			EN: `missing argument "{name}", which must be a stream receiver: {"{key}": "<id>"}`,
			KO: `인자 "{name}" 이(가) 없습니다 — 스트림 수신자여야 합니다: {"{key}": "<id>"}`,
		},
		"control.stream.noID": {
			EN: `argument "{name}" has no "{key}", so frames have no receiver`,
			KO: `인자 "{name}" 에 "{key}" 가 없습니다 — 프레임을 받을 수신자가 없습니다`,
		},
	})
}
