package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/soksak-ai/soksak-core/core/i18n"
)

func packageTarget(out, version string, target releaseTarget, input releaseInput) (targetProvenance, error) {
	files := []archiveInput{{Name: "sok", Path: input.Client}, {Name: "soksak", Path: input.Application}}
	if target.Platform == "windows" {
		files[0].Name, files[1].Name = "sok.exe", "soksak.exe"
	} else if target.Platform == "darwin" {
		files[1].Name = "soksak.app"
	}
	assets := make([]releaseAsset, 0, len(files))
	for _, file := range files {
		binaryPath := file.Path
		if target.Platform == "darwin" && file.Name == "soksak.app" {
			binaryPath = filepath.Join(file.Path, "Contents", "MacOS", "soksak")
		}
		if err := inspectExecutable(binaryPath, target.Platform, target.Architecture); err != nil {
			return targetProvenance{}, err
		}
		asset, err := inspectPath(file.Name, file.Path)
		if err != nil {
			return targetProvenance{}, err
		}
		assets = append(assets, asset)
	}
	archiveName := "soksak-" + version + "-" + target.Platform + "-" + target.Architecture + "." + target.ArchiveFormat
	archivePath := filepath.Join(out, archiveName)
	if target.ArchiveFormat == "zip" {
		if err := writeDeterministicZip(archivePath, files); err != nil {
			return targetProvenance{}, err
		}
	} else if err := writeDeterministicTarGzip(archivePath, files); err != nil {
		return targetProvenance{}, err
	}
	archive, err := inspectFile(archiveName, archivePath)
	if err != nil {
		return targetProvenance{}, err
	}
	return targetProvenance{Platform: target.Platform, Architecture: target.Architecture, SystemRunID: input.SystemRunID, Signing: input.Signing, Archive: archive, ArchiveFiles: assets}, nil
}

func inspectPath(name, path string) (releaseAsset, error) {
	info, err := os.Stat(path)
	if err != nil {
		return releaseAsset{}, err
	}
	if !info.IsDir() {
		return inspectFile(name, path)
	}
	digest := sha256.New()
	var size int64
	entries, err := archiveEntries([]archiveInput{{Name: name, Path: path}})
	if err != nil {
		return releaseAsset{}, err
	}
	for _, entry := range entries {
		if entry.Directory {
			continue
		}
		file, err := os.Open(entry.Path)
		if err != nil {
			return releaseAsset{}, err
		}
		digest.Write([]byte(entry.Name))
		written, copyErr := io.Copy(digest, file)
		file.Close()
		if copyErr != nil {
			return releaseAsset{}, copyErr
		}
		size += written
	}
	if size == 0 {
		return releaseAsset{}, i18n.Errorf("release.empty", map[string]string{"path": path})
	}
	return releaseAsset{Name: name, SHA256: hex.EncodeToString(digest.Sum(nil)), Size: size}, nil
}

func inspectFile(name, path string) (releaseAsset, error) {
	file, err := os.Open(path)
	if err != nil {
		return releaseAsset{}, err
	}
	defer file.Close()
	digest := sha256.New()
	size, err := io.Copy(digest, file)
	if err != nil {
		return releaseAsset{}, err
	}
	if size == 0 {
		return releaseAsset{}, i18n.Errorf("release.empty", map[string]string{"path": path})
	}
	return releaseAsset{Name: name, SHA256: hex.EncodeToString(digest.Sum(nil)), Size: size}, nil
}

func writeChecksums(out string, names []string) error {
	lines := make([]string, 0, len(names))
	for _, name := range names {
		asset, err := inspectFile(name, filepath.Join(out, name))
		if err != nil {
			return err
		}
		lines = append(lines, asset.SHA256+"  "+name)
	}
	return os.WriteFile(filepath.Join(out, "SHA256SUMS"), []byte(strings.Join(lines, "\n")+"\n"), 0o644)
}

