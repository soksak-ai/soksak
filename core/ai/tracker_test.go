package ai

import (
	"os"
	"path/filepath"
	"testing"
)

// TestTheFirstLookNamesWhateverIsThere. Arming happens while the agent is
// already starting, and the transcript it is writing is the newest one present.
func TestTheFirstLookNamesWhateverIsThere(t *testing.T) {
	directory := t.TempDir()
	writeTranscript(t, directory, sessionIDs[0]+".jsonl", "", at(1))
	writeTranscript(t, directory, sessionIDs[1]+".jsonl", "", at(5))

	active, changed, err := NewTracker().Active(directory)
	if err != nil {
		t.Fatalf("Active: %v", err)
	}
	if !changed || active != sessionIDs[1] {
		t.Fatalf("Active = %q,%v; want %q,true", active, changed, sessionIDs[1])
	}
}

// TestNothingWrittenIsNotASession. The watcher fires for every change in the
// directory, and most of them are not a transition. Answering the same session
// again would be harmless; answering *some* session when nothing was written is
// the failure this whole rule exists to prevent.
func TestNothingWrittenIsNotASession(t *testing.T) {
	directory := t.TempDir()
	writeTranscript(t, directory, sessionIDs[0]+".jsonl", "", at(1))

	tracker := NewTracker()
	if _, changed, err := tracker.Active(directory); err != nil || !changed {
		t.Fatalf("the first look answered %v, %v", changed, err)
	}

	active, changed, err := tracker.Active(directory)
	if err != nil {
		t.Fatalf("Active: %v", err)
	}
	if changed {
		t.Fatalf("a second look at an unchanged directory named %q", active)
	}
}

// TestATranscriptThatGrewIsTheActiveOne. An agent that resumes an older session
// writes to its existing file, so growth — not creation — is what marks it.
func TestATranscriptThatGrewIsTheActiveOne(t *testing.T) {
	directory := t.TempDir()
	writeTranscript(t, directory, sessionIDs[0]+".jsonl", "", at(1))
	writeTranscript(t, directory, sessionIDs[1]+".jsonl", "", at(5))

	tracker := NewTracker()
	if _, _, err := tracker.Active(directory); err != nil {
		t.Fatalf("Active: %v", err)
	}

	// The older one is written to. It is still not the newest file in the
	// directory by name or by creation, and it is the session being used.
	writeTranscript(t, directory, sessionIDs[0]+".jsonl", "more", at(9))

	active, changed, err := tracker.Active(directory)
	if err != nil {
		t.Fatalf("Active: %v", err)
	}
	if !changed || active != sessionIDs[0] {
		t.Fatalf("Active = %q,%v; want %q,true", active, changed, sessionIDs[0])
	}
}

// TestANewTranscriptIsTheActiveOne — /clear starts a new file, which is the
// transition the frontend records as a fork.
func TestANewTranscriptIsTheActiveOne(t *testing.T) {
	directory := t.TempDir()
	writeTranscript(t, directory, sessionIDs[0]+".jsonl", "", at(1))

	tracker := NewTracker()
	if _, _, err := tracker.Active(directory); err != nil {
		t.Fatalf("Active: %v", err)
	}

	writeTranscript(t, directory, sessionIDs[1]+".jsonl", "", at(2))

	active, changed, err := tracker.Active(directory)
	if err != nil {
		t.Fatalf("Active: %v", err)
	}
	if !changed || active != sessionIDs[1] {
		t.Fatalf("Active = %q,%v; want %q,true", active, changed, sessionIDs[1])
	}
}

// TestDeletingTheCurrentTranscriptDoesNotResurrectAnOldSession is the case that
// separates this rule from "the newest file in the directory".
//
// Remove what the agent was writing and an untouched older transcript becomes
// the newest file. Naming it would tell the frontend the session moved to one
// nobody opened, and that fabricated transition is what gets stored as lineage.
func TestDeletingTheCurrentTranscriptDoesNotResurrectAnOldSession(t *testing.T) {
	directory := t.TempDir()
	writeTranscript(t, directory, sessionIDs[0]+".jsonl", "", at(1))
	current := writeTranscript(t, directory, sessionIDs[1]+".jsonl", "", at(5))

	tracker := NewTracker()
	if _, _, err := tracker.Active(directory); err != nil {
		t.Fatalf("Active: %v", err)
	}
	if err := os.Remove(current); err != nil {
		t.Fatalf("removing the current transcript: %v", err)
	}

	active, changed, err := tracker.Active(directory)
	if err != nil {
		t.Fatalf("Active: %v", err)
	}
	if changed {
		t.Fatalf("a deletion named %q as the active session", active)
	}
}

