package environment

import platformspec "github.com/soksak-ai/soksak-spec/go/platformspec"

const File = platformspec.EnvironmentFile

type Plugin = platformspec.Plugin
type Component = platformspec.Component
type Environment = platformspec.Environment

var Parse = platformspec.ParseEnvironment
var Validate = platformspec.ValidateEnvironment
var Empty = platformspec.EmptyEnvironment
