package files

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The operating system's watcher reports a real change.
//
// Every rule above the backend — the refcount, the parent fold, the burst fold — is checked against
// a fake, which is what makes them checkable at all. None of that shows the kernel being read.
// `watch_dir` was refused by name in this binary until 2026-08-17 and the file tree's live refresh
// was dead, so the part that had no test is exactly the part that was missing.
func TestTheWatcherReportsAWrite(t *testing.T) {
	backend, err := NewOSWatcher()
	if err != nil {
		t.Skipf("this host has no filesystem watcher: %v", err)
	}

	reported := make(chan string, 8)
	backend.Deliver(func(paths ...string) {
		for _, path := range paths {
			reported <- path
		}
	})

	dir := t.TempDir()
	if err := backend.Arm(dir); err != nil {
		t.Fatalf("arming %s: %v", dir, err)
	}

	written := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(written, []byte("x"), 0o644); err != nil {
		t.Fatalf("writing the file the watcher is meant to report: %v", err)
	}

	select {
	case path := <-reported:
		if filepath.Dir(path) != filepath.Dir(written) {
			t.Errorf("the watcher reported %s, and the write was in %s", path, filepath.Dir(written))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a file was written in an armed directory and the watcher reported nothing")
	}

	// Disarmed means quiet. A watch that keeps reporting after it is dropped costs every consumer
	// that shares the path, which is what the refcount above exists to keep exact.
	if err := backend.Disarm(dir); err != nil {
		t.Fatalf("disarming %s: %v", dir, err)
	}
	for len(reported) > 0 {
		<-reported
	}
	if err := os.WriteFile(filepath.Join(dir, "b.txt"), []byte("y"), 0o644); err != nil {
		t.Fatalf("writing after the disarm: %v", err)
	}
	select {
	case path := <-reported:
		t.Errorf("the directory was disarmed and the watcher still reported %s", path)
	case <-time.After(500 * time.Millisecond):
	}
}
