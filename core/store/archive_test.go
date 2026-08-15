package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func alwaysDead(int) bool  { return false }
func alwaysAlive(int) bool { return true }

// A backup is built beside the destination and moved onto it, so the
// destination never holds a half-written store: a process killed mid-build
// leaves its work file, never a truncated backup.
func TestABackupIsBuiltBesideItsDestinationAndMovedOn(t *testing.T) {
	kv := seeded(t)
	destination := filepath.Join(t.TempDir(), "backups", "soksak-1.db")
	result, err := kv.Backup(destination, 4242)
	if err != nil {
		t.Fatalf("backing up: %v", err)
	}
	if result.Path != destination {
		t.Errorf("path = %q, want the resolved destination", result.Path)
	}
	if _, err := os.Stat(destination); err != nil {
		t.Fatalf("the backup is not there: %v", err)
	}
	leftovers, err := os.ReadDir(filepath.Dir(destination))
	if err != nil {
		t.Fatalf("reading the destination directory: %v", err)
	}
	if len(leftovers) != 1 {
		t.Errorf("the work file was left behind: %v", leftovers)
	}
	// What was written is a store, not a copy of the file's bytes mid-write.
	restored, err := OpenKV(destination)
	if err != nil {
		t.Fatalf("opening the backup: %v", err)
	}
	t.Cleanup(func() { _ = restored.Close() })
	if _, found, _ := restored.GetDocument("mailbox", "messages", "x1", nil); !found {
		t.Error("the backup does not hold the record")
	}
}

// A destination that already holds something is refused by name. Overwriting it
// would destroy an earlier snapshot, or a file that was never a snapshot.
func TestABackupRefusesToOverwrite(t *testing.T) {
	kv := seeded(t)
	destination := filepath.Join(t.TempDir(), "soksak-1.db")
	if err := os.WriteFile(destination, []byte("mine"), 0o644); err != nil {
		t.Fatalf("preparing: %v", err)
	}
	if _, err := kv.Backup(destination, 4242); err == nil {
		t.Fatal("a backup overwrote what was already there")
	}
	contents, err := os.ReadFile(destination)
	if err != nil || string(contents) != "mine" {
		t.Errorf("the destination changed to %q (%v)", contents, err)
	}
}

// Reclaim removes the work files whose owner is gone, and nothing else. One
// backup builds a file the size of the store; measured on an earlier build
// (2026-08-08), a dozen of them had accumulated to around 500MB.
func TestReclaimTakesOnlyTheAbandonedWorkFiles(t *testing.T) {
	directory := t.TempDir()
	dead := filepath.Join(directory, "soksak-1.db.tmp.4242.0")
	unrelated := filepath.Join(directory, "notes.txt")
	partial := filepath.Join(directory, "soksak-1.db.tmp.notapid.0")
	for _, path := range []string{dead, unrelated, partial} {
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatalf("preparing: %v", err)
		}
	}
	reclaimed, err := reclaimScratch([]string{directory}, alwaysDead)
	if err != nil {
		t.Fatalf("reclaiming: %v", err)
	}
	if reclaimed != 1 {
		t.Errorf("reclaimed = %d, want 1", reclaimed)
	}
	for _, path := range []string{unrelated, partial} {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("%s was taken: %v", filepath.Base(path), err)
		}
	}
	if _, err := os.Stat(dead); !os.IsNotExist(err) {
		t.Error("the abandoned work file survived")
	}
}

// An owner that cannot be asked about counts as alive. Reading "I cannot tell"
// as "dead" deletes the file somebody else is building.
func TestReclaimLeavesAWorkFileWhoseOwnerMightBeAlive(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "soksak-1.db.tmp.4242.0")
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatalf("preparing: %v", err)
	}
	reclaimed, err := reclaimScratch([]string{directory}, alwaysAlive)
	if err != nil {
		t.Fatalf("reclaiming: %v", err)
	}
	if reclaimed != 0 {
		t.Errorf("reclaimed = %d, want 0", reclaimed)
	}
	if _, err := os.Stat(path); err != nil {
		t.Error("a live owner's work file was taken")
	}
}

// A directory that does not exist has nothing to reclaim, which is an answer
// rather than a failure.
func TestReclaimingAMissingDirectoryIsNotAFailure(t *testing.T) {
	reclaimed, err := reclaimScratch([]string{filepath.Join(t.TempDir(), "absent")}, alwaysDead)
	if err != nil {
		t.Fatalf("reclaiming: %v", err)
	}
	if reclaimed != 0 {
		t.Errorf("reclaimed = %d", reclaimed)
	}
}

// Restore validates the candidate, keeps the current store beside it, swaps,
// and reopens — one hand, because a process that swaps only the file goes on
// looking at what is no longer there through its old connection.
func TestRestoreSwapsTheFileAndReopensOntoIt(t *testing.T) {
	kv := seeded(t)
	candidate := filepath.Join(t.TempDir(), "snapshot.db")
	if _, err := kv.Backup(candidate, 4242); err != nil {
		t.Fatalf("backing up: %v", err)
	}
	// Move the live store on past the snapshot.
	if _, err := kv.Put("mailbox", "messages", "p", "x2", document(t, `{"read":false,"title":"after"}`), 200); err != nil {
		t.Fatalf("putting: %v", err)
	}
	if err := kv.Restore(candidate, 777); err != nil {
		t.Fatalf("restoring: %v", err)
	}
	if _, found, _ := kv.GetDocument("mailbox", "messages", "x2", nil); found {
		t.Error("the store still answers from what the snapshot did not hold")
	}
	if _, found, _ := kv.GetDocument("mailbox", "messages", "x1", nil); !found {
		t.Error("the store does not answer from the restored content")
	}
	kept := kv.Path() + ".bak-777.db"
	if _, err := os.Stat(kept); err != nil {
		t.Errorf("the pre-restore store was not kept at %s: %v", kept, err)
	}
	previous, err := OpenKV(kept)
	if err != nil {
		t.Fatalf("opening what was kept: %v", err)
	}
	t.Cleanup(func() { _ = previous.Close() })
	if _, found, _ := previous.GetDocument("mailbox", "messages", "x2", nil); !found {
		t.Error("what was kept is not the pre-restore content")
	}
}

