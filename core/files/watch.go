package files

import (
	"fmt"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

// defaultFoldWindow is how long changes are collected before a directory is
// reported.
//
// The number is carried from a debouncing watcher library and has
// no measurement attached to it. It is kept rather than replaced with an
// invented one; measuring it is its own investigation. What is new here is that
// it is *ours*: Go's watchers do not debounce, so the fold is a core rule with
// an injected scheduler rather than a library's behaviour.
const defaultFoldWindow = 250 * time.Millisecond

// Backend is the OS watcher, kept behind an interface so every rule above it —
// the refcount, the parent fold, the burst fold — is checkable without a real
// filesystem event.
//
// Deliver hands the backend the sink for changed paths and is called once, at
// construction, before any Arm. It is part of the interface rather than a
// return value from Register because Register answers nothing: without this
// method a concrete backend would have no way to reach the folding rules.
//
// Arm and Disarm are non-recursive by contract. A lazy tree arms only the
// directories it has opened, so a huge tree costs one watch per opened folder
// instead of a recursive watch that floods.
//
// Neither may call the delivered report synchronously. They run while the
// subscription counts are held, which is what keeps the count and the OS watch
// moving together; a synchronous report from inside them would deadlock.
// Delivering from the backend's own goroutine, which is how every OS watcher
// works, is what this expects.
type Backend interface {
	Deliver(report func(paths ...string))
	Arm(path string) error
	Disarm(path string) error
}

// watchers holds the subscription counts and the fold state.
type watchers struct {
	backend Backend
	emit    func(dir string)
	fold    time.Duration
	after   func(time.Duration, func())

	mu sync.Mutex
	// counts is consumers per resolved path. The OS watch is one per path:
	// armed at 0→1, disarmed at 1→0, so several windows and plugins watching
	// one folder do not break each other's subscription (the W8 M1 dedup
	// contract).
	counts  map[string]int
	pending map[string]bool
	folding bool
}

func newWatchers(backend Backend, emit func(dir string), fold time.Duration, after func(time.Duration, func())) *watchers {
	if fold <= 0 {
		fold = defaultFoldWindow
	}
	if after == nil {
		after = func(delay time.Duration, run func()) { time.AfterFunc(delay, run) }
	}
	watch := &watchers{
		backend: backend,
		emit:    emit,
		fold:    fold,
		after:   after,
		counts:  map[string]int{},
		pending: map[string]bool{},
	}
	if backend != nil {
		backend.Deliver(watch.Report)
	}
	return watch
}

// Watch registers one consumer and answers the count after the change.
//
// A build that cannot deliver events refuses by name instead of answering a
// count. The worst failure here is a consumer that believes it registered and
// waits forever for events that never come — and a nil sink produces exactly
// that, so both halves of the delivery path are checked.
func (watch *watchers) Watch(path string, home string) (int, error) {
	if watch.backend == nil {
		return 0, i18n.Errorf("files.watch.noWatcher", nil)
	}
	if watch.emit == nil {
		return 0, i18n.Errorf("files.watch.noSink", nil)
	}
	key, err := watchKey(path, home)
	if err != nil {
		return 0, err
	}

	// The count and the OS watch move together, under one lock. Measured here
	// with eight consumers arriving at once and a 20 ms arm: releasing the lock
	// around the Arm let all eight read the count at zero and arm the same path
	// eight times, and a refcount only ever disarms once — so seven OS watches
	// would have outlived every consumer.
	watch.mu.Lock()
	defer watch.mu.Unlock()

	if existing := watch.counts[key]; existing > 0 {
		watch.counts[key] = existing + 1
		return watch.counts[key], nil
	}
	// Armed before the count is raised. A count raised on a failed arm never
	// comes back down: the next release drops it to zero and disarms a watch
	// that was never armed, and the path can never be armed again.
	if err := watch.backend.Arm(key); err != nil {
		return 0, fmt.Errorf("watch_dir could not watch %s: %w", key, err)
	}
	watch.counts[key] = 1
	return 1, nil
}

// Unwatch releases one consumer and answers the count after the change.
//
// Releasing a path that was never registered is zero and idempotent, not an
// error: a tree unmounting a subtree does not know which of its folders were
// armed.
//
// The count is dropped before the OS watch is released, which is the opposite
// order to Watch and deliberate. Watch arms first because a count raised on a
// failed arm never comes back down. The failure here runs the other way: a
// count held on a failed disarm strands the consumer at one forever, so every
// later release answers 1 and the path can never be let go. The count is ours
// to keep consistent; the OS handle is not, so a disarm that fails is reported
// rather than allowed to pin the subscription.
func (watch *watchers) Unwatch(path string, home string) (int, error) {
	if watch.backend == nil {
		return 0, i18n.Errorf("files.watch.noWatcher", nil)
	}
	key, err := watchKey(path, home)
	if err != nil {
		return 0, err
	}

	watch.mu.Lock()
	defer watch.mu.Unlock()

	existing, wasWatched := watch.counts[key]
	if !wasWatched {
		return 0, nil
	}
	if existing > 1 {
		watch.counts[key] = existing - 1
		return existing - 1, nil
	}
	delete(watch.counts, key)
	if err := watch.backend.Disarm(key); err != nil {
		return 0, fmt.Errorf("watch_dir could not release %s: %w", key, err)
	}
	return 0, nil
}

// Report takes raw changed paths from the backend.
//
// It never emits inline. What the consumer wants is the directory to re-list,
// and a burst of changes under one directory is one re-list — four events would
// otherwise be four full directory reads.
func (watch *watchers) Report(paths ...string) {
	// Resolved before the lock: this touches the filesystem, and the backend
	// delivers on its own goroutine while a window may be calling watch_dir.
	dirs := make([]string, 0, len(paths))
	for _, path := range paths {
		if dir, reportable := parentOf(path); reportable {
			dirs = append(dirs, dir)
		}
	}
	if len(dirs) == 0 {
		return
	}

	watch.mu.Lock()
	for _, dir := range dirs {
		watch.pending[dir] = true
	}
	schedule := !watch.folding
	watch.folding = true
	watch.mu.Unlock()

	if schedule {
		watch.after(watch.fold, watch.flush)
	}
}

// flush reports each collected directory once and reopens the window.
func (watch *watchers) flush() {
	watch.mu.Lock()
	dirs := make([]string, 0, len(watch.pending))
	for dir := range watch.pending {
		dirs = append(dirs, dir)
	}
	watch.pending = map[string]bool{}
	watch.folding = false
	emit := watch.emit
	watch.mu.Unlock()

	// Sorted so two identical bursts report identically; map order would make
	// one burst's output depend on nothing the caller can see.
	sort.Strings(dirs)
	if emit == nil {
		return
	}
	// Emitted outside the lock: the sink is the window owner's and
	// may come back through this package.
	for _, dir := range dirs {
		emit(dir)
	}
}

// parentOf answers the directory to re-list for a changed entry.
//
// The reported unit is the parent rather than the changed entry, because the
// consumer re-lists a directory. There is no filtering to watched paths: the
// consumer already compares the reported directory with its own, and filtering
// here would silently drop the case where a watched directory is itself
// renamed.
//
// A path with no directory to re-list is skipped. The filesystem root has no
// parent, and a relative path has none that this package can name — core reads
// no working directory, so resolving one would be an ambient read.
func parentOf(path string) (string, bool) {
	if path == "" || !filepath.IsAbs(path) {
		return "", false
	}
	parent := filepath.Dir(path)
	if parent == path {
		return "", false
	}
	return resolvePath(parent), true
}

// watchKey is the identity of a watched directory.
//
// Both the key and the reported directory are symlink-resolved, and that is a
// divergence with a reason: keying raw strings makes the tests
// canonicalize the fixture to match what FSEvents reports — the rule then
// is in the test instead of the code. In production on <local-evidence>, where /var is a
// link to /private/var, that mismatch makes the consumer's `changed === dir`
// never match.
func watchKey(path string, home string) (string, error) {
	if path == "" {
		// Never silently the home: watch_dir names a directory, and defaulting
		// would arm a folder nobody asked for and answer a count for it.
		return "", i18n.Errorf("files.watch.noPath", nil)
	}
	expanded, err := expand(path, home)
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(expanded) {
		// The same rule parentOf keeps, on the other side of the same
		// subscription. Core reads no working directory, so a relative path
		// has no directory this package can name — parentOf therefore drops
		// every change reported under one. Arming it anyway answered a refcount
		// for a subscription that can never fire, which is the failure this
		// file exists to refuse: a consumer that believes it registered and
		// waits forever.
		return "", i18n.Errorf("files.watch.relativePath", map[string]string{"path": fmt.Sprintf("%q", path)})
	}
	return resolvePath(expanded), nil
}
