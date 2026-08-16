package control

import (
	"encoding/json"
	"fmt"

	"github.com/soksak/soksak-core/core/i18n"
)

// Protocol is the wire version this build speaks.
//
// A client requesting a version this build does not have is refused during
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
	// Language is the language this caller reads. Empty means the language
	// agreed in the greeting, and no greeting means English.
	//
	// It rides on the request rather than only on the connection because one
	// process serves several readers: a window, a `sok` invocation and a
	// sidecar share a build, and the language is the asker's, not the socket's.
	Language string `json:"language,omitempty"`
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
	// receives that at the greeting rather than through surprising answers.
	Identity string `json:"identity"`
	// Commands is what this build serves and refuses, with reasons. Sent in the
	// greeting because a client that must ask separately will act on a name it
	// has not checked.
	Commands Table `json:"commands"`
	// Language is what this build will answer in for this session, and
	// Languages is everything it serves. A client that asked for one this build
	// does not have is told here, rather than receiving sentences that quietly
	// stayed English.
	Language  string   `json:"language"`
	Languages []string `json:"languages"`
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

	language, err := i18n.ParseLanguage(request.Language)
	if err != nil {
		return Response{ID: request.ID, Error: err.Error()}
	}

	args := make(Args, len(request.Args))
	for name, raw := range request.Args {
		args[name] = raw
	}
	// Stamped so a delegated command answers in the caller's language too. Rendering here covers
	// only what this process wrote; a window builds its own sentences and cannot see the request.
	//
	// The window the caller named is theirs to name over a 0600 socket, so it passes through as
	// sent rather than being overwritten with nothing.
	var window string
	if raw, named := args[CallerWindowArgument]; named {
		_ = json.Unmarshal(raw, &window)
	}
	result, err := registry.InvokeFrom(Caller{Window: window, Language: language}, request.Command, args)
	if err != nil {
		// Rendered here, at the edge, because this is the first place with the
		// reader in hand. A handler that formatted the sentence itself would have
		// picked a language before the caller was known.
		return Response{ID: request.ID, Error: i18n.Render(err, language)}
	}
	return Response{ID: request.ID, Ok: true, Result: answerOf(registry, request.Command, result)}
}

// PlaneAnswer is the shape every control-plane answer has.
//
// A command handled in this process returns its value, and a window's command answers its own
// envelope — `{ok, code, data, message, hint}` — which the relay passes through whole. Two shapes
// reached the socket and nothing in the answer said which one it was, so a client had to know who
// owned each command to parse it. Measured 2026-08-17: two readings in one session were taken
// against the wrong shape and reported the opposite of what was on screen.
//
// The in-process caller is a different audience and keeps the value: a window calling `invoke` names
// the command and has its type at the call site. This shape is for the plane whose caller is
// generic.
type PlaneAnswer struct {
	Code string `json:"code"`
	Data any    `json:"data"`
}

// answerOf gives a locally handled result the shape a window's answer already has. Which it is comes
// from the registry, not from looking at the value.
func answerOf(registry *Registry, command string, result any) any {
	if !registry.ServesLocally(command) {
		return result
	}
	return PlaneAnswer{Code: "OK", Data: result}
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
	language, err := i18n.ParseLanguage(request.Language)
	if err != nil {
		return Response{ID: request.ID, Error: err.Error()}
	}
	served := make([]string, 0, len(i18n.Known()))
	for _, known := range i18n.Known() {
		served = append(served, string(known))
	}
	return Response{ID: request.ID, Ok: true, Result: Greeting{
		Protocol:  Protocol,
		Identity:  identity,
		Commands:  registry.Describe(),
		Language:  string(language),
		Languages: served,
	}}
}
