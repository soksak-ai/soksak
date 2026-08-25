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
