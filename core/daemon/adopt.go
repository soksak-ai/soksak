package daemon

import (
	"encoding/json"
	"fmt"
	"strings"
)

// The adoption rule: a pid written down by a previous run names a process only
// for as long as the kernel has not handed that number to somebody else.
//
// A pid is a small recycled integer. The record therefore holds the command
// line the pid was started with, and this build ends a recorded pid only when
// the live process at that number is still running that command. Without the
// match, cleaning up after a crash is a lottery on the user's other processes.
//
// This build adopts a leftover in order to end it, and never into its own
// status table. It holds no pipe to a process it did not start, so an adopted
// entry would report a daemon whose log is permanently empty — a silence the
// reader would take for a quiet daemon.

// Reaper ends a process this build did not start.
//
// Both halves are the host's: reading another process's command line and
// signalling a tree are answered differently on every platform, so the branch
// stays with the caller, which is where the platform is known.
type Reaper interface {
	// CommandLine answers what a live pid is running, and whether there is a
	// live process at all. The two are separate answers: a pid that is gone is
	// an ordinary outcome, and an error means the question could not be asked.
	CommandLine(pid int) (string, bool, error)
	// End ends the process and the tree below it.
	End(pid int) error
}

// Recorded is one pid a previous run wrote down, with what it was running.
type Recorded struct {
	PID int
	Cmd string
}

// UnmarshalJSON reads the pair the caller stored: [pid, "command line"].
//
// The shape is the caller's, and it is checked rather than filled in: a record
// missing its command line would decode to an empty string, and an empty
// command line matches every process on the machine.
func (record *Recorded) UnmarshalJSON(raw []byte) error {
	var pair []json.RawMessage
	if err := json.Unmarshal(raw, &pair); err != nil {
		return fmt.Errorf("a recorded daemon is the pair [pid, cmd]: %w", err)
	}
	if len(pair) != 2 {
		return fmt.Errorf("a recorded daemon is the pair [pid, cmd] and this one has %d element(s)", len(pair))
	}
	if err := json.Unmarshal(pair[0], &record.PID); err != nil {
		return fmt.Errorf("a recorded daemon's pid: %w", err)
	}
	if err := json.Unmarshal(pair[1], &record.Cmd); err != nil {
		return fmt.Errorf("a recorded daemon's cmd: %w", err)
	}
	return nil
}

// What one recorded pid turned out to be.
const (
	// adoptionGone: no process holds that number. The record can be dropped.
	adoptionGone = "gone"
	// adoptionTaken: a live process holds the number and is running something
	// else. Nothing was ended, and the record can be dropped.
	adoptionTaken = "taken"
	// adoptionEnded: the leftover was still ours, and it is now stopped.
	adoptionEnded = "ended"
	// adoptionHeld: it is ours and it is still running, because this build
	// could not query it or could not end it. Reason states which.
	adoptionHeld = "held"
)

// Adoption is what happened to one recorded pid.
type Adoption struct {
	PID    int    `json:"pid"`
	Cmd    string `json:"cmd"`
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
}

// adopt matches every recorded pid and ends the ones that still match the
// record.
//
// The whole batch is read before anything is touched, for the reason the
// terminal group checks every argument before opening a PTY: a refusal that had
// already killed three processes cannot be retried.
func adopt(reaper Reaper, records []Recorded) ([]Adoption, error) {
	for index, record := range records {
		if record.PID <= 0 {
			return nil, fmt.Errorf(
				"entry %d records pid %d — a pid is positive, and 0 names this process's own group to a unix kill",
				index, record.PID)
		}
		if strings.TrimSpace(record.Cmd) == "" {
			return nil, fmt.Errorf(
				"entry %d records pid %d with no command line — there would be nothing to match, and every process at that number would be ended",
				index, record.PID)
		}
	}

	adopted := make([]Adoption, 0, len(records))
	for _, record := range records {
		adopted = append(adopted, adoptOne(reaper, record))
	}
	return adopted, nil
}

func adoptOne(reaper Reaper, record Recorded) Adoption {
	answer := Adoption{PID: record.PID, Cmd: record.Cmd}

	line, live, err := reaper.CommandLine(record.PID)
	if err != nil {
		answer.State, answer.Reason = adoptionHeld, fmt.Sprintf("what pid %d is running could not be read: %v", record.PID, err)
		return answer
	}
	if !live {
		answer.State = adoptionGone
		return answer
	}
	if !strings.Contains(line, record.Cmd) {
		// Reported rather than passed over: the caller stores these records,
		// and knowing the number was reused is what lets it drop the record
		// instead of carrying it to the next run.
		answer.State, answer.Reason = adoptionTaken, fmt.Sprintf("pid %d is running %q now", record.PID, line)
		return answer
	}
	if err := reaper.End(record.PID); err != nil {
		answer.State, answer.Reason = adoptionHeld, fmt.Sprintf("pid %d could not be ended: %v", record.PID, err)
		return answer
	}
	answer.State = adoptionEnded
	return answer
}
