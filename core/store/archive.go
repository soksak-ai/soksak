package store

import (
	"database/sql"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/soksak/soksak-core/core/i18n"
)

// Snapshots: making one, going back to one, and clearing up after one that died
// halfway.

// BackupResult returns the resolved destination.
//
// The path is resolved once and returned rather than recomputed by whoever
// asked: a default computed on both sides is two processes writing different
// files and each believing it wrote the one.
type BackupResult struct {
	Path string `json:"path"`
}

// ReclaimResult is how many abandoned work files were taken.
type ReclaimResult struct {
	Reclaimed int `json:"reclaimed"`
}

// scratchSequence separates two snapshots taken by one process. The pid
// separates processes; without the sequence, two rotations inside one process
// would tread on each other's work file.
var scratchSequence atomic.Uint64

const scratchMarker = ".tmp."

func scratchPath(destination string, pid int) string {
	return fmt.Sprintf("%s%s%d.%d", destination, scratchMarker, pid, scratchSequence.Add(1)-1)
}

// Backup writes a consistent single-file snapshot to destination.
//
// It is built beside the destination and moved onto it, so the destination
// never holds a half-written store: a process killed mid-build leaves its work
// file, which data_reclaim takes, and never a truncated backup that looks like
// a good one.
//
// The work file's name includes this process's pid, because a fixed name means
// two writers tread on each other: one cleans up what it reads as crash debris
// and it is the other's live file.
//
// A destination that already holds something is refused rather than
// overwritten. Between that check and the move, another writer aiming at the
// same path would still win — inside one process that cannot happen, and across
// processes the destination is what the caller chose.
func (kv *KV) Backup(destination string, pid int) (BackupResult, error) {
	if destination == "" {
		return BackupResult{}, i18n.Errorf("store.backup.noDestination", nil)
	}
	if _, err := os.Stat(destination); err == nil {
		return BackupResult{}, i18n.Errorf("store.backup.destinationOccupied", map[string]string{"path": destination})
	} else if !errors.Is(err, fs.ErrNotExist) {
		return BackupResult{}, fmt.Errorf("store: looking at %s: %w", destination, err)
	}
	directory := filepath.Dir(destination)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return BackupResult{}, fmt.Errorf("store: could not create %s: %w", directory, err)
	}

	scratch := scratchPath(destination, pid)
	// VACUUM INTO refuses a file that exists, and a restart can hand out the
	// same pid and sequence again.
	_ = os.Remove(scratch)
	err := kv.read(func(db *sql.DB) error {
		// VACUUM INTO writes one consistent file, absorbing the write-ahead log
		// rather than leaving a sidecar the copy would not carry.
		_, err := db.Exec("VACUUM INTO '" + strings.ReplaceAll(scratch, "'", "''") + "'")
		return err
	})
	if err != nil {
		_ = os.Remove(scratch)
		return BackupResult{}, fmt.Errorf("store: building the backup at %s: %w", scratch, err)
	}
	if err := os.Rename(scratch, destination); err != nil {
		_ = os.Remove(scratch)
		return BackupResult{}, fmt.Errorf("store: moving the backup onto %s: %w", destination, err)
	}
	return BackupResult{Path: destination}, nil
}

// scratchOwner reads the pid a work file's name declares. A name shaped
// otherwise was not made by this rule and is not this rule's to remove.
func scratchOwner(name string) (int, bool) {
	marker := strings.LastIndex(name, scratchMarker)
	if marker <= 0 {
		return 0, false
	}
	tail := strings.Split(name[marker+len(scratchMarker):], ".")
	if len(tail) != 2 {
		return 0, false
	}
	owner, err := strconv.Atoi(tail[0])
	if err != nil {
		return 0, false
	}
	if _, err := strconv.Atoi(tail[1]); err != nil {
		return 0, false
	}
	return owner, true
}

// reclaimScratch removes the work files whose owner is gone.
//
// One backup builds a file the size of the store, and if it dies mid-build that
// size stays. Measured (2026-08-08): a dozen of them, around
// 500MB, in a user's data folder.
//
// An owner that cannot be asked about counts as alive. Reading "I cannot tell"
// as "dead" deletes the file somebody else is building. That judgement is the
// caller's: asking whether a pid is alive is a different question on every
// platform, and this package does not branch on which one it is running on.
//
// A directory that is not there has nothing to reclaim; a directory that cannot
// be read is a failure, because "nothing to clear up" and "could not look" are
// different answers.
func reclaimScratch(directories []string, alive func(pid int) bool) (int, error) {
	seen := make(map[string]struct{}, len(directories))
	reclaimed := 0
	for _, directory := range directories {
		if directory == "" {
			continue
		}
		if _, already := seen[directory]; already {
			continue
		}
		seen[directory] = struct{}{}

		items, err := os.ReadDir(directory)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return reclaimed, fmt.Errorf("store: reading %s: %w", directory, err)
		}
		for _, item := range items {
			if item.IsDir() {
				continue
			}
			owner, ours := scratchOwner(item.Name())
			if !ours || alive(owner) {
				continue
			}
			if err := os.Remove(filepath.Join(directory, item.Name())); err != nil {
				return reclaimed, fmt.Errorf("store: removing %s: %w", item.Name(), err)
			}
			reclaimed++
		}
	}
	return reclaimed, nil
}

