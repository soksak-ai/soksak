package daemon

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func testSupervisor(t *testing.T) (*Supervisor, *stubSpawner, *stubClock, chan Daemon) {
	t.Helper()
	spawner := &stubSpawner{}
	clock := &stubClock{at: 1_000}
	deps, announced := testDeps(spawner, clock, &stubTimer{})
	supervisor := newSupervisor(deps)
	t.Cleanup(func() { supervisor.StopAll() })
	return supervisor, spawner, clock, announced
}

// waitFor takes the next announcement, or fails rather than hanging the suite.
func waitFor(t *testing.T, announced chan Daemon) Daemon {
	t.Helper()
	select {
	case row := <-announced:
		return row
	case <-time.After(5 * time.Second):
		t.Fatal("no announcement arrived")
		return Daemon{}
	}
}

func TestADaemonRunsItsLineFromTheWorkspaceRoot(t *testing.T) {
	supervisor, spawner, _, _ := testSupervisor(t)

	pid, err := supervisor.Start("/workspaces/app", "dev", "npm run dev")
	if err != nil {
		t.Fatalf("starting: %v", err)
	}

	spec := spawner.started()[0]
	if spec.Dir != "/workspaces/app" {
		t.Errorf("Dir = %q, want the workspace root — a daemon started anywhere else builds the wrong tree", spec.Dir)
	}
	if spec.Args[len(spec.Args)-1] != "npm run dev" {
		t.Errorf("args = %q, want the declared line whole", spec.Args)
	}
	if !spec.Group {
		t.Error("the daemon was started outside its own process group; a stop would reach the shell and leave the server running")
	}
	if pid != spawner.child(0).PID() {
		t.Errorf("pid = %d, want the child's %d", pid, spawner.child(0).PID())
	}
}

// The environment is the host's rule, never this package's, and a daemon that
// received nothing at all would fail on PATH.
func TestADaemonReceivesTheHostsEnvironmentRatherThanThisProcessOwn(t *testing.T) {
	supervisor, spawner, _, _ := testSupervisor(t)

	if _, err := supervisor.Start("/workspaces/app", "dev", "npm run dev"); err != nil {
		t.Fatalf("starting: %v", err)
	}

	spec := spawner.started()[0]
	if len(spec.Env) == 0 {
		t.Fatal("the daemon was started with no environment; os/exec reads this process's own for a nil Env, which is the one thing the core must never do")
	}
	if spec.Env[0] != "PATH=/usr/bin" {
		t.Errorf("Env = %q, want what the host's rule built", spec.Env)
	}
}

func TestStartingADaemonThatIsAlreadyRunningIsRefusedByName(t *testing.T) {
	supervisor, _, _, _ := testSupervisor(t)

	if _, err := supervisor.Start("/workspaces/app", "dev", "npm run dev"); err != nil {
		t.Fatalf("starting: %v", err)
	}

	_, err := supervisor.Start("/workspaces/app", "dev", "npm run dev")
	if err == nil {
		t.Fatal("a second copy started; the two would fight over the port and this table could only reach one")
	}
	if !strings.Contains(err.Error(), "dev") {
		t.Errorf("the refusal %q does not name the daemon", err)
	}
}

// One name is one workspace's. Two workspaces each declaring "dev" is
// ordinary, and refusing the second would make a workspace hold one workspace.
func TestTheSameNameInAnotherProjectIsAnotherDaemon(t *testing.T) {
	supervisor, spawner, _, _ := testSupervisor(t)

	if _, err := supervisor.Start("/workspaces/a", "dev", "npm run dev"); err != nil {
		t.Fatalf("starting the first: %v", err)
	}
	if _, err := supervisor.Start("/workspaces/b", "dev", "npm run dev"); err != nil {
		t.Fatalf("starting the second: %v", err)
	}
	if len(spawner.started()) != 2 {
		t.Fatalf("%d daemons started, want 2", len(spawner.started()))
	}
}

func TestADaemonThatExitedCanBeStartedAgain(t *testing.T) {
	supervisor, spawner, _, announced := testSupervisor(t)

	if _, err := supervisor.Start("/workspaces/app", "dev", "npm run dev"); err != nil {
		t.Fatalf("starting: %v", err)
	}
	spawner.child(0).exit(1)
	waitFor(t, announced)

	if _, err := supervisor.Start("/workspaces/app", "dev", "npm run dev"); err != nil {
		t.Fatalf("starting again after it exited: %v", err)
	}
}

