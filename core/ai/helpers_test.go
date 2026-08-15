package ai

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The tests build real trees rather than a filesystem stub, because every rule
// in this package is a rule about what an agent actually left on disk:
// modification times, file names, and the shape of the head of a file. A stub
// would let all three drift from the thing being described.

// writeTranscript puts one transcript in dir and stamps its modification time,
// answering its path. The stamp is explicit because "which transcript was
// written last" is the whole question, and a test that relied on the order of
// its own writes would be measuring how fast the machine is.
func writeTranscript(t *testing.T, dir, name, body string, modified time.Time) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("making %s: %v", dir, err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
	if err := os.Chtimes(path, modified, modified); err != nil {
		t.Fatalf("stamping %s: %v", path, err)
	}
	return path
}

// claudeBody is a transcript that names itself the way claude's do.
func claudeBody(sessionID, cwd string) string {
	return `{"type":"summary"}` + "\n" +
		`{"sessionId":"` + sessionID + `","cwd":"` + cwd + `"}` + "\n"
}

// codexBody is a transcript that names itself the way codex's do.
func codexBody(sessionID, cwd string) string {
	return `{"type":"session_meta","payload":{"id":"` + sessionID + `","cwd":"` + cwd + `"}}` + "\n"
}

// sessionIDs are distinct identifiers with a fixed lexical order, so a test can
// say which one a tie must resolve to.
var sessionIDs = []string{
	"11111111-1111-4111-8111-111111111111",
	"22222222-2222-4222-8222-222222222222",
	"33333333-3333-4333-8333-333333333333",
}

// at is a fixed instant, so modification times are chosen rather than observed.
func at(minutes int) time.Time {
	return time.Date(2026, 8, 15, 12, minutes, 0, 0, time.UTC)
}
