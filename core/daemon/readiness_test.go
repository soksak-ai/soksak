package daemon

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/soksak-ai/soksak-core/core/control"
)

func announcementLine(socket string) string {
	return `{"protocol":2,"socket":"` + socket + `","processLabel":"soksak-test"}`
}

func TestTheFirstLineNamingASocketIsReadiness(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "control.sock")

	read := readAnnouncement(announcementLine(socket))

	if read.State != Ready {
		t.Fatalf("state = %q, want %q (reason %q)", read.State, Ready, read.Reason)
	}
	if read.Socket != socket {
		t.Errorf("socket = %q, want %q", read.Socket, socket)
	}
	if read.ProcessLabel != "soksak-test" {
		t.Errorf("process label = %q", read.ProcessLabel)
	}
}

// The whole point of reading a line instead of a directory entry: nothing here
// touches the filesystem, so there is no second look to take and no poll to
// write. A daemon that announces a path this process cannot see is still ready.
func TestReadinessNeverLooksAtTheFilesystem(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "never-created", "control.sock")

	read := readAnnouncement(announcementLine(missing))

	if read.State != Ready {
		t.Fatalf("a socket path that does not exist read as %q; readiness is the announcement, never the file", read.State)
	}
}

func TestOrdinaryOutputAnnouncesNothing(t *testing.T) {
	for _, line := range []string{
		"listening on http://localhost:5173",
		"",
		"   ",
		`{"level":"info","msg":"ready"}`,
		"{not json at all",
	} {
		read := readAnnouncement(line)
		if read.State != Mute {
			t.Errorf("%q read as %q, want %q — ordinary output is not an announcement", line, read.State, Mute)
		}
		if read.Socket != "" {
			t.Errorf("%q carried socket %q", line, read.Socket)
		}
	}
}

// A half-announcement is refused rather than read as ordinary output: the
// daemon tried to speak the envelope and got it wrong, and reporting that as
// "this one announces nothing" sends the reader looking at the wrong daemon.
func TestAHalfAnnouncementIsRefusedByName(t *testing.T) {
	cases := []struct {
		line string
		says string
	}{
		{`{"socket":"/tmp/a.sock"}`, "protocol"},
		{`{"protocol":2}`, "socket"},
		{`{"protocol":2,"socket":"/tmp/a.sock"}`, "process label"},
		{`{"protocol":2,"socket":"","processLabel":"soksak-test"}`, "empty"},
		{`{"protocol":2,"socket":"control.sock","processLabel":"soksak-test"}`, "relative"},
	}
	for _, one := range cases {
		read := readAnnouncement(one.line)
		if read.State != Refused {
			t.Errorf("%q read as %q, want %q", one.line, read.State, Refused)
			continue
		}
		if !strings.Contains(read.Reason, one.says) {
			t.Errorf("%q was refused with %q, which does not say %q", one.line, read.Reason, one.says)
		}
	}
}

// A daemon speaking another envelope version is up and unusable, which is not
// the same as one that is still starting. It is named at the announcement,
// which is the only moment before a caller acts on the socket.
func TestAProtocolMismatchIsRefusedCarryingBothNumbers(t *testing.T) {
	read := readAnnouncement(`{"protocol":99,"socket":"/tmp/a.sock","processLabel":"soksak-test"}`)

	if read.State != Refused {
		t.Fatalf("state = %q, want %q", read.State, Refused)
	}
	if !strings.Contains(read.Reason, "99") {
		t.Errorf("the refusal %q does not carry what the daemon said", read.Reason)
	}
	if !strings.Contains(read.Reason, "2") {
		t.Errorf("the refusal %q does not carry what this build speaks (%d)", read.Reason, control.Protocol)
	}
	if read.Socket != "" {
		t.Errorf("a refused announcement carried socket %q; nothing may connect to it", read.Socket)
	}
}
