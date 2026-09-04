package session

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"

	controlwire "github.com/soksak-ai/soksak-contract-control"
)

// A session outlives the process that owns it.
//
// S10 states this and the test that held it used a closure returning an error, which measures the
// error path and not the process. An owner is a unit reached over a socket, so this starts one,
// reads its answer, stops it, and reads the answer again.
//
// The distinction the row exists for: an owner that is gone leaves its sessions orphaned, never
// lost. Lost means the owner answered and reported the session missing. Nothing else may produce
// it, because the core does not read an owner's store and cannot tell a recoverable session from an
// unrecoverable one.
func TestASessionSurvivesItsOwnerProcessExiting(t *testing.T) {
	// A short directory: a unix socket path has a hard length limit, and t.TempDir() is long
	// enough on this platform to exceed it.
	directory, err := os.MkdirTemp("", "sok")
	if err != nil {
		t.Fatalf("preparing the socket directory: %v", err)
	}
	defer os.RemoveAll(directory)
	socket := filepath.Join(directory, "o.sock")

	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Skipf("unix sockets are unavailable here: %v", err)
	}
	served := make(chan struct{})
	go func() {
		defer close(served)
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			// One answer per connection, in the envelope an owner answers in: the report travels
			// under `data`.
			report, _ := json.Marshal(map[string]any{
				"data": controlwire.SessionReport{
					Complete: true,
					Sessions: []controlwire.SessionOutcome{{Session: "7", Outcome: controlwire.SessionFull}},
				},
			})
			_, _ = connection.Write(report)
			_ = connection.Close()
		}
	}()

	send := func(_ string, _ controlwire.Request) (controlwire.Response, error) {
		connection, err := net.Dial("unix", socket)
		if err != nil {
			return controlwire.Response{}, err
		}
		defer connection.Close()
		body := make([]byte, 4096)
		read, err := connection.Read(body)
		if err != nil {
			return controlwire.Response{}, err
		}
		return controlwire.Response{Ok: true, Result: json.RawMessage(body[:read])}, nil
	}

	index := []Entry{{Session: "7", Owner: "an-owner", ViewID: "v1", WindowLabel: "main", Shown: true}}

	listed, err := List(index, AskThrough(send))
	if err != nil {
		t.Fatalf("listing while the owner runs: %v", err)
	}
	if len(listed) != 1 || listed[0].State != StateLive {
		t.Fatalf("with the owner running the session reads %+v, want live", listed)
	}

	// The owner exits. Nothing else changes.
	_ = listener.Close()
	_ = os.Remove(socket)
	<-served

	listed, err = List(index, AskThrough(send))
	if err != nil {
		t.Fatalf("listing after the owner exited: %v", err)
	}
	if len(listed) != 1 {
		t.Fatalf("the session left the index with its owner: %+v", listed)
	}
	if listed[0].State != StateOrphaned {
		t.Fatalf("after the owner exited the session reads %q, want %q", listed[0].State, StateOrphaned)
	}
	if listed[0].Outcome != "" {
		t.Fatalf("an owner that answered nothing produced the outcome %q", listed[0].Outcome)
	}
}
