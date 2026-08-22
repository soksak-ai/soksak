package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

var boundarySourceExtensions = map[string]bool{".c": true, ".cc": true, ".cpp": true, ".go": true, ".h": true, ".hpp": true, ".js": true, ".mjs": true, ".rs": true, ".sh": true, ".ts": true, ".tsx": true}
var boundarySkippedTrees = map[string]bool{".git": true, ".task": true, "bin": true, "dist": true, "evidence": true, "node_modules": true, "target": true}
var boundarySiblingTokens = []string{"soksak-contracts", "soksak-kits", "soksak-plugins", "soksak-sidecars", "wails-services"}

func repositoryBoundaryFindings(root string) ([]string, error) {
	findings := []string{}
	err := filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info.IsDir() {
			if path != root && boundarySkippedTrees[info.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			findings = append(findings, filepath.ToSlash(relative)+": symbolic link")
			return nil
		}
		if filepath.ToSlash(relative) == "repository_boundary.go" {
			return nil
		}
		if !boundarySourceExtensions[filepath.Ext(info.Name())] && info.Name() != "Dockerfile" && !strings.HasPrefix(info.Name(), "Taskfile") {
			return nil
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		scanner := bufio.NewScanner(file)
		line := 0
		for scanner.Scan() {
			line++
			text := filepath.ToSlash(scanner.Text())
			for _, token := range boundarySiblingTokens {
				if strings.Contains(text, token) {
					findings = append(findings, fmt.Sprintf("%s:%d sibling source %s", filepath.ToSlash(relative), line, token))
				}
			}
		}
		return scanner.Err()
	})
	return findings, err
}
