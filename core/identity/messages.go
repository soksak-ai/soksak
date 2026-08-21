package identity

import "github.com/soksak-ai/soksak-core/core/i18n"

// The refusal this package answers a caller with. The identifier is an input,
// never a guess, so the missing input is named rather than filled in.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"identity.require.noIdentifier": {
			EN: "identity: no identifier was given, and one is never derived",
			KO: "identity: 식별자를 받지 못했으며 식별자는 추론하지 않습니다",
		},
		"identity.require.runtimeNotAbsolute": {
			EN: "identity: runtime endpoint directory must be absolute: {path}",
			KO: "identity: 런타임 끝점 디렉터리는 절대 경로여야 합니다: {path}",
		},
		"identity.require.persistentNotAbsolute": {
			EN: "identity: persistent home must be absolute: {path}",
			KO: "identity: 영구 홈은 절대 경로여야 합니다: {path}",
		},
	})
}
