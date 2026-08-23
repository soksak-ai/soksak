package environment

import "github.com/soksak-ai/soksak-core/core/i18n"

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"environment.home.absolute": {EN: "environment home must be absolute", KO: "환경 홈 경로는 절대 경로여야 합니다"},
	})
}
