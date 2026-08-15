package daemon

import (
	"strings"
	"testing"
	"time"
)

func testRunner(t *testing.T) (*Supervisor, *stubSpawner, *stubTimer) {
	t.Helper()
	spawner := &stubSpawner{appeared: make(chan *stubChild, 4)}
	timer := &stubTimer{armed: make(chan time.Duration, 4)}
	deps, _ := testDeps(spawner, &stubClock{}, timer)
	return newSupervisor(deps), spawner, timer
}

func TestARunOnceAnswersWithItsCodeAndEverythingItPrinted(t *testing.T) {
	supervisor, spawner, _ := testRunner(t)

	go func() {
		child := <-spawner.appeared
		child.say("building", "@@RELEASE_SUMMARY@@ {\"ok\":true}")
		child.complain("a warning")
		child.exit(0)
	}()

	once, err := supervisor.RunOnce("/projects/app", "node build.mjs", nil, time.Minute)
	if err != nil {
		t.Fatalf("running: %v", err)
	}
	if once.Code == nil || *once.Code != 0 {
		t.Fatalf("code = %v, want 0", once.Code)
	}
	if len(once.Lines) != 3 {
		t.Fatalf("lines = %q, want both streams", once.Lines)
	}
	found := false
	for _, line := range once.Lines {
		if strings.HasPrefix(line, "@@RELEASE_SUMMARY@@ ") {
			found = true
		}
	}
	if !found {
		t.Errorf("lines = %q; the caller finds its summary by prefix, so nothing may be added to a line", once.Lines)
	}
}

// A command that ran and failed is not a command that could not be run. The
// caller reads the code and prints the output as the evidence.
func TestAFailedRunAnswersWithItsCodeRatherThanAnError(t *testing.T) {
	supervisor, spawner, _ := testRunner(t)

	go func() {
		child := <-spawner.appeared
		child.complain("error: the checksum did not match")
		child.exit(3)
	}()

	once, err := supervisor.RunOnce("/projects/app", "node validate.mjs", nil, time.Minute)
	if err != nil {
		t.Fatalf("running: %v", err)
	}
	if once.Code == nil || *once.Code != 3 {
		t.Fatalf("code = %v, want 3", once.Code)
	}
}

func TestASignalledRunLeavesNoCodeRatherThanZero(t *testing.T) {
	supervisor, spawner, _ := testRunner(t)

	go func() {
		child := <-spawner.appeared
		child.exit(-1)
	}()

	once, err := supervisor.RunOnce("/projects/app", "node build.mjs", nil, time.Minute)
	if err != nil {
		t.Fatalf("running: %v", err)
	}
	if once.Code != nil {
		t.Fatalf("code = %d; a child that left no code of its own must not report success", *once.Code)
	}
}

// A run that printed nothing answers with an empty list. Nil arrives as JSON
// null, and the caller joins these lines as its failure evidence.
func TestASilentRunAnswersWithNoLinesRatherThanNull(t *testing.T) {
	supervisor, spawner, _ := testRunner(t)

	go func() { (<-spawner.appeared).exit(0) }()

	once, err := supervisor.RunOnce("/projects/app", "true", nil, time.Minute)
	if err != nil {
		t.Fatalf("running: %v", err)
	}
	if once.Lines == nil {
		t.Fatal("lines is nil")
	}
}

// A deadline that passed ends the command. Answering the caller while leaving
// the work running keeps the machine busy with what it just failed at.
func TestARunThatPassedItsDeadlineIsStoppedAndNamed(t *testing.T) {
	supervisor, spawner, timer := testRunner(t)

	appeared := make(chan *stubChild, 1)
	go func() {
		child := <-spawner.appeared
		child.say("still linking")
		appeared <- child
		// The deadline is armed after the child is started. Waiting for it is
		// what makes this the machine that was too slow rather than a race.
		<-timer.armed
		timer.fire()
	}()

	_, err := supervisor.RunOnce("/projects/app", "node build.mjs", nil, 90*time.Second)
	if err == nil {
		t.Fatal("a run that never finished answered as if it had")
	}
	if !strings.Contains(err.Error(), "node build.mjs") {
		t.Errorf("the failure %q does not name the command", err)
	}
	if !strings.Contains(err.Error(), "still linking") {
		t.Errorf("the failure %q carries none of the output; where it stopped is the whole evidence", err)
	}
	if (<-appeared).signalled() == 0 {
		t.Error("the command was left running after the deadline")
	}
	if asked := timer.deadlines(); len(asked) != 1 || asked[0] != 90*time.Second {
		t.Errorf("deadlines asked for = %v, want the caller's 90s", asked)
	}
}

// release.publish sends its token this way rather than writing it into the
// shell line, where every process list on the machine would show it.
func TestAnEnvironmentOverrideReachesTheChild(t *testing.T) {
	supervisor, spawner, _ := testRunner(t)

	go func() { (<-spawner.appeared).exit(0) }()

	if _, err := supervisor.RunOnce("/projects/app", "gh release create", map[string]string{"GH_TOKEN": "secret"}, time.Minute); err != nil {
		t.Fatalf("running: %v", err)
	}

	spec := spawner.started()[0]
	carried := false
	for _, entry := range spec.Env {
		if entry == "GH_TOKEN=secret" {
			carried = true
		}
		if strings.Contains(strings.Join(spec.Args, " "), "secret") {
			t.Fatal("the token was interpolated into the command line, where a process list shows it")
		}
	}
	if !carried {
		t.Fatalf("Env = %q, want the caller's override", spec.Env)
	}
}

// Output above the bound is dropped, and the answer states that. Silence there
// would let a caller parse a truncated log as a complete one.
func TestOutputAboveTheBoundIsNamedRatherThanDroppedQuietly(t *testing.T) {
	supervisor, spawner, _ := testRunner(t)

	line := strings.Repeat("x", 64*1024)
	go func() {
		child := <-spawner.appeared
		for written := 0; written <= maxOnceBytes; written += len(line) {
			child.say(line)
		}
		child.say("the last word")
		child.exit(0)
	}()

	once, err := supervisor.RunOnce("/projects/app", "node build.mjs", nil, time.Minute)
	if err != nil {
		t.Fatalf("running: %v", err)
	}

	last := once.Lines[len(once.Lines)-1]
	if !strings.Contains(last, "were not kept") {
		t.Fatalf("the answer ends with %q; nothing says the output was cut", last)
	}
	if once.Code == nil || *once.Code != 0 {
		t.Errorf("code = %v; the child's own answer stands whatever this build kept", once.Code)
	}
}
