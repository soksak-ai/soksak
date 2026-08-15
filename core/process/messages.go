package process

import "github.com/soksak/soksak-core/core/i18n"

// The refusals this package answers a caller with. A caller reads these over
// the command registry, so they are declared here rather than formatted at the
// call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"process.sidecar.noHome": {
			EN: "sidecar {name} cannot be resolved: this process was given no home",
			KO: "사이드카 {name} 을(를) 해석할 수 없습니다 — 이 프로세스에 home 이 없습니다",
		},
		"process.sidecar.notInstalled": {
			EN: "sidecar {name} is not installed at {target}: {path} is missing — the home needs a staged dist",
			KO: "사이드카 {name} 이(가) {target} 에 설치되어 있지 않습니다 — {path} 이(가) 없습니다. home 에 staged dist 가 필요합니다",
		},
		"process.sidecar.symlink": {
			EN: "sidecar {name}: {path} is a symlink — a named path answers for itself or not at all",
			KO: "사이드카 {name}: {path} 이(가) 심볼릭 링크입니다 — 지정된 경로는 그 자신으로만 응답합니다",
		},
		"process.sidecar.notRegularFile": {
			EN: "sidecar {name}: {path} is not a regular file",
			KO: "사이드카 {name}: {path} 이(가) 일반 파일이 아닙니다",
		},
		"process.sidecar.illegalName": {
			EN: `sidecar name "{name}" is illegal — it must match ^[a-z0-9][a-z0-9-]*$`,
			KO: `사이드카 이름 "{name}" 은(는) 허용되지 않습니다 — ^[a-z0-9][a-z0-9-]*$ 를 만족해야 합니다`,
		},
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
			KO: "process_reclaim_by_window 에는 창 라벨이 필요합니다 — 빈 라벨은 아무것도 일치시키지 않으며, 자기 라벨을 모르는 호출자가 '주인 없는 자식 전부 회수'를 뜻하게 해서는 안 됩니다",
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
