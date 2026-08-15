package boot

import "github.com/soksak/soksak-core/core/i18n"

// The refusals this composition root answers a caller with. These handlers
// decode a raw argument themselves rather than going through control.Arg, so
// the sentence is declared here instead of formatted at the call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"boot.args.missing": {
			EN: `{command}: missing argument "{name}"`,
			KO: `{command}: 인자 "{name}" 이(가) 없습니다`,
		},
	})
}
