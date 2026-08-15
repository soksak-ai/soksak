package ai

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestATranscriptUnderAnAgentsTreeIsRead — the ordinary case, for both agents.
func TestATranscriptUnderAnAgentsTreeIsRead(t *testing.T) {
	home := t.TempDir()

	claudePath := writeTranscript(t,
		filepath.Join(home, ".claude", "projects", "-Users-max-proj"),
		sessionIDs[0]+".jsonl", claudeBody(sessionIDs[0], "<machine-path>/proj"), at(1))
	session, err := Inspect(claudePath)
	if err != nil {
		t.Fatalf("Inspect: %v", err)
	}
	if session == nil || session.Kind != Claude || session.SessionID != sessionIDs[0] {
		t.Fatalf("Inspect(claude) = %+v", session)
	}

	codexPath := writeTranscript(t,
		filepath.Join(home, ".codex", "sessions", "2026", "08", "15"),
		"rollout-2026-08-15T12-00-00-"+sessionIDs[1]+".jsonl",
		codexBody(sessionIDs[1], "<machine-path>/proj"), at(1))
	session, err = Inspect(codexPath)
	if err != nil {
		t.Fatalf("Inspect: %v", err)
	}
	if session == nil || session.Kind != Codex || session.SessionID != sessionIDs[1] {
		t.Fatalf("Inspect(codex) = %+v", session)
	}
}

// TestInspectIsNotAGeneralFileRead is the rule that keeps this command from
// being a way to read any file on the machine through every transport the
// registry answers on.
//
// The judgement is on path components. A substring test passes for a directory
// somebody named ".claude_projects", and it says nothing at all about a path
// that enters the tree and then walks back out.
// Every path below names a file that is really there and really readable, and
// the refusal is matched against the rule that produced it. A test that pointed
// at files which do not exist would pass on the read failing, and it would go
// on passing after the rule was replaced by a substring test — measured here on
// 2026-08-15 by doing exactly that.
func TestInspectIsNotAGeneralFileRead(t *testing.T) {
	home := t.TempDir()
	secret := writeTranscript(t, home, "secret.jsonl", claudeBody(sessionIDs[0], "/w"), at(1))
	// A real session tree, so the path that walks out of one walks out of
	// something the operating system can actually resolve.
	writeTranscript(t, filepath.Join(home, ".claude", "projects", "-w"),
		sessionIDs[0]+".jsonl", claudeBody(sessionIDs[0], "/w"), at(1))
	const notATranscriptPath = "refuses to be a general file read"

	refused := []struct{ path, because string }{
		{path: secret, because: notATranscriptPath},
		// The components are all there, in the wrong shape. A substring test
		// admits every one of these.
		{
			path:    writeTranscript(t, filepath.Join(home, ".claude_projects"), sessionIDs[0]+".jsonl", claudeBody(sessionIDs[0], "/w"), at(1)),
			because: notATranscriptPath,
		},
		{
			path:    writeTranscript(t, filepath.Join(home, ".claude", "elsewhere", "projects"), sessionIDs[0]+".jsonl", claudeBody(sessionIDs[0], "/w"), at(1)),
			because: notATranscriptPath,
		},
		{
			path:    writeTranscript(t, filepath.Join(home, "projects", ".claude"), sessionIDs[0]+".jsonl", claudeBody(sessionIDs[0], "/w"), at(1)),
			because: notATranscriptPath,
		},
		// In, and back out. The file at the end of it is the readable one
		// written above.
		{
			path:    filepath.Join(home, ".claude", "projects") + "/../../secret.jsonl",
			because: "walks back out",
		},
		// Completed from wherever this process happens to stand.
		{
			path:    ".claude/projects/-w/" + sessionIDs[0] + ".jsonl",
			because: "absolute POSIX path",
		},
	}
	for _, probe := range refused {
		_, err := Inspect(probe.path)
		if err == nil {
			t.Errorf("Inspect(%q) was answered; want a refusal", probe.path)
			continue
		}
		if !strings.Contains(err.Error(), probe.because) {
			t.Errorf("Inspect(%q) failed with %v; want the refusal to be %q", probe.path, err, probe.because)
		}
	}
}

// TestInspectNamesThePathItRefuses. A caller that is told only "no" cannot tell
// a rejected path from an empty file.
func TestInspectNamesThePathItRefuses(t *testing.T) {
	const path = "/etc/passwd"
	_, err := Inspect(path)
	if err == nil {
		t.Fatal("an arbitrary file was read")
	}
	if !strings.Contains(err.Error(), path) {
		t.Fatalf("the refusal does not carry the path: %v", err)
	}
}

// TestAMissingTranscriptIsAFailureNotAnAbsentSession. The caller named this
// file; nothing about "it is not there" is the same as "it holds no session".
func TestAMissingTranscriptIsAFailureNotAnAbsentSession(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".claude", "projects", "-w", sessionIDs[0]+".jsonl")
	if _, err := Inspect(path); err == nil {
		t.Fatal("a transcript that is not there read as an empty session")
	}
}

// TestATranscriptThatNamesNothingIsNotAFailure. The file is a transcript, it is
// readable, and it has not written its identity yet.
func TestATranscriptThatNamesNothingIsNotAFailure(t *testing.T) {
	path := writeTranscript(t,
		filepath.Join(t.TempDir(), ".claude", "projects", "-w"),
		sessionIDs[0]+".jsonl", "", at(1))

	session, err := Inspect(path)
	if err != nil {
		t.Fatalf("Inspect: %v", err)
	}
	if session != nil {
		t.Fatalf("Inspect = %+v, want nothing", session)
	}
}
