package application

import (
	"testing"

	controlwire "github.com/soksak-ai/soksak-contract-control"
	ptycontract "github.com/soksak-ai/soksak-contract-pty"
	"github.com/soksak-ai/soksak-core/core/sidecar"
)

type inventoryUnitHost struct {
	started bool
	result  controlwire.Response
	called  string
}

func (host *inventoryUnitHost) Start(string) (sidecar.Open, error) {
	panic("process inventory must not start a sidecar")
}
func (host *inventoryUnitHost) Send(name string, request controlwire.Request) (controlwire.Response, error) {
	host.called = name + ":" + request.Command
	return host.result, nil
}
func (host *inventoryUnitHost) Started() []sidecar.Open {
	if !host.started {
		return nil
	}
	return []sidecar.Open{{Name: ptycontract.SidecarName, Version: "0.0.1"}}
}

func TestTerminalProcessInventoryReadsThePublicPTYWireWithoutStartingIt(t *testing.T) {
	host := &inventoryUnitHost{started: true, result: controlwire.Response{Ok: true, Result: controlwire.Answer{
		Code: "OK", Data: ptycontract.ProcessInventory{Revision: 4, Processes: []ptycontract.Process{{ID: "pty-session-7", Owner: ptycontract.SidecarName, PID: 123, State: "running"}}},
	}}}
	source := terminalProcessInventorySource{units: host}
	got, err := source.Inventory()
	if err != nil {
		t.Fatal(err)
	}
	if host.called != ptycontract.SidecarName+":"+ptycontract.CommandProcessInventory {
		t.Fatalf("call=%q", host.called)
	}
	if got.Owner != ptycontract.SidecarName || got.Revision != 4 || len(got.Processes) != 1 || got.Processes[0].PID != 123 {
		t.Fatalf("inventory=%+v", got)
	}
}

func TestTerminalProcessInventoryDoesNotStartAnAbsentPTYOwner(t *testing.T) {
	host := &inventoryUnitHost{}
	got, err := (terminalProcessInventorySource{units: host}).Inventory()
	if err != nil {
		t.Fatal(err)
	}
	if host.called != "" || got.Owner != ptycontract.SidecarName || got.Revision != 0 || len(got.Processes) != 0 {
		t.Fatalf("host call=%q inventory=%+v", host.called, got)
	}
}
