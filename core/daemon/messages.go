package daemon

import "github.com/soksak-ai/soksak-core/core/i18n"

// The refusals this group answers a caller with. A caller reads these over the
// command registry, so they are declared here rather than formatted at the
// call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"daemon.args.missing": {
			EN: `{command}: missing argument "{name}"`,
			KO: `{command}: 인자 "{name}" 이(가) 없습니다`,
		},
		"daemon.args.null": {
			EN: `{command}: argument "{name}" is null; send a value`,
			KO: `{command}: 인자 "{name}" 이(가) null 입니다 — 값을 보내십시오`,
		},
		"daemon.args.empty": {
			EN: `{command}: argument "{name}" is empty — it names nothing`,
			KO: `{command}: 인자 "{name}" 이(가) 비어 있습니다 — 지정된 대상이 없습니다`,
		},
		"daemon.args.lineCountTooLow": {
			EN: `{command}: argument "{name}" is {value} — request at least one line, or leave it out for {default}`,
			KO: `{command}: 인자 "{name}" 이(가) {value} 입니다 — 최소 1 줄을 요청하거나, 생략하면 {default} 입니다`,
		},
		"daemon.args.missingTimeout": {
			EN: `{command}: missing argument "{name}" — a run with no deadline never comes back`,
			KO: `{command}: 인자 "{name}" 이(가) 없습니다 — 기한 없는 실행은 끝나지 않습니다`,
		},
		"daemon.args.deadlinePassed": {
			EN: `{command}: argument "{name}" is {value} — a deadline that has already passed stops the command before it starts`,
			KO: `{command}: 인자 "{name}" 이(가) {value} 입니다 — 이미 지난 기한은 명령을 시작 전에 멈춥니다`,
		},
		"daemon.args.environmentName": {
			EN: `{command}: argument "{name}" includes the name "{entry}" — an environment name is not empty and holds no '='`,
			KO: `{command}: 인자 "{name}" 에 이름 "{entry}" 이(가) 있습니다 — 환경 변수 이름은 비어 있지 않고 '=' 를 포함하지 않습니다`,
		},
		"daemon.args.entriesNull": {
			EN: `{command}: argument "{name}" is null; send the recorded pairs, or an empty list`,
			KO: `{command}: 인자 "{name}" 이(가) null 입니다 — 기록된 쌍이나 빈 목록을 보내십시오`,
		},
		"daemon.args.restartUnsupported": {
			EN: `{command}: argument "{name}" requests a restart policy and nothing in this build restarts a daemon — daemon_status reports its exit code, and starting it again is the caller's call`,
			KO: `{command}: 인자 "{name}" 이(가) 재시작 정책을 요구하지만 이 빌드는 데몬을 재시작하지 않습니다 — 종료 코드는 daemon_status 가 보고하고, 다시 시작하는 것은 호출자의 몫입니다`,
		},
		"daemon.args.emptyUnset": {
			EN: `{command}: argument "{name}" is empty — send null to leave it unset`,
			KO: `{command}: 인자 "{name}" 이(가) 비어 있습니다 — 설정하지 않으려면 null 을 보내십시오`,
		},
		"daemon.args.missingMoment": {
			EN: `{command}: missing argument "{name}" — a schedule with no moment has none to fire at`,
			KO: `{command}: 인자 "{name}" 이(가) 없습니다 — 시각 없는 예약은 발화할 시점이 없습니다`,
		},
		"daemon.args.notAMoment": {
			EN: `{command}: argument "{name}" is {value}, which is not a moment — epoch milliseconds are positive`,
			KO: `{command}: 인자 "{name}" 이(가) {value} 입니다 — 시각이 아닙니다. epoch 밀리초는 양수입니다`,
		},
	})
}

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"daemon.trigger.noKind": {
			EN: `a trigger names no "{field}" — it is one of "{at}", "{every}" or "{reconcile}"`,
			KO: `트리거에 "{field}" 가 없습니다 — "{at}", "{every}", "{reconcile}" 중 하나입니다`,
		},
		"daemon.trigger.noMoment": {
			EN: `an "{kind}" trigger has no "{field}" — there is no moment to fire at`,
			KO: `"{kind}" 트리거에 "{field}" 가 없습니다 — 발화할 시각이 없습니다`,
		},
		"daemon.trigger.noInterval": {
			EN: `an "{kind}" trigger has no "{field}" — there is no interval to repeat on`,
			KO: `"{kind}" 트리거에 "{field}" 가 없습니다 — 반복할 간격이 없습니다`,
		},
		"daemon.trigger.intervalNotPositive": {
			EN: `an "{kind}" trigger has "{field}" = {value}, and an interval is positive`,
			KO: `"{kind}" 트리거의 "{field}" 가 {value} 입니다 — 간격은 양수입니다`,
		},
		"daemon.trigger.cronUnsupported": {
			EN: `this build parses no "{kind}" expression ("{expr}"), so it cannot compute when such a job is due; an "{every}" trigger re-armed after each fire is the shape it can honour`,
			KO: `이 빌드는 "{kind}" 식("{expr}")을 해석하지 않아 해당 작업의 시각을 계산할 수 없습니다 — 발화마다 다시 등록하는 "{every}" 트리거가 이 빌드가 지원하는 형태입니다`,
		},
		"daemon.trigger.unknownKind": {
			EN: `"{kind}" is not a trigger this build serves — it is one of "{at}", "{every}" or "{reconcile}"`,
			KO: `"{kind}" 는 이 빌드가 제공하는 트리거가 아닙니다 — "{at}", "{every}", "{reconcile}" 중 하나입니다`,
		},
	})
}

