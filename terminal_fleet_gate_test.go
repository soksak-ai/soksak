package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	controlwire "github.com/soksak/soksak-contract-control"
	ptycontract "github.com/soksak/soksak-contract-pty"
)

type terminalFleetPlugin struct {
	ID       string
	Program  string
	Sidecars []string
}

type terminalFleetView struct {
	plugin terminalFleetPlugin
	tab    string
	pid    uint32
}

func terminalFleetPlugins(t *testing.T) []terminalFleetPlugin {
	t.Helper()
	var fleet []terminalFleetPlugin
	for _, root := range pluginRoots(t) {
		body, err := os.ReadFile(filepath.Join(root, "plugin.json"))
		if err != nil {
			t.Fatalf("reading %s: %v", root, err)
		}
		var manifest struct {
			ID         string `json:"id"`
			Implements []struct {
				ID      string `json:"id"`
				Version string `json:"version"`
			} `json:"implements"`
			Contributes struct {
				Programs []struct {
					ID string `json:"id"`
				} `json:"programs"`
			} `json:"contributes"`
			Sidecars []struct {
				Name string `json:"name"`
			} `json:"sidecars"`
		}
		if err := json.Unmarshal(body, &manifest); err != nil {
			t.Fatalf("reading %s manifest: %v", root, err)
		}
		terminal := false
		for _, implemented := range manifest.Implements {
			if implemented.ID == "soksak-spec-plugin-terminal" && implemented.Version == "0.0.1" {
				terminal = true
			}
		}
		if !terminal {
			continue
		}
		if len(manifest.Contributes.Programs) != 1 {
			t.Fatalf("%s contributes %d terminal programs, expected one", manifest.ID, len(manifest.Contributes.Programs))
		}
		plugin := terminalFleetPlugin{ID: manifest.ID, Program: manifest.Contributes.Programs[0].ID}
		for _, sidecar := range manifest.Sidecars {
			plugin.Sidecars = append(plugin.Sidecars, sidecar.Name)
		}
		fleet = append(fleet, plugin)
	}
	sort.Slice(fleet, func(i, j int) bool { return fleet[i].ID < fleet[j].ID })
	if len(fleet) != 7 {
		t.Fatalf("terminal plugin fleet has %d members, expected 7: %+v", len(fleet), fleet)
	}
	return fleet
}

func (gate *restoreGate) installTerminalSidecars(fleet []terminalFleetPlugin) {
	gate.t.Helper()
	units := map[string]bool{}
	for _, plugin := range fleet {
		for _, unit := range plugin.Sidecars {
			units[unit] = true
		}
	}
	names := make([]string, 0, len(units))
	for name := range units {
		names = append(names, name)
	}
	sort.Strings(names)
	gate.t.Cleanup(func() {
		for index := len(names) - 1; index >= 0; index-- {
			_, _ = gate.try("sidecar_stop", "name="+names[index])
		}
	})
	for _, name := range names {
		source := filepath.Join("..", "soksak-sidecars", "soksak-sidecar-"+name)
		stage := filepath.Join(source, "stage.sh")
		release := filepath.Join(source, "release", "unit.json")
		for _, required := range []string{stage, release} {
			info, err := os.Lstat(required)
			if err != nil || !info.Mode().IsRegular() {
				gate.t.Fatalf("terminal unit %s has no regular %s: %v", name, required, err)
			}
		}
		target := filepath.Join(gate.installationHome(), "sidecars", "soksak-sidecar-"+name)
		dist := filepath.Join(target, "dist")
		command := exec.Command("./stage.sh", dist)
		command.Dir = source
		command.Env = os.Environ()
		if output, err := command.CombinedOutput(); err != nil {
			gate.t.Fatalf("staging terminal unit %s: %v\n%s", name, err, output)
		}
		releaseDir := filepath.Join(target, "release")
		if err := os.MkdirAll(releaseDir, 0o700); err != nil {
			gate.t.Fatalf("creating release directory for %s: %v", name, err)
		}
		body, err := os.ReadFile(release)
		if err != nil {
			gate.t.Fatalf("reading release for %s: %v", name, err)
		}
		if err := os.WriteFile(filepath.Join(releaseDir, "unit.json"), body, 0o600); err != nil {
			gate.t.Fatalf("installing release for %s: %v", name, err)
		}
		if links := symlinksUnder(target); len(links) > 0 {
			gate.t.Fatalf("terminal unit %s staged symbolic links: %v", name, links)
		}
	}
}

