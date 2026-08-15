package control

import (
	"encoding/json"
	"fmt"
)

// Protocol is the wire version this build speaks.
//
// A client that asks for a version this build does not have is refused during
// the greeting rather than at the first command that behaves differently: a
// mismatch discovered halfway through a session has already produced answers
// the caller trusted.
const Protocol = 1

// Request is one command, as it arrives on the wire.
//
// The envelope is one line of JSON because the transport is a byte stream with
// no framing of its own, and a length prefix would make the socket unreadable
// by hand — which is the difference between a control plane someone can
// operate and one they can only write a client for.
type Request struct {
	// ID is echoed on the answer. The caller chooses it; this build never
	// interprets it, so a client may pipeline and match on its own terms.
	ID string `json:"id"`
	// Command names a registry entry. Nothing outside the registry exists.
	Command string `json:"command"`
	// Args are the command's arguments, still encoded. Decoding happens per
	// command, so this boundary never has to know their shapes.
	Args map[string]json.RawMessage `json:"args,omitempty"`
}

// Response is one answer.
//
// Ok is explicit rather than inferred from Error being empty: a command whose
// result is null and one that failed with an empty message would otherwise be
// the same three bytes on the wire.
type Response struct {
	ID     string `json:"id"`
	Ok     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

// Greeting is what system.hello answers.
type Greeting struct {
	// Protocol is what this build speaks, which the client compares to what it
	// asked for.
	Protocol int `json:"protocol"`
	// Identity names the installation, so a client that found the wrong socket
	// learns that from the greeting rather than from surprising answers.
	Identity string `json:"identity"`
	// Commands is what this build serves and refuses, with reasons. Sent in the
	// greeting because a client that must ask separately will act on a name it
	// has not checked.
	Commands Table `json:"commands"`
}

// HelloCommand is the greeting's name. It is reserved: a feature package that
// registered it would replace the negotiation with something that answers
// differently.
const HelloCommand = "system.hello"

// Answer runs one request against the registry and builds its response.
//
// The transport calls this. It performs no I/O, so the rules it holds — the id
// echo, the reserved greeting, the refusal of an unnamed command — are the same
// over a socket, a pipe, or a test.
func Answer(registry *Registry, identity string, request Request) Response {
	if request.Command == "" {
		return Response{ID: request.ID, Error: "the request named no command"}
	}

	if request.Command == HelloCommand {
		return greet(registry, identity, request)
	}

	args := make(Args, len(request.Args))
	for name, raw := range request.Args {
		args[name] = raw
	}
	result, err := registry.Invoke(request.Command, args)
	if err != nil {
		return Response{ID: request.ID, Error: err.Error()}
	}
	return Response{ID: request.ID, Ok: true, Result: result}
}

func greet(registry *Registry, identity string, request Request) Response {
	if raw, asked := request.Args["protocol"]; asked {
		var wanted int
		if err := json.Unmarshal(raw, &wanted); err != nil {
			return Response{ID: request.ID, Error: fmt.Sprintf("argument %q: %v", "protocol", err)}
		}
		if wanted != Protocol {
			return Response{ID: request.ID, Error: fmt.Sprintf(
				"this build speaks protocol %d and the client asked for %d", Protocol, wanted)}
		}
	}
	return Response{ID: request.ID, Ok: true, Result: Greeting{
		Protocol: Protocol,
		Identity: identity,
		Commands: registry.Describe(),
	}}
}
