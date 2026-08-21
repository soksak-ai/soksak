package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// How a gate waits, and what it hands the application as a path.
//
// Both of these were learned by a run failing and neither could be held by reading the code, so
// they are held here.
//
// A gate that waits on a clock passes when the machine is quiet and fails when it is not, and the
// failure names whatever it happened to read rather than the wait. Measured 2026-08-18: the
// arrangement gate read the window every 250ms and called it settled when two readings agreed —
// three runs in six failed, at 17s, 37s and 52s, where the passing runs took 65 to 95. After the
// waits became the window's own events the same eight runs took 54.8 to 56.0 seconds, a spread of
// one second, and none failed.
//
// Polling is what is left when there is no event to wait on, not the way to wait. Where one is
// used, the reason it is used is written beside it, and this counts them so a new one cannot arrive
// unremarked.

// sleepInGate is a wait on the clock. The recorder lead-ins are named constants and stated as
// lead-ins rather than barriers; a bare duration is what this counts.
var sleepInGate = regexp.MustCompile(`time\.Sleep\(`)

// pollInGate is the harness's own polling loop.
var pollInGate = regexp.MustCompile(`\.until\(`)

// relativeDirToTheApplication is a path handed to the application that this run resolved against
// its own directory. The application resolves it against the application's, which is elsewhere.
var relativeDirToTheApplication = regexp.MustCompile(`"(?:dir|path)="\+\s*filepath\.Join\("[a-z]`)

// clockWaits is how many waits on a clock the gates still hold, and pollingWaits how many polling
// loops. Both only go down. Lower them when a wait becomes an event; the failure names the new
// floor.
//
// They are not zero and neither is claimed to be finished. What each remaining one is waiting for
// is written where it is — and where it is a poll, why there is nothing to wait on instead.
//
// The two that remain are the harness starting a process and the polling loop itself. Four others
// went when the region began declaring what it stands: a caller had been working that out from
// which elements had a rectangle, and every one of them polled because an inference has no edge to
// wait on.
const (
	clockWaits   = 2
	pollingWaits = 2
)

func gateSources(t *testing.T) map[string]string {
	t.Helper()
	sources := map[string]string{}
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("reading this directory: %v", err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, "_test.go") {
			continue
		}
		body, readErr := os.ReadFile(name)
		if readErr != nil {
			t.Fatalf("reading %s: %v", name, readErr)
		}
		sources[name] = string(body)
	}
	if len(sources) == 0 {
		t.Fatal("no test source was read; the path is wrong")
	}
	return sources
}

func countAcross(sources map[string]string, pattern *regexp.Regexp) (int, []string) {
	total := 0
	var where []string
	for name, body := range sources {
		for index, line := range strings.Split(body, "\n") {
			if strings.HasPrefix(strings.TrimSpace(line), "//") {
				continue
			}
			if pattern.MatchString(line) {
				total++
				where = append(where, name+":"+itoa(index+1)+" "+strings.TrimSpace(line))
			}
		}
	}
	return total, where
}

func TestAGateWaitsOnTheWindowRatherThanTheClock(t *testing.T) {
	sources := gateSources(t)

	sleeps, atSleep := countAcross(sources, sleepInGate)
	if sleeps > clockWaits {
		t.Errorf("%d waits on a clock, over the floor of %d:\n%s\n"+
			"Wait on what the window announces — a settled layout, a closed transaction, a "+
			"recording that ended. Where nothing announces it, build that first.",
			sleeps, clockWaits, strings.Join(atSleep, "\n"))
	}
	if sleeps < clockWaits {
		t.Errorf("%d waits on a clock, under the floor of %d. Lower clockWaits to %d.",
			sleeps, clockWaits, sleeps)
	}

	polls, atPoll := countAcross(sources, pollInGate)
	if polls > pollingWaits {
		t.Errorf("%d polling loops, over the floor of %d:\n%s\n"+
			"Polling is what is left when there is no event to wait on. Where there is one, wait "+
			"on it; where there is not, the reason goes beside the loop.",
			polls, pollingWaits, strings.Join(atPoll, "\n"))
	}
	if polls < pollingWaits {
		t.Errorf("%d polling loops, under the floor of %d. Lower pollingWaits to %d.",
			polls, pollingWaits, polls)
	}
}

func TestAPathHandedToTheApplicationIsAbsolute(t *testing.T) {
	// The application resolves a relative path against its own working directory, which is not this
	// one. Measured 2026-08-17: nine recordings answered OK and left no frame anywhere the run
	// could find, because the gate had named `evidence/...` and the application had written it
	// somewhere else. A missing frame and a frame in the wrong place read the same from here.
	found, where := countAcross(gateSources(t), relativeDirToTheApplication)
	if found > 0 {
		t.Errorf("%d paths handed to the application are this run's own, not absolute:\n%s\n"+
			"Join them onto os.Getwd() — the application resolves what it is given against its own "+
			"directory.", found, strings.Join(where, "\n"))
	}
}

func TestNoSymbolicLinkStandsInForAPath(t *testing.T) {
	// A link makes one path answer as another, and every reading after it describes a place the
	// reader did not name. A path is declared, or it is discovered; it is never redirected.
	var links []string
	err := filepath.Walk(".", func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() && skippedTrees[info.Name()] {
			return filepath.SkipDir
		}
		if info.Mode()&os.ModeSymlink != 0 {
			links = append(links, path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking the tree: %v", err)
	}
	if len(links) > 0 {
		t.Errorf("these paths are links:\n%s\nDeclare the path, or discover it. A link answers for "+
			"somewhere the reader did not name.", strings.Join(links, "\n"))
	}
}
