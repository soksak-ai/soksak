package daemon

import (
	"encoding/json"
	"sort"
	"strings"
	"testing"

	"github.com/soksak-ai/soksak-core/core/control"
)

// sent builds the arguments exactly as the frontend encodes them, so a shape
// this build cannot read fails here rather than in front of a user.
func sent(t *testing.T, encoded string) control.Args {
	t.Helper()
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(encoded), &raw); err != nil {
		t.Fatalf("the test's own arguments do not encode: %v", err)
	}
	return control.Args(raw)
}

func registered(t *testing.T, deps Deps) (*control.Registry, *Supervisor) {
	t.Helper()
	registry := control.NewRegistry()
	supervisor := Register(registry, deps)
	t.Cleanup(func() { supervisor.StopAll() })
	return registry, supervisor
}

func fullDeps(t *testing.T) (Deps, *stubSpawner) {
	t.Helper()
	spawner := &stubSpawner{appeared: make(chan *stubChild, 4)}
	deps, _ := testDeps(spawner, &stubClock{at: 1_000}, &stubTimer{})
	deps.Reaper = &stubReaper{live: map[int]string{}}
	return deps, spawner
}

func table(t *testing.T, registry *control.Registry) (map[string]bool, map[string]string) {
	t.Helper()
	served := map[string]bool{}
	for _, command := range registry.Describe().Commands {
		served[command.Name] = true
	}
	refused := map[string]string{}
	for _, one := range registry.Describe().Unserved {
		refused[one.Name] = one.BlockedBy
	}
	return served, refused
}

func TestAFullyWiredHostServesEveryNameInTheGroup(t *testing.T) {
	deps, _ := fullDeps(t)
	registry, _ := registered(t, deps)

	served, refused := table(t, registry)
	for _, name := range commandNames {
		if !served[name] {
			t.Errorf("%s is not served by a host that has everything", name)
		}
		if reason, held := refused[name]; held {
			t.Errorf("%s is refused with %q by a host that has everything", name, reason)
		}
	}
}

// The name list and what Register touches are held equal, so a command added
// to one and not the other cannot pass unnoticed.
func TestTheNameListMatchesWhatRegisterTouches(t *testing.T) {
	deps, _ := fullDeps(t)
	registry, _ := registered(t, deps)

	var touched []string
	for _, command := range registry.Describe().Commands {
		touched = append(touched, command.Name)
	}
	for _, one := range registry.Describe().Unserved {
		touched = append(touched, one.Name)
	}
	sort.Strings(touched)

	listed := append([]string(nil), commandNames...)
	sort.Strings(listed)

	if strings.Join(touched, ",") != strings.Join(listed, ",") {
		t.Fatalf("Register touches %v and the list says %v", touched, listed)
	}
}

// A caller that hears only "unknown command" cannot tell a build that forgot a
// command from one that cannot have it, so it re-investigates settled ground.
func TestAHostWithoutTheMeansToStartAProcessRefusesByName(t *testing.T) {
	cases := []struct {
		what   string
		change func(*Deps)
		says   string
	}{
		{"no spawner", func(deps *Deps) { deps.Spawner = nil }, "spawner"},
		{"no process groups", func(deps *Deps) { deps.Windows = true }, "process group"},
		{"no login shell", func(deps *Deps) { deps.LoginShell = "" }, "login shell"},
		{"no environment rule", func(deps *Deps) { deps.Environment = nil }, "environment"},
	}

	for _, one := range cases {
		deps, _ := fullDeps(t)
		one.change(&deps)
		registry, _ := registered(t, deps)

		served, refused := table(t, registry)
		for _, name := range []string{commandStart, commandRunOnce} {
			if served[name] {
				t.Errorf("%s: %s is served", one.what, name)
				continue
			}
			if !strings.Contains(refused[name], one.says) {
				t.Errorf("%s: %s is refused with %q, which does not say what is missing", one.what, name, refused[name])
			}
		}
		// Asking what is running is answerable with nothing running, and the
		// answer — nothing — is true. It is a different answer from "nothing
		// can be started here", which is what the refusal above states.
		for _, name := range []string{commandStop, commandStatus, commandLogs} {
			if !served[name] {
				t.Errorf("%s: %s stopped being served, and an empty table is still an answer", one.what, name)
			}
		}
	}
}

