package sidecar

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

// Finding a unit this host did not start.
//
// A unit is a process so that it outlives the application. An application that came back and started
// a second one would leave the first holding everything — shells, connections, whatever it was
// keeping — with nothing able to reach it, and the second would look healthy the whole time.
//
// What is recorded is only what this host was told: the address the unit announced and the token it
// announced with it. Nothing is derived. A later run reads its own record, connects, and greets; if
// something answers, that is the unit. If nothing does, the record was left by a unit that is gone
// and it goes with it.
//
// The check is a connect and a greeting, not a look at the filesystem. A socket path exists both
// when someone is listening and when a dead unit left it behind, so a stat answers "a file is there"
// and never "someone is listening" — and the only way to turn the first into the second is to
// connect, which is what this does.

// record is what this host writes down about a unit it started.
type record struct {
	Address     string `json:"address"`
	Token       string `json:"token"`
	Protocol    int    `json:"protocol"`
	PID         int    `json:"pid"`
	SecretNames string `json:"secretNames,omitempty"`
}

func (host *Host) recordPath(name string) string {
	return filepath.Join(host.deps.Home, "run", "sidecar-"+name+".json")
}

// remember writes down what a unit announced, so a later run of this application can find it.
//
// A failure to write is not a failure to start. The unit is running and reachable now; what is lost
// is the next run's ability to find it, and reporting that as a start failure would end a unit that
// works.
func (host *Host) remember(name string, open Open, token, secretNames string) {
	path := host.recordPath(name)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return
	}
	encoded, err := json.Marshal(record{
		Address: open.Address, Token: token, Protocol: open.Protocol, PID: open.PID, SecretNames: secretNames,
	})
	if err != nil {
		return
	}
	_ = os.WriteFile(path, encoded, 0o600)
}

func (host *Host) forget(name string) { _ = os.Remove(host.recordPath(name)) }

// adopt finds a unit a previous run of this application started, and answers whether it is there.
//
// Adopting is not owning in the sense of arguments — this host did not choose them — but it is
// ownership in the sense that matters here: the unit was started for this home by this application,
// its address and token are this application's own record, and ending it at shutdown is what keeps
// the next run from finding two.
func (host *Host) adopt(name, secretNames string) (Open, bool, error) {
	raw, err := os.ReadFile(host.recordPath(name))
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			// A record that cannot be read is not a unit that is not there. It is left alone rather
			// than removed, so whatever wrote it is not silently replaced.
			return Open{}, false, nil
		}
		return Open{}, false, nil
	}
	var remembered record
	if err := json.Unmarshal(raw, &remembered); err != nil || remembered.Address == "" {
		host.forget(name)
		return Open{}, false, nil
	}
	if remembered.SecretNames != secretNames {
		return Open{}, false, i18n.Errorf("sidecar.secretSetMismatch", map[string]string{"name": name})
	}
	if host.deps.Dial == nil {
		return Open{}, false, nil
	}

	conn, err := host.deps.Dial(remembered.Address)
	if err != nil {
		// Nothing is listening there. The record is a unit that has gone.
		host.forget(name)
		return Open{}, false, nil
	}
	open := Open{Name: name, Address: remembered.Address, Protocol: remembered.Protocol, PID: remembered.PID}
	held := &unit{open: open, stderr: newRing(64), token: remembered.Token, adopted: true, secretNames: secretNames}

	host.mu.Lock()
	if existing, running := host.open[name]; running {
		host.mu.Unlock()
		_ = conn.Close()
		return existing.open, true, nil
	}
	host.open[name] = held
	host.mu.Unlock()

	// Greeted on this connection before it is trusted. Something else may be listening at an address
	// a unit used to have, and a host that skipped the greeting would relay this plugin's requests to
	// whatever that is.
	if err := host.greet(conn, bufferedReader(conn), name); err != nil {
		_ = conn.Close()
		host.mu.Lock()
		if host.open[name] == held {
			delete(host.open, name)
		}
		host.mu.Unlock()
		host.forget(name)
		return Open{}, false, nil
	}
	_ = conn.Close()
	return open, true, nil
}