// Restore replaces this store's file with a candidate and reopens onto it.
//
// The swap can only be done by the process holding the connection: dropping the
// lock, swapping, and reopening must be one hand. A process that swaps only the
// file leaves the owner looking at what is no longer there through its old
// connection.
//
// The candidate is validated first, and the current store is kept beside the
// new one — going back is itself a write, and a restore that turns out to be
// the wrong one must not be the end of the road.
func (kv *KV) Restore(candidate string, nowMillis int64) error {
	if err := validateCandidate(candidate); err != nil {
		return err
	}
	kv.mu.Lock()
	defer kv.mu.Unlock()
	if kv.db == nil {
		return i18n.Errorf("store.restore.storeClosed", map[string]string{"path": kv.path})
	}
	if err := kv.db.Close(); err != nil {
		return fmt.Errorf("store: could not release %s: %w", kv.path, err)
	}
	kv.db = nil

	kept := fmt.Sprintf("%s.bak-%d.db", kv.path, nowMillis)
	if _, err := os.Stat(kv.path); err == nil {
		if err := copyFile(kv.path, kept); err != nil {
			return fmt.Errorf("store: keeping the current store at %s: %w", kept, err)
		}
	}
	if err := copyFile(candidate, kv.path); err != nil {
		// The handle stays closed and the file is whatever the failed copy
		// left. Reopening it would present an unknown state as a working
		// store, so the answer names where the previous one was kept instead.
		return fmt.Errorf(
			"store: putting %s in place failed and %s is now in an unknown state; the store as it was is at %s: %w",
			candidate, kv.path, kept, err)
	}
	if err := removeSidecars(kv.path); err != nil {
		return err
	}
	db, err := openDatabase(kv.path)
	if err != nil {
		return err
	}
	kv.db = db
	return nil
}

// removeSidecars takes the write-ahead log and its shared-memory file.
//
// They belong to content that is gone; left beside a swapped-in file they
// describe rows it does not have, and SQLite replays them onto it.
//
// It is its own function because the rule is otherwise unobservable: the reopen
// right after it creates a fresh log at the same path, so a test looking at the
// path afterwards sees a file either way and passes whether the removal ran or
// not. This is the seam that lets it be asserted.
func removeSidecars(path string) error {
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.Remove(path + suffix); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("store: removing %s: %w", path+suffix, err)
		}
	}
	return nil
}

// validateCandidate refuses anything that is not a healthy store of this shape.
// Restoring an unchecked file replaces a store that works with one that may
// not, and the failure arrives later, on a read.
func validateCandidate(candidate string) error {
	info, err := os.Stat(candidate)
	if err != nil {
		return fmt.Errorf("store: the backup at %s cannot be read: %w", candidate, err)
	}
	if info.IsDir() {
		return i18n.Errorf("store.restore.candidateIsDirectory", map[string]string{"path": candidate})
	}
	// Read-only, and its own handle: this must not disturb the store being
	// replaced, and it must not create anything at the candidate's path.
	db, err := sql.Open("sqlite", candidate+"?_pragma=query_only(true)")
	if err != nil {
		return fmt.Errorf("store: could not open %s: %w", candidate, err)
	}
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(1)

	var verdict string
	if err := db.QueryRow("PRAGMA integrity_check").Scan(&verdict); err != nil {
		return fmt.Errorf("store: %s is not a readable database: %w", candidate, err)
	}
	if verdict != "ok" {
		return i18n.Errorf("store.restore.integrityFailed", map[string]string{"path": candidate, "verdict": verdict})
	}
	for _, table := range []string{"records", "kv", "meta_collections"} {
		var count int
		err := db.QueryRow(
			`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&count)
		if err != nil {
			return fmt.Errorf("store: reading the shape of %s: %w", candidate, err)
		}
		if count == 0 {
			return i18n.Errorf("store.restore.shapeMismatch", map[string]string{"path": candidate, "table": table})
		}
	}
	return nil
}

// copyFile streams rather than reading the whole file: a store is as large as
// the data in it, and this runs on the machine that already holds that data.
//
// The mode is private to the user. A store file holds whatever every plugin
// kept, and the same machine's other users have no business reading it.
func copyFile(from, to string) error {
	source, err := os.Open(from)
	if err != nil {
		return err
	}
	defer func() { _ = source.Close() }()
	destination, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(destination, source); err != nil {
		_ = destination.Close()
		return err
	}
	return destination.Close()
}
