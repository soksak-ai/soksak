package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

func trackedRecordFiles(root string, extensions map[string]bool, excludedPrefixes []string) ([]string, error) {
	return trackedRecordFilesUnder(root, extensions, nil, excludedPrefixes)
}

func trackedRecordFilesUnder(root string, extensions map[string]bool, includedPrefixes, excludedPrefixes []string) ([]string, error) {
	command := exec.Command("git", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
	output, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("list tracked files: %w", err)
	}
	var files []string
	for _, raw := range bytes.Split(output, []byte{0}) {
		path := string(raw)
		if path == "" || len(extensions) > 0 && !extensions[filepath.Ext(path)] ||
			len(includedPrefixes) > 0 && !hasAnyPrefix(path, includedPrefixes) ||
			hasAnyPrefix(path, excludedPrefixes) {
			continue
		}
		if _, statErr := os.Lstat(filepath.Join(root, path)); statErr != nil {
			if os.IsNotExist(statErr) {
				continue
			}
			return nil, fmt.Errorf("inspect record file %s: %w", path, statErr)
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