// The sidecars are taken, and that is asserted where it can be seen.
//
// Watching the path after a restore proves nothing: the reopen creates a fresh
// write-ahead log at the same name, so the file is there and the old contents
// are gone whether the removal ran or not. The removal itself is what is
// checked here.
func TestTheSidecarsAreTaken(t *testing.T) {
	base := filepath.Join(t.TempDir(), "soksak.db")
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.WriteFile(base+suffix, []byte("STALE"), 0o600); err != nil {
			t.Fatalf("planting: %v", err)
		}
	}
	if err := removeSidecars(base); err != nil {
		t.Fatalf("removing: %v", err)
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if _, err := os.Stat(base + suffix); err == nil {
			t.Errorf("%s survived", base+suffix)
		}
	}
	// Nothing to remove is not a failure: a store closed cleanly has no log.
	if err := removeSidecars(base); err != nil {
		t.Errorf("removing what is not there: %v", err)
	}
	// A removal that cannot be done is named rather than passed over: what
	// stays is a log describing rows the swapped-in file does not have.
	blocked := filepath.Join(t.TempDir(), "blocked.db")
	if err := os.MkdirAll(blocked+"-wal", 0o755); err != nil {
		t.Fatalf("planting: %v", err)
	}
	if err := os.WriteFile(filepath.Join(blocked+"-wal", "occupant"), []byte("x"), 0o600); err != nil {
		t.Fatalf("planting: %v", err)
	}
	if err := removeSidecars(blocked); err == nil {
		t.Error("a sidecar that could not be removed was passed over in silence")
	}
}

// A candidate that is not this schema is refused, and the live store is
// untouched.
func TestRestoreRefusesAFileThatIsNotThisStore(t *testing.T) {
	kv := seeded(t)
	stranger := filepath.Join(t.TempDir(), "stranger.db")
	other, err := OpenKV(stranger)
	if err != nil {
		t.Fatalf("preparing: %v", err)
	}
	if _, err := other.db.Exec(`DROP TABLE records`); err != nil {
		t.Fatalf("preparing: %v", err)
	}
	if err := other.Close(); err != nil {
		t.Fatalf("preparing: %v", err)
	}
	err = kv.Restore(stranger, 777)
	if err == nil {
		t.Fatal("a file missing records was restored")
	}
	if !strings.Contains(err.Error(), "records") {
		t.Errorf("error = %v, want one naming what is missing", err)
	}
	if _, found, _ := kv.GetDocument("mailbox", "messages", "x1", nil); !found {
		t.Error("the live store was disturbed by a refused restore")
	}
}

func TestRestoreRefusesAFileThatIsNotThere(t *testing.T) {
	kv := seeded(t)
	if err := kv.Restore(filepath.Join(t.TempDir(), "absent.db"), 777); err == nil {
		t.Fatal("a missing candidate was restored")
	}
	if _, found, _ := kv.GetDocument("mailbox", "messages", "x1", nil); !found {
		t.Error("the live store was disturbed by a refused restore")
	}
}

func TestRestoreRefusesAFileThatIsNotAStore(t *testing.T) {
	kv := seeded(t)
	rubbish := filepath.Join(t.TempDir(), "rubbish.db")
	if err := os.WriteFile(rubbish, []byte("not a database at all"), 0o644); err != nil {
		t.Fatalf("preparing: %v", err)
	}
	if err := kv.Restore(rubbish, 777); err == nil {
		t.Fatal("a file that is not a database was restored")
	}
	if _, found, _ := kv.GetDocument("mailbox", "messages", "x1", nil); !found {
		t.Error("the live store was disturbed by a refused restore")
	}
}

// A candidate that opens, holds every table, and still fails its integrity
// check is refused. Restoring it would replace a store that works with one that
// does not, and the failure would arrive later, on a read — by which time the
// store it replaced is the thing being looked for.
func TestRestoreRefusesACandidateThatFailsItsIntegrityCheck(t *testing.T) {
	kv := seeded(t)
	candidate := filepath.Join(t.TempDir(), "snapshot.db")
	if _, err := kv.Backup(candidate, 4242); err != nil {
		t.Fatalf("backing up: %v", err)
	}
	damaged, err := OpenKV(candidate)
	if err != nil {
		t.Fatalf("opening the candidate: %v", err)
	}
	desyncOneIndex(t, damaged)
	if err := damaged.Close(); err != nil {
		t.Fatalf("closing the candidate: %v", err)
	}

	err = kv.Restore(candidate, 777)
	if err == nil {
		t.Fatal("a candidate that fails its integrity check was restored")
	}
	if !strings.Contains(err.Error(), "integrity") {
		t.Errorf("error = %v, want it to name the check that refused", err)
	}
	if _, found, _ := kv.GetDocument("mailbox", "messages", "x1", nil); !found {
		t.Error("the live store was disturbed by a refused restore")
	}
}
