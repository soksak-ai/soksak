package main

import (
	"bytes"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

func trackedRecordFiles(root string, extensions map[string]bool, excludedPrefixes []string) ([]string, error) {
	command := exec.Command("git", "-C", root, "ls-files", "-z", "--cached")
	output, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("list tracked files: %w", err)
	}
	var files []string
	for _, raw := range bytes.Split(output, []byte{0}) {
		path := string(raw)
		if path == "" || !extensions[filepath.Ext(path)] || hasAnyPrefix(path, excludedPrefixes) {
			continue
		}
		files = append(files, path)
	}
	sort.Strings(files)
	return files, nil
}

func hasAnyPrefix(path string, prefixes []string) bool {
	for _, prefix := range prefixes {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}