func TestAFailedSpawnFailsCarryingTheDaemonAndTheRoot(t *testing.T) {
	spawner := &stubSpawner{fail: errors.New("no such file or directory")}
	deps, _ := testDeps(spawner, &stubClock{}, &stubTimer{})
	supervisor := newSupervisor(deps)

	_, err := supervisor.Start("/workspaces/app", "dev", "npm run dev")
	if err == nil {
		t.Fatal("a spawn that failed answered with a pid")
	}
	if !strings.Contains(err.Error(), "dev") || !strings.Contains(err.Error(), "/workspaces/app") {
		t.Errorf("the failure %q names neither the daemon nor the workspace", err)
	}
}

func TestStatusReportsWhatIsRunningUnderOneWorkspace(t *testing.T) {
	supervisor, _, clock, _ := testSupervisor(t)

	if _, err := supervisor.Start("/workspaces/app", "dev", "npm run dev"); err != nil {
		t.Fatalf("starting: %v", err)
	}
	if _, err := supervisor.Start("/workspaces/other", "api", "npm run api"); err != nil {
		t.Fatalf("starting: %v", err)
	}
	clock.advance(4_000)

	rows := supervisor.Status("/workspaces/app")
	if len(rows) != 1 {
		t.Fatalf("status = %+v, want only this workspace's daemon", rows)
	}
	if !rows[0].Running {
		t.Error("a running daemon reported as stopped")
	}
	if rows[0].ExitCode != nil {
		t.Errorf("exit_code = %d while it runs; a code that has not happened yet is null", *rows[0].ExitCode)
	}
	if rows[0].UptimeMS != 4_000 {
		t.Errorf("uptime_ms = %d, want 4000", rows[0].UptimeMS)
	}
	if rows[0].Restarts != 0 {
		t.Errorf("restarts = %d; nothing in this build restarts a daemon", rows[0].Restarts)
	}
}

// A workspace nobody started anything under answers with an empty list. Nil
// arrives as JSON null, and "no daemons are running" would then read the same
// as "this build cannot tell you".
func TestAWorkspaceWithNoDaemonsAnswersWithAnEmptyList(t *testing.T) {
	supervisor, _, _, _ := testSupervisor(t)

	rows := supervisor.Status("/workspaces/none")
	if rows == nil {
		t.Fatal("status answered nil")
	}
	if len(rows) != 0 {
		t.Fatalf("status = %+v", rows)
	}
}

// The exit code is the whole reason a caller queries a daemon that stopped.
func TestAnExitedDaemonKeepsItsCodeInTheStatusTable(t *testing.T) {
	supervisor, spawner, clock, announced := testSupervisor(t)

	if _, err := supervisor.Start("/workspaces/app", "dev", "npm run dev"); err != nil {
		t.Fatalf("starting: %v", err)
	}
	clock.advance(2_000)
	spawner.child(0).exit(7)
	waitFor(t, announced)
	clock.advance(9_000)

	rows := supervisor.Status("/workspaces/app")
	if len(rows) != 1 {
		t.Fatalf("the exited daemon left the table: %+v", rows)
	}
	if rows[0].Running {
		t.Error("an exited daemon reported as running")
	}
	if rows[0].ExitCode == nil || *rows[0].ExitCode != 7 {
		t.Fatalf("exit_code = %v, want 7", rows[0].ExitCode)
	}
	if rows[0].UptimeMS != 2_000 {
		t.Errorf("uptime_ms = %d, want how long it ran (2000), not how long ago it started", rows[0].UptimeMS)
	}
}

// "It was killed" and "it exited 0" are different facts, and one of them means
// the daemon did its job.
func TestASignalledDaemonLeavesNoExitCodeRatherThanZero(t *testing.T) {
	supervisor, _, _, announced := testSupervisor(t)

	if _, err := supervisor.Start("/workspaces/app", "dev", "npm run dev"); err != nil {
		t.Fatalf("starting: %v", err)
	}
	if _, err := supervisor.Stop("/workspaces/app", "dev"); err != nil {
		t.Fatalf("stopping: %v", err)
	}
	waitFor(t, announced)

	rows := supervisor.Status("/workspaces/app")
	if rows[0].ExitCode != nil {
		t.Fatalf("exit_code = %d after a kill; a signalled process left no code of its own", *rows[0].ExitCode)
	}
}

func TestStopEndsOneNamedDaemonAndLeavesTheRest(t *testing.T) {
	supervisor, spawner, _, _ := testSupervisor(t)

	if _, err := supervisor.Start("/workspaces/app", "dev", "npm run dev"); err != nil {
		t.Fatalf("starting: %v", err)
	}
	if _, err := supervisor.Start("/workspaces/app", "api", "npm run api"); err != nil {
		t.Fatalf("starting: %v", err)
	}

	stopped, err := supervisor.Stop("/workspaces/app", "dev")
	if err != nil {
		t.Fatalf("stopping: %v", err)
	}
	if len(stopped) != 1 || stopped[0] != "dev" {
		t.Fatalf("stopped = %q, want only dev", stopped)
	}
	if spawner.child(1).signalled() != 0 {
		t.Error("the other daemon was signalled too")
	}
}