// TestTwoTranscriptsWrittenInTheSameInstantAnswerTheSameWayTwice. Go randomises
// map iteration, so a tie broken by iteration order answers a different session
// on every call — and the frontend reads every difference as a transition.
func TestTwoTranscriptsWrittenInTheSameInstantAnswerTheSameWayTwice(t *testing.T) {
	directory := t.TempDir()
	writeTranscript(t, directory, sessionIDs[0]+".jsonl", "", at(4))
	writeTranscript(t, directory, sessionIDs[1]+".jsonl", "", at(4))
	writeTranscript(t, directory, sessionIDs[2]+".jsonl", "", at(4))

	first := ""
	for attempt := 0; attempt < 20; attempt++ {
		active, changed, err := NewTracker().Active(directory)
		if err != nil || !changed {
			t.Fatalf("Active answered %q,%v,%v", active, changed, err)
		}
		if attempt == 0 {
			first = active
			continue
		}
		if active != first {
			t.Fatalf("the same directory answered %q and then %q", first, active)
		}
	}
}

// TestADirectoryTheAgentHasNotCreatedIsNotAFailure. Arming happens the moment
// the command starts, which is before the agent has made its session folder.
func TestADirectoryTheAgentHasNotCreatedIsNotAFailure(t *testing.T) {
	active, changed, err := NewTracker().Active(filepath.Join(t.TempDir(), "not-yet"))
	if err != nil {
		t.Fatalf("Active: %v", err)
	}
	if changed {
		t.Fatalf("a directory that does not exist named %q", active)
	}
}

// TestADirectoryThatCannotBeReadIsAFailure. Absence is an answer; anything else
// is not, and a watcher that silently observes nothing looks like an agent that
// never ran.
func TestADirectoryThatCannotBeReadIsAFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a-file")
	if err := os.WriteFile(path, []byte("not a directory"), 0o600); err != nil {
		t.Fatalf("writing the file: %v", err)
	}
	if _, _, err := NewTracker().Active(path); err == nil {
		t.Fatal("a path that is not a directory was observed as an empty one")
	}
}

// TestTheTrackerRefusesARelativeDirectory. The directory is completed from
// wherever this process stands, so the same call watches a different tree in
// the application and in a headless one.
func TestTheTrackerRefusesARelativeDirectory(t *testing.T) {
	if _, _, err := NewTracker().Active("sessions"); err == nil {
		t.Fatal("a relative directory was observed")
	}
	if _, _, err := NewTracker().Active(""); err == nil {
		t.Fatal("an empty directory was observed")
	}
}

// TestTwoDirectoriesKeepSeparateMemories. One process watches every terminal's
// session folder; a shared snapshot would make one project's write look like a
// transition in another.
func TestTwoDirectoriesKeepSeparateMemories(t *testing.T) {
	first, second := t.TempDir(), t.TempDir()
	writeTranscript(t, first, sessionIDs[0]+".jsonl", "", at(1))
	writeTranscript(t, second, sessionIDs[1]+".jsonl", "", at(1))

	tracker := NewTracker()
	if active, changed, err := tracker.Active(first); err != nil || !changed || active != sessionIDs[0] {
		t.Fatalf("the first directory answered %q,%v,%v", active, changed, err)
	}
	if active, changed, err := tracker.Active(second); err != nil || !changed || active != sessionIDs[1] {
		t.Fatalf("the second directory answered %q,%v,%v", active, changed, err)
	}
	if active, changed, err := tracker.Active(first); err != nil || changed {
		t.Fatalf("the first directory changed after the second was read: %q,%v,%v", active, changed, err)
	}
}
