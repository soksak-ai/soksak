package main

import (
	"reflect"
	"testing"
)

func TestHelpRequestsOneDiscoverableCommandDocument(t *testing.T) {
	request, err := requestFrom([]string{"help", "window.snapshot"})
	if err != nil {
		t.Fatalf("parse help: %v", err)
	}
	if request.Command != "command.docs" {
		t.Fatalf("help command = %q, want command.docs", request.Command)
	}
	if got := string(request.Args["name"]); got != `"window.snapshot"` {
		t.Fatalf("help name = %s, want window.snapshot", got)
	}
	if _, targeted := request.Args["window"]; targeted {
		t.Fatal("help is pinned to one window instead of a renderer that declares command.docs")
	}
}

func TestHelpRequiresExactlyOneCommandName(t *testing.T) {
	for _, argv := range [][]string{{"help"}, {"help", "window.snapshot", "extra"}} {
		if _, err := requestFrom(argv); err == nil {
			t.Fatalf("requestFrom(%v) accepted an ambiguous help request", argv)
		}
	}
}

func TestJSONObjectAndNameValueProduceTheSameRequest(t *testing.T) {
	jsonRequest, err := requestFrom([]string{"plugin.source.set", "{\"id\":\"demo\",\"source\":\"development\",\"revision\":3}"})
	if err != nil {
		t.Fatal(err)
	}
	parameterRequest, err := requestFrom([]string{"plugin.source.set", "id=demo", "source=development", "revision=3"})
	if err != nil {
		t.Fatal(err)
	}
	if jsonRequest.Command != parameterRequest.Command || !reflect.DeepEqual(jsonRequest.Args, parameterRequest.Args) {
		t.Fatalf("json=%+v parameters=%+v", jsonRequest, parameterRequest)
	}
}

func TestJSONObjectAndNameValueCannotBeMixed(t *testing.T) {
	if _, err := requestFrom([]string{"plugin.source.set", "{\"id\":\"demo\"}", "source=development"}); err == nil {
		t.Fatal("mixed JSON object and name=value arguments were accepted")
	}
}

func TestJSONObjectMustContainAnObject(t *testing.T) {
	for _, value := range []string{"null", "[]", "\"text\""} {
		if _, err := requestFrom([]string{"plugin.source.set", value}); err == nil {
			t.Errorf("accepted %s", value)
		}
	}
}