func TestStopWithNoNameEndsEveryDaemonUnderTheWorkspace(t *testing.T) {
	supervisor, _, _, _ := testSupervisor(t)

	for _, name := range []string{"dev", "api"} {
		if _, err := supervisor.Start("/workspaces/app", name, "npm run "+name); err != nil {
			t.Fatalf("starting %s: %v", name, err)
		}
	}
	if _, err := supervisor.Start("/workspaces/other", "dev", "npm run dev"); err != nil {
		t.Fatalf("starting elsewhere: %v", err)
	}

	stopped, err := supervisor.Stop("/workspaces/app", "")
	if err != nil {
		t.Fatalf("stopping: %v", err)
	}
	if len(stopped) != 2 {
		t.Fatalf("stopped = %q, want both of this workspace's daemons", stopped)
	}
	if rows := supervisor.Status("/workspaces/other"); !rows[0].Running {
		t.Error("another workspace's daemon was stopped")
	}
}

// A daemon that had already exited is not one this call stopped. Naming it
// would report work nobody did.
func TestStopAnswersOnlyWithWhatItActuallyEnded(t *testing.T) {
	supervisor, spawner, _, announced := testSupervisor(t)

	if _, err := supervisor.Start("/workspaces/app", "dev", "npm run dev"); err != nil {
		t.Fatalf("starting: %v", err)
	}
	spawner.child(0).exit(0)
	waitFor(t, announced)

	stopped, err := supervisor.Stop("/workspaces/app", "")
	if err != nil {
		t.Fatalf("stopping: %v", err)
	}
	if len(stopped) != 0 {
		t.Fatalf("stopped = %q, want nothing — it had already exited", stopped)
	}
}

// A stop that came back before the child was reaped would let the next start
// find the port still held.
func TestStopReturnsOnlyOnceTheChildIsReaped(t *testing.T) {
	supervisor, spawner, _, _ := testSupervisor(t)

	if _, err := supervisor.Start("/workspaces/app", "dev", "npm run dev"); err != nil {
		t.Fatalf("starting: %v", err)
	}
	if _, err := supervisor.Stop("/workspaces/app", "dev"); err != nil {
		t.Fatalf("stopping: %v", err)
	}

	select {
	case <-spawner.child(0).ended:
	default:
		t.Fatal("stop answered while the child was still running")
	}
	if rows := supervisor.Status("/workspaces/app"); rows[0].Running {
		t.Error("stop answered before the table knew the daemon had ended")
	}
}

func TestADaemonThatCouldNotBeStoppedIsNamedRatherThanReportedStopped(t *testing.T) {
	supervisor, spawner, _, _ := testSupervisor(t)

	if _, err := supervisor.Start("/workspaces/app", "dev", "npm run dev"); err != nil {
		t.Fatalf("starting: %v", err)
	}
	spawner.child(0).mu.Lock()
	spawner.child(0).signalErr = errors.New("operation not permitted")
	spawner.child(0).mu.Unlock()

	_, err := supervisor.Stop("/workspaces/app", "dev")
	if err == nil {
		t.Fatal("a daemon that could not be signalled was reported as stopped")
	}
	if !strings.Contains(err.Error(), "dev") || !strings.Contains(err.Error(), "still running") {
		t.Errorf("the failure %q does not say which daemon is still up", err)
	}
	spawner.child(0).mu.Lock()
	spawner.child(0).signalErr = nil
	spawner.child(0).mu.Unlock()
}

func TestStopAllEndsEveryWorkspacesDaemons(t *testing.T) {
	spawner := &stubSpawner{}
	deps, _ := testDeps(spawner, &stubClock{}, &stubTimer{})
	supervisor := newSupervisor(deps)

	if _, err := supervisor.Start("/workspaces/a", "dev", "npm run dev"); err != nil {
		t.Fatalf("starting: %v", err)
	}
	if _, err := supervisor.Start("/workspaces/b", "dev", "npm run dev"); err != nil {
		t.Fatalf("starting: %v", err)
	}

	if ended := supervisor.StopAll(); ended != 2 {
		t.Fatalf("StopAll ended %d, want 2 — a daemon left behind holds its port after the app is gone", ended)
	}
}

