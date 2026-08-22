package settings

import platformspec "github.com/soksak-ai/soksak-spec/go/platformspec"

const (
	File          = platformspec.SettingsFile
	InstalledFile = platformspec.InstalledFile
)

type Development = platformspec.Development
type Plugin = platformspec.PluginPreference
type Component = platformspec.ComponentPreference
type Document = platformspec.Settings
type InstalledComponent = platformspec.InstalledComponent
type Installed = platformspec.Installed

var Parse = platformspec.ParseSettings
var Validate = platformspec.ValidateSettings
var Empty = platformspec.EmptySettings
var ParseInstalled = platformspec.ParseInstalled
var ValidateInstalled = platformspec.ValidateInstalled
var EmptyInstalled = platformspec.EmptyInstalled
