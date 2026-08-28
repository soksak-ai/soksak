package application

import "github.com/soksak-ai/soksak-core/core/i18n"

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"application.processLabel.darwinLength": {
			EN: "Darwin process label has {bytes} bytes; expected 1 through 31",
			KO: "Darwin 프로세스 label은 {bytes}바이트이며 1바이트 이상 31바이트 이하여야 합니다",
		},
		"application.processLabel.retainFailed": {
			EN: "Darwin could not retain the process label",
			KO: "Darwin이 프로세스 label을 보관하지 못했습니다",
		},
		"application.processLabel.mismatch": {
			EN: "Darwin process name is {actual}; expected {requested}",
			KO: "Darwin 프로세스 이름은 {actual}이며 기대값은 {requested}입니다",
		},
		"application.processLabel.readFailed": {
			EN: "Darwin proc_name for pid {pid} returned {result}",
			KO: "Darwin proc_name이 pid {pid}에 대해 {result}을 반환했습니다",
		},
	})
}