// The refusals the daemon table and the scheduler answer a caller with. A
// caller reads these over the command registry, so they are declared here
// rather than formatted at the call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"daemon.recorded.elementCount": {
			EN: "a recorded daemon is the pair [pid, cmd] and this one has {count} element(s)",
			KO: "기록된 데몬은 [pid, cmd] 쌍입니다 — 이 항목의 원소는 {count} 개입니다",
		},
		"daemon.start.alreadyRunning": {
			EN: `daemon "{name}" is already running under {root} as pid {pid} — stop it before starting it again`,
			KO: `데몬 "{name}" 이(가) {root} 에서 pid {pid} 로 이미 실행 중입니다 — 다시 시작하기 전에 중지하십시오`,
		},
		"daemon.logs.notStarted": {
			EN: `no daemon "{name}" was started under {root} in this build`,
			KO: `이 빌드에서 {root} 아래에 시작된 데몬 "{name}" 이(가) 없습니다`,
		},
		"daemon.schedule.noCommand": {
			EN: "a schedule fires a registry command and this one names none",
			KO: "예약은 레지스트리 명령을 발화합니다 — 이 예약에는 명령 이름이 없습니다",
		},
		"daemon.schedule.unknown": {
			EN: `no schedule "{id}" is registered here`,
			KO: `여기에 등록된 예약 "{id}" 이(가) 없습니다`,
		},
		"daemon.schedule.noProcessLease": {
			EN: `{command}: argument "{name}" is not served by this build — it cannot tell which process a fired command started, so it could not hold a lease until that process exited; the lease would be released while the work was still running, which is the one thing the option exists to prevent`,
			KO: `{command}: 이 빌드는 인자 "{name}" 을(를) 지원하지 않습니다 — 발화된 명령이 어떤 프로세스를 시작했는지 알 수 없어 그 프로세스가 끝날 때까지 임차를 유지할 수 없습니다. 작업이 진행 중인데 임차가 해제되며, 그것이 이 옵션이 막으려던 유일한 상황입니다`,
		},
		"daemon.schedule.noTimeout": {
			EN: `{command}: argument "{name}" is not served by this build — it fires a command by calling its handler, and a running handler cannot be taken back; a cap here would report a timeout while the work continued`,
			KO: `{command}: 이 빌드는 인자 "{name}" 을(를) 지원하지 않습니다 — 명령은 핸들러 호출로 발화되고, 실행 중인 핸들러는 회수할 수 없습니다. 여기서 상한을 두면 작업이 계속되는 동안 시한 초과를 보고하게 됩니다`,
		},
		"daemon.schedule.noConcurrency": {
			EN: `{command}: argument "{name}" is not served by this build — one job holds one lease here and a second fire waits for the first; there is no other setting to choose`,
			KO: `{command}: 이 빌드는 인자 "{name}" 을(를) 지원하지 않습니다 — 한 작업이 임차 하나를 점유하고 두 번째 발화는 첫 번째를 기다립니다. 선택할 다른 설정이 없습니다`,
		},
		"daemon.schedule.noZombieBackstop": {
			EN: `{command}: argument "{name}" is not served by this build — it caps a process lease, and this build holds none`,
			KO: `{command}: 이 빌드는 인자 "{name}" 을(를) 지원하지 않습니다 — 프로세스 임차의 상한이지만 이 빌드는 임차를 보유하지 않습니다`,
		},
	})
}

// The refusals the daemon command line assembly answers a caller with. A caller
// reads these over the command registry, so they are declared here rather than
// formatted at the call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"daemon.shell.emptyCommand": {
			EN: `argument "{name}" is empty — a shell with nothing to run starts and exits at once, and the caller would read that as a daemon that crashed`,
			KO: `인자 "{name}" 이(가) 비어 있습니다 — 실행할 것이 없는 셸은 즉시 시작하고 종료하며, 호출자는 그것을 죽은 데몬으로 읽습니다`,
		},
		"daemon.shell.noLoginShell": {
			EN: "this process was given no login shell to run a daemon through — set daemon.Deps.LoginShell; reading $SHELL here would tie the answer to whatever launched this process",
			KO: "이 프로세스는 데몬을 실행할 로그인 셸을 받지 못했습니다 — daemon.Deps.LoginShell 을 넣으십시오. 여기서 $SHELL 을 읽으면 답이 이 프로세스를 실행한 대상에 묶입니다",
		},
	})
}

// The refusal a run-to-completion answers a caller with when its deadline
// passes. A caller reads it over the command registry, so it is declared here
// rather than formatted at the call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"daemon.once.timeout": {
			EN: `"{cmd}" under {root} did not finish within {timeout} and was stopped; its last output was:
{tail}`,
			KO: `"{cmd}" 이(가) {root} 에서 {timeout} 안에 끝나지 않아 중지되었습니다. 마지막 출력은 다음과 같습니다:
{tail}`,
		},
	})
}
