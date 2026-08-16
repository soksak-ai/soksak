package control

import (
	"encoding/json"
	"strings"
	"testing"
)

func registryWithEcho(t *testing.T) *Registry {
	t.Helper()
	registry := NewRegistry()
	registry.MustRegister(Command{
		Name: "echo",
		Handler: func(args Args) (any, error) {
			word, err := Arg[string](args, "word")
			return word, err
		},
	})
	return registry
}

func TestTheAnswerCarriesTheCallersOwnID(t *testing.T) {
	// The caller matches answers to requests by this. Renumbering it, or
	// dropping it on the failure path, breaks a pipelining client precisely
	// when something already went wrong.
	for _, id := range []string{"1", "", "a-caller-chosen-id", "  spaced  "} {
		answer := Answer(registryWithEcho(t), "com.soksak.test", Request{ID: id, Command: "nope"})
		if answer.ID != id {
			t.Errorf("id %q came back as %q", id, answer.ID)
		}
	}
}

func TestAFailedCommandIsNotOk(t *testing.T) {
	answer := Answer(registryWithEcho(t), "com.soksak.test",
		Request{ID: "1", Command: "echo", Args: map[string]json.RawMessage{}})

	if answer.Ok {
		t.Fatal("a command that returned an error answered ok")
	}
	if !strings.Contains(answer.Error, "word") {
		t.Errorf("the error did not name the missing argument: %q", answer.Error)
	}
}

func TestASuccessfulNullResultIsStillOk(t *testing.T) {
	// Ok is carried rather than inferred: a command whose answer is null and a
	// command that failed with no message must not be the same three bytes.
	registry := NewRegistry()
	registry.MustRegister(Command{Name: "nothing", Handler: func(Args) (any, error) { return nil, nil }})

	answer := Answer(registry, "com.soksak.test", Request{ID: "1", Command: "nothing"})
	if !answer.Ok {
		t.Fatalf("a successful command answered not-ok: %+v", answer)
	}

	encoded, err := json.Marshal(answer)
	if err != nil {
		t.Fatalf("encoding: %v", err)
	}
	if !strings.Contains(string(encoded), `"ok":true`) {
		t.Errorf("the wire form lost the verdict: %s", encoded)
	}
}

func TestAnUnnamedCommandIsRefusedRatherThanLookedUp(t *testing.T) {
	answer := Answer(registryWithEcho(t), "com.soksak.test", Request{ID: "1"})
	if answer.Ok {
		t.Fatal("a request with no command name succeeded")
	}
}

func TestTheGreetingCarriesTheIdentityAndTheCommandTable(t *testing.T) {
	// A client that found the wrong socket must learn it here. Without the
	// identity it would find out from answers that are correct for another
	// installation.
	answer := Answer(registryWithEcho(t), "com.soksak.wails", Request{ID: "1", Command: HelloCommand})
	if !answer.Ok {
		t.Fatalf("the greeting failed: %+v", answer)
	}
	greeting, ok := answer.Result.(Greeting)
	if !ok {
		t.Fatalf("the greeting answered %T", answer.Result)
	}
	if greeting.Identity != "com.soksak.wails" {
		t.Errorf("identity = %q", greeting.Identity)
	}
	if greeting.Protocol != Protocol {
		t.Errorf("protocol = %d, want %d", greeting.Protocol, Protocol)
	}
	if len(greeting.Commands.Commands) == 0 {
		t.Error("the greeting carried no command table")
	}
}

func TestAProtocolMismatchIsRefusedAtTheGreeting(t *testing.T) {
	// Refused here rather than at the first command that behaves differently: a
	// mismatch found halfway through has already produced trusted answers.
	answer := Answer(registryWithEcho(t), "com.soksak.test", Request{
		ID:      "1",
		Command: HelloCommand,
		Args:    map[string]json.RawMessage{"protocol": json.RawMessage(`999`)},
	})
	if answer.Ok {
		t.Fatal("a client asking for protocol 999 was greeted")
	}
	if !strings.Contains(answer.Error, "999") {
		t.Errorf("the refusal did not say what was asked for: %q", answer.Error)
	}
}

func TestTheGreetingIsNotAnEntryAnyoneCanReplace(t *testing.T) {
	// A feature package that registered this name would replace the
	// negotiation with something that answers differently.
	registry := NewRegistry()
	registry.MustRegister(Command{
		Name:    HelloCommand,
		Handler: func(Args) (any, error) { return "not a greeting", nil },
	})

	answer := Answer(registry, "com.soksak.test", Request{ID: "1", Command: HelloCommand})
	if _, ok := answer.Result.(Greeting); !ok {
		t.Fatalf("a registered handler took over the greeting: %#v", answer.Result)
	}
}

func TestArgumentsReachTheHandlerStillEncoded(t *testing.T) {
	answer := Answer(registryWithEcho(t), "com.soksak.test", Request{
		ID:      "1",
		Command: "echo",
		Args:    map[string]json.RawMessage{"word": json.RawMessage(`"core"`)},
	})
	if !answer.Ok {
		t.Fatalf("echo failed: %+v", answer)
	}
	// Measured on the frontend door: encoding on the caller's side turns "core"
	// into "\"core\"". One encoding, and it happens where the value entered.
	// Every control-plane answer has one shape, so the value it was sent is under `data`.
	envelope, wrapped := answer.Result.(PlaneAnswer)
	if !wrapped || envelope.Data != "core" {
		t.Errorf("result = %#v, want the string it was sent under data", answer.Result)
	}
}
