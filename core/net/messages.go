package net

import "github.com/soksak-ai/soksak-core/core/i18n"

// The refusals this package answers a caller with. A caller reads these over
// the command registry, so they are declared here rather than formatted at the
// call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"net.request.secretSubstitutionUnserved": {
			EN: "net: secret substitution is not served yet; no vault is open",
			KO: "net: 비밀 치환은 아직 제공되지 않습니다 — 열린 볼트가 없습니다",
		},
		"net.request.impersonationUnserved": {
			EN: "net: impersonation {name} is not served yet",
			KO: "net: 위장 {name} 은(는) 아직 제공되지 않습니다",
		},
		"net.request.schemeNotAllowed": {
			EN: "net: scheme {scheme} is not allowed; only http and https",
			KO: "net: 스킴 {scheme} 은(는) 허용되지 않습니다 — http 와 https 만 허용합니다",
		},
		"net.request.noHost": {
			EN: "net: {url} has no host",
			KO: "net: {url} 에 host 가 없습니다",
		},
	})
}
