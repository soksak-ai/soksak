package settings

import "github.com/soksak-ai/soksak-core/core/i18n"

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"settings.home.absolute": {EN: "settings home must be absolute", KO: "설정 홈 경로는 절대 경로여야 합니다"},
	})
}