func symlinksUnder(root string) []string {
	var found []string
	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			found = append(found, path)
		}
		return nil
	})
	return found
}

func (gate *restoreGate) terminalCommand(window, plugin, command string, params ...string) map[string]any {
	gate.t.Helper()
	name := "plugin." + plugin + "." + command
	out, err := gate.try(name, append([]string{"window=" + window}, params...)...)
	if err != nil {
		statusArgs := []string{"window=" + window}
		for _, param := range params {
			if strings.HasPrefix(param, "view=") {
				statusArgs = append(statusArgs, param)
			}
		}
		status, _ := gate.try("plugin."+plugin+".status", statusArgs...)
		read, _ := gate.try("plugin."+plugin+".read", statusArgs...)
		sidecars, _ := gate.try("sidecar_status")
		gate.t.Fatalf("%s: %v\n%s\nstatus:\n%s\nread:\n%s\nsidecars:\n%s\nrenderer errors:\n%s%s",
			name, err, out, status, read, sidecars, strings.Join(gate.rendererErrors(window), "\n"), gate.lastWords())
	}
	var answer struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("reading %s.%s: %v\n%s", plugin, command, err, out)
	}
	return answer.Data
}

func TestEveryTerminalPluginRunsItsDeclaredProvider(t *testing.T) {
	fleet := terminalFleetPlugins(t)
	gate := newGate(t, "<local-evidence>/soksak-terminal-fleet-gate", "com.soksak.terminalfleetgate")
	plugins := gate.installPlugins()
	gate.installTerminalSidecars(fleet)
	gate.start()
	window := gate.openWorkspace()
	gate.consentAndEnable(window, plugins)
	gate.run("plugin.boot.wait", "window="+window, "timeoutMs=20000")
	for _, plugin := range fleet {
		gate.run("secret_generate", "ns="+plugin.ID, "key=terminal-checkpoint-key-v1", "bytes=32")
	}
	gate.run("window.resize", "window="+window, "w=1400", "h=900")
	gate.run("ui.layout.wait-settled", "window="+window)

	views := make([]terminalFleetView, 0, len(fleet))
	for index, plugin := range fleet {
		tab := gate.open(window, plugin.Program)
		gate.terminalCommand(window, plugin.ID, "wait",
			"view="+tab, "phase=live", "timeoutMs=8000")
		marker := fmt.Sprintf("SOKSAK_FLEET_%d", index)
		gate.terminalCommand(window, plugin.ID, "send",
			"view="+tab, "data=printf '%s\\n' "+marker+"\r")
		ready := gate.terminalCommand(window, plugin.ID, "wait",
			"view="+tab, "phase=live", "contains="+marker, "timeoutMs=8000")
		if ready["phase"] != "live" || ready["fidelity"] != "complete" {
			t.Errorf("%s reached marker with status %+v", plugin.ID, ready)
		}
		wideValue, wideOK := ready["cols"].(float64)
		wideColumns := int(wideValue)
		if !wideOK || wideColumns < 1 {
			t.Fatalf("%s reported no terminal columns: %+v", plugin.ID, ready)
		}
		gate.run("window.resize", "window="+window, "w=900", "h=650")
		gate.run("ui.layout.wait-settled", "window="+window)
		resizedMarker := marker + "_RESIZED"
		gate.terminalCommand(window, plugin.ID, "send",
			"view="+tab, "data=printf '%s\\n' "+resizedMarker+"\r")
		resized := gate.terminalCommand(window, plugin.ID, "wait",
			"view="+tab, "phase=live", "contains="+resizedMarker, "timeoutMs=8000")
		narrowValue, narrowOK := resized["cols"].(float64)
		narrowColumns := int(narrowValue)
		if !narrowOK || narrowColumns < 1 {
			t.Fatalf("%s reported no terminal columns after resize: %+v", plugin.ID, resized)
		}
		if narrowColumns >= wideColumns {
			t.Errorf("%s columns did not decrease after resize: %d -> %d", plugin.ID, wideColumns, narrowColumns)
		}
		gate.run("window.resize", "window="+window, "w=1400", "h=900")
		gate.run("ui.layout.wait-settled", "window="+window)
		read := gate.terminalCommand(window, plugin.ID, "read", "view="+tab)
		if !strings.Contains(fmt.Sprint(read["text"]), marker) {
			t.Errorf("%s screen does not contain %s: %+v", plugin.ID, marker, read)
		}
		focused := gate.terminalCommand(window, plugin.ID, "focus", "view="+tab)
		if focused["focused"] != true {
			t.Errorf("%s did not focus its declared input: %+v", plugin.ID, focused)
		}
		gate.assertTerminalNodes(window, tab, plugin.ID)
		gate.assertTerminalAccessibility(window, tab, plugin.ID)
		unicodeMarker := fmt.Sprintf("%c%c%c_%d_%c%c_%c_e%c",
			rune(0xB2E4), rune(0xAD6D), rune(0xC5B4), index,
			rune(0x6F22), rune(0x5B57), rune(0x1F642), rune(0x0301))
		gate.terminalCommand(window, plugin.ID, "send",
			"view="+tab, "data=printf '%s\\n' "+unicodeMarker+"\r")
		gate.terminalCommand(window, plugin.ID, "wait",
			"view="+tab, "phase=live", "contains="+unicodeMarker, "timeoutMs=8000")
		tailMarker := fmt.Sprintf("SOKSAK_HIGH_OUTPUT_TAIL_%d", index)
		gate.terminalCommand(window, plugin.ID, "send",
			"view="+tab, "data=yes X | head -c 262144; printf '\\n%s\\n' "+tailMarker+"\r")
		gate.terminalCommand(window, plugin.ID, "wait",
			"view="+tab, "phase=live", "contains="+tailMarker, "timeoutMs=20000")
		diagnostics := gate.terminalCommand(window, plugin.ID, "status", "view="+tab)
		views = append(views, terminalFleetView{
			plugin: plugin, tab: tab, pid: terminalShellPID(t, diagnostics, tab),
		})
	}

	if errors := gate.rendererErrors(window); len(errors) > 0 {
		t.Errorf("terminal fleet produced renderer errors:\n%s", strings.Join(errors, "\n"))
	}

	gate.quit()
	detached := make(map[string]string, len(views))
	for index, view := range views {
		marker := fmt.Sprintf("SOKSAK_DETACHED_%d", index)
		detached[view.tab] = marker
		ptyWriteByPane(t, gate.runtime, view.tab, marker)
	}
	gate.start()
	gate.awaitWindow(window)
	for index, view := range views {
		gate.activate(window, view.tab, fmt.Sprintf("terminal-warm-%d", index))
		status := gate.terminalCommand(window, view.plugin.ID, "wait",
			"view="+view.tab, "phase=live", "contains="+detached[view.tab], "timeoutMs=8000")
		if status["recoveryOutcome"] != "continued" || status["fidelity"] != "complete" {
			t.Errorf("%s warm recovery status = %+v", view.plugin.ID, status)
		}
		diagnostics := gate.terminalCommand(window, view.plugin.ID, "status", "view="+view.tab)
		if got := terminalShellPID(t, diagnostics, view.tab); got != view.pid {
			t.Errorf("%s shell PID changed across restart: %d -> %d", view.plugin.ID, view.pid, got)
		}
		read := gate.terminalCommand(window, view.plugin.ID, "read", "view="+view.tab)
		if count := strings.Count(fmt.Sprint(read["text"]), detached[view.tab]); count != 1 {
			t.Errorf("%s detached marker count = %d: %+v", view.plugin.ID, count, read)
		}
		archived := gate.terminalCommand(window, view.plugin.ID, "archive", "view="+view.tab)
		bytes, bytesOK := archived["bytes"].(float64)
		if archived["archived"] != true || !bytesOK || bytes < 1 {
			t.Fatalf("%s did not acknowledge a durable archive: %+v", view.plugin.ID, archived)
		}
		gate.captureTerminalWithoutFocus(window, view.plugin.ID)
	}

	gate.quit()
	for _, view := range views {
		ptyCloseByPane(t, gate.runtime, view.tab)
	}
	gate.start()
	gate.awaitWindow(window)
	for index, view := range views {
		gate.activate(window, view.tab, fmt.Sprintf("terminal-archived-%d", index))
		status := gate.terminalCommand(window, view.plugin.ID, "wait",
			"view="+view.tab, "phase=archived", "contains="+detached[view.tab], "timeoutMs=8000")
		if status["recoveryOutcome"] != "archived" || status["fidelity"] != "complete" {
			t.Errorf("%s archived recovery status = %+v", view.plugin.ID, status)
		}
		sent := gate.terminalCommand(window, view.plugin.ID, "send",
			"view="+view.tab, "data=ARCHIVED_INPUT_MUST_FAIL")
		if sent["sent"] != false {
			t.Errorf("%s accepted input on an archived screen: %+v", view.plugin.ID, sent)
		}
	}
}

