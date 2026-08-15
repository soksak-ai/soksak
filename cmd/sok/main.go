// Command sok drives a running backend from outside it.
//
// Everything the application can do, it does through the command registry, and
// this addresses the same registry over the control socket. So a thing that can
// only be done by clicking is a thing that is not finished — and finding that
// out is what this is for.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"runtime"
	"strings"

	"github.com/soksak/soksak-core/core/control"
	"github.com/soksak/soksak-core/core/identity"
)

const usage = `sok — drive a running soksak backend

  sok <command> [name=value ...]     run one command
  sok commands                       list what this build serves and refuses
  sok hello                          greet the backend and print its identity

Values are JSON when they parse as JSON, and strings otherwise:

  sok window_place label=w-a x=100 y=200 w=800 h=600
  sok data_kv_set ns=core key=theme value='"dark"'

The socket is derived from the identifier, as the application derives it.
SOKSAK_IDENTIFIER overrides it; --socket overrides that.
`

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "sok:", err)
		os.Exit(1)
	}
}

func run(argv []string) error {
	socket := ""
	var rest []string
	for index := 0; index < len(argv); index++ {
		switch {
		case argv[index] == "--socket" && index+1 < len(argv):
			index++
			socket = argv[index]
		case strings.HasPrefix(argv[index], "--socket="):
			socket = strings.TrimPrefix(argv[index], "--socket=")
		default:
			rest = append(rest, argv[index])
		}
	}
	if len(rest) == 0 || rest[0] == "-h" || rest[0] == "--help" {
		fmt.Print(usage)
		return nil
	}

	if socket == "" {
		resolved, err := address()
		if err != nil {
			return err
		}
		socket = resolved
	}

	request, err := requestFrom(rest)
	if err != nil {
		return err
	}
	return ask(socket, request)
}

// address derives the socket the same way the application does, from the same
// package. Spelling it again here would be a second answer to "where does this
// installation live", and the two would drift.
func address() (string, error) {
	identifier := os.Getenv("SOKSAK_IDENTIFIER")
	if identifier == "" {
		identifier = "com.soksak.wails"
	}
	resolved, err := identity.Require(identifier, identity.Environment{
		Windows:     runtime.GOOS == "windows",
		Home:        os.Getenv("HOME"),
		UserProfile: os.Getenv("USERPROFILE"),
	})
	if err != nil {
		return "", err
	}
	return resolved.Socket, nil
}

// requestFrom turns argv into one request.
//
// A value that parses as JSON is sent as that JSON; anything else is sent as a
// string. So `x=100` is a number and `key=theme` is a string, which is what
// someone typing at a shell means by them — and `value='"dark"'` is available
// when a string that looks like JSON is meant.
func requestFrom(argv []string) (control.Request, error) {
	name := argv[0]
	switch name {
	case "commands":
		name = control.HelloCommand
	case "hello":
		name = control.HelloCommand
	}

	request := control.Request{ID: "1", Command: name, Args: map[string]json.RawMessage{}}
	for _, pair := range argv[1:] {
		key, value, found := strings.Cut(pair, "=")
		if !found {
			return control.Request{}, fmt.Errorf("argument %q is not name=value", pair)
		}
		if json.Valid([]byte(value)) {
			request.Args[key] = json.RawMessage(value)
			continue
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			return control.Request{}, fmt.Errorf("argument %q: %w", key, err)
		}
		request.Args[key] = encoded
	}
	return request, nil
}

func ask(socket string, request control.Request) error {
	connection, err := net.Dial("unix", socket)
	if err != nil {
		return fmt.Errorf("no backend is answering at %s: %w", socket, err)
	}
	defer func() { _ = connection.Close() }()

	line, err := json.Marshal(request)
	if err != nil {
		return err
	}
	if _, err := connection.Write(append(line, '\n')); err != nil {
		return err
	}

	answer, err := bufio.NewReader(connection).ReadBytes('\n')
	if err != nil {
		return fmt.Errorf("the backend closed without answering: %w", err)
	}

	var response control.Response
	if err := json.Unmarshal(answer, &response); err != nil {
		return fmt.Errorf("the answer was not one line of JSON: %w", err)
	}
	if !response.Ok {
		// The exit status is the verdict so a shell can branch on it, and
		// the message goes to stderr so a pipeline reading stdout gets nothing
		// rather than an error it might parse as a result.
		return fmt.Errorf("%s", response.Error)
	}

	encoded, err := json.MarshalIndent(response.Result, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(encoded))
	return nil
}
