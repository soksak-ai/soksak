package application

import controlwire "github.com/soksak-ai/soksak-contract-control"

func processLabelFromEnvironment(value string) (string, error) {
	if value == "" {
		return controlwire.DefaultProcessLabel, nil
	}
	return controlwire.ParseProcessLabel(value)
}
