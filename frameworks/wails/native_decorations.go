package wails

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"unsafe"

	"github.com/soksak-ai/soksak-core/core/control"
	"github.com/soksak-ai/soksak-core/core/i18n"
)

// NativeDecoration is one pointer-transparent stroke drawn in the window's
// final native plane. Path uses the deliberately small SVG subset emitted by
// roundedOrthogonalPath: M, L, Q and Z with absolute coordinates in CSS
// top-left points.
type NativeDecoration struct {
	ID          string    `json:"id"`
	Path        string    `json:"path"`
	StrokeR     float64   `json:"strokeR"`
	StrokeG     float64   `json:"strokeG"`
	StrokeB     float64   `json:"strokeB"`
	StrokeA     float64   `json:"strokeA"`
	StrokeWidth float64   `json:"strokeWidth"`
	Dash        []float64 `json:"dash"`
}

// NativeDecorationApplied is one stroke as the native plane holds it: the id and the path it was
// given. A reading of the plane that only counts cannot tell a stroke standing where the document
// no longer declares one.
type NativeDecorationApplied struct {
	ID   string `json:"id"`
	Path string `json:"path"`
}

type NativeDecorationReceipt struct {
	Window    string                    `json:"window"`
	Sequence  uint64                    `json:"sequence"`
	Count     int                       `json:"count"`
	Supported bool                      `json:"supported"`
	Layer     string                    `json:"layer"`
	Applied   []NativeDecorationApplied `json:"applied"`
}

func appliedOf(decorations []preparedNativeDecoration) []NativeDecorationApplied {
	applied := make([]NativeDecorationApplied, 0, len(decorations))
	for _, decoration := range decorations {
		applied = append(applied, NativeDecorationApplied{ID: decoration.ID, Path: decoration.Path})
	}
	return applied
}

const (
	nativePathMove = iota + 1
	nativePathLine
	nativePathQuad
	nativePathClose
)

type nativePathCommand struct {
	op             int
	x1, y1, x2, y2 float64
}

type preparedNativeDecoration struct {
	NativeDecoration
	commands []nativePathCommand
}

func pathNumber(tokens []string, at *int) (float64, error) {
	if *at >= len(tokens) {
		return 0, i18n.Errorf("wails.decoration.pathCoordinateMissing", map[string]string{"index": strconv.Itoa(*at)})
	}
	value, err := strconv.ParseFloat(tokens[*at], 64)
	*at++
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, i18n.Errorf("wails.decoration.pathCoordinateInvalid", map[string]string{"value": tokens[*at-1]})
	}
	return value, nil
}

func parseNativeDecorationPath(path string) ([]nativePathCommand, error) {
	tokens := strings.Fields(path)
	if len(tokens) == 0 {
		return nil, i18n.Errorf("wails.decoration.pathEmpty", nil)
	}
	commands := make([]nativePathCommand, 0, len(tokens)/3)
	for at := 0; at < len(tokens); {
		op := tokens[at]
		at++
		command := nativePathCommand{}
		var err error
		switch op {
		case "M", "L":
			if op == "M" {
				command.op = nativePathMove
			} else {
				command.op = nativePathLine
			}
			command.x1, err = pathNumber(tokens, &at)
			if err == nil {
				command.y1, err = pathNumber(tokens, &at)
			}
		case "Q":
			command.op = nativePathQuad
			command.x1, err = pathNumber(tokens, &at)
			if err == nil {
				command.y1, err = pathNumber(tokens, &at)
			}
			if err == nil {
				command.x2, err = pathNumber(tokens, &at)
			}
			if err == nil {
				command.y2, err = pathNumber(tokens, &at)
			}
		case "Z":
			command.op = nativePathClose
		default:
			return nil, i18n.Errorf("wails.decoration.pathOperation", map[string]string{"operation": op})
		}
		if err != nil {
			return nil, err
		}
		commands = append(commands, command)
	}
	if commands[0].op != nativePathMove {
		return nil, i18n.Errorf("wails.decoration.pathStart", nil)
	}
	return commands, nil
}

func prepareNativeDecorations(decorations []NativeDecoration) ([]preparedNativeDecoration, error) {
	prepared := make([]preparedNativeDecoration, 0, len(decorations))
	ids := make(map[string]struct{}, len(decorations))
	for _, decoration := range decorations {
		if decoration.ID == "" {
			return nil, i18n.Errorf("wails.decoration.idEmpty", nil)
		}
		if _, duplicate := ids[decoration.ID]; duplicate {
			return nil, i18n.Errorf("wails.decoration.idDuplicate", map[string]string{"id": decoration.ID})
		}
		ids[decoration.ID] = struct{}{}
		channels := []float64{
			decoration.StrokeR, decoration.StrokeG, decoration.StrokeB, decoration.StrokeA,
		}
		for _, channel := range channels {
			if !isFiniteBetween(channel, 0, 1) {
				return nil, i18n.Errorf("wails.decoration.color", map[string]string{"id": decoration.ID})
			}
		}
		if !isFiniteBetween(decoration.StrokeWidth, 0.5, 8) {
			return nil, i18n.Errorf("wails.decoration.strokeWidth", map[string]string{"id": decoration.ID})
		}
		for _, dash := range decoration.Dash {
			if !isFiniteBetween(dash, 0.1, 1000) {
				return nil, i18n.Errorf("wails.decoration.dash", map[string]string{"id": decoration.ID})
			}
		}
		commands, err := parseNativeDecorationPath(decoration.Path)
		if err != nil {
			return nil, fmt.Errorf("native decoration %q: %w", decoration.ID, err)
		}
		prepared = append(prepared, preparedNativeDecoration{
			NativeDecoration: decoration,
			commands:         commands,
		})
	}
	return prepared, nil
}

