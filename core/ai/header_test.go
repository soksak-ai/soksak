package ai

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testSessionID = "3f1b2c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"

// TestAClaudeTranscriptNamesItselfAcrossItsFirstLines matches the measured
// format: the identity is spread over the records rather than sitting in a
// header, so the first line carrying each field wins.
func TestAClaudeTranscriptNamesItselfAcrossItsFirstLines(t *testing.T) {
	head := strings.Join([]string{
		`{"type":"summary","summary":"a run"}`,
		`{"sessionId":"` + testSessionID + `","type":"user"}`,
		`{"cwd":"<machine-path>/proj","type":"assistant"}`,
	}, "\n")

	session := ParseHeader(Claude, head)
	if session == nil {
		t.Fatal("a transcript that names both its session and its directory read as nothing")
	}
	if session.Kind != Claude || session.SessionID != testSessionID || session.Cwd != "<machine-path>/proj" {
		t.Fatalf("ParseHeader = %+v", session)
	}
}

// TestABrokenLineDoesNotStopTheRead is what makes reading a transcript that is
// being appended to safe: the tail of the file is mid-write often enough that
// stopping at the first unparseable line would answer "no session" for a
// session that is running right now.
func TestABrokenLineDoesNotStopTheRead(t *testing.T) {
	head := strings.Join([]string{
		`{"type":"summary"`, // truncated mid-write
		`not json at all`,
		`{"sessionId":"` + testSessionID + `","cwd":"/w"}`,
	}, "\n")

	session := ParseHeader(Claude, head)
	if session == nil || session.SessionID != testSessionID {
		t.Fatalf("ParseHeader = %+v, want the session from the last line", session)
	}
}

// TestAForgedSessionIDIsSkippedRatherThanTrusted. A line that claims an
// identifier this build would never mint is not the identity of the file; the
// read goes on and finds the real one.
func TestAForgedSessionIDIsSkippedRatherThanTrusted(t *testing.T) {
	head := strings.Join([]string{
		`{"sessionId":"../../evil","cwd":"/w"}`,
		`{"sessionId":"` + testSessionID + `"}`,
	}, "\n")

	session := ParseHeader(Claude, head)
	if session == nil {
		t.Fatal("the forged line swallowed the real one")
	}
	if session.SessionID != testSessionID {
		t.Fatalf("SessionID = %q, want the valid one", session.SessionID)
	}
}

// TestATranscriptThatNamesOnlyHalfOfItselfIsNotASession. A file with an
// identifier and no working directory cannot be placed, and a file with a
// directory and no identifier cannot be resumed.
func TestATranscriptThatNamesOnlyHalfOfItselfIsNotASession(t *testing.T) {
	if session := ParseHeader(Claude, `{"sessionId":"`+testSessionID+`"}`); session != nil {
		t.Errorf("an identifier with no directory read as %+v", session)
	}
	if session := ParseHeader(Claude, `{"cwd":"/w"}`); session != nil {
		t.Errorf("a directory with no identifier read as %+v", session)
	}
	if session := ParseHeader(Claude, `{"sessionId":"`+testSessionID+`","cwd":""}`); session != nil {
		t.Errorf("an empty directory read as %+v", session)
	}
}

// TestACodexTranscriptIsNamedByItsMetaLine matches the measured format: one
// session_meta record carries payload.id and payload.cwd.
func TestACodexTranscriptIsNamedByItsMetaLine(t *testing.T) {
	head := strings.Join([]string{
		`{"type":"turn_context"}`,
		`{"type":"session_meta","payload":{"id":"` + testSessionID + `","cwd":"<machine-path>/proj"}}`,
	}, "\n")

	session := ParseHeader(Codex, head)
	if session == nil {
		t.Fatal("a codex transcript with a meta line read as nothing")
	}
	if session.Kind != Codex || session.SessionID != testSessionID || session.Cwd != "<machine-path>/proj" {
		t.Fatalf("ParseHeader = %+v", session)
	}
}

// TestACodexMetaLineWithoutAValidIdentityNamesNothing.
func TestACodexMetaLineWithoutAValidIdentityNamesNothing(t *testing.T) {
	for _, head := range []string{
		`{"type":"session_meta","payload":{"id":"nope","cwd":"/w"}}`,
		`{"type":"session_meta","payload":{"id":"` + testSessionID + `"}}`,
		`{"type":"session_meta"}`,
		`{"type":"turn_context","payload":{"id":"` + testSessionID + `","cwd":"/w"}}`,
	} {
		if session := ParseHeader(Codex, head); session != nil {
			t.Errorf("ParseHeader(Codex, %s) = %+v, want nothing", head, session)
		}
	}
}

// TestAnUnknownKindNamesNothing. Dispatching an unrecognised kind to the claude
// parser would answer with a claude session for a file that is not one.
func TestAnUnknownKindNamesNothing(t *testing.T) {
	if session := ParseHeader(Kind("gemini"), `{"sessionId":"`+testSessionID+`","cwd":"/w"}`); session != nil {
		t.Fatalf("ParseHeader(unknown kind) = %+v, want nothing", session)
	}
}

// TestOnlyTheFrontOfATranscriptIsRead is the reason this reads a head rather
// than a file: a transcript grows to megabytes, and its identity is written in
// the first records. Nothing past the window may reach the answer.
func TestOnlyTheFrontOfATranscriptIsRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), testSessionID+".jsonl")
	filler := strings.Repeat(`{"type":"assistant","text":"`+strings.Repeat("x", 1000)+`"}`+"\n", headBytes/1020+2)
	body := filler + `{"sessionId":"` + testSessionID + `","cwd":"/w"}` + "\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("writing the transcript: %v", err)
	}

	head, err := readHead(path)
	if err != nil {
		t.Fatalf("readHead: %v", err)
	}
	if len(head) > headBytes {
		t.Fatalf("read %d bytes, want at most %d", len(head), headBytes)
	}
	if strings.Contains(head, testSessionID) {
		t.Fatal("the window reached past its own size")
	}
	// And the cut is at a line boundary: half a record is not a record, and
	// feeding one to the parser would make a truncated line look like a
	// malformed one.
	if !strings.HasSuffix(head, "\n") {
		t.Fatal("the head ends mid-line")
	}
}

// TestAShortTranscriptIsReadWhole. The window is a ceiling, never a floor.
func TestAShortTranscriptIsReadWhole(t *testing.T) {
	path := filepath.Join(t.TempDir(), testSessionID+".jsonl")
	body := `{"sessionId":"` + testSessionID + `","cwd":"/w"}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("writing the transcript: %v", err)
	}

	head, err := readHead(path)
	if err != nil {
		t.Fatalf("readHead: %v", err)
	}
	if head != body {
		t.Fatalf("readHead = %q, want %q", head, body)
	}
}

// TestAMissingTranscriptFails. A path that was named and cannot be read is not
// an absent session; the caller asked about a file it believes exists.
func TestAMissingTranscriptFails(t *testing.T) {
	if _, err := readHead(filepath.Join(t.TempDir(), "absent.jsonl")); err == nil {
		t.Fatal("reading a file that is not there succeeded")
	}
}