func TestAHostThatCannotIdentifyAPidRefusesToReapByName(t *testing.T) {
	deps, _ := fullDeps(t)
	deps.Reaper = nil
	registry, _ := registered(t, deps)

	served, refused := table(t, registry)
	if served[commandReap] {
		t.Fatal("daemon_reap is served with no way to tell what a pid is running")
	}
	if !strings.Contains(refused[commandReap], "command line") {
		t.Errorf("the refusal %q does not say what is missing", refused[commandReap])
	}

	_, err := registry.Invoke(commandReap, sent(t, `{"entries":[[42,"npm run dev"]]}`))
	if err == nil {
		t.Fatal("a refused command answered")
	}
	if !strings.Contains(err.Error(), "recycled") {
		t.Errorf("the caller was told %q, which does not say why", err)
	}
}

func TestAHostWithNoClockIsAWiringFaultRatherThanARuntimeCondition(t *testing.T) {
	defer func() {
		reason, panicked := recover().(string)
		if !panicked {
			t.Fatal("Register accepted a host with no clock; every daemon would report the same uptime forever")
		}
		if !strings.Contains(reason, "Now") {
			t.Errorf("the panic %q does not name the field to set", reason)
		}
	}()
	deps, _ := fullDeps(t)
	deps.Now = nil
	Register(control.NewRegistry(), deps)
}

// The argument shapes are the caller's. Each of these is the object the
// frontend sends today, including the nulls it spells "not set" with.
func TestTheCallersArgumentShapesAreAnswered(t *testing.T) {
	deps, spawner := fullDeps(t)
	registry, _ := registered(t, deps)

	pid, err := registry.Invoke(commandStart, sent(t,
		`{"root":"/workspaces/app","name":"dev","cmd":"npm run dev","restart":null}`))
	if err != nil {
		t.Fatalf("daemon_start: %v", err)
	}
	if pid != spawner.child(0).PID() {
		t.Fatalf("daemon_start answered %v, want the pid the catalogue records", pid)
	}

	rows, err := registry.Invoke(commandStatus, sent(t, `{"root":"/workspaces/app"}`))
	if err != nil {
		t.Fatalf("daemon_status: %v", err)
	}
	if len(rows.([]Daemon)) != 1 {
		t.Fatalf("daemon_status answered %+v", rows)
	}

	lines, err := registry.Invoke(commandLogs, sent(t, `{"root":"/workspaces/app","name":"dev","lines":null}`))
	if err != nil {
		t.Fatalf("daemon_logs: %v", err)
	}
	if lines.([]string) == nil {
		t.Error("daemon_logs answered null")
	}

	stopped, err := registry.Invoke(commandStop, sent(t, `{"root":"/workspaces/app","name":null}`))
	if err != nil {
		t.Fatalf("daemon_stop: %v", err)
	}
	if names := stopped.([]string); len(names) != 1 || names[0] != "dev" {
		t.Fatalf("daemon_stop answered %q, want the names it ended", names)
	}

	adopted, err := registry.Invoke(commandReap, sent(t, `{"entries":[[4242,"npm run dev"]]}`))
	if err != nil {
		t.Fatalf("daemon_reap: %v", err)
	}
	if len(adopted.([]Adoption)) != 1 {
		t.Fatalf("daemon_reap answered %+v", adopted)
	}
}