func isFiniteBetween(value, low, high float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= low && value <= high
}

// NativeDecorationHost is the ordering seam shared by the command writer and
// the native-surface service. The first replaces the full decoration snapshot;
// the second raises that exact snapshot after every provider inventory commit.
type NativeDecorationHost interface {
	Commit(window string, decorations []NativeDecoration) (NativeDecorationReceipt, error)
	Reapply(window string) error
	Status(window string) NativeDecorationReceipt
}

type nativeDecorationStore struct {
	mu       sync.Mutex
	windows  func(string) unsafe.Pointer
	applyFn  func(unsafe.Pointer, []preparedNativeDecoration) (bool, int, error)
	byWindow map[string][]preparedNativeDecoration
	status   map[string]NativeDecorationReceipt
}

func newNativeDecorationStore(windows func(string) unsafe.Pointer) *nativeDecorationStore {
	return &nativeDecorationStore{
		windows:  windows,
		applyFn:  applyNativeDecorations,
		byWindow: make(map[string][]preparedNativeDecoration),
		status:   make(map[string]NativeDecorationReceipt),
	}
}

func (store *nativeDecorationStore) apply(window string, decorations []preparedNativeDecoration) (bool, int, error) {
	if store == nil || store.windows == nil {
		return false, 0, i18n.Errorf("wails.decoration.hostUnavailable", nil)
	}
	handle := store.windows(window)
	if handle == nil {
		return false, 0, i18n.Errorf("wails.decoration.windowUnavailable", map[string]string{"window": window})
	}
	return store.applyFn(handle, decorations)
}

func (store *nativeDecorationStore) Commit(window string, decorations []NativeDecoration) (NativeDecorationReceipt, error) {
	prepared, err := prepareNativeDecorations(decorations)
	if err != nil {
		return NativeDecorationReceipt{}, err
	}
	supported, count, err := store.apply(window, prepared)
	if err != nil {
		return NativeDecorationReceipt{}, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	previous := store.status[window]
	receipt := NativeDecorationReceipt{
		Window: window, Sequence: previous.Sequence + 1, Count: count,
		Supported: supported, Layer: "dom-only", Applied: appliedOf(prepared),
	}
	if supported {
		receipt.Layer = "native-above-surfaces"
	}
	store.byWindow[window] = prepared
	store.status[window] = receipt
	return receipt, nil
}

func (store *nativeDecorationStore) Reapply(window string) error {
	if store == nil {
		return nil
	}
	store.mu.Lock()
	decorations, present := store.byWindow[window]
	store.mu.Unlock()
	if !present {
		return nil
	}
	supported, count, err := store.apply(window, decorations)
	if err != nil {
		return err
	}
	store.mu.Lock()
	receipt := store.status[window]
	receipt.Count = count
	receipt.Supported = supported
	receipt.Layer = "dom-only"
	if supported {
		receipt.Layer = "native-above-surfaces"
	}
	store.status[window] = receipt
	store.mu.Unlock()
	return nil
}

func (store *nativeDecorationStore) Status(window string) NativeDecorationReceipt {
	if store == nil {
		return NativeDecorationReceipt{Window: window, Layer: "unavailable"}
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	status, present := store.status[window]
	if !present {
		return NativeDecorationReceipt{Window: window, Layer: "not-committed"}
	}
	return status
}

func RegisterNativeDecorations(registry *control.Registry, host NativeDecorationHost) {
	registry.MustRegister(control.Command{
		Name:  "native_decorations_commit",
		Owner: control.OwnerFramework,
		Handler: func(args control.Args) (any, error) {
			window, err := control.Arg[string](args, control.CallerWindowArgument)
			if err != nil {
				return nil, err
			}
			decorations, err := control.Arg[[]NativeDecoration](args, "decorations")
			if err != nil {
				return nil, err
			}
			if host == nil {
				return nil, i18n.Errorf("wails.decoration.hostUnavailable", nil)
			}
			return host.Commit(window, decorations)
		},
	})
	registry.MustRegister(control.Command{
		Name:  "native_decorations_status",
		Owner: control.OwnerFramework,
		Handler: func(args control.Args) (any, error) {
			window, err := control.Arg[string](args, control.CallerWindowArgument)
			if err != nil {
				return nil, err
			}
			if host == nil {
				return NativeDecorationReceipt{Window: window, Layer: "unavailable"}, nil
			}
			return host.Status(window), nil
		},
	})
}
