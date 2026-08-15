package daemon

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/soksak/soksak-core/core/control"
)

// stubFirer stands in for the registry a schedule fires into.
type stubFirer struct {
	mu       sync.Mutex
	fired    []string
	params   []control.Args
	failures int
}

func (firer *stubFirer) invoke(name string, params control.Args) (any, error) {
	firer.mu.Lock()
	firer.fired = append(firer.fired, name)
	firer.params = append(firer.params, params)
	failing := firer.failures > 0
	if failing {
		firer.failures--
	}
	firer.mu.Unlock()

	if failing {
		return nil, errors.New("the command answered ok:false")
	}
	return nil, nil
}

func (firer *stubFirer) calls() []string {
	firer.mu.Lock()
	defer firer.mu.Unlock()
	return append([]string(nil), firer.fired...)
}

func testScheduler(t *testing.T) (*scheduler, *stubFirer, *stubClock, *stubTimer) {
	t.Helper()
	firer := &stubFirer{}
	clock := &stubClock{at: 1_000}
	timer := &stubTimer{}
	deps, _ := testDeps(&stubSpawner{}, clock, timer)
	return newScheduler(deps, firer.invoke), firer, clock, timer
}

func params(t *testing.T, encoded string) control.Args {
	t.Helper()
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(encoded), &raw); err != nil {
		t.Fatalf("the test's own parameters do not encode: %v", err)
	}
	return control.Args(raw)
}

func moment(at int64) *int64 { return &at }

// The timer waits exactly as long as the job asked for. A scheduler that woke
// on a fixed tick would be a poll with a longer name.
func TestAOneShotArmsOneTimerForItsOwnWait(t *testing.T) {
	schedule, _, _, timer := testScheduler(t)

	if _, err := schedule.register(scheduleRequest{
		Trigger: Trigger{Kind: triggerAt, At: moment(4_000)},
		Command: "notify_show",
	}); err != nil {
		t.Fatalf("registering: %v", err)
	}

	asked := timer.deadlines()
	if len(asked) != 1 || asked[0] != 3*time.Second {
		t.Fatalf("deadlines = %v, want one wait of 3s", asked)
	}
}

func TestAOneShotFiresItsCommandWithItsParameters(t *testing.T) {
	schedule, firer, clock, timer := testScheduler(t)

	if _, err := schedule.register(scheduleRequest{
		Trigger: Trigger{Kind: triggerAt, At: moment(4_000)},
		Command: "notify_show",
		Params:  params(t, `{"title":"time"}`),
	}); err != nil {
		t.Fatalf("registering: %v", err)
	}

	clock.advance(3_000)
	timer.fire()
	schedule.settled()

	if fired := firer.calls(); len(fired) != 1 || fired[0] != "notify_show" {
		t.Fatalf("fired %q, want the command it was registered with", fired)
	}
	if string(firer.params[0]["title"]) != `"time"` {
		t.Errorf("fired with %v, want the caller's parameters", firer.params[0])
	}
}

// It fired the once it had. Keeping it would grow the list with jobs that can
// never be due, and make cancel answer "removed" for work already done.
func TestAOneShotLeavesTheTableAfterItFires(t *testing.T) {
	schedule, _, clock, timer := testScheduler(t)

	id, err := schedule.register(scheduleRequest{
		Trigger: Trigger{Kind: triggerAt, At: moment(4_000)},
		Command: "notify_show",
	})
	if err != nil {
		t.Fatalf("registering: %v", err)
	}

	clock.advance(3_000)
	timer.fire()
	schedule.settled()

	if rows := schedule.list(); len(rows) != 0 {
		t.Fatalf("list = %+v, want nothing left", rows)
	}
	if schedule.cancel(id) {
		t.Error("cancel answered removed for a job that had already fired")
	}
}

func TestAnIntervalJobArmsAgainAfterEachFire(t *testing.T) {
	schedule, firer, clock, timer := testScheduler(t)

	every := int64(60_000)
	if _, err := schedule.register(scheduleRequest{
		Trigger: Trigger{Kind: triggerEvery, EveryMS: &every},
		Command: "plugin_tick",
	}); err != nil {
		t.Fatalf("registering: %v", err)
	}

	for round := 1; round <= 3; round++ {
		clock.advance(every)
		timer.fire()
		schedule.settled()
		if fired := firer.calls(); len(fired) != round {
			t.Fatalf("after round %d the command fired %d time(s)", round, len(fired))
		}
	}

	rows := schedule.list()
	if len(rows) != 1 || rows[0].NextAt == nil {
		t.Fatalf("list = %+v, want the job still due", rows)
	}
}

