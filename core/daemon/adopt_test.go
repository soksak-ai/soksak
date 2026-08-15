package daemon

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// stubReaper answers about processes this build did not start.
type stubReaper struct {
	live  map[int]string
	fails map[int]error
	ended []int
	// endFails makes End answer with an error for one pid.
	endFails map[int]error
}

func (stub *stubReaper) CommandLine(pid int) (string, bool, error) {
	if err := stub.fails[pid]; err != nil {
		return "", false, err
	}
	line, live := stub.live[pid]
	return line, live, nil
}

func (stub *stubReaper) End(pid int) error {
	if err := stub.endFails[pid]; err != nil {
		return err
	}
	stub.ended = append(stub.ended, pid)
	return nil
}

// The whole reason a command line is recorded beside the pid. A pid is a small
// number the kernel hands out again, so a record from an hour ago may name the
// user's editor by now.
func TestARecordedPidWhoseCommandLineChangedIsNeverEnded(t *testing.T) {
	reaper := &stubReaper{live: map[int]string{4242: "/usr/bin/some-editor a-file"}}

	adopted, err := adopt(reaper, []Recorded{{PID: 4242, Cmd: "npm run dev"}})
	if err != nil {
		t.Fatalf("adopting: %v", err)
	}

	if len(reaper.ended) != 0 {
		t.Fatalf("ended %v; the pid was reused and this killed whatever inherited it", reaper.ended)
	}
	if adopted[0].State != adoptionTaken {
		t.Errorf("state = %q, want %q", adopted[0].State, adoptionTaken)
	}
	if !strings.Contains(adopted[0].Reason, "some-editor") {
		t.Errorf("the answer %q does not say what is actually running there", adopted[0].Reason)
	}
}

// The daemon was started through a login shell, so the live command line is the
// shell's and the record is the line the caller declared. Requiring the two to
// be equal would leave every leftover behind.
func TestARecordedLineIsMatchedInsideTheLiveOne(t *testing.T) {
	reaper := &stubReaper{live: map[int]string{7: "/bin/zsh -lc npm run dev"}}

	adopted, err := adopt(reaper, []Recorded{{PID: 7, Cmd: "npm run dev"}})
	if err != nil {
		t.Fatalf("adopting: %v", err)
	}

	if len(reaper.ended) != 1 || reaper.ended[0] != 7 {
		t.Fatalf("ended %v, want the matched leftover", reaper.ended)
	}
	if adopted[0].State != adoptionEnded {
		t.Errorf("state = %q, want %q", adopted[0].State, adoptionEnded)
	}
}

func TestAPidThatIsGoneIsSaidToBeGoneRatherThanEnded(t *testing.T) {
	adopted, err := adopt(&stubReaper{live: map[int]string{}}, []Recorded{{PID: 9, Cmd: "npm run dev"}})
	if err != nil {
		t.Fatalf("adopting: %v", err)
	}
	if adopted[0].State != adoptionGone {
		t.Errorf("state = %q, want %q — the record can be dropped, and nothing was killed", adopted[0].State, adoptionGone)
	}
}

// One entry this build could not act on must not silently read as done, and
// must not stop the others either: the caller is cleaning up a whole project.
func TestOneUnreachableLeftoverIsReportedAndTheRestAreStillReaped(t *testing.T) {
	reaper := &stubReaper{
		live:     map[int]string{11: "sh -lc npm run dev", 12: "sh -lc npm run api"},
		endFails: map[int]error{11: errors.New("operation not permitted")},
	}

	adopted, err := adopt(reaper, []Recorded{{PID: 11, Cmd: "npm run dev"}, {PID: 12, Cmd: "npm run api"}})
	if err != nil {
		t.Fatalf("adopting: %v", err)
	}

	if adopted[0].State != adoptionHeld {
		t.Errorf("state = %q, want %q", adopted[0].State, adoptionHeld)
	}
	if !strings.Contains(adopted[0].Reason, "not permitted") {
		t.Errorf("the answer %q does not carry why it is still running", adopted[0].Reason)
	}
	if len(reaper.ended) != 1 || reaper.ended[0] != 12 {
		t.Fatalf("ended %v, want the other leftover reaped anyway", reaper.ended)
	}
}

// Nothing is touched until the whole batch has been read. A pid of 0 names this
// process's own group to a unix kill, and an empty command line matches every
// process alive.
func TestACorruptRecordStopsTheBatchBeforeAnythingIsKilled(t *testing.T) {
	for _, corrupt := range []Recorded{{PID: 0, Cmd: "npm run dev"}, {PID: -1, Cmd: "npm run dev"}, {PID: 5, Cmd: ""}} {
		reaper := &stubReaper{live: map[int]string{8: "sh -lc npm run dev"}}
		records := []Recorded{{PID: 8, Cmd: "npm run dev"}, corrupt}

		if _, err := adopt(reaper, records); err == nil {
			t.Fatalf("%+v was accepted", corrupt)
		}
		if len(reaper.ended) != 0 {
			t.Fatalf("%+v: ended %v before the batch was read", corrupt, reaper.ended)
		}
	}
}

// The record is a pair on the wire: [pid, "command line"].
func TestARecordDecodesFromThePairTheCallerStored(t *testing.T) {
	var records []Recorded
	if err := json.Unmarshal([]byte(`[[123,"npm run dev"]]`), &records); err != nil {
		t.Fatalf("decoding: %v", err)
	}
	if len(records) != 1 || records[0].PID != 123 || records[0].Cmd != "npm run dev" {
		t.Fatalf("decoded %+v", records)
	}
}

func TestARecordThatIsNotAPairIsRefusedByName(t *testing.T) {
	var records []Recorded
	err := json.Unmarshal([]byte(`[[123]]`), &records)
	if err == nil {
		t.Fatal("a one-element record decoded; the command line would be empty and match everything")
	}
	if !strings.Contains(err.Error(), "pid") {
		t.Errorf("the refusal %q does not say what the pair holds", err)
	}
}
