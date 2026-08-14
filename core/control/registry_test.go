package control

import (
	"errors"
	"strings"
	"testing"
)

func TestInvokeRunsTheRegisteredCommand(t *testing.T) {
	registry := NewRegistry()
	registry.MustRegister(Command{Name: "app.ping", Handler: func(Args) (any, error) { return "pong", nil }})

	got, err := registry.Invoke("app.ping", nil)
	if err != nil || got != "pong" {
		t.Fatalf("invoke = %v, %v", got, err)
	}
}

func TestAnUnknownCommandFailsCarryingItsName(t *testing.T) {
	// The caller needs the name to tell which call failed, not that one did.
	_, err := NewRegistry().Invoke("app.missing", nil)
	if err == nil || !strings.Contains(err.Error(), "app.missing") {
		t.Fatalf("error = %v, want it to name the command", err)
	}
}

func TestARefusalCarriesItsReason(t *testing.T) {
	// "Not written yet" and "impossible here" must be distinguishable, or the
	// caller re-investigates settled ground.
	registry := NewRegistry()
	if err := registry.DeclareUnserved("window.capture", "capture needs a window"); err != nil {
		t.Fatalf("declaring: %v", err)
	}

	_, err := registry.Invoke("window.capture", nil)
	if err == nil || !strings.Contains(err.Error(), "capture needs a window") {
		t.Fatalf("error = %v, want the reason", err)
	}
}

func TestAReasonlessRefusalIsRefused(t *testing.T) {
	if err := NewRegistry().DeclareUnserved("window.capture", ""); err == nil {
		t.Fatal("an unserved command must state why")
	}
}

func TestOneNameHasOneOwner(t *testing.T) {
	// Two owners is a conflict, not a reload. Replacing would let a later
	// registration answer in an earlier one's place.
	registry := NewRegistry()
	registry.MustRegister(Command{Name: "app.ping", Handler: func(Args) (any, error) { return nil, nil }})

	err := registry.Register(Command{Name: "app.ping", Handler: func(Args) (any, error) { return nil, nil }})
	if err == nil || !strings.Contains(err.Error(), "app.ping") {
		t.Fatalf("error = %v, want a conflict naming the command", err)
	}
}

func TestTheTableReportsBothSides(t *testing.T) {
	registry := NewRegistry()
	registry.MustRegister(Command{Name: "app.environment", Handler: func(Args) (any, error) { return nil, nil }})
	registry.MustRegister(Command{Name: "window.snapshot", Owner: OwnerFramework, Handler: func(Args) (any, error) { return nil, nil }})
	_ = registry.DeclareUnserved("net.http", "no transport yet")

	table := registry.Describe()
	if len(table.Commands) != 2 || len(table.Unserved) != 1 {
		t.Fatalf("table = %+v", table)
	}
	// Sorted, so two readings compare without the caller ordering them.
	if table.Commands[0].Name != "app.environment" || table.Commands[1].Name != "window.snapshot" {
		t.Errorf("commands are not sorted: %+v", table.Commands)
	}
	if table.Commands[0].Owner != OwnerCore {
		t.Errorf("an undeclared owner must default to core, got %q", table.Commands[0].Owner)
	}
	if table.Commands[1].Owner != OwnerFramework {
		t.Errorf("owner = %q", table.Commands[1].Owner)
	}
	if table.Unserved[0].BlockedBy != "no transport yet" {
		t.Errorf("unserved = %+v", table.Unserved)
	}
}

func TestRegisteringAfterDeclaringUnservedServesIt(t *testing.T) {
	registry := NewRegistry()
	_ = registry.DeclareUnserved("app.ping", "not yet")
	registry.MustRegister(Command{Name: "app.ping", Handler: func(Args) (any, error) { return "pong", nil }})

	if got, err := registry.Invoke("app.ping", nil); err != nil || got != "pong" {
		t.Fatalf("invoke = %v, %v", got, err)
	}
	if len(registry.Describe().Unserved) != 0 {
		t.Error("a command that is now served must leave the unserved list")
	}
}

func TestAHandlerErrorReachesTheCaller(t *testing.T) {
	registry := NewRegistry()
	sentinel := errors.New("the disk is full")
	registry.MustRegister(Command{Name: "data.set", Handler: func(Args) (any, error) { return nil, sentinel }})

	if _, err := registry.Invoke("data.set", nil); !errors.Is(err, sentinel) {
		t.Fatalf("error = %v, want the handler's own", err)
	}
}