// A reconcile job has no clock. It runs its registration scan and then waits
// for the caller to say something changed.
func TestAReconcileJobFiresOnRegistrationAndThenOnlyOnAPoke(t *testing.T) {
	schedule, firer, _, timer := testScheduler(t)

	if _, err := schedule.register(scheduleRequest{
		Trigger: Trigger{Kind: triggerReconcile},
		Command: "plugin_reconcile",
	}); err != nil {
		t.Fatalf("registering: %v", err)
	}
	timer.fire()
	schedule.settled()

	if fired := firer.calls(); len(fired) != 1 {
		t.Fatalf("fired %q, want the registration scan", fired)
	}
	if rows := schedule.list(); rows[0].NextAt != nil {
		t.Fatalf("next_at = %d; a reconcile job waits for an event, not for a time", *rows[0].NextAt)
	}

	if err := schedule.poke(""); err != nil {
		t.Fatalf("poking: %v", err)
	}
	schedule.settled()
	if fired := firer.calls(); len(fired) != 2 {
		t.Fatalf("fired %q, want the poke to have fired it again", fired)
	}
}

// A poke with no id is "something changed": it reaches the jobs that exist to
// answer that, and leaves a timed job to its own time.
func TestAPokeWithNoIdReachesOnlyTheReconcileJobs(t *testing.T) {
	schedule, firer, _, _ := testScheduler(t)

	if _, err := schedule.register(scheduleRequest{
		Trigger: Trigger{Kind: triggerAt, At: moment(9_000)},
		Command: "notify_show",
	}); err != nil {
		t.Fatalf("registering: %v", err)
	}
	if _, err := schedule.register(scheduleRequest{
		Trigger: Trigger{Kind: triggerReconcile},
		Command: "plugin_reconcile",
	}); err != nil {
		t.Fatalf("registering: %v", err)
	}
	schedule.settled()

	if err := schedule.poke(""); err != nil {
		t.Fatalf("poking: %v", err)
	}
	schedule.settled()

	for _, name := range firer.calls() {
		if name == "notify_show" {
			t.Fatal("a poke fired a job that was waiting for its own time")
		}
	}
}

// Answering "done" for a job that is not there would let a caller believe a
// reconcile it depends on has been asked for.
func TestPokingAJobThatIsNotThereFailsByName(t *testing.T) {
	schedule, _, _, _ := testScheduler(t)

	err := schedule.poke("sch-404")
	if err == nil {
		t.Fatal("a poke for an unregistered job answered as if it had fired")
	}
	if !strings.Contains(err.Error(), "sch-404") {
		t.Errorf("the failure %q does not name the job", err)
	}
}

func TestACancelledJobNeverFiresAgain(t *testing.T) {
	schedule, firer, clock, timer := testScheduler(t)

	id, err := schedule.register(scheduleRequest{
		Trigger: Trigger{Kind: triggerAt, At: moment(4_000)},
		Command: "notify_show",
	})
	if err != nil {
		t.Fatalf("registering: %v", err)
	}

	if !schedule.cancel(id) {
		t.Fatal("cancel answered that there was no such job")
	}
	clock.advance(9_000)
	timer.fire()
	schedule.settled()

	if fired := firer.calls(); len(fired) != 0 {
		t.Fatalf("fired %q after being cancelled", fired)
	}
}

// A failing command backs off rather than retrying at once, and stops at the
// count the caller set. Retrying forever turns one broken job into a machine
// that never idles.
func TestAFailingJobRetriesWithBackoffAndStops(t *testing.T) {
	schedule, firer, clock, timer := testScheduler(t)
	firer.failures = 99

	if _, err := schedule.register(scheduleRequest{
		Trigger: Trigger{Kind: triggerAt, At: moment(1_000)},
		Command: "plugin_sync",
		Retry:   &Retry{Max: 2, BaseMS: 1_000, MaxMS: 4_000},
	}); err != nil {
		t.Fatalf("registering: %v", err)
	}

	timer.fire()
	schedule.settled()
	if rows := schedule.list(); len(rows) != 1 || rows[0].NextAt == nil || *rows[0].NextAt != 2_000 {
		t.Fatalf("list = %+v, want a retry armed 1000ms on", rows)
	}

	clock.advance(1_000)
	timer.fire()
	schedule.settled()
	if rows := schedule.list(); len(rows) != 1 || *rows[0].NextAt != 4_000 {
		t.Fatalf("list = %+v, want the second retry 2000ms on", rows)
	}

	clock.advance(2_000)
	timer.fire()
	schedule.settled()
	if fired := firer.calls(); len(fired) != 3 {
		t.Fatalf("fired %d times, want the first and two retries", len(fired))
	}
	if rows := schedule.list(); len(rows) != 0 {
		t.Fatalf("list = %+v, want the job gone once its retries ran out", rows)
	}
}

