package application

const defaultProcessLabel = "soksak"

func processLabelFromEnvironment(string) (string, error) {
	return defaultProcessLabel, nil
}
