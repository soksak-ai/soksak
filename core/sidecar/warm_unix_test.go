//go:build !windows

package sidecar

import (
	"os"
	"testing"
	"time"

	"github.com/soksak-ai/soksak-core/core/process"
)

// What a unit held before the application went is still there when it comes back.
//
// This is the claim the whole shape rests on. A unit is a separate process so that shells outlive
// an application generation, and every piece under that — the record, the adoption, the release
// that is not an end — exists for this one reading. Each piece is tested on its own and none of
// them states that the thing they are for is true.
//
// Two hosts over one home stand in for two runs. What separates them is what separates two runs: an
// empty map, and whatever the first wrote down. The unit holds state across them, and it is that
// state — not a pid, not an address — that is checked, because a caller that reattached to a
// process which had forgotten everything would see a live session with a blank screen.
//
// It would have caught the release that ended units: this passes only while letting go leaves the
// unit running.
func TestWhatAUnitHeldSurvivesTheApplication(t *testing.T) {
	home := shortHome(t)
	runtimeRoot := shortHome(t)
	stageUnit(t, home, "keeper", keeperSource)
	deps := Deps{
		Home: home, Runtime: runtimeRoot, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 10 * time.Second, ResolvePath: testSidecarResolver(home),
	}

	// The first run puts something in and lets go.
	first := NewHost(deps)
	started, err := first.Start("keeper")
	if err != nil {
		t.Fatalf("starting the unit: %v", err)
	}
	for _, word := range []string{"one", "two", "three"} {
		if answer, err := first.Send("keeper", request("k", "keeper.keep", map[string]any{
			"request": map[string]any{"word": word},
		})); err != nil || !answer.Ok {
			t.Fatalf("keeping %q: %v %+v", word, err, answer)
		}
	}
	// The application quits — the path the host actually takes, not a Release the product never
	// calls. This is where it broke: the shutdown hook ended every unit, so a shell died with the
	// application it was meant to outlive, and the test above passed the whole time because it let
	// go by hand instead.
	if err := first.ServiceShutdown(); err != nil {
		t.Fatalf("the application's shutdown hook: %v", err)
	}

	// The second run finds it, and finds what it held.
	second := NewHost(deps)
	t.Cleanup(func() { second.StopAll() })
	found, err := second.Start("keeper")
	if err != nil {
		t.Fatalf("the second run could not reach the unit: %v", err)
	}
	if found.PID != started.PID {
		t.Fatalf("the second run is talking to a different process: %d then %d.\n"+
			"Whatever the first one held is unreachable, and this run would report a healthy session "+
			"with nothing in it.", started.PID, found.PID)
	}

	answer, err := second.Send("keeper", request("r", "keeper.recall", nil))
	if err != nil || !answer.Ok {
		t.Fatalf("recalling: %v %+v", err, answer)
	}
	var held struct {
		Words []string `json:"words"`
	}
	if err := answerData(answer, &held); err != nil {
		t.Fatal(err)
	}
	if len(held.Words) != 3 || held.Words[0] != "one" || held.Words[2] != "three" {
		t.Fatalf("the unit came back holding %v — a session that survived and forgot is a blank "+
			"screen somebody was working in", held.Words)
	}
}

// keeperSource is a unit that holds something across the runs that talk to it.
//
// It stands for a shell: what matters is not what it holds but that letting go of it, and finding it
// again, leaves what it held intact.
const keeperSource = `package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
)

func main() {
	flag.String("home", "", "")
	runtimeRoot := flag.String("runtime", "", "")
	flag.Parse()
	run := *runtimeRoot
	os.MkdirAll(run, 0o700)
	address := filepath.Join(run, "keeper.sock")
	os.Remove(address)
	listener, err := net.Listen("unix", address)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	processLabel := os.Getenv("SOKSAK_PROCESS_LABEL")
	line, _ := json.Marshal(map[string]any{"protocol": 2, "socket": address, "processLabel": processLabel})
	fmt.Println(string(line))
	os.Stdout.Sync()

	var mu sync.Mutex
	words := []string{}
	for {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		go func() {
			defer conn.Close()
			reader := bufio.NewReader(conn)
			for {
				raw, err := reader.ReadBytes('\n')
				if err != nil {
					return
				}
				var request struct {
					ID      string ` + "`json:\"id\"`" + `
					Command string ` + "`json:\"command\"`" + `
					Args    struct {
						Request struct {
							Word string ` + "`json:\"word\"`" + `
						} ` + "`json:\"request\"`" + `
					} ` + "`json:\"args\"`" + `
				}
				json.Unmarshal(raw, &request)
				var data any = map[string]any{}
				if request.Command == "system.hello" {
					data = map[string]any{"protocol": 2, "processLabel": processLabel}
				}
				mu.Lock()
				switch request.Command {
				case "keeper.keep":
					words = append(words, request.Args.Request.Word)
				case "keeper.recall":
					held := make([]string, len(words))
					copy(held, words)
					data = map[string]any{"words": held}
				}
				mu.Unlock()
				var result any = map[string]any{"code": "OK", "data": data}
				if request.Command == "system.hello" {
					result = data
				}
				answer, _ := json.Marshal(map[string]any{
					"id": request.ID, "ok": true, "result": result,
				})
				conn.Write(append(answer, '\n'))
			}
		}()
	}
}
`
