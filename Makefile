SHELL := /bin/sh

.PHONY: require-target preflight prepare verify build compose

require-target:
	@test '$(origin TARGET)' = 'command line' && test -n '$(TARGET)' || { echo 'TARGET must be an explicit Make command-line variable' >&2; exit 2; }

preflight:
	@scripts/ci/check-build-toolchain.sh --toolchain-only

prepare: preflight
	@scripts/ci/prepare-frontend-dependencies.sh

verify:
	@go tool wails3 task verify

build: require-target
	@case '$(TARGET)' in \
		aarch64-apple-darwin) scripts/ci/darwin-release.sh arm64 ;; \
		x86_64-apple-darwin) scripts/ci/darwin-release.sh x86_64 ;; \
		aarch64-unknown-linux-gnu) scripts/ci/linux-release.sh arm64 ;; \
		x86_64-unknown-linux-gnu) scripts/ci/linux-release.sh amd64 ;; \
		x86_64-pc-windows-msvc) scripts/ci/windows-build.sh all ;; \
		universal-apple-darwin) echo 'use make compose TARGET=universal-apple-darwin after both thin artifacts exist' >&2; exit 2 ;; \
		*) echo 'unsupported TARGET=$(TARGET)' >&2; exit 2 ;; \
	esac

compose: require-target
	@test '$(TARGET)' = 'universal-apple-darwin' || { echo 'compose requires TARGET=universal-apple-darwin' >&2; exit 2; }
	@scripts/ci/darwin-universal.sh
