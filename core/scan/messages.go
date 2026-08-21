package scan

import "github.com/soksak-ai/soksak-core/core/i18n"

// The refusals this package answers a caller with. A caller reads these over
// the command registry, so they are declared here rather than formatted at the
// call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"scan.unitId.empty": {
			EN: "unit id is empty; it must match ^[a-z0-9][a-z0-9-]*$",
			KO: "유닛 id 가 비어 있습니다 — ^[a-z0-9][a-z0-9-]*$ 를 만족해야 합니다",
		},
		"scan.unitId.illegal": {
			EN: `unit id "{id}" must match ^[a-z0-9][a-z0-9-]*$`,
			KO: `유닛 id "{id}" 은(는) ^[a-z0-9][a-z0-9-]*$ 를 만족해야 합니다`,
		},
		"scan.removeUnit.notInstalled": {
			EN: "no unit is installed at {dir}",
			KO: "{dir} 에 설치된 유닛이 없습니다",
		},
	})
}
