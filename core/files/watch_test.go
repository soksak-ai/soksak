package files

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeBackend stands in for the OS watcher. Every rule in watch.go is the
// core's — refcount dedup, the parent fold, the burst fold — so none of them
// needs a real filesystem event to be checked, and none of them can drift out
// of reach of the gate.
type fakeBackend struct {
	mu        sync.Mutex
	armed     []string
	disarmed  []string
	armErr    error
	disarmErr error
	armDelay  time.Duration
	report    func(paths ...string)
}

func (backend *fakeBackend) Deliver(report func(paths ...string)) { backend.report = report }

func (backend *fakeBackend) Arm(path string) error {
	backend.mu.Lock()
	delay, failure := backend.armDelay, backend.armErr
	backend.mu.Unlock()
	// A real Arm is a syscall, so it takes time. The delay widens that window
	// on demand, which is what makes a lost race reproducible.
	time.Sleep(delay)
	if failure != nil {
		return failure
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	backend.armed = append(backend.armed, path)
	return nil
}

func (backend *fakeBackend) Disarm(path string) error {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	backend.disarmed = append(backend.disarmed, path)
	return backend.disarmErr
}

func (backend *fakeBackend) armedPaths() []string {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	return append([]string{}, backend.armed...)
}

// fakeClock collects what was scheduled instead of sleeping. A test that sleeps
// for the fold window turns a rule into a stopwatch reading.
type fakeClock struct {
	delays  []time.Duration
	pending []func()
}

func (clock *fakeClock) After(delay time.Duration, run func()) {
	clock.delays = append(clock.delays, delay)
	clock.pending = append(clock.pending, run)
}

func (clock *fakeClock) fire() {
	pending := clock.pending
	clock.pending = nil
	for _, run := range pending {
		run()
	}
}

type recorder struct{ dirs []string }

func (sink *recorder) emit(dir string) { sink.dirs = append(sink.dirs, dir) }

func newFixture(t *testing.T, backend Backend) (*watchers, *recorder, *fakeClock) {
	t.Helper()
	sink := &recorder{}
	clock := &fakeClock{}
	return newWatchers(backend, sink.emit, defaultFoldWindow, clock.After), sink, clock
}

// The W8 M1 dedup contract: several windows and plugins watch the same folder,
// and one of them releasing must not break the others.
func TestASecondConsumerRaisesTheCountWithoutArmingAgain(t *testing.T) {
	backend := &fakeBackend{}
	watch, _, _ := newFixture(t, backend)

	first, err := watch.Watch("/work", "")
	if err != nil {
		t.Fatalf("first consumer: %v", err)
	}
	second, err := watch.Watch("/work", "")
	if err != nil {
		t.Fatalf("second consumer: %v", err)
	}
	if first != 1 || second != 2 {
		t.Errorf("counts = %d, %d; want 1, 2", first, second)
	}
	if len(backend.armed) != 1 {
		t.Errorf("armed %v, want exactly one OS watch per path", backend.armed)
	}
}

// Several windows open the same folder at once. The count and the OS watch have
// to move together: two callers that both find the count at zero would arm the
// same path twice, and the second watch is then never released — the refcount
// only ever disarms once.
func TestTwoConsumersArrivingAtOnceArmOnce(t *testing.T) {
	backend := &fakeBackend{armDelay: 20 * time.Millisecond}
	watch, _, _ := newFixture(t, backend)

	const consumers = 8
	var waiting sync.WaitGroup
	waiting.Add(consumers)
	for range consumers {
		go func() {
			defer waiting.Done()
			if _, err := watch.Watch("/work", ""); err != nil {
				t.Errorf("watching: %v", err)
			}
		}()
	}
	waiting.Wait()

	if armed := backend.armedPaths(); len(armed) != 1 {
		t.Errorf("armed %v, want exactly one OS watch for one path", armed)
	}
	count, err := watch.Watch("/work", "")
	if err != nil {
		t.Fatalf("watching: %v", err)
	}
	if count != consumers+1 {
		t.Errorf("count = %d, want %d", count, consumers+1)
	}
}

func TestOneConsumerReleasingKeepsTheOtherArmed(t *testing.T) {
	backend := &fakeBackend{}
	watch, _, _ := newFixture(t, backend)
	mustWatch(t, watch, "/work")
	mustWatch(t, watch, "/work")

	remaining, err := watch.Unwatch("/work", "")
	if err != nil {
		t.Fatalf("partial release: %v", err)
	}
	if remaining != 1 {
		t.Errorf("count = %d, want 1", remaining)
	}
	if len(backend.disarmed) != 0 {
		t.Errorf("disarmed %v while a consumer was still watching", backend.disarmed)
	}

	last, err := watch.Unwatch("/work", "")
	if err != nil {
		t.Fatalf("final release: %v", err)
	}
	if last != 0 {
		t.Errorf("count = %d, want 0", last)
	}
	if len(backend.disarmed) != 1 {
		t.Errorf("disarmed %v, want exactly one", backend.disarmed)
	}
}

// Releasing something that was never registered is an ordinary answer: a tree
// unmounting a subtree does not know which of its folders were armed.
func TestUnwatchingAnUnwatchedPathIsZeroAndIdempotent(t *testing.T) {
	backend := &fakeBackend{}
	watch, _, _ := newFixture(t, backend)

	for range 3 {
		remaining, err := watch.Unwatch("/never", "")
		if err != nil {
			t.Fatalf("releasing an unwatched path must not fail: %v", err)
		}
		if remaining != 0 {
			t.Errorf("count = %d, want 0", remaining)
		}
	}
	if len(backend.disarmed) != 0 {
		t.Errorf("disarmed %v for a path that was never armed", backend.disarmed)
	}
}

// The worst failure here is a consumer that believes it registered waiting
// forever for events that never come.
func TestAnAbsentBackendRefusesByName(t *testing.T) {
	watch, _, _ := newFixture(t, nil)

	if _, err := watch.Watch("/work", ""); err == nil {
		t.Fatal("a build with no watcher must refuse rather than answer a refcount")
	} else if !strings.Contains(err.Error(), "Watch") {
		t.Errorf("the refusal does not name what to supply: %v", err)
	}
}

// Same reason as the absent backend: armed events with nowhere to go are a
// subscription that silently never delivers.
func TestAnAbsentSinkRefusesByName(t *testing.T) {
	clock := &fakeClock{}
	watch := newWatchers(&fakeBackend{}, nil, defaultFoldWindow, clock.After)

	if _, err := watch.Watch("/work", ""); err == nil {
		t.Fatal("a build with no change sink must refuse rather than fold events into nothing")
	} else if !strings.Contains(err.Error(), "EmitChange") {
		t.Errorf("the refusal does not name what to supply: %v", err)
	}
}

// A count raised on a failed arm never comes back down: the next release drops
// it to zero and disarms a watch that was never armed, and the path can never
// be armed again.
func TestAFailedArmLeavesTheCountAtZeroSoARetryStillArms(t *testing.T) {
	backend := &fakeBackend{armErr: errors.New("too many open files")}
	watch, _, _ := newFixture(t, backend)

	if _, err := watch.Watch("/work", ""); err == nil {
		t.Fatal("a failed arm must be reported")
	}

	backend.armErr = nil
	count, err := watch.Watch("/work", "")
	if err != nil {
		t.Fatalf("the retry: %v", err)
	}
	if count != 1 {
		t.Errorf("count = %d, want the retry to be the first consumer", count)
	}
	if len(backend.armed) != 1 {
		t.Errorf("armed %v", backend.armed)
	}
}

// The reported unit is the directory to re-list, and one burst under it is one
// re-list. Four events would otherwise be four full directory reads.
func TestABurstUnderOneDirectoryReportsItOnce(t *testing.T) {
	backend := &fakeBackend{}
	watch, sink, clock := newFixture(t, backend)
	mustWatch(t, watch, "/work")

	backend.report("/work/a.txt", "/work/b.txt", "/work/a.txt")
	backend.report("/work/c.txt")
	if len(sink.dirs) != 0 {
		t.Fatalf("the fold window emitted early: %v", sink.dirs)
	}
	if len(clock.pending) != 1 {
		t.Fatalf("a burst scheduled %d flushes, want one", len(clock.pending))
	}
	if clock.delays[0] != defaultFoldWindow {
		t.Errorf("the fold window was %v", clock.delays[0])
	}

	clock.fire()
	if !equal(sink.dirs, []string{"/work"}) {
		t.Errorf("emitted %v, want the directory once", sink.dirs)
	}
}

func TestTwoDirectoriesInOneBurstAreTwoReports(t *testing.T) {
	backend := &fakeBackend{}
	watch, sink, clock := newFixture(t, backend)
	mustWatch(t, watch, "/work")

	backend.report("/work/a.txt", "/other/b.txt")
	clock.fire()

	if !equal(sink.dirs, []string{"/other", "/work"}) {
		t.Errorf("emitted %v, want both directories", sink.dirs)
	}
}

// The consumer already compares the reported directory with its own
// (`changed === dir`). Filtering to watched paths here would silently drop the
// case where the watched directory is itself renamed.
func TestAChangeOutsideAnyWatchedPathIsStillReported(t *testing.T) {
	backend := &fakeBackend{}
	watch, sink, clock := newFixture(t, backend)
	mustWatch(t, watch, "/work")

	backend.report("/somewhere/else/f.txt")
	clock.fire()

	if !equal(sink.dirs, []string{"/somewhere/else"}) {
		t.Errorf("emitted %v", sink.dirs)
	}
}

// A path with no directory to re-list is skipped rather than emitted. An empty
// string reaching the sink would make the tree re-list nothing under a name it
// cannot match, and a relative path has no meaning here because core reads no
// working directory.
func TestAPathWithNoParentIsSkipped(t *testing.T) {
	backend := &fakeBackend{}
	watch, sink, clock := newFixture(t, backend)
	mustWatch(t, watch, "/work")

	backend.report("", "/", "bare-name", "also/relative")
	clock.fire()

	if len(sink.dirs) != 0 {
		t.Errorf("emitted %v, want nothing", sink.dirs)
	}
}

func TestASecondBurstSchedulesAgainAfterTheFirstFlush(t *testing.T) {
	backend := &fakeBackend{}
	watch, sink, clock := newFixture(t, backend)
	mustWatch(t, watch, "/work")

	backend.report("/work/a.txt")
	clock.fire()
	backend.report("/work/b.txt")
	if len(clock.pending) != 1 {
		t.Fatalf("the second burst scheduled %d flushes, want one", len(clock.pending))
	}
	clock.fire()

	if !equal(sink.dirs, []string{"/work", "/work"}) {
		t.Errorf("emitted %v, want one report per window", sink.dirs)
	}
}

// The fold window collects and then lets go. A directory left in the pending
// set is reported again by every later burst anywhere in the tree — the tree
// re-lists a folder nothing touched, and the set only ever grows. Every other
// fold test fires once, so none of them can see it.
func TestAFlushedDirectoryIsNotReportedAgainByTheNextBurst(t *testing.T) {
	backend := &fakeBackend{}
	watch, sink, clock := newFixture(t, backend)
	mustWatch(t, watch, "/work")

	backend.report("/work/a.txt")
	clock.fire()
	backend.report("/other/b.txt")
	clock.fire()

	if !equal(sink.dirs, []string{"/work", "/other"}) {
		t.Errorf("emitted %v, want each window to report only what changed in it", sink.dirs)
	}
}

// Deps.Delay states that a zero takes the default, so the wiring does not need
// the number. Every fixture above passes the window explicitly, so nothing else
// enters that branch.
func TestAZeroDelayTakesTheDefaultFoldWindow(t *testing.T) {
	backend := &fakeBackend{}
	sink := &recorder{}
	clock := &fakeClock{}
	watch := newWatchers(backend, sink.emit, 0, clock.After)
	mustWatch(t, watch, "/work")

	backend.report("/work/a.txt")
	if len(clock.delays) != 1 || clock.delays[0] != defaultFoldWindow {
		t.Errorf("scheduled %v, want the default fold window", clock.delays)
	}
}

// parentOf drops every change reported under a relative path — core reads no
// working directory to resolve one against. Arming one anyway answered a
// refcount for a subscription that could never fire, which is the failure the
// nil-backend and nil-sink refusals above exist to prevent, reached by a third
// door.
func TestARelativePathIsRefusedRatherThanWatchedSilently(t *testing.T) {
	backend := &fakeBackend{}
	watch, _, _ := newFixture(t, backend)

	if _, err := watch.Watch("work/notes", ""); err == nil {
		t.Fatal("a relative path must be refused, not armed under a key nothing can report")
	}
	if len(backend.armed) != 0 {
		t.Errorf("armed %v", backend.armed)
	}
}

// The release order is the opposite of Watch's, on purpose. Watch arms before
// it raises the count because a count raised on a failed arm never comes back
// down; here the failure runs the other way, so the count is dropped first and
// the error names what could not be released. Holding the count on a failed
// disarm would strand the consumer at one forever — every later release would
// answer 1 and the path could never be let go.
func TestAFailedDisarmStillReleasesTheSubscription(t *testing.T) {
	backend := &fakeBackend{disarmErr: errors.New("watch already removed")}
	watch, _, _ := newFixture(t, backend)
	mustWatch(t, watch, "/work")

	remaining, err := watch.Unwatch("/work", "")
	if err == nil {
		t.Fatal("a failed disarm must be reported rather than swallowed")
	}
	if remaining != 0 {
		t.Errorf("count = %d, want the subscription released even so", remaining)
	}
	// And the path is watchable again rather than stuck holding a phantom
	// consumer.
	count, err := watch.Watch("/work", "")
	if err != nil {
		t.Fatalf("re-watching: %v", err)
	}
	if count != 1 {
		t.Errorf("count = %d, want the next consumer to be the first", count)
	}
}

func TestTheFoldWindowIsTheOneWrittenDown(t *testing.T) {
	// Inherited from notify_debouncer_mini with no measurement attached to it.
	// It is kept rather than replaced with an invented number, and measuring it
	// is its own investigation.
	if defaultFoldWindow != 250*time.Millisecond {
		t.Errorf("defaultFoldWindow = %v", defaultFoldWindow)
	}
}

// Keying raw strings makes the *tests* canonicalize the
// fixture to match what FSEvents reports — the rule is then in the test
// instead of the code, and on /tmp that mismatch makes `changed === dir` never
// match in production. Here both the key and the reported directory resolve.
func TestOnePathTwoSpellingsIsOneWatch(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "real")
	if err := os.Mkdir(real, 0o755); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}
	resolved, err := filepath.EvalSymlinks(real)
	if err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}

	backend := &fakeBackend{}
	watch, sink, clock := newFixture(t, backend)

	if count := mustWatch(t, watch, link); count != 1 {
		t.Errorf("count = %d", count)
	}
	if count := mustWatch(t, watch, real); count != 2 {
		t.Errorf("count = %d, want the two spellings to be one watch", count)
	}
	if !equal(backend.armed, []string{resolved}) {
		t.Errorf("armed %v, want the resolved path once", backend.armed)
	}

	// And the directory that comes back is spelled the same way, so the
	// consumer's `changed === dir` matches at all.
	backend.report(filepath.Join(link, "f.txt"))
	clock.fire()
	if !equal(sink.dirs, []string{resolved}) {
		t.Errorf("emitted %v, want %q", sink.dirs, resolved)
	}

	if _, err := watch.Unwatch(real, ""); err != nil {
		t.Fatalf("releasing: %v", err)
	}
	remaining, err := watch.Unwatch(link, "")
	if err != nil {
		t.Fatalf("releasing the other spelling: %v", err)
	}
	if remaining != 0 {
		t.Errorf("count = %d, want the two spellings to release one watch", remaining)
	}
	if !equal(backend.disarmed, []string{resolved}) {
		t.Errorf("disarmed %v", backend.disarmed)
	}
}

