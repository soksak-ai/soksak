package sidecar

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/soksak-ai/soksak-core/core/i18n"

	"github.com/soksak-ai/soksak-core/core/atomicfile"
)

// Finding a unit this host did not start.
//
// An unclean application termination can leave a Sidecar process and record. A later application
// verifies that process before it starts another process with the same unit name.
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
	// Path is the program the unit was started from. A run whose record resolves to another
	// program does not adopt the unit; it ends it and starts the recorded one.
	Path         string `json:"path,omitempty"`
	Version      string `json:"version,omitempty"`
	ProcessLabel string `json:"processLabel"`
}

func (host *Host) recordPath(name string) string {
	return filepath.Join(host.deps.Home, "run", "sidecar-"+name+".json")
}

// remember writes down what a unit announced, so a later run of this application can find it.
//
// A failure to write is not a failure to start. The unit is running and reachable now; what is lost
// is the next run's ability to find it, and reporting that as a start failure would end a unit that
// works.
func (host *Host) remember(name string, open Open, token, secretNames, version, path string) {
	location := host.recordPath(name)
	if err := os.MkdirAll(filepath.Dir(location), 0o700); err != nil {
		return
	}
	encoded, err := json.Marshal(record{
		Address: open.Address, Token: token, Protocol: open.Protocol, PID: open.PID, SecretNames: secretNames, Path: path, Version: version, ProcessLabel: open.ProcessLabel,
	})
	if err != nil {
		return
	}
	_ = atomicfile.Publish(location, encoded, 0o600)
}

func (host *Host) forget(name string) { _ = os.Remove(host.recordPath(name)) }

// Recorded reports the unit identities this home owns without connecting,
// greeting, adopting, starting, or exposing their tokens.
//
// A record whose process has ended is not an identity this home owns: it is what a run that died
// without stopping left behind. Reading the inventory forgets it, so a caller that refuses to act
// while a name is recorded is held by units that are running and by nothing else.
func (host *Host) Recorded() ([]Open, error) {
	directory := filepath.Join(host.deps.Home, "run")
	entries, err := os.ReadDir(directory)
	if errors.Is(err, fs.ErrNotExist) {
		return []Open{}, nil
	}
	if err != nil {
		return nil, err
	}
	owned := make([]Open, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "sidecar-") || !strings.HasSuffix(name, ".json") {
			continue
		}
		if entry.Type()&os.ModeSymlink != 0 || !entry.Type().IsRegular() {
			return nil, i18n.Errorf("sidecar.recordNotRegular", map[string]string{"path": filepath.Join(directory, name)})
		}
		raw, err := os.ReadFile(filepath.Join(directory, name))
		if err != nil {
			return nil, err
		}
		var remembered record
		if json.Unmarshal(raw, &remembered) != nil || remembered.PID < 1 {
			return nil, i18n.Errorf("sidecar.recordInvalid", map[string]string{"path": filepath.Join(directory, name)})
		}
		identity := strings.TrimSuffix(strings.TrimPrefix(name, "sidecar-"), ".json")
		if processGone(remembered.PID) {
			host.forget(identity)
			continue
		}
		if remembered.Address == "" || remembered.Protocol < 1 || remembered.ProcessLabel == "" {
			return nil, i18n.Errorf("sidecar.recordInvalid", map[string]string{"path": filepath.Join(directory, name)})
		}
		owned = append(owned, Open{
			Name: identity, Address: remembered.Address, Protocol: remembered.Protocol,
			PID: remembered.PID, Version: remembered.Version, ProcessLabel: remembered.ProcessLabel,
		})
	}
	sort.Slice(owned, func(left, right int) bool { return owned[left].Name < owned[right].Name })
	return owned, nil
}

// adoptOwned verifies and attaches the unit named by this home's record without
// starting anything. Stop uses it to reclaim work left by an earlier process.
func (host *Host) adoptOwned(name string) (bool, error) {
	raw, err := os.ReadFile(host.recordPath(name))
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var remembered record
	if json.Unmarshal(raw, &remembered) != nil || remembered.Address == "" {
		host.forget(name)
		return false, nil
	}
	if remembered.PID < 1 {
		return false, i18n.Errorf("sidecar.invalidAdoptedPID", map[string]string{"pid": strconv.Itoa(remembered.PID)})
	}
	_, found, err := host.adopt(name, remembered.SecretNames, "", "")
	return found, err
}

// adopt finds a unit a previous run of this application started, and answers whether it is there.
//
// Adopting is not owning in the sense of arguments — this host did not choose them — but it is
// ownership in the sense that matters here: the unit was started for this home by this application,
// its address and token are this application's own record, and ending it at shutdown is what keeps
// the next run from finding two.
// path, when given, is the program the record must name for the unit to be adopted; "" adopts
// whatever program the record names.
func (host *Host) adopt(name, secretNames, version, path string) (Open, bool, error) {
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
		if secretNames == "" {
			// An empty declaration is no opinion: the recorded unit stands,
			// and its own secret set stays the remembered truth.
			secretNames = remembered.SecretNames
		} else if remembered.SecretNames == "" {
			// A keyless record yields to the first real declaration: what ran
			// without the secret cannot serve the caller that requires it.
			_ = signalPID(remembered.PID)
			host.awaitGone(remembered.Address)
			host.forget(name)
			return Open{}, false, nil
		} else {
			return Open{}, false, i18n.Errorf("sidecar.secretSetMismatch", map[string]string{
				"name": name, "running": remembered.SecretNames, "declared": secretNames,
			})
		}
	}
	if host.deps.Dial == nil {
		return Open{}, false, nil
	}
	if remembered.ProcessLabel != host.deps.ProcessLabel ||
		(version != "" && remembered.Version != version) || (path != "" && remembered.Path != path) {
		// The unit runs another program than the record now names: it is ended, and the caller
		// starts the recorded program once nothing answers at the old address.
		_ = signalPID(remembered.PID)
		host.awaitGone(remembered.Address)
		host.forget(name)
		return Open{}, false, nil
	}

	conn, err := host.deps.Dial(remembered.Address)
	if err != nil {
		// Nothing is listening there. The record is a unit that has gone.
		host.forget(name)
		return Open{}, false, nil
	}
	open := Open{Name: name, Address: remembered.Address, Protocol: remembered.Protocol, PID: remembered.PID, Version: remembered.Version, ProcessLabel: remembered.ProcessLabel}
	held := &unit{open: open, stderr: newRing(64), token: remembered.Token, adopted: true, secretNames: secretNames, path: remembered.Path}

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

// awaitGone returns once nothing accepts a connection at address, or after the ready deadline.
func (host *Host) awaitGone(address string) {
	deadline := time.Now().Add(host.deps.ReadyWithin)
	for time.Now().Before(deadline) {
		conn, err := host.deps.Dial(address)
		if err != nil {
			return
		}
		_ = conn.Close()
		time.Sleep(50 * time.Millisecond)
	}
}
