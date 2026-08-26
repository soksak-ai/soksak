package environment

import platformspec "github.com/soksak-ai/soksak-spec/go/platformspec"

const File = platformspec.EnvironmentFile

const (
	RegistrySource    = platformspec.RegistrySource
	LocalSource       = platformspec.LocalSource
	DevelopmentSource = platformspec.DevelopmentSource
)

type Plugin = platformspec.Plugin
type Component = platformspec.Component
type Environment = platformspec.Environment

var Parse = platformspec.ParseEnvironment
var Validate = platformspec.ValidateEnvironment
var Empty = platformspec.EmptyEnvironment

// Clone copies value with its own maps: a write computes next from current, and
// a next that shares current's maps turns every "before" comparison into a
// comparison with itself.
func Clone(value Environment) Environment {
	next := Environment{Revision: value.Revision, Plugins: make(map[string]Plugin, len(value.Plugins)), Sidecars: make(map[string]Component, len(value.Sidecars))}
	for id, plugin := range value.Plugins {
		next.Plugins[id] = plugin
	}
	for id, sidecar := range value.Sidecars {
		next.Sidecars[id] = sidecar
	}
	return next
}
