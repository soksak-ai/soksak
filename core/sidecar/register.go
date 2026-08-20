package sidecar

import (
	"encoding/json"

	controlwire "github.com/soksak/soksak-contract-control"
	"github.com/soksak/soksak-core/core/control"
	"github.com/soksak/soksak-core/core/i18n"
)

// The surface a declared unit is received through.
//
// Six names, and what they are for is one thing: a plugin declares a unit in its manifest, and
// these open the one it declared and nothing else. The declaration is checked here
// rather than trusted, because "declared equals actual" is the only thing standing between a
// manifest a person consented to and a process this application starts.
//
// Nothing here reads a payload. A request goes out as it arrived and an answer comes back as it was
// given: the meaning is the plugin's contract with its unit, and a surface that understood it would
// need editing for every unit anyone writes.

// Deps for registration. Each field is something this package refuses to derive.
type Registration struct {
	Host *Host
	// Provided answers what the installed unit states it implements. Nil means this build cannot
	// check declared against actual, and the commands say so rather than checking nothing quietly.
	//
	// What was *declared* arrives with the open request instead of being read here. The manifest is
	// the caller's, and the caller's API object was built from that manifest and no other — so a
	// plugin can only ask about a unit its own manifest names. Reading manifests here as well would
	// be a second source for one fact.
	Provided func(unit string) (Provided, error)
	// Sink is where a unit's stream bytes arrive for the caller. Nil means this host has no stream,
	// and `sidecar_stream` is declared unserved rather than opening a connection whose output has
	// nowhere to go — a unit writing into nothing blocks, and what that looks like is a unit that
	// stopped.
	Sink Sink
}

// streamUnserved is why both stream names refuse when this host has no sink.
//
// Opening the connection anyway would leave a unit writing into nothing, and a unit blocked on a full
// buffer is indistinguishable from a unit that stopped.
const streamUnserved = "this host carries no stream for a unit's output to arrive on"

// Requirement is a contract a plugin asked for: an id and one exact version.
type Requirement struct {
	ID    string `json:"id"`
	Range string `json:"range"`
}

// Provided is a contract an installed unit states it implements.
type Provided struct {
	ID      string `json:"id"`
	Version string `json:"version"`
}

// Names is every command this group owns, served or not.
//
// A build with no host registers none of them, and the difference between "this build starts no
// units" and "this build forgot a command" is only visible if the names are still declared.
func Names() []string {
	return []string{"sidecar_open", "sidecar_send", "sidecar_stream", "sidecar_stream_close", "sidecar_close", "sidecar_status"}
}

// Register puts this group on the registry.
//
// A missing dependency refuses by name rather than being absent: a caller that receives "unknown
// command" cannot tell a capability this build does not have from a name it typed wrong.
func Register(registry *control.Registry, deps Registration) {
	declare := func(name, reason string) {
		if err := registry.DeclareUnserved(name, reason); err != nil {
			panic(err)
		}
	}
	serve := func(name string, handler control.Handler) {
		registry.MustRegister(control.Command{Name: name, Owner: control.OwnerCore, Handler: handler})
	}

	// One reason, and it names what is missing rather than that something is.
	if deps.Host == nil || deps.Provided == nil {
		reason := "this build was given no way to start a unit, or no way to read what an " +
			"installed unit provides"
		for _, name := range Names() {
			declare(name, reason)
		}
		return
	}

	serve("sidecar_open", func(args control.Args) (any, error) {
		name, err := control.Arg[string](args, "name")
		if err != nil {
			return nil, err
		}
		requirement, err := control.Arg[Requirement](args, "requirement")
		if err != nil {
			return nil, err
		}
		return deps.openDeclared(name, requirement)
	})

	serve("sidecar_send", func(args control.Args) (any, error) {
		name, err := control.Arg[string](args, "name")
		if err != nil {
			return nil, err
		}
		payload, err := control.Arg[string](args, "payload")
		if err != nil {
			return nil, err
		}
		var request controlwire.Request
		if err := json.Unmarshal([]byte(payload), &request); err != nil {
			return nil, i18n.Errorf("sidecar.payloadNotARequest", map[string]string{
				"name": name, "reason": err.Error(),
			})
		}
		return deps.Host.Send(name, request)
	})

	if deps.Sink == nil {
		declare("sidecar_stream", streamUnserved)
		declare("sidecar_stream_close", streamUnserved)
	} else {
		serve("sidecar_stream", func(args control.Args) (any, error) {
			name, err := control.Arg[string](args, "name")
			if err != nil {
				return nil, err
			}
			stream, err := control.Arg[string](args, "stream")
			if err != nil {
				return nil, err
			}
			payload, err := control.Arg[string](args, "payload")
			if err != nil {
				return nil, err
			}
			var request controlwire.Request
			if err := json.Unmarshal([]byte(payload), &request); err != nil {
				return nil, i18n.Errorf("sidecar.payloadNotARequest", map[string]string{
					"name": name, "reason": err.Error(),
				})
			}
			answer, bytes, err := deps.Host.Stream(name, request)
			if err != nil {
				return nil, err
			}
			// A refused request leaves no connection. Answering as though a stream had opened would
			// make a refusal read as a session that produced nothing.
			if bytes == nil {
				return answer, nil
			}
			deps.Host.openStream(stream, bytes)
			go func() {
				pump(bytes, deps.Sink, stream, DefaultReadSize)
				deps.Host.forgetStream(stream)
			}()
			return answer, nil
		})

		serve("sidecar_stream_close", func(args control.Args) (any, error) {
			stream, err := control.Arg[string](args, "stream")
			if err != nil {
				return nil, err
			}
			deps.Host.CloseStream(stream)
			return map[string]any{"stream": stream, "open": false}, nil
		})
	}

	serve("sidecar_close", func(args control.Args) (any, error) {
		name, err := control.Arg[string](args, "name")
		if err != nil {
			return nil, err
		}
		if err := deps.Host.Stop(name); err != nil {
			return nil, err
		}
		return map[string]any{"name": name, "open": false}, nil
	})

	serve("sidecar_status", func(control.Args) (any, error) {
		return map[string]any{"open": deps.Host.Started()}, nil
	})
}

// openDeclared starts a unit only when the manifest declared it and the unit implements what was
// declared.
//
// Both halves are checked. A name nobody declared is a process a person never consented to, and a
// unit implementing a different contract answers a plugin's request with something else's semantics
// — which does not fail, it arrives as a different answer.
func (deps Registration) openDeclared(name string, requirement Requirement) (Open, error) {
	provided, err := deps.Provided(name)
	if err != nil {
		return Open{}, err
	}
	if provided.ID != requirement.ID {
		return Open{}, i18n.Errorf("sidecar.contractMismatch", map[string]string{
			"name": name, "wanted": requirement.ID, "found": provided.ID,
		})
	}
	if provided.Version != requirement.Range {
		return Open{}, i18n.Errorf("sidecar.versionMismatch", map[string]string{
			"name": name, "wanted": requirement.ID, "wanted2": requirement.Range, "found": provided.Version,
		})
	}
	return deps.Host.Start(name)
}
