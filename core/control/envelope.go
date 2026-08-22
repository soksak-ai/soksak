package control

import (
	"encoding/json"
	"fmt"

	controlwire "github.com/soksak-ai/soksak-contract-control"
	"github.com/soksak-ai/soksak-core/core/i18n"
)

// Protocol is the wire version this build speaks.
//
// A client requesting a version this build does not have is refused during
// the greeting rather than at the first command that behaves differently: a
// mismatch discovered halfway through a session has already produced answers
// the caller trusted.
// The wire is the contract's, and this package answers on it.
//
// Protocol, Request, Response, Greeting and the answer shape are declared in
// the public contract because more than one thing speaks them: this application and every sidecar
// that answers on its own socket. A wire defined here would make each of those copy
// it, and two copies diverge without failing — they arrive as a different
// answer.
//
// They are aliases rather than wrappers so a value crossing this boundary is
// the same value, and so nothing in this repository had to change spelling when
// the wire moved out.
const Protocol = controlwire.Protocol

// HelloCommand is the greeting's name. It is reserved: a feature package that
// registered it would replace the negotiation with something that answers
// differently.
const HelloCommand = controlwire.HelloCommand

type (
	Request     = controlwire.Request
	Response    = controlwire.Response
	Greeting    = controlwire.Greeting
	PlaneAnswer = controlwire.Answer
)

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