// The home rule applies here too, or the tree and the watcher key the same
// folder differently.
func TestTheTildeReachesTheWatchKey(t *testing.T) {
	home := t.TempDir()
	work := filepath.Join(home, "work")
	if err := os.Mkdir(work, 0o755); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}
	resolved, err := filepath.EvalSymlinks(work)
	if err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}

	backend := &fakeBackend{}
	watch, _, _ := newFixture(t, backend)

	if _, err := watch.Watch("~/work", home); err != nil {
		t.Fatalf("watching through the tilde: %v", err)
	}
	if !equal(backend.armed, []string{resolved}) {
		t.Errorf("armed %v, want %q", backend.armed, resolved)
	}
}

func TestAnEmptyPathIsRefusedRatherThanWatchingTheHome(t *testing.T) {
	backend := &fakeBackend{}
	watch, _, _ := newFixture(t, backend)

	if _, err := watch.Watch("", "/homes/a"); err == nil {
		t.Fatal("an empty path must be refused, not silently turned into the home")
	}
	if len(backend.armed) != 0 {
		t.Errorf("armed %v", backend.armed)
	}
}

func mustWatch(t *testing.T, watch *watchers, path string) int {
	t.Helper()
	count, err := watch.Watch(path, "")
	if err != nil {
		t.Fatalf("watching %s: %v", path, err)
	}
	return count
}
