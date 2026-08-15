package terminal

import (
	"sort"
	"testing"

	"github.com/soksak/soksak-core/core/control"
)

// A hand-kept list is a second answer to "what does this group own", and two
// answers drift. This holds them equal: a command added to Register and not to
// CommandNames leaves the composition root unable to declare it.
func TestTheNameListMatchesWhatRegisterTouches(t *testing.T) {
	registry := control.NewRegistry()
	Register(registry, Deps{Sessions: stubSessions{}})

	described := registry.Describe()
	touched := map[string]bool{}
	for _, command := range described.Commands {
		touched[command.Name] = true
	}
	for _, unserved := range described.Unserved {
		touched[unserved.Name] = true
	}

	declared := map[string]bool{}
	for _, name := range CommandNames() {
		if declared[name] {
			t.Errorf("%s is listed twice", name)
		}
		declared[name] = true
	}

	var missing, extra []string
	for name := range touched {
		if !declared[name] {
			missing = append(missing, name)
		}
	}
	for name := range declared {
		if !touched[name] {
			extra = append(extra, name)
		}
	}
	sort.Strings(missing)
	sort.Strings(extra)

	if len(missing) > 0 {
		t.Errorf("Register touches these and CommandNames does not list them: %v", missing)
	}
	if len(extra) > 0 {
		t.Errorf("CommandNames lists these and Register never touches them: %v", extra)
	}
}

// stubSessions is an owner that exists and does nothing. The test asks which
// names Register touches, never what they answer.
type stubSessions struct{}

func (stubSessions) Open(string, uint16, uint16) (Handle, error) { return Handle{}, nil }
func (stubSessions) Write(Handle, string) error                  { return nil }
func (stubSessions) Resize(Handle, uint16, uint16) error         { return nil }
func (stubSessions) Close(Handle) error                          { return nil }
