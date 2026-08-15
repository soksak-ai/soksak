package secret

import "github.com/soksak/soksak-core/core/i18n"

// The refusals this group answers a caller with. A caller reads these over the
// command registry, so they are declared here rather than formatted at the
// call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"secret.record.notBase64": {
			EN: `secret: the record is not base64`,
			KO: `secret: 이 레코드는 base64 가 아닙니다`,
		},
		"secret.record.noNonce": {
			EN: `secret: the record is {bytes} bytes and holds no nonce`,
			KO: `secret: 이 레코드는 {bytes} 바이트이고 nonce 가 없습니다`,
		},
		"secret.record.wrongKeyOrAddress": {
			EN: `secret: the record does not match this device key, or it was moved from the address it was sealed at`,
			KO: `secret: 이 레코드는 이 기기 키와 맞지 않거나, 봉인된 주소에서 옮겨졌습니다`,
		},
		"secret.record.otherVersion": {
			EN: `secret: {ns}/{key} is a version {version} record and this build writes version {writes}`,
			KO: `secret: {ns}/{key} 는 버전 {version} 레코드이고 이 빌드는 버전 {writes} 를 기록합니다`,
		},
		"secret.record.otherDevice": {
			EN: `secret: {ns}/{key} was sealed under device key {sealed} and this host holds {held}`,
			KO: `secret: {ns}/{key} 는 기기 키 {sealed} 로 봉인되었고 이 호스트의 키는 {held} 입니다`,
		},
		"secret.record.notSealed": {
			EN: `secret: the record at {ns}/{key} is not a sealed record`,
			KO: `secret: {ns}/{key} 의 레코드는 봉인된 레코드가 아닙니다`,
		},
	})
}

// The refusals the vault answers before a record is ever read or written. What
// is missing is named, so a caller does not read a host gap as a missing key.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"secret.deviceKey.noKeyStore": {
			EN: `secret: this host was given no key store and holds no device key`,
			KO: `secret: 이 호스트에는 키 저장소가 주어지지 않았고 기기 키도 없습니다`,
		},
		"secret.deviceKey.wrongSize": {
			EN: `secret: the {backend} key store answered with a {size}-byte device key; {required} bytes are required`,
			KO: `secret: {backend} 키 저장소가 {size} 바이트 기기 키로 응답했습니다 — {required} 바이트가 필요합니다`,
		},
		"secret.deps.noStore": {
			EN: `secret: this process holds no store, and a vault with nowhere to write records is not one`,
			KO: `secret: 이 프로세스에는 스토어가 없습니다 — 레코드를 기록할 곳이 없으면 볼트가 아닙니다`,
		},
		"secret.get.notFound": {
			EN: `secret: {ns}/{key} is not in this vault`,
			KO: `secret: {ns}/{key} 은(는) 이 볼트에 없습니다`,
		},
	})
}

// The refusals the two names a secret is addressed by answer a caller with. A
// caller reads these over the command registry, so they are declared here
// rather than formatted at the call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"secret.namespace.empty": {
			EN: `secret: a namespace is empty, and a secret without a namespace has no owner`,
			KO: `secret: 네임스페이스가 비어 있습니다 — 네임스페이스 없는 비밀에는 소유자가 없습니다`,
		},
		"secret.namespace.illegal": {
			EN: `secret: namespace "{ns}" is not lowercase alphanumeric with hyphens`,
			KO: `secret: 네임스페이스 "{ns}" 은(는) 소문자·숫자·하이픈 형식이 아닙니다`,
		},
		"secret.key.notAName": {
			EN: `secret: key "{key}" is not a name`,
			KO: `secret: 키 "{key}" 은(는) 이름이 아닙니다`,
		},
		"secret.key.illegalCharacter": {
			EN: `secret: key "{key}" contains {char}, which a key may not`,
			KO: `secret: 키 "{key}" 에 허용되지 않는 문자 {char} 이(가) 있습니다`,
		},
	})
}
