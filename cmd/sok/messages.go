package main

import "github.com/soksak-ai/soksak-core/core/i18n"

// The refusals this command answers its caller with. A person at a shell reads
// these, so they are declared here rather than formatted at the call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"sok.request.objectRequired": {EN: "the JSON argument must be one object", KO: "JSON 인자는 객체 하나여야 합니다"},
		"sok.request.mixedForms":     {EN: "a JSON object and name=value arguments cannot be mixed", KO: "JSON 객체와 name=value 인자를 함께 사용할 수 없습니다"},
		"sok.help.oneName": {
			EN: "help requires exactly one command name",
			KO: "help에는 명령 이름을 정확히 하나 지정해야 합니다",
		},
		"sok.request.notNameValue": {
			EN: `argument "{argument}" is not name=value`,
			KO: `인자 "{argument}" 이(가) name=value 형식이 아닙니다`,
		},
	})
}