func (gate *restoreGate) captureTerminalWithoutFocus(window, plugin string) {
	gate.t.Helper()
	directory, err := filepath.Abs(filepath.Join(".task", "terminal-visual"))
	if err != nil {
		gate.t.Fatalf("resolving terminal capture path: %v", err)
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		gate.t.Fatalf("creating terminal capture directory: %v", err)
	}
	path := filepath.Join(directory, plugin+".png")
	recording := filepath.Join(directory, plugin+"-recording")
	if err := os.RemoveAll(recording); err != nil {
		gate.t.Fatalf("clearing %s recording: %v", plugin, err)
	}
	gate.run("window.snapshot", "window="+window, "path="+path)
	gate.run("window.record", "window="+window, "dir="+recording, "frames=6", "intervalMs=16")
	info, err := os.Stat(path)
	if err != nil || info.Size() == 0 {
		gate.t.Fatalf("%s capture was not written: %v", plugin, err)
	}
	frames, err := filepath.Glob(filepath.Join(recording, "f*.png"))
	if err != nil || len(frames) != 6 {
		gate.t.Fatalf("%s recording has %d of 6 frames: %v", plugin, len(frames), err)
	}
}

func terminalShellPID(t *testing.T, status map[string]any, pane string) uint32 {
	t.Helper()
	source, ok := status["source"].(map[string]any)
	if !ok {
		t.Fatalf("terminal status has no source diagnostics: %+v", status)
	}
	pty, ok := source["pty"].(map[string]any)
	if !ok {
		t.Fatalf("terminal status has no PTY diagnostics: %+v", status)
	}
	sessions, ok := pty["sessions"].([]any)
	if !ok || len(sessions) == 0 {
		t.Fatalf("terminal status has no PTY session: %+v", status)
	}
	for _, value := range sessions {
		session, ok := value.(map[string]any)
		if !ok || session["paneId"] != pane {
			continue
		}
		pid, pidOK := session["shellPid"].(float64)
		if pidOK && pid >= 1 {
			return uint32(pid)
		}
	}
	t.Fatalf("terminal status has no shell PID for %s: %+v", pane, status)
	return 0
}

