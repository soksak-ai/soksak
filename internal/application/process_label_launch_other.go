//go:build !darwin

package application

func launchProcessLabel(value string) (string, error) {
	return processLabelFromEnvironment(value)
}
