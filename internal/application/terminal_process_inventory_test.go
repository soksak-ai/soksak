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

const (
	fixturePTYUnit  = "fixture-pty-component"
	fixturePTYOwner = "fixture-project-sidecar-pty"
)

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
	return []sidecar.Open{{Name: fixturePTYUnit, Version: "0.0.1"}}
}

func TestTerminalProcessInventoryReadsThePublicPTYWireWithoutStartingIt(t *testing.T) {
	host := &inventoryUnitHost{started: true, result: controlwire.Response{Ok: true, Result: controlwire.Answer{
		Code: "OK", Data: ptycontract.ProcessInventory{Revision: 4, Processes: []ptycontract.Process{{ID: "pty-session-7", Owner: fixturePTYOwner, PID: 123, State: "running"}}},
	}}}
	source := terminalProcessInventorySource{units: host, owner: func() (terminalProcessOwner, error) {
		return terminalProcessOwner{Unit: fixturePTYUnit, Owner: fixturePTYOwner}, nil
	}}
	got, err := source.Inventory()
	if err != nil {
		t.Fatal(err)
	}
	if host.called != fixturePTYUnit+":"+ptycontract.CommandProcessInventory {
		t.Fatalf("call=%q", host.called)
	}
	if got.Owner != fixturePTYOwner || got.Revision != 4 || len(got.Processes) != 1 || got.Processes[0].PID != 123 {
		t.Fatalf("inventory=%+v", got)
	}
}

func TestTerminalProcessInventoryDoesNotStartAnAbsentPTYOwner(t *testing.T) {
	host := &inventoryUnitHost{}
	got, err := (terminalProcessInventorySource{units: host, owner: func() (terminalProcessOwner, error) {
		return terminalProcessOwner{Unit: fixturePTYUnit, Owner: fixturePTYOwner}, nil
	}}).Inventory()
	if err != nil {
		t.Fatal(err)
	}
	if host.called != "" || got.Owner != fixturePTYOwner || got.Revision != 0 || len(got.Processes) != 0 {
		t.Fatalf("host call=%q inventory=%+v", host.called, got)
	}
}