func ptyWriteByPane(t *testing.T, runtimeRoot, pane, marker string) {
	t.Helper()
	client := openPTYControl(t, runtimeRoot)
	defer func() { _ = client.connection.Close() }()
	session := client.sessionForPane(t, pane)
	// Octal output keeps the marker out of the echoed input line; exactly one screen occurrence is expected.
	octal := make([]string, 0, len(marker))
	for _, value := range []byte(marker) {
		octal = append(octal, fmt.Sprintf("\\%03o", value))
	}
	command := "printf '" + strings.Join(octal, "") + "\\n'\r"
	writeRequest, _ := json.Marshal(map[string]any{
		"session": session, "dataB64": base64.StdEncoding.EncodeToString([]byte(command)),
	})
	client.call(t, controlwire.Request{ID: "write", Command: ptycontract.CommandWrite, Args: map[string]json.RawMessage{"request": writeRequest}})
}

type ptyControl struct {
	connection net.Conn
	reader     *bufio.Reader
}

func openPTYControl(t *testing.T, runtimeRoot string) *ptyControl {
	t.Helper()
	token, err := os.ReadFile(ptycontract.TokenPath(runtimeRoot))
	if err != nil {
		t.Fatalf("reading PTY token: %v", err)
	}
	connection, err := net.Dial("unix", ptycontract.ControlSocketPath(runtimeRoot))
	if err != nil {
		t.Fatalf("connecting to PTY: %v", err)
	}
	client := &ptyControl{connection: connection, reader: bufio.NewReader(connection)}
	protocol, _ := json.Marshal(controlwire.Protocol)
	auth, _ := json.Marshal(strings.TrimSpace(string(token)))
	client.call(t, controlwire.Request{ID: "hello", Command: controlwire.HelloCommand, Args: map[string]json.RawMessage{
		"protocol": protocol, "token": auth,
	}})
	return client
}

