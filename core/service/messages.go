package service

import "github.com/soksak/soksak-core/core/i18n"

// The refusals this package answers a caller with. A caller reads these over
// the command registry, so they are declared here rather than formatted at the
// call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"service.ledger.notJSON": {
			EN: "service: the ledger is not valid JSON",
			KO: "service: 원장이 유효한 JSON 이 아닙니다",
		},
	})
}
