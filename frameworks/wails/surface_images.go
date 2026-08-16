package wails

import (
	"encoding/base64"
	"fmt"
)

// CompositorImages reads surface pixels through the compositor.
//
// The capture wants pixels; the compositor holds the inventory and hands the request to the
// backend that owns each kind. Nothing here names a kind — the verb is "snapshot" and what comes
// back is a PNG.
type CompositorImages struct {
	composition CompositionSource
	deliver     func(id string, message map[string]any) (map[string]any, error)
}

// NewCompositorImages joins the capture to the compositor.
func NewCompositorImages(
	composition CompositionSource,
	deliver func(id string, message map[string]any) (map[string]any, error),
) *CompositorImages {
	return &CompositorImages{composition: composition, deliver: deliver}
}

// Placed answers every surface the native layer applied, at the frame it applied.
//
// The applied half, not the declared one. The declaration is where a surface was asked to go, and
// drawing a page at a rectangle it is not at would put the difference G3 measures into the image
// as if it were not there.
func (images *CompositorImages) Placed(window string) []SurfacePixels {
	if images == nil || images.composition == nil {
		return nil
	}
	var placed []SurfacePixels
	for _, placement := range images.composition.Latest(window).Placements {
		placed = append(placed, SurfacePixels{
			ID:    placement.ID,
			Frame: placement.Applied,
			Dark:  darkness(placement),
		})
	}
	return placed
}

// darkness names why a surface puts no light on the screen, empty when it does.
//
// Three ways to arrive there and they are different defects: a pane whose tab is
// not the front one is hidden on purpose, a surface at zero alpha is a fade that
// did not finish, and one with no area is a layout that gave it nothing. A
// capture that answered "not drawn" for all three would leave the caller to
// guess which.
func darkness(placement SurfacePlacement) string {
	switch {
	case !placement.AppliedVisible:
		return "the native layer hid it"
	case placement.AppliedAlpha == 0:
		return "it is fully transparent"
	case !placement.Applied.Area():
		return "it has no area"
	default:
		return ""
	}
}

// Image is one surface's own pixels.
func (images *CompositorImages) Image(id string) ([]byte, error) {
	if images == nil || images.deliver == nil {
		return nil, fmt.Errorf("surface %s cannot be asked for pixels: there is nothing to ask", id)
	}
	answer, err := images.deliver(id, map[string]any{"verb": "snapshot"})
	if err != nil {
		return nil, err
	}
	encoded, given := answer["png"].(string)
	if !given || encoded == "" {
		return nil, fmt.Errorf("surface %s answered no pixels", id)
	}
	return base64.StdEncoding.DecodeString(encoded)
}