func (client *ptyControl) call(t *testing.T, request controlwire.Request) controlwire.Response {
	t.Helper()
	if err := json.NewEncoder(client.connection).Encode(request); err != nil {
		t.Fatal(err)
	}
	line, err := client.reader.ReadBytes('\n')
	if err != nil {
		t.Fatal(err)
	}
	var response controlwire.Response
	if err := json.Unmarshal(line, &response); err != nil {
		t.Fatal(err)
	}
	if !response.Ok {
		t.Fatalf("PTY refused %s: %s", request.Command, response.Error)
	}
	return response
}

func (client *ptyControl) sessionForPane(t *testing.T, pane string) uint64 {
	t.Helper()
	paneRequest, _ := json.Marshal(map[string]string{"paneId": pane})
	held := client.call(t, controlwire.Request{ID: "pane", Command: ptycontract.CommandPane, Args: map[string]json.RawMessage{"request": paneRequest}})
	body, _ := json.Marshal(held.Result)
	var result struct {
		Data struct {
			Opened struct {
				Session uint64 `json:"session"`
			} `json:"opened"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &result); err != nil || result.Data.Opened.Session == 0 {
		t.Fatalf("PTY pane response has no session: %s", body)
	}
	return result.Data.Opened.Session
}

func ptyCloseByPane(t *testing.T, runtimeRoot, pane string) {
	t.Helper()
	client := openPTYControl(t, runtimeRoot)
	defer func() { _ = client.connection.Close() }()
	session := client.sessionForPane(t, pane)
	request, _ := json.Marshal(map[string]uint64{"session": session})
	client.call(t, controlwire.Request{
		ID: "close", Command: ptycontract.CommandClose,
		Args: map[string]json.RawMessage{"request": request},
	})
}

func (gate *restoreGate) assertTerminalNodes(window, view, plugin string) {
	gate.t.Helper()
	out := gate.run("ui.tree", "window="+window)
	var answer struct {
		Data struct {
			Nodes []struct {
				Address  string `json:"address"`
				NodePath string `json:"nodePath"`
			} `json:"nodes"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("ui.tree: %v\n%s", err, out)
	}
	wanted := map[string]bool{
		"terminal-root": false, "terminal-screen": false,
		"terminal-input": false, "terminal-restore-status": false,
	}
	for _, node := range answer.Data.Nodes {
		if strings.Contains(node.Address, plugin) && strings.Contains(node.Address, view) {
			if _, required := wanted[node.NodePath]; required {
				wanted[node.NodePath] = true
			}
		}
	}
	for node, found := range wanted {
		if !found {
			gate.t.Errorf("%s view %s exposes no %s node", plugin, view, node)
		}
	}
}

func (gate *restoreGate) assertTerminalAccessibility(window, view, plugin string) {
	gate.t.Helper()
	out := gate.run("ui.tree", "window="+window)
	var answer struct {
		Data struct {
			Nodes []struct {
				Address   string  `json:"address"`
				NodePath  string  `json:"nodePath"`
				Role      *string `json:"role"`
				AriaLabel *string `json:"ariaLabel"`
				AriaLive  *string `json:"ariaLive"`
				TabIndex  int     `json:"tabIndex"`
			} `json:"nodes"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(out), &answer); err != nil {
		gate.t.Fatalf("ui.tree accessibility: %v\n%s", err, out)
	}
	for _, node := range answer.Data.Nodes {
		if !strings.Contains(node.Address, plugin) || !strings.Contains(node.Address, view) {
			continue
		}
		switch node.NodePath {
		case "terminal-screen":
			if node.Role == nil || *node.Role != "log" || node.AriaLive == nil || *node.AriaLive != "polite" {
				gate.t.Errorf("%s terminal screen accessibility = %+v", plugin, node)
			}
		case "terminal-input":
			if node.AriaLabel == nil || *node.AriaLabel == "" || node.TabIndex < 0 {
				gate.t.Errorf("%s terminal input accessibility = %+v", plugin, node)
			}
		}
	}
}
