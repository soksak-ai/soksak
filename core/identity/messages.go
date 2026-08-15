package identity

import "github.com/soksak/soksak-core/core/i18n"

// The refusal this package answers a caller with. The identifier is an input,
// never a guess, so the missing input is named rather than filled in.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"identity.require.noIdentifier": {
			EN: "identity: no identifier was given, and one is never derived",
			KO: "identity: 식별자를 받지 못했으며 식별자는 추론하지 않습니다",
		},
	})
}