func TestARunOnceAnswersTheShapeTheReleaseCommandsParse(t *testing.T) {
	deps, spawner := fullDeps(t)
	registry, _ := registered(t, deps)

	go func() {
		child := <-spawner.appeared
		child.say("done")
		child.exit(0)
	}()

	answer, err := registry.Invoke(commandRunOnce, sent(t,
		`{"root":"/workspaces/app","cmd":"node build.mjs","timeoutSecs":180,"env":{"GH_TOKEN":"x"}}`))
	if err != nil {
		t.Fatalf("daemon_run_once: %v", err)
	}
	once := answer.(Once)
	if once.Code == nil || *once.Code != 0 {
		t.Fatalf("code = %v", once.Code)
	}

	// The caller reads { code, lines }; the names on the wire are what it
	// indexes by.
	encoded, err := json.Marshal(once)
	if err != nil {
		t.Fatalf("encoding: %v", err)
	}
	for _, field := range []string{`"code"`, `"lines"`} {
		if !strings.Contains(string(encoded), field) {
			t.Errorf("%s answers %s, which carries no %s", commandRunOnce, encoded, field)
		}
	}
}

// The status row is read field by field by the caller. These names are its.
func TestTheStatusRowKeepsTheFieldNamesTheCallerReads(t *testing.T) {
	encoded, err := json.Marshal(Daemon{})
	if err != nil {
		t.Fatalf("encoding: %v", err)
	}
	for _, field := range []string{`"root"`, `"name"`, `"pid"`, `"running"`, `"exit_code"`, `"uptime_ms"`, `"restarts"`} {
		if !strings.Contains(string(encoded), field) {
			t.Errorf("a status row is %s, which carries no %s", encoded, field)
		}
	}
}

// Accepting a restart policy and never acting on it would leave a daemon that
// died at 3am down until somebody looked, while the caller believed something
// was keeping it up.
func TestARestartPolicyIsRefusedRatherThanIgnored(t *testing.T) {
	deps, _ := fullDeps(t)
	registry, _ := registered(t, deps)

	_, err := registry.Invoke(commandStart, sent(t,
		`{"root":"/workspaces/app","name":"dev","cmd":"npm run dev","restart":"always"}`))
	if err == nil {
		t.Fatal("a restart policy was accepted and nothing in this build restarts anything")
	}
	if !strings.Contains(err.Error(), "restart") {
		t.Errorf("the refusal %q does not name the argument", err)
	}
}

// Absent, null and empty are three different answers, and none of them is a
// workspace root.
func TestAnArgumentThatNamesNothingIsRefusedByName(t *testing.T) {
	deps, _ := fullDeps(t)
	registry, _ := registered(t, deps)

	cases := []struct {
		command string
		args    string
	}{
		{commandStart, `{"name":"dev","cmd":"npm run dev"}`},
		{commandStart, `{"root":null,"name":"dev","cmd":"npm run dev"}`},
		{commandStart, `{"root":"","name":"dev","cmd":"npm run dev"}`},
		{commandStart, `{"root":"/workspaces/app","name":"dev"}`},
		{commandStop, `{"root":"/workspaces/app","name":""}`},
		{commandLogs, `{"root":"/workspaces/app","name":"dev","lines":0}`},
		{commandRunOnce, `{"root":"/workspaces/app","cmd":"node x.mjs"}`},
		{commandRunOnce, `{"root":"/workspaces/app","cmd":"node x.mjs","timeoutSecs":0}`},
		{commandRunOnce, `{"root":"/workspaces/app","cmd":"node x.mjs","timeoutSecs":60,"env":{"":"x"}}`},
		{commandReap, `{}`},
		{commandReap, `{"entries":null}`},
	}
	for _, one := range cases {
		if _, err := registry.Invoke(one.command, sent(t, one.args)); err == nil {
			t.Errorf("%s accepted %s", one.command, one.args)
		}
	}
}

