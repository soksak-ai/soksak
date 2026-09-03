package atomicfile

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// A reader never sees a partial file.
//
// The property is invisible in the source — a write into the target is one call — so it is measured
// with a reader running against the write. The body is large enough that writing it is several
// steps; a small one can land in one and would pass against a store that does not hold the
// property at all.
func TestAReaderSeesOneWholeVersionOrTheOther(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "record.json")

	bodies := [][]byte{
		[]byte(strings.Repeat("a", 1<<20)),
		[]byte(strings.Repeat("b", 1<<20)),
		[]byte(strings.Repeat("c", 1<<20)),
	}
	whole := map[string]bool{}
	for _, body := range bodies {
		whole[string(body)] = true
	}
	if err := Publish(path, bodies[0], 0o644); err != nil {
		t.Fatalf("seeding: %v", err)
	}

	var writers, readers sync.WaitGroup
	stop := make(chan struct{})
	torn := make(chan string, 1)

	for round := 0; round < 40; round++ {
		writers.Add(1)
		go func(round int) {
			defer writers.Done()
			if err := Publish(path, bodies[round%len(bodies)], 0o644); err != nil {
				select {
				case torn <- err.Error():
				default:
				}
			}
		}(round)
	}
	for reader := 0; reader < 8; reader++ {
		readers.Add(1)
		go func() {
			defer readers.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				body, err := os.ReadFile(path)
				if err != nil || whole[string(body)] {
					continue
				}
				select {
				case torn <- "read a version no writer wrote":
				default:
				}
				return
			}
		}()
	}
	writers.Wait()
	close(stop)
	readers.Wait()

	select {
	case what := <-torn:
		t.Fatalf("%s", what)
	default:
	}
}

// The published file has the mode asked for, and nothing is left beside it.
func TestAPublishedFileHasItsModeAndNoLeftovers(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "record.json")

	if err := Publish(path, []byte("value"), 0o600); err != nil {
		t.Fatalf("publishing: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("reading it back: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode is %v, want 0600", info.Mode().Perm())
	}
	items, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("reading the directory: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("the directory holds %d files, want only the published one", len(items))
	}
}

// A publish into a directory that does not exist fails rather than making it.
//
// Creating it is the caller's decision: a caller writing somewhere it did not expect to be missing
// wants to hear about it, and one that means to make the path does that first.
func TestAPublishDoesNotMakeTheDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "absent", "record.json")
	if err := Publish(path, []byte("value"), 0o644); err == nil {
		t.Fatal("publishing into a directory that does not exist is an error")
	}
	if _, err := os.Stat(filepath.Dir(path)); err == nil {
		t.Fatal("the directory was created")
	}
}

// A link is published through, not over.
//
// Rename replaces what it lands on, so a publish onto the link itself would leave a regular file
// where the person put a link. A file symlinked into place is a thing people do on purpose, and
// saving it is not a request to undo that.
func TestPublishingThroughALinkKeepsTheLink(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "real.txt")
	link := filepath.Join(directory, "link.txt")
	if err := os.WriteFile(target, []byte("before"), 0o644); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("preparing the fixture: %v", err)
	}

	if err := Publish(link, []byte("after"), 0o644); err != nil {
		t.Fatalf("publishing through the link: %v", err)
	}

	body, err := os.ReadFile(target)
	if err != nil || string(body) != "after" {
		t.Fatalf("the target holds %q err=%v, want the published body", body, err)
	}
	info, err := os.Lstat(link)
	if err != nil {
		t.Fatalf("stat of the link: %v", err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("the publish replaced the link with a regular file")
	}
}
