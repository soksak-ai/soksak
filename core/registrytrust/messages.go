package registrytrust

import "github.com/soksak-ai/soksak-core/core/i18n"

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"registrytrust.trailingData":     {EN: "registry document contains trailing JSON data", KO: "registry 문서에 불필요한 JSON 데이터가 있습니다"},
		"registrytrust.publicKeyInvalid": {EN: "registry public key is invalid", KO: "registry public key가 올바르지 않습니다"},
	})
}
