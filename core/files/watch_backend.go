package files

import (
	"sync"

	"github.com/fsnotify/fsnotify"
)

// osWatcher is the operating system's watcher behind the Backend interface.
//
// Every rule above it stays here — the subscription refcount, the parent fold, the burst fold — and
// this holds only the part no rule can supply: what the kernel reports. Writing that part by hand
// means three implementations (kqueue, inotify, ReadDirectoryChangesW) and their edge cases, which
// is the reimplementation a maintained library exists to prevent.
//
// Non-recursive by contract, which is what fsnotify's Add already is: a lazy tree arms the folders
// it has opened and a large tree costs one watch per opened folder.
type osWatcher struct {
	mu      sync.Mutex
	watcher *fsnotify.Watcher
	report  func(paths ...string)
	closed  bool
}

// NewOSWatcher starts the operating system's watcher.
//
// It answers an error rather than a nil backend: a host that could not start one refuses `watch_dir`
// by name, and a nil handed on silently would accept subscriptions that can never fire.
func NewOSWatcher() (Backend, error) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	backend := &osWatcher{watcher: watcher}
	go backend.pump()
	return backend, nil
}

// Deliver takes the sink once, before any Arm, as the interface states.
func (backend *osWatcher) Deliver(report func(paths ...string)) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	backend.report = report
}

func (backend *osWatcher) Arm(path string) error {
	return backend.watcher.Add(path)
}

func (backend *osWatcher) Disarm(path string) error {
	return backend.watcher.Remove(path)
}

// pump runs on the watcher's own goroutine, which is what the interface expects: Arm and Disarm run
// while the subscription counts are held, and a report from inside them would deadlock.
func (backend *osWatcher) pump() {
	for {
		select {
		case event, open := <-backend.watcher.Events:
			if !open {
				return
			}
			backend.deliver(event.Name)
		case _, open := <-backend.watcher.Errors:
			if !open {
				return
			}
			// A read error on one watch is not the end of the others. The folding rules above see
			// nothing, which is the same as a quiet directory — and a watch that stopped reporting
			// shows up as a tree that does not refresh, which is what `files.watch` reports on.
		}
	}
}

func (backend *osWatcher) deliver(path string) {
	backend.mu.Lock()
	report := backend.report
	backend.mu.Unlock()
	if report != nil {
		report(path)
	}
}
