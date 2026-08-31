package application

import (
	"bytes"
	"io"
	"testing"
	"time"

	controlwire "github.com/soksak-ai/soksak-contract-control"
	ptycontract "github.com/soksak-ai/soksak-contract-pty"
	"github.com/soksak-ai/soksak-core/core/sidecar"
)

type processObserverUnits struct {
	started func(sidecar.Open)
	streams int
	name    string
}

func (units *processObserverUnits) ObserveStarted(listener func(sidecar.Open)) func() {
	units.started = listener
	return func() { units.started = nil }
}

func (units *processObserverUnits) Stream(name string, request controlwire.Request) (
	controlwire.Response, io.ReadCloser, error,
) {
	units.streams++
	units.name = name
	event := `{"revision":2,"kind":"started","process":{"id":"pty-session-2","owner":"fixture-project-sidecar-pty","pid":42,"parentPid":7,"command":"/bin/zsh -l","state":"running","startedAtUnixMs":10}}` + "\n"
	return controlwire.Response{Ok: true}, io.NopCloser(bytes.NewBufferString(event)), nil
}

func TestPTYProcessObserverRelaysThePublicEventStream(t *testing.T) {
	units := &processObserverUnits{}
	received := make(chan ptycontract.ProcessEvent, 1)
	stop := observeTerminalProcessEvents(units, func() (terminalProcessOwner, error) {
		return terminalProcessOwner{Unit: fixturePTYUnit, Owner: fixturePTYOwner}, nil
	}, func(name string, payload any) {
		if name != "process-inventory-changed" {
			t.Errorf("event name = %q", name)
			return
		}
		received <- payload.(ptycontract.ProcessEvent)
	})
	defer stop()
	if units.started == nil {
		t.Fatal("observer did not subscribe to unit starts")
	}
	units.started(sidecar.Open{Name: fixturePTYUnit})
	select {
	case event := <-received:
		if units.streams != 1 || units.name != fixturePTYUnit || event.Revision != 2 || event.Process.ID != "pty-session-2" {
			t.Fatalf("streams=%d event=%+v", units.streams, event)
		}
	case <-time.After(time.Second):
		t.Fatal("process event was not relayed")
	}
}
