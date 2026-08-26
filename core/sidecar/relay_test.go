package sidecar

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"testing"

	controlwire "github.com/soksak-ai/soksak-contract-control"
	"time"
)

// memoryUnit answers every request on a connection under the id it arrived with. closeAfter > 0
// ends the connection from the unit's side after that many non-greeting answers.
type memoryUnit struct {
	dials      atomic.Int32
	greetings  atomic.Int32
	closeAfter int
	// silent answers the greeting and then nothing, as a unit that took the request and stopped.
	silent bool
}

func (fake *memoryUnit) dial(string) (io.ReadWriteCloser, error) {
	fake.dials.Add(1)
	ours, theirs := net.Pipe()
	go fake.serve(theirs)
	return ours, nil
}

func (fake *memoryUnit) serve(conn net.Conn) {
	defer func() { _ = conn.Close() }()
	reader := bufio.NewReader(conn)
	answered := 0
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			return
		}
		var request controlwire.Request
		if err := json.Unmarshal(line, &request); err != nil {
			return
		}
		if request.Command == controlwire.HelloCommand {
			fake.greetings.Add(1)
		}
		if fake.silent && request.Command != controlwire.HelloCommand {
			// Takes the request and answers nothing.
			continue
		}
		answer, _ := json.Marshal(controlwire.Response{
			ID: request.ID, Ok: true, Result: map[string]any{"command": request.Command},
		})
		if _, err := conn.Write(append(answer, '\n')); err != nil {
			return
		}
		if request.Command == controlwire.HelloCommand {
			continue
		}
		answered++
		if fake.closeAfter > 0 && answered >= fake.closeAfter {
			return
		}
	}
}

func relayHost(fake *memoryUnit) *Host {
	host := NewHost(Deps{Dial: fake.dial})
	host.open["unit"] = &unit{open: Open{Name: "unit", Address: "memory"}, token: "token"}
	return host
}

func TestTwoRequestsReuseOneConnection(t *testing.T) {
	fake := &memoryUnit{}
	host := relayHost(fake)
	t.Cleanup(func() { _ = host.ServiceShutdown() })

	for _, id := range []string{"first", "second"} {
		answer, err := host.Send("unit", controlwire.Request{ID: id, Command: "fake-unit.echo"})
		if err != nil {
			t.Fatalf("send %s: %v", id, err)
		}
		if !answer.Ok || answer.ID != id {
			t.Fatalf("answer to %s = %+v", id, answer)
		}
	}
	if dials := fake.dials.Load(); dials != 1 {
		t.Fatalf("two requests opened %d connections", dials)
	}
	if greetings := fake.greetings.Load(); greetings != 1 {
		t.Fatalf("one connection was greeted %d times", greetings)
	}

	// Overlapping callers share the connection and each gets its own answer under its own id.
	var wait sync.WaitGroup
	failures := make(chan error, 8)
	for index := range 8 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			id := fmt.Sprintf("overlap-%d", index)
			answer, err := host.Send("unit", controlwire.Request{ID: id, Command: "fake-unit.echo"})
			if err != nil {
				failures <- err
				return
			}
			if answer.ID != id {
				failures <- fmt.Errorf("request %s was answered as %s", id, answer.ID)
			}
		}()
	}
	wait.Wait()
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	if dials := fake.dials.Load(); dials != 1 {
		t.Fatalf("overlapping requests opened %d connections", dials)
	}
}

func TestReconnectsAfterTheUnitCloses(t *testing.T) {
	fake := &memoryUnit{closeAfter: 1}
	host := relayHost(fake)
	t.Cleanup(func() { _ = host.ServiceShutdown() })

	first, err := host.Send("unit", controlwire.Request{ID: "1", Command: "fake-unit.echo"})
	if err != nil || !first.Ok || first.ID != "1" {
		t.Fatalf("first send: answer=%+v err=%v", first, err)
	}
	// The unit closed its side after answering. The next request opens and greets a new connection
	// rather than waiting on the one nobody is on.
	second, err := host.Send("unit", controlwire.Request{ID: "2", Command: "fake-unit.echo"})
	if err != nil || !second.Ok || second.ID != "2" {
		t.Fatalf("send after the unit closed: answer=%+v err=%v", second, err)
	}
	if dials := fake.dials.Load(); dials != 2 {
		t.Fatalf("expected one reconnect, saw %d connections", dials)
	}
	if greetings := fake.greetings.Load(); greetings != 2 {
		t.Fatalf("the reconnected connection was greeted %d times in total", greetings)
	}
	// Stopping the unit ends the held connection; a later send finds none open.
	if err := host.Stop("unit"); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if _, err := host.Send("unit", controlwire.Request{ID: "3", Command: "fake-unit.echo"}); err == nil {
		t.Fatal("a send after stop was answered")
	}
}

// A unit that takes a request and answers nothing must not hold the caller. Waiting without end is
// how one silent unit stops every caller behind it: the plugin that asked, the queue behind that
// plugin, and the person typing into it.
func TestARequestThatIsNeverAnsweredEnds(t *testing.T) {
	fake := &memoryUnit{silent: true}
	host := relayHost(fake)
	host.answerWithin = 300 * time.Millisecond

	started := time.Now()
	_, err := host.Send("unit", controlwire.Request{ID: "1", Command: "probe"})
	if err == nil {
		t.Fatal("a request nobody answered was reported as answered")
	}
	if waited := time.Since(started); waited > 3*time.Second {
		t.Fatalf("the caller waited %v", waited)
	}
}