func writeDeterministicZip(path string, inputs []archiveInput) error {
	entries, err := archiveEntries(inputs)
	if err != nil {
		return err
	}
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	writer := zip.NewWriter(file)
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.Name, Method: zip.Store}
		header.SetModTime(time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC))
		header.SetMode(entry.Mode)
		if entry.Directory {
			header.Name += "/"
		}
		destination, err := writer.CreateHeader(header)
		if err != nil {
			return closeZip(writer, file, err)
		}
		if !entry.Directory {
			if err := copyFile(destination, entry.Path); err != nil {
				return closeZip(writer, file, err)
			}
		}
	}
	if err := writer.Close(); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

func writeDeterministicTarGzip(path string, inputs []archiveInput) error {
	entries, err := archiveEntries(inputs)
	if err != nil {
		return err
	}
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	gzipWriter := gzip.NewWriter(file)
	gzipWriter.Header.ModTime = time.Unix(0, 0)
	gzipWriter.Header.OS = 255
	tarWriter := tar.NewWriter(gzipWriter)
	for _, entry := range entries {
		header := &tar.Header{Name: entry.Name, Mode: int64(entry.Mode.Perm()), ModTime: time.Unix(0, 0), AccessTime: time.Unix(0, 0), ChangeTime: time.Unix(0, 0)}
		if entry.Directory {
			header.Typeflag, header.Name = tar.TypeDir, header.Name+"/"
		} else {
			info, statErr := os.Stat(entry.Path)
			if statErr != nil {
				return closeTar(tarWriter, gzipWriter, file, statErr)
			}
			header.Typeflag, header.Size = tar.TypeReg, info.Size()
		}
		if err := tarWriter.WriteHeader(header); err != nil {
			return closeTar(tarWriter, gzipWriter, file, err)
		}
		if !entry.Directory {
			if err := copyFile(tarWriter, entry.Path); err != nil {
				return closeTar(tarWriter, gzipWriter, file, err)
			}
		}
	}
	if err := tarWriter.Close(); err != nil {
		return closeTar(tarWriter, gzipWriter, file, err)
	}
	if err := gzipWriter.Close(); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

type archiveEntry struct {
	Name, Path string
	Mode       fs.FileMode
	Directory  bool
}

func archiveEntries(inputs []archiveInput) ([]archiveEntry, error) {
	var entries []archiveEntry
	for _, input := range inputs {
		info, err := os.Lstat(input.Path)
		if err != nil {
			return nil, err
		}
		if info.Mode()&fs.ModeSymlink != 0 {
			return nil, i18n.Errorf("release.symlink", map[string]string{"path": input.Path})
		}
		if !info.IsDir() {
			entries = append(entries, archiveEntry{Name: input.Name, Path: input.Path, Mode: info.Mode().Perm()})
			continue
		}
		err = filepath.WalkDir(input.Path, func(path string, directory fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			entryInfo, err := directory.Info()
			if err != nil {
				return err
			}
			if entryInfo.Mode()&fs.ModeSymlink != 0 {
				return i18n.Errorf("release.symlink", map[string]string{"path": path})
			}
			relative, err := filepath.Rel(input.Path, path)
			if err != nil {
				return err
			}
			name := input.Name
			if relative != "." {
				name = filepath.ToSlash(filepath.Join(input.Name, relative))
			}
			entries = append(entries, archiveEntry{Name: name, Path: path, Mode: entryInfo.Mode().Perm(), Directory: entryInfo.IsDir()})
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	return entries, nil
}

func copyFile(destination io.Writer, path string) error {
	source, err := os.Open(path)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(destination, source)
	closeErr := source.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func closeZip(writer *zip.Writer, file *os.File, cause error) error {
	_ = writer.Close()
	_ = file.Close()
	return cause
}

func closeTar(tarWriter *tar.Writer, gzipWriter *gzip.Writer, file *os.File, cause error) error {
	_ = tarWriter.Close()
	_ = gzipWriter.Close()
	_ = file.Close()
	return cause
}
