package store

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// A reader never sees a partial value.
//
// The gate SESSION.md S10 states as "a partial record is never read". It is measured rather than
// argued because the failing shape is invisible in the source: a plain write into the target file
// is one call, and only a reader arriving inside it can tell that the call is not one step.
//
// The value is large enough that a write of it is several page-sized steps. A small value can land
// in one and would pass this gate against a store that does not hold the property.
func TestAReaderNeverSeesAPartialValue(t *testing.T) {
	base := t.TempDir()
	const id = "a-plugin"
	const key = "record"

	values := []string{
		strings.Repeat("a", 1<<20),
		strings.Repeat("b", 1<<20),
		strings.Repeat("c", 1<<20),
	}
	whole := map[string]bool{}
	for _, value := range values {
		whole[value] = true
	}
	if err := writePluginData(base, id, key, values[0]); err != nil {
		t.Fatalf("seeding: %v", err)
	}

	var writers, readers sync.WaitGroup
	stop := make(chan struct{})
	spliced := make(chan string, 1)

	for round := 0; round < 40; round++ {
		writers.Add(1)
		go func(round int) {
			defer writers.Done()
			if err := writePluginData(base, id, key, values[round%len(values)]); err != nil {
				select {
				case spliced <- fmt.Sprintf("write: %v", err):
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
				value, held, err := readPluginData(base, id, key)
				if err != nil || !held {
					continue
				}
				if whole[value] {
					continue
				}
				select {
				case spliced <- fmt.Sprintf("read %d bytes that are no written value", len(value)):
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
	case what := <-spliced:
		t.Fatalf("a reader saw a value no writer wrote: %s", what)
	default:
	}
}

// A write in progress is not a key.
//
// The staged neighbour sits in the same directory as the value it will become, because rename is
// atomic only within one filesystem. It must not answer as a key of its own: a caller listing what
// it stored would find a name it never wrote and cannot read.
func TestAStagedWriteIsNotListedAsAKey(t *testing.T) {
	base := t.TempDir()
	const id = "a-plugin"

	if err := writePluginData(base, id, "kept", "value"); err != nil {
		t.Fatalf("writing: %v", err)
	}
	stray := filepath.Join(base, id, "kept.json.999.next")
	if err := os.WriteFile(stray, []byte("half"), 0o644); err != nil {
		t.Fatalf("staging: %v", err)
	}

	keys, err := listPluginData(base, id)
	if err != nil {
		t.Fatalf("listing: %v", err)
	}
	if len(keys) != 1 || keys[0] != "kept" {
		t.Fatalf("listed %v, want [kept]", keys)
	}

	value, held, err := readPluginData(base, id, "kept")
	if err != nil || !held || value != "value" {
		t.Fatalf("read %q held=%v err=%v, want the whole value", value, held, err)
	}
}

// A finished write leaves nothing behind.
func TestAFinishedWriteLeavesNoStagedFile(t *testing.T) {
	base := t.TempDir()
	const id = "a-plugin"

	if err := writePluginData(base, id, "record", "value"); err != nil {
		t.Fatalf("writing: %v", err)
	}
	items, err := os.ReadDir(filepath.Join(base, id))
	if err != nil {
		t.Fatalf("reading the directory: %v", err)
	}
	for _, item := range items {
		if strings.HasSuffix(item.Name(), ".next") {
			t.Fatalf("a staged file outlived its write: %s", item.Name())
		}
	}
}