// The schedule half of the group, in the shapes the frontend sends. The nulls
// are the caller's way of saying "not set" and every one of them is here.
func TestTheCallersScheduleShapesAreAnswered(t *testing.T) {
	deps, _ := fullDeps(t)
	registry, _ := registered(t, deps)

	id, err := registry.Invoke(commandScheduleSet, sent(t,
		`{"at":1750000000000,"command":"notify_show","params":{"title":"time"},"id":null}`))
	if err != nil {
		t.Fatalf("schedule_set: %v", err)
	}
	if id.(string) == "" {
		t.Fatal("schedule_set answered no id; the caller cancels by it")
	}

	jobID, err := registry.Invoke(commandScheduleRegister, sent(t,
		`{"trigger":{"kind":"every","every_ms":60000},"command":"plugin_tick","params":null,"id":null,`+
			`"retry":null,"concurrency":null,"timeout_ms":null,"process_lease":null,"zombie_backstop_ms":null,"owner":"soksak-plugin-x"}`))
	if err != nil {
		t.Fatalf("schedule_register: %v", err)
	}

	rows, err := registry.Invoke(commandScheduleList, control.Args{})
	if err != nil {
		t.Fatalf("schedule_list: %v", err)
	}
	if len(rows.([]Job)) != 2 {
		t.Fatalf("schedule_list answered %+v", rows)
	}

	if _, err := registry.Invoke(commandSchedulePoke, sent(t, `{"id":null}`)); err != nil {
		t.Fatalf("schedule_poke: %v", err)
	}

	removed, err := registry.Invoke(commandScheduleCancel, sent(t, `{"id":"`+jobID.(string)+`"}`))
	if err != nil {
		t.Fatalf("schedule_cancel: %v", err)
	}
	if removed != true {
		t.Errorf("schedule_cancel answered %v for a job that was there", removed)
	}
}

// A job row is read field by field by the caller, and its own record of what it
// registered is compared against these names.
func TestTheJobRowKeepsTheFieldNamesTheCallerReads(t *testing.T) {
	encoded, err := json.Marshal(Job{Params: control.Args{}})
	if err != nil {
		t.Fatalf("encoding: %v", err)
	}
	for _, field := range []string{`"id"`, `"trigger"`, `"command"`, `"params"`, `"next_at"`, `"running"`, `"concurrency"`} {
		if !strings.Contains(string(encoded), field) {
			t.Errorf("a job row is %s, which carries no %s", encoded, field)
		}
	}
	if strings.Contains(string(encoded), `"params":null`) {
		t.Errorf("a job row is %s; a caller spreading its parameters would spread a null", encoded)
	}
}

// An option accepted and then not acted on is the failure this group exists to
// avoid: the caller believes a lease is held, or a timeout is capped, and
// nothing reports otherwise until the work goes wrong.
func TestAScheduleOptionThisBuildCannotHonourIsRefusedByName(t *testing.T) {
	deps, _ := fullDeps(t)
	registry, _ := registered(t, deps)

	base := `"command":"plugin_tick","params":null,"id":null`
	cases := []struct {
		args string
		says string
	}{
		{`{"trigger":{"kind":"cron","expr":"*/5 * * * *"},` + base + `}`, "cron"},
		{`{"trigger":{"kind":"reconcile"},` + base + `,"process_lease":true}`, "process_lease"},
		{`{"trigger":{"kind":"reconcile"},` + base + `,"timeout_ms":5000}`, "timeout_ms"},
		{`{"trigger":{"kind":"reconcile"},` + base + `,"concurrency":4}`, "concurrency"},
		{`{"trigger":{"kind":"reconcile"},` + base + `,"zombie_backstop_ms":10800000}`, "zombie_backstop_ms"},
	}
	for _, one := range cases {
		_, err := registry.Invoke(commandScheduleRegister, sent(t, one.args))
		if err == nil {
			t.Errorf("%s was accepted", one.args)
			continue
		}
		if !strings.Contains(err.Error(), one.says) {
			t.Errorf("%s was refused with %q, which does not name %q", one.args, err, one.says)
		}
	}

	// Nothing was registered by any of them: a refusal that had already put the
	// job on the table would fire it.
	rows, err := registry.Invoke(commandScheduleList, control.Args{})
	if err != nil {
		t.Fatalf("schedule_list: %v", err)
	}
	if len(rows.([]Job)) != 0 {
		t.Fatalf("schedule_list = %+v after five refusals", rows)
	}
}
