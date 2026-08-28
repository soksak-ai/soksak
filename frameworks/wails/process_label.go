package wails

// ApplyProcessLabel publishes one already-validated diagnostic label to the operating system and
// returns what the platform reads back. The label never changes the application identifier,
// dependency graph, permissions, socket, or ownership.
func ApplyProcessLabel(label string) (string, error) {
	return applyProcessLabel(label)
}
