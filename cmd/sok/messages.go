package main

import "github.com/soksak/soksak-core/core/i18n"

// The refusals this command answers its caller with. A person at a shell reads
// these, so they are declared here rather than formatted at the call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"sok.request.notNameValue": {
			EN: `argument "{argument}" is not name=value`,
			KO: `인자 "{argument}" 이(가) name=value 형식이 아닙니다`,
		},
	})
}
