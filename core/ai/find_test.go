package ai

import (
	"os"
	"path/filepath"
	"testing"
)

// TestTheNewestTranscriptAnswersForTheDirectory. The terminal asks once, when a
// command ends, and the transcript the agent wrote last is the one that command
// produced.
func TestTheNewestTranscriptAnswersForTheDirectory(t *testing.T) {
	home := t.TempDir()
	const cwd = "<machine-path>/proj"
	directory, err := Directory(home, cwd)
	if err != nil {
		t.Fatalf("Directory: %v", err)
	}
	writeTranscript(t, directory, sessionIDs[0]+".jsonl", claudeBody(sessionIDs[0], cwd), at(1))
	writeTranscript(t, directory, sessionIDs[1]+".jsonl", claudeBody(sessionIDs[1], cwd), at(5))
	writeTranscript(t, directory, sessionIDs[2]+".jsonl", claudeBody(sessionIDs[2], cwd), at(3))

	session, err := Newest(home, cwd)
	if err != nil {
		t.Fatalf("Newest: %v", err)
	}
	if session == nil {
		t.Fatal("a directory holding three transcripts answered nothing")
	}
	if session.SessionID != sessionIDs[1] {
		t.Fatalf("SessionID = %q, want the most recently written %q", session.SessionID, sessionIDs[1])
	}
	if session.Kind != Claude || session.Cwd != cwd {
		t.Fatalf("Newest = %+v", session)
	}
}

// TestAnAgentThatNeverRanHereAnswersNothing. A working directory with no
// session tree is an ordinary answer: most directories have never had an agent
// in them, and a failure there would make every terminal command in the
// application look broken.
func TestAnAgentThatNeverRanHereAnswersNothing(t *testing.T) {
	session, err := Newest(t.TempDir(), "<machine-path>/never-visited")
	if err != nil {
		t.Fatalf("Newest: %v", err)
	}
	if session != nil {
		t.Fatalf("Newest = %+v, want nothing", session)
	}
}

// TestADirectoryThatCannotBeReadIsNotAnEmptyOne separates the two answers this
// package exists to keep apart. A session tree that is there and unreadable is
// a failure; collapsing it into "no sessions" hides a broken installation
// behind a feature that quietly does nothing.
func TestADirectoryThatCannotBeReadIsNotAnEmptyOne(t *testing.T) {
	home := t.TempDir()
	const cwd = "<machine-path>/proj"
	directory, err := Directory(home, cwd)
	if err != nil {
		t.Fatalf("Directory: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(directory), 0o755); err != nil {
		t.Fatalf("making the projects folder: %v", err)
	}
	// A file where the session directory belongs. Reading it fails with
	// something that is not absence, which is exactly the case being pinned.
	if err := os.WriteFile(directory, []byte("not a directory"), 0o600); err != nil {
		t.Fatalf("writing in place of the directory: %v", err)
	}

	if _, err := Newest(home, cwd); err == nil {
		t.Fatal("an unreadable session directory answered as an empty one")
	}
}

// TestAFileThatIsNotATranscriptIsNotConsidered. The newest file in a session
// directory is not necessarily a session: anything else living there must not
// be able to displace the real answer.
func TestAFileThatIsNotATranscriptIsNotConsidered(t *testing.T) {
	home := t.TempDir()
	const cwd = "<machine-path>/proj"
	directory, err := Directory(home, cwd)
	if err != nil {
		t.Fatalf("Directory: %v", err)
	}
	writeTranscript(t, directory, sessionIDs[0]+".jsonl", claudeBody(sessionIDs[0], cwd), at(1))
	writeTranscript(t, directory, "notes.jsonl", claudeBody(sessionIDs[1], cwd), at(9))
	writeTranscript(t, directory, sessionIDs[2]+".jsonl.tmp", claudeBody(sessionIDs[2], cwd), at(9))

	session, err := Newest(home, cwd)
	if err != nil {
		t.Fatalf("Newest: %v", err)
	}
	if session == nil || session.SessionID != sessionIDs[0] {
		t.Fatalf("Newest = %+v, want the one transcript %q", session, sessionIDs[0])
	}
}

// TestATranscriptThatHasNotNamedItselfYetAnswersNothing. The agent creates the
// file before it writes the record carrying the identity, and the terminal asks
// right after the command starts.
func TestATranscriptThatHasNotNamedItselfYetAnswersNothing(t *testing.T) {
	home := t.TempDir()
	const cwd = "<machine-path>/proj"
	directory, err := Directory(home, cwd)
	if err != nil {
		t.Fatalf("Directory: %v", err)
	}
	writeTranscript(t, directory, sessionIDs[0]+".jsonl", "", at(1))

	session, err := Newest(home, cwd)
	if err != nil {
		t.Fatalf("Newest: %v", err)
	}
	if session != nil {
		t.Fatalf("Newest = %+v, want nothing", session)
	}
}

// TestFindRefusesACwdItCannotEncode. The refusal has to survive this far: an
// empty working directory that answered "no session" would tell a caller its
// agent left no trace.
func TestFindRefusesACwdItCannotEncode(t *testing.T) {
	for _, cwd := range []string{"", "proj", "../proj"} {
		if _, err := Newest(t.TempDir(), cwd); err == nil {
			t.Errorf("Newest(%q) answered; want a refusal", cwd)
		}
	}
}
