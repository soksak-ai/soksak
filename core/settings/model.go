package settings

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"regexp"
)

const File = "settings.json"

type Development struct {
	Path string `json:"path"`
}
type Plugin struct {
	Enabled     bool              `json:"enabled"`
	Development *Development      `json:"development,omitempty"`
	Providers   map[string]string `json:"providers,omitempty"`
}
type Component struct {
	Development *Development `json:"development,omitempty"`
}
type Document struct {
	Revision  uint64               `json:"revision"`
	Plugins   map[string]Plugin    `json:"plugins"`
	Sidecars  map[string]Component `json:"sidecars"`
	Kits      map[string]Component `json:"kits"`
	Contracts map[string]Component `json:"contracts"`
	Specs     map[string]Component `json:"specs"`
}

var idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,127}$`)

func Parse(body []byte) (Document, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var value Document
	if err := decoder.Decode(&value); err != nil {
		return Document{}, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return Document{}, fmt.Errorf("settings has trailing data")
	}
	if err := Validate(value); err != nil {
		return Document{}, err
	}
	return value, nil
}

func Validate(value Document) error {
	if value.Revision < 1 || value.Plugins == nil || value.Sidecars == nil || value.Kits == nil || value.Contracts == nil || value.Specs == nil {
		return fmt.Errorf("settings requires revision and all component maps")
	}
	for id, plugin := range value.Plugins {
		if !idPattern.MatchString(id) {
			return fmt.Errorf("invalid plugin id %s", id)
		}
		if err := validateDevelopment(plugin.Development); err != nil {
			return err
		}
		for requirement, provider := range plugin.Providers {
			if !idPattern.MatchString(requirement) || !idPattern.MatchString(provider) {
				return fmt.Errorf("invalid provider selection %s", requirement)
			}
		}
	}
	for _, values := range []map[string]Component{value.Sidecars, value.Kits, value.Contracts, value.Specs} {
		for id, component := range values {
			if !idPattern.MatchString(id) {
				return fmt.Errorf("invalid component id %s", id)
			}
			if err := validateDevelopment(component.Development); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateDevelopment(value *Development) error {
	if value == nil {
		return nil
	}
	if !filepath.IsAbs(value.Path) || filepath.Clean(value.Path) != value.Path {
		return fmt.Errorf("development path must be absolute")
	}
	return nil
}

func Empty() Document {
	return Document{Revision: 1, Plugins: map[string]Plugin{}, Sidecars: map[string]Component{}, Kits: map[string]Component{}, Contracts: map[string]Component{}, Specs: map[string]Component{}}
}
