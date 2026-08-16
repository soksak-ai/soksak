package control

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// shortDir answers a temporary directory short enough to hold a unix socket.
//
// A socket path is bounded by the platform — 104 bytes on darwin, 108 on linux
// — and t.TempDir() spells the test's own name into the path, so the longer
// test names here overrun it and bind fails with "invalid argument".
func shortDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "sok")
	if err != nil {
		t.Fatalf("temporary directory: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

// served starts a listener on a unix socket in a temporary directory and
// answers on it. The socket is real because the framing rules — one line in,
// one line out — are only true of a stream.
func served(t *testing.T, registry *Registry) net.Conn {
	t.Helper()
	path := filepath.Join(shortDir(t), "s.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("listening: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() { _ = Serve(listener, registry, "com.soksak.test") }()

	client, err := net.Dial("unix", path)
	if err != nil {
		t.Fatalf("dialling: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

// planeData is the value inside a control-plane answer. Every answer has one shape — `{code, data}`
// — so a test that wants the value unwraps it here rather than in each assertion.
func planeData(result any) any {
	envelope, ok := result.(map[string]any)
	if !ok {
		return result
	}
	return envelope["data"]
}

func send(t *testing.T, client net.Conn, lines ...string) []Response {
	t.Helper()
	for _, line := range lines {
		if _, err := client.Write([]byte(line + "\n")); err != nil {
			t.Fatalf("writing: %v", err)
		}
	}
	reader := bufio.NewReader(client)
	answers := make([]Response, 0, len(lines))
	for range lines {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			t.Fatalf("reading: %v", err)
		}
		var answer Response
		if err := json.Unmarshal(line, &answer); err != nil {
			t.Fatalf("decoding %q: %v", line, err)
		}
		answers = append(answers, answer)
	}
	return answers
}

func TestOneLineInOneLineOut(t *testing.T) {
	client := served(t, registryWithEcho(t))

	answers := send(t, client,
		`{"id":"1","command":"echo","args":{"word":"one"}}`,
		`{"id":"2","command":"echo","args":{"word":"two"}}`,
	)

	if answers[0].ID != "1" || planeData(answers[0].Result) != "one" {
		t.Errorf("first = %+v", answers[0])
	}
	if answers[1].ID != "2" || planeData(answers[1].Result) != "two" {
		t.Errorf("second = %+v", answers[1])
	}
}

func TestAnswersComeBackInTheOrderTheyWereAsked(t *testing.T) {
	// "create then place" means that order. The id matches answers to
	// requests; it does not license reordering them.
	client := served(t, registryWithEcho(t))

	var lines []string
	for _, word := range []string{"a", "b", "c", "d", "e"} {
		lines = append(lines, `{"id":"`+word+`","command":"echo","args":{"word":"`+word+`"}}`)
	}
	answers := send(t, client, lines...)

	got := make([]string, 0, len(answers))
	for _, answer := range answers {
		got = append(got, answer.ID)
	}
	if strings.Join(got, "") != "abcde" {
		t.Errorf("answers arrived as %v", got)
	}
}

func TestAMalformedLineIsAnsweredRatherThanIgnored(t *testing.T) {
	// Silence would leave a client unable to tell a bad request from a command
	// that hangs, and it would wait for the wrong reason.
	client := served(t, registryWithEcho(t))

	answers := send(t, client, `{not json`)
	if answers[0].Ok {
		t.Fatal("a malformed line succeeded")
	}
	if !strings.Contains(answers[0].Error, "JSON") {
		t.Errorf("error = %q", answers[0].Error)
	}
}

func TestAMalformedLineDoesNotEndTheConversation(t *testing.T) {
	// One bad line is one bad request. Dropping the connection would take
	// unrelated in-flight work with it.
	client := served(t, registryWithEcho(t))

	answers := send(t, client,
		`{not json`,
		`{"id":"2","command":"echo","args":{"word":"still here"}}`,
	)
	if planeData(answers[1].Result) != "still here" {
		t.Errorf("the connection did not survive a bad line: %+v", answers[1])
	}
}

func TestTwoClientsReachTheSameRegistry(t *testing.T) {
	registry := NewRegistry()
	seen := 0
	registry.MustRegister(Command{
		Name:    "count",
		Handler: func(Args) (any, error) { seen++; return seen, nil },
	})

	path := filepath.Join(shortDir(t), "s.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("listening: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() { _ = Serve(listener, registry, "com.soksak.test") }()

	for _, want := range []float64{1, 2} {
		client, err := net.Dial("unix", path)
		if err != nil {
			t.Fatalf("dialling: %v", err)
		}
		answers := send(t, client, `{"id":"1","command":"count"}`)
		if planeData(answers[0].Result) != want {
			t.Errorf("a second connection answered %v, want %v — two registries",
				planeData(answers[0].Result), want)
		}
		_ = client.Close()
	}
}

func TestClosingTheListenerEndsServe(t *testing.T) {
	path := filepath.Join(shortDir(t), "s.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("listening: %v", err)
	}
	stopped := make(chan error, 1)
	go func() { stopped <- Serve(listener, NewRegistry(), "com.soksak.test") }()

	if err := listener.Close(); err != nil {
		t.Fatalf("closing: %v", err)
	}
	// A closed listener is how this stops. If it were an error, every clean
	// shutdown would log one.
	if err := <-stopped; err != nil {
		t.Errorf("Serve returned %v after a clean close", err)
	}
}

func TestAnOverlongLineDoesNotTakeTheProcessDown(t *testing.T) {
	// A client that never sends a newline would otherwise grow the reader until
	// the process dies — a control plane killable by its own socket.
	//
	// The oversized conversation ends: a truncated line cannot be resynced, and
	// reading its tail as new requests would run commands nobody sent. What
	// must survive is the process, so that is what this asserts.
	registry := registryWithEcho(t)
	path := filepath.Join(shortDir(t), "s.sock")
	listener, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("listening: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() { _ = Serve(listener, registry, "com.soksak.test") }()

	flooder, err := net.Dial("unix", path)
	if err != nil {
		t.Fatalf("dialling: %v", err)
	}
	huge := `{"id":"1","command":"echo","args":{"word":"` + strings.Repeat("x", maxRequestBytes+16) + `"}}`
	// The write may fail partway, because the server stops reading as soon as
	// the line is too long. That is the refusal, not a test failure.
	_, _ = flooder.Write([]byte(huge + "\n"))
	_ = flooder.Close()

	next, err := net.Dial("unix", path)
	if err != nil {
		t.Fatalf("the listener stopped accepting after an oversized request: %v", err)
	}
	t.Cleanup(func() { _ = next.Close() })

	answers := send(t, next, `{"id":"2","command":"echo","args":{"word":"alive"}}`)
	// One shape for every answer on this plane: a command this process serves answers
	// `{code, data}`, the same as a window's.
	if planeData(answers[0].Result) != "alive" {
		t.Errorf("after an oversized request the plane answered %+v", answers[0])
	}
}
