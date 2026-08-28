package application

import controlwire "github.com/soksak-ai/soksak-contract-control"

var defaultProcessLabel = controlwire.DefaultProcessLabel

func processLabelFromEnvironment(value string) (string, error) {
	if value == "" {
		return controlwire.ParseProcessLabel(defaultProcessLabel)
	}
	return controlwire.ParseProcessLabel(value)
}