// Two pokes while a job runs are one further run: the point of a reconcile is
// to see what it has not seen yet, and one run sees all of it.
func TestPokesThatArriveWhileAJobRunsCoalesceIntoOne(t *testing.T) {
	firer := &stubFirer{}
	clock := &stubClock{at: 1_000}
	timer := &stubTimer{}
	deps, _ := testDeps(&stubSpawner{}, clock, timer)

	inside := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	schedule := newScheduler(deps, func(name string, args control.Args) (any, error) {
		once.Do(func() {
			close(inside)
			<-release
		})
		return firer.invoke(name, args)
	})

	if _, err := schedule.register(scheduleRequest{
		Trigger: Trigger{Kind: triggerReconcile},
		Command: "plugin_reconcile",
	}); err != nil {
		t.Fatalf("registering: %v", err)
	}
	timer.fire()

	<-inside
	if err := schedule.poke(""); err != nil {
		t.Fatalf("poking: %v", err)
	}
	if err := schedule.poke(""); err != nil {
		t.Fatalf("poking: %v", err)
	}
	close(release)
	schedule.settled()

	if fired := firer.calls(); len(fired) != 2 {
		t.Fatalf("fired %d times, want the first run and one coalesced re-run", len(fired))
	}
}

// The caller re-registers what it stored when it comes up, and it re-uses the
// id it stored. Two jobs under one name would fire the work twice.
func TestRegisteringUnderAnExistingIdReplacesThatJob(t *testing.T) {
	schedule, firer, clock, timer := testScheduler(t)

	every := int64(60_000)
	if _, err := schedule.register(scheduleRequest{
		Trigger: Trigger{Kind: triggerEvery, EveryMS: &every},
		Command: "plugin_old",
		ID:      "sch-mine",
	}); err != nil {
		t.Fatalf("registering: %v", err)
	}
	if _, err := schedule.register(scheduleRequest{
		Trigger: Trigger{Kind: triggerEvery, EveryMS: &every},
		Command: "plugin_new",
		ID:      "sch-mine",
	}); err != nil {
		t.Fatalf("registering again: %v", err)
	}

	if rows := schedule.list(); len(rows) != 1 {
		t.Fatalf("list = %+v, want one job under the id", rows)
	}
	clock.advance(every)
	timer.fire()
	schedule.settled()

	if fired := firer.calls(); len(fired) != 1 || fired[0] != "plugin_new" {
		t.Fatalf("fired %q, want only the job that replaced the first", fired)
	}
}

func TestTheListIsSoonestFirstAndCarriesNoNulls(t *testing.T) {
	schedule, _, _, _ := testScheduler(t)

	if _, err := schedule.register(scheduleRequest{
		Trigger: Trigger{Kind: triggerAt, At: moment(9_000)},
		Command: "later",
		ID:      "sch-later",
	}); err != nil {
		t.Fatalf("registering: %v", err)
	}
	if _, err := schedule.register(scheduleRequest{
		Trigger: Trigger{Kind: triggerAt, At: moment(5_000)},
		Command: "sooner",
		ID:      "sch-sooner",
	}); err != nil {
		t.Fatalf("registering: %v", err)
	}

	rows := schedule.list()
	if rows[0].ID != "sch-sooner" {
		t.Fatalf("list = %+v, want the soonest first", rows)
	}
	for _, row := range rows {
		if row.Params == nil {
			t.Errorf("%s carries null parameters; a caller spreading them would spread a null", row.ID)
		}
		if row.Concurrency != 1 {
			t.Errorf("%s reports concurrency %d; one job holds one lease here", row.ID, row.Concurrency)
		}
	}
}

func TestAJobWithNoCommandIsRefusedByName(t *testing.T) {
	schedule, _, _, _ := testScheduler(t)

	_, err := schedule.register(scheduleRequest{Trigger: Trigger{Kind: triggerReconcile}})
	if err == nil {
		t.Fatal("a job with nothing to fire was registered")
	}
	if !strings.Contains(err.Error(), "command") {
		t.Errorf("the refusal %q does not say what is missing", err)
	}
}
