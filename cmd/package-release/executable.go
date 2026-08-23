package main

import (
	"debug/elf"
	"debug/macho"
	"debug/pe"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

func inspectExecutable(path, platform, architecture string) error {
	target := platform + "/" + architecture
	switch platform {
	case "windows":
		file, err := pe.Open(path)
		if err != nil {
			return executableError(path, target, err)
		}
		defer file.Close()
		if architecture != "x86_64" || file.Machine != pe.IMAGE_FILE_MACHINE_AMD64 {
			return architectureError(path, target)
		}
	case "linux":
		file, err := elf.Open(path)
		if err != nil {
			return executableError(path, target, err)
		}
		defer file.Close()
		want := elf.EM_X86_64
		if architecture == "arm64" {
			want = elf.EM_AARCH64
		} else if architecture != "x86_64" {
			return architectureError(path, target)
		}
		if file.Machine != want {
			return architectureError(path, target)
		}
	case "darwin":
		file, err := macho.OpenFat(path)
		if err != nil {
			return executableError(path, target, err)
		}
		defer file.Close()
		found := map[macho.Cpu]bool{}
		for _, item := range file.Arches {
			found[item.Cpu] = true
		}
		if architecture != "universal" || !found[macho.CpuAmd64] || !found[macho.CpuArm64] || len(found) != 2 {
			return architectureError(path, target)
		}
	default:
		return i18n.Errorf("release.input", map[string]string{"target": target})
	}
	return nil
}

func executableError(path, target string, err error) error {
	return i18n.Errorf("release.executable", map[string]string{"path": path, "target": target, "reason": err.Error()})
}

func architectureError(path, target string) error {
	return i18n.Errorf("release.architecture", map[string]string{"path": path, "target": target})
}