func TestLogsAnswerTheDaemonsRecentOutput(t *testing.T) {
	supervisor, spawner, _, announced := testSupervisor(t)

	if _, err := supervisor.Start("/workspaces/app", "dev", "npm run dev"); err != nil {
		t.Fatalf("starting: %v", err)
	}
	spawner.child(0).say("compiling", "ready in 300ms")
	spawner.child(0).complain("warning: something")
	spawner.child(0).exit(0)
	waitFor(t, announced)

	lines, err := supervisor.Logs("/workspaces/app", "dev", 100)
	if err != nil {
		t.Fatalf("reading the log: %v", err)
	}
	if len(lines) != 3 {
		t.Fatalf("lines = %q, want both streams", lines)
	}
	for _, line := range lines {
		if strings.HasPrefix(line, "stdout:") || strings.HasPrefix(line, "stderr:") {
			t.Errorf("%q was tagged; callers parse these lines by their own prefixes", line)
		}
	}
}

// Answering with an empty log would say the daemon printed nothing, and the
// caller would go looking at the daemon instead of at the name it asked for.
func TestLogsForADaemonThatWasNeverStartedFailByName(t *testing.T) {
	supervisor, _, _, _ := testSupervisor(t)

	_, err := supervisor.Logs("/workspaces/app", "typo", 100)
	if err == nil {
		t.Fatal("an unknown daemon answered with a log")
	}
	if !strings.Contains(err.Error(), "typo") || !strings.Contains(err.Error(), "/workspaces/app") {
		t.Errorf("the failure %q names neither the daemon nor the workspace", err)
	}
}

// A daemon that speaks the control envelope names its socket on its first
// line, and the announcement is delivered to the listener. Without the event the only
// way to learn a daemon came up is to look again.
func TestADaemonThatNamesItsSocketIsAnnouncedReady(t *testing.T) {
	supervisor, spawner, _, announced := testSupervisor(t)

	if _, err := supervisor.Start("/workspaces/app", "db", "sidecar:db-studio"); err != nil {
		t.Fatalf("starting: %v", err)
	}
	spawner.child(0).say(announcementLine("/tmp/soksak/db.sock"))

	row := waitFor(t, announced)
	if row.Readiness.State != Ready {
		t.Fatalf("announced %+v, want ready", row.Readiness)
	}
	if row.Readiness.Socket != "/tmp/soksak/db.sock" {
		t.Errorf("socket = %q, want what the daemon said", row.Readiness.Socket)
	}
	if row.Name != "db" || row.Root != "/workspaces/app" {
		t.Errorf("the announcement %+v does not say which daemon it is about", row)
	}

	rows := supervisor.Status("/workspaces/app")
	if rows[0].Readiness.Socket != "/tmp/soksak/db.sock" {
		t.Errorf("status readiness = %+v, want the same answer the event carried", rows[0].Readiness)
	}
}

// An event for every daemon that never announces would teach the listener to
// ignore the ones that do.
func TestADaemonWithOrdinaryOutputAnnouncesNothing(t *testing.T) {
	supervisor, spawner, _, announced := testSupervisor(t)

	if _, err := supervisor.Start("/workspaces/app", "dev", "npm run dev"); err != nil {
		t.Fatalf("starting: %v", err)
	}
	spawner.child(0).say("listening on http://localhost:5173")
	spawner.child(0).exit(0)

	row := waitFor(t, announced)
	if row.Running {
		t.Fatalf("the first announcement was %+v; ordinary output was announced as if it said something", row)
	}
	if row.Readiness.State != Mute {
		t.Errorf("readiness = %+v, want mute — the first line is spent", row.Readiness)
	}
}

// Silent and mute are different answers: one daemon has not spoken yet, the
// other has spoken and said nothing about a socket.
func TestADaemonThatHasPrintedNothingIsSilentRatherThanMute(t *testing.T) {
	supervisor, _, _, _ := testSupervisor(t)

	if _, err := supervisor.Start("/workspaces/app", "dev", "npm run dev"); err != nil {
		t.Fatalf("starting: %v", err)
	}

	if state := supervisor.Status("/workspaces/app")[0].Readiness.State; state != Silent {
		t.Fatalf("readiness = %q, want %q", state, Silent)
	}
}

// Nobody is typing at a daemon. A command that prompts for input must read EOF
// and give up rather than wait for an answer that cannot come — and an open
// pipe per daemon is a handle this process holds for as long as it runs.
func TestADaemonsStdinIsClosedSoAPromptEndsRatherThanHangs(t *testing.T) {
	supervisor, spawner, _, _ := testSupervisor(t)

	if _, err := supervisor.Start("/workspaces/app", "dev", "npm run dev"); err != nil {
		t.Fatalf("starting: %v", err)
	}

	if !spawner.child(0).stdinClosed() {
		t.Fatal("the daemon's stdin was left open")
	}
}
