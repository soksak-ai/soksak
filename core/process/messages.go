package process

import "github.com/soksak-ai/soksak-core/core/i18n"

// The refusals this package answers a caller with. A caller reads these over
// the command registry, so they are declared here rather than formatted at the
// call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"process.spawn.noSpawner": {
			EN: "process_spawn: this host was given no spawner and starts no children",
			KO: "process_spawn: 이 호스트에는 spawner 가 없어 자식 프로세스를 시작하지 않습니다",
		},
		"process.handle.noSuchProcess": {
			EN: "process {id}: no such process",
			KO: "프로세스 {id}: 그런 프로세스가 없습니다",
		},
		"process.write.stdinClosed": {
			EN: "process {id}: stdin is closed",
			KO: "프로세스 {id}: stdin 이 닫혀 있습니다",
		},
		"process.reclaimByWindow.needsLabel": {
			EN: "process_reclaim_by_window needs a window label: an empty label matches nothing, and a caller that does not know its own label must not spell 'reap everything unowned'",
			KO: "process_reclaim_by_window 에는 창 라벨이 필요합니다. 빈 라벨은 아무것도 일치시키지 않습니다. 라벨을 지정하십시오",
		},
	})
}

// The refusal a grouped spawn answers a caller with. A caller reads it over the
// command registry, so it is declared here rather than formatted at the call
// site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"process.spawn.groupNotHonoured": {
			EN: "a process group was requested and this host cannot honour it: {because} — spawning ungrouped instead would leave grandchildren holding the child's stdout after a kill",
			KO: "프로세스 그룹이 요청되었으나 이 호스트는 지원하지 않습니다: {because} — 그룹 없이 시작하면 kill 이후에도 손자 프로세스가 자식의 stdout 을 점유합니다",
		},
	})
}

// The refusals secret resolution answers a caller with. A spawn that names a
// secret reads these over the command registry, so they are declared here
// rather than formatted at the call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"process.secret.noVault": {
			EN: "this process has no vault — {ns}/{key} cannot be resolved",
			KO: "이 프로세스에는 vault 가 없습니다 — {ns}/{key} 을(를) 해석할 수 없습니다",
		},
		"process.secret.needsNamespace": {
			EN: "secretEnv injection needs ns: a secret without a namespace has no owner",
			KO: "secretEnv 주입에는 ns 가 필요합니다 — 네임스페이스 없는 비밀에는 소유자가 없습니다",
		},
	})
}

// The refusals spawn argument decoding answers a caller with. A caller reads
// these over the command registry, so they are declared here rather than
// formatted at the call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"process.spawn.emptyWindowLabel": {
			EN: "process_spawn: window was given as an empty label — omit it to spawn an unowned child",
			KO: "process_spawn: window 가 빈 라벨로 전달되었습니다 — 주인 없는 자식을 시작하려면 생략하십시오",
		},
		"process.arg.missing": {
			EN: `missing argument "{name}"`,
			KO: `인자 "{name}" 이(가) 없습니다`,
		},
		"process.arg.null": {
			EN: `argument "{name}" is null; omit it or send a value`,
			KO: `인자 "{name}" 이(가) null 입니다 — 생략하거나 값을 보내십시오`,
		},
	})
}
