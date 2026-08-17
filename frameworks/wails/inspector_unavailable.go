//go:build production && !devtools

package wails

// inspectorAvailable is false: this build compiled the framework's inspector away. See
// inspector_available.go for why the fact is carried rather than discovered as a silent no-op.
const inspectorAvailable = false
