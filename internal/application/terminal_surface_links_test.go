package application

import (
	"testing"

	controlwire "github.com/soksak-ai/soksak-contract-control"
	"github.com/soksak-ai/soksak-core/core/sidecar"
)

type recordedTerminalUnitHost struct {
	calls []string
}

func (host *recordedTerminalUnitHost) Start(name string) (sidecar.Open, error) {
	host.calls = append(host.calls, "start:"+name)
	return sidecar.Open{Name: name, Version: "0.0.1"}, nil
}

func (host *recordedTerminalUnitHost) Send(name string, request controlwire.Request) (controlwire.Response, error) {
	host.calls = append(host.calls, "send:"+name+":"+request.Command)
	return controlwire.Response{
		Ok: true,
		Result: controlwire.Answer{
			Code: "OK",
			Data: map[string]any{"held": true},
		},
	}, nil
}

func TestTerminalSurfaceExposesExactStartAndSendAsSeparateOperations(t *testing.T) {
	host := &recordedTerminalUnitHost{}
	links := terminalSurfaceLinks(host)
	if links.Start == nil {
		t.Fatal("terminal surface link exposes no exact unit starter")
	}
	if err := links.Start("fixture-pty-provider"); err != nil {
		t.Fatal(err)
	}
	if err := links.Start("soksak-sidecar-terminal-wezterm"); err != nil {
		t.Fatal(err)
	}
	answer, err := links.Send("soksak-sidecar-terminal-wezterm", "surface.state", map[string]any{"pane": "tab-a.1"})
	if err != nil {
		t.Fatal(err)
	}
	if answer["held"] != true {
		t.Fatalf("answer=%v", answer)
	}
	want := []string{
		"start:fixture-pty-provider",
		"start:soksak-sidecar-terminal-wezterm",
		"send:soksak-sidecar-terminal-wezterm:surface.state",
	}
	if len(host.calls) != len(want) {
		t.Fatalf("calls=%v want=%v", host.calls, want)
	}
	for index := range want {
		if host.calls[index] != want[index] {
			t.Fatalf("calls=%v want=%v", host.calls, want)
		}
	}
}
