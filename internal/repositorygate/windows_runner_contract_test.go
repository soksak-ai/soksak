package repositorygate

import (
	"os"
	"strings"
	"testing"
)

func TestWindowsBuildRunnerIsSharedByDockerAndActions(t *testing.T) {
	workflow := readText(t, ".github/workflows/multiplatform-system.yml")
	docker := readText(t, "scripts/ci/windows-docker.sh")
	if !strings.Contains(workflow, "windows-build.sh all") {
		t.Error("workflow does not execute the complete Windows build")
	}
	for _, required := range []string{"phase=${1:-all}", "windows-build.sh $BUILD_PHASE"} {
		if !strings.Contains(docker, required) {
			t.Errorf("Docker runner omits %q", required)
		}
	}
	dockerfile := readText(t, "build/docker/Dockerfile.windows-ci")
	for _, required := range []string{"NODE_IMAGE=node:must-be-provided", "PNPM_VERSION=must-be-provided", "wails3@v3.0.0-beta.12", "COPY --from=node-runtime /usr/local/ /usr/local/"} {
		if !strings.Contains(dockerfile, required) {
			t.Errorf("Windows CI image does not pin %s", required)
		}
	}
	if !strings.Contains(docker, "io.soksak.windows-ci.definition-sha") {
		t.Fatal("Docker runner rebuilds the CI image without a definition hash")
	}
	for _, required := range []string{"frontend/package.json", "NODE_IMAGE=node:$node_version-bookworm", "PNPM_VERSION=$pnpm_version"} {
		if !strings.Contains(docker, required) {
			t.Errorf("Docker runner does not project the frontend owner file through %q", required)
		}
	}
	runner := readText(t, "scripts/ci/windows-build.sh")
	for _, required := range []string{"go mod tidy -diff", "frontend/bindings", "generate syso"} {
		if !strings.Contains(runner, required) {
			t.Errorf("Windows canonical source gate is missing %q", required)
		}
	}
	for _, forbidden := range []string{"generate bindings", "generated_source_digest", "go mod tidy\n"} {
		if strings.Contains(runner, forbidden) {
			t.Errorf("Windows build mutates canonical source through %q", forbidden)
		}
	}
}

func TestCrossBuilderConsumesOnePinnedFrontendAndBuildsBothBinaries(t *testing.T) {
	dockerfile := readText(t, "build/docker/Dockerfile.cross")
	for _, forbidden := range []string{"npm install", "npm run build"} {
		if strings.Contains(dockerfile, forbidden) {
			t.Errorf("cross compiler owns frontend operation %q", forbidden)
		}
	}
	for _, forbidden := range []string{`CGO_CFLAGS="-w"`, "Frameworks -w"} {
		if strings.Contains(dockerfile, forbidden) {
			t.Errorf("cross compiler suppresses C diagnostics through %q", forbidden)
		}
	}
	for _, required := range []string{"frontend/dist/index.html", "./cmd/sok", "-tags production", `"$OUTPUT/sok$EXT"`, "CGO_ENABLED=0 go build", `chown -R "$HOST_UID:$HOST_GID"`, "macos.10.15", "MACOSX_DEPLOYMENT_TARGET=10.15"} {
		if !strings.Contains(dockerfile, required) {
			t.Errorf("cross compiler omits %q", required)
		}
	}
	runner := readText(t, "scripts/ci/cross-build.sh")
	for _, required := range []string{"frontend-build.sh", "cross-image.sh", "--platform", "file \"$application\"", "go version -m", "readelf --version-info", "HOST_UID"} {
		if !strings.Contains(runner, required) {
			t.Errorf("cross release runner omits %q", required)
		}
	}
	imageBuilder := readText(t, "scripts/ci/cross-image.sh")
	for _, required := range []string{".zig-version", "ZIG_VERSION=$zig_version"} {
		if !strings.Contains(imageBuilder, required) {
			t.Errorf("cross image builder does not project Zig owner file through %q", required)
		}
	}
	if !strings.Contains(dockerfile, "ZIG_VERSION=must-be-provided") || strings.Contains(dockerfile, "ZIG_VERSION=0.") {
		t.Fatal("cross image hardcodes Zig instead of reading .zig-version")
	}
	frontend := readText(t, "scripts/ci/frontend-build.sh")
	for _, required := range []string{"frontend/package.json", "NODE_VERSION=$node_version", "PNPM_VERSION=$pnpm_version", "PNPM_DISABLE_SELF_UPDATE_CHECK=1", ".build-input-sha256", `node --version`, `pnpm --version`, "build_frontend"} {
		if !strings.Contains(frontend, required) {
			t.Errorf("frontend runner omits %q", required)
		}
	}
	frontendImage := readText(t, "build/docker/Dockerfile.frontend")
	if !strings.Contains(frontendImage, "NPM_CONFIG_UPDATE_NOTIFIER=false") {
		t.Fatal("frontend image does not disable the npm update notifier")
	}
	universal := readText(t, "scripts/ci/darwin-universal.sh")
	for _, required := range []string{"cross-build.sh", "lipo -create", "soksak.app", `test "$(lipo -archs`} {
		if !strings.Contains(universal, required) {
			t.Errorf("Darwin universal runner omits %q", required)
		}
	}
	native := readText(t, "scripts/ci/darwin-release.sh")
	for _, required := range []string{"MACOSX_DEPLOYMENT_TARGET=10.15", "minimum=11.0", "GOARCH=$architecture", "clang_arch=x86_64", "cli_minimum", "want 12.0", "vtool -show-build", "lipo -create", "grep -F 'warning:'", "codesign --verify --deep --strict"} {
		if !strings.Contains(native, required) {
			t.Errorf("native Darwin release runner omits %q", required)
		}
	}
}

func readText(t *testing.T, path string) string {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}
