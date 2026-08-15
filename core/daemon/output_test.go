package daemon

import (
	"io"
	"strings"
	"sync"
	"testing"
)

// collected drains a pipe through the pump and answers what it kept.
func collected(t *testing.T, write func(io.Writer), announce func(string)) []string {
	t.Helper()
	reader, writer := io.Pipe()

	var guard sync.Mutex
	var kept []string
	done := make(chan struct{})
	go func() {
		defer close(done)
		pump(reader, announce, func(line string) {
			guard.Lock()
			kept = append(kept, line)
			guard.Unlock()
		})
	}()

	write(writer)
	_ = writer.Close()
	<-done

	guard.Lock()
	defer guard.Unlock()
	return append([]string(nil), kept...)
}

// The readiness rule reads one line and no more. A line that arrives second
// cannot be the first one, whatever it says.
func TestOnlyTheFirstLineIsOfferedAsAnAnnouncement(t *testing.T) {
	var offered []string
	kept := collected(t,
		func(writer io.Writer) {
			_, _ = io.WriteString(writer, "starting\n{\"protocol\":1,\"socket\":\"<local-evidence>/late.sock\"}\n")
		},
		func(line string) { offered = append(offered, line) })

	if len(offered) != 1 || offered[0] != "starting" {
		t.Fatalf("offered %q, want only the first line", offered)
	}
	if len(kept) != 2 {
		t.Errorf("kept %q; the announcement line is output too and stays in the log", kept)
	}
}

// A reader that stops reading fills the child's pipe, and a child blocked in
// write cannot be stopped by anything short of a kill. So the pump keeps
// draining after it has given up on keeping.
func TestALineTooLongToKeepDoesNotStopTheDrain(t *testing.T) {
	kept := collected(t,
		func(writer io.Writer) {
			// No newline: the scanner fills its whole buffer and gives up.
			_, _ = io.WriteString(writer, strings.Repeat("x", maxLineBytes+16))
			// This write only returns if something is still reading.
			_, _ = io.WriteString(writer, "and the daemon carried on printing\n")
		},
		nil)

	if len(kept) != 1 {
		t.Fatalf("kept %d line(s), want the one that says the log stopped", len(kept))
	}
	if !strings.Contains(kept[0], "stopped being kept") {
		t.Errorf("kept %q; a log that stopped must say so, or a daemon that is still printing reads as one that went quiet", kept[0])
	}
}
