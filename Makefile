SHELL := /bin/sh

.PHONY: require-target guard preflight lock prepare verify build compose
registry_flags = --@soksak:registry=$(REGISTRY) --@soksak-ai:registry=$(REGISTRY) --config.minimum-release-age=0
# Recipes forward the flags as arguments; the scripts and the Taskfile pass them to pnpm verbatim.
registry_arguments = $(if $(findstring command line,$(origin REGISTRY)),$(registry_flags))
# REGISTRY is accepted from the make command line only ($(origin) must be "command line").
# GNU make's own environment channels (MAKEFLAGS, GNUMAKEFLAGS, MAKEFILES, -e) are outside this
# Makefile's control and are not refused; setting them is a deliberate act of the caller.

require-target:
	@test '$(origin TARGET)' = 'command line' && test -n '$(TARGET)' || { echo 'TARGET must be an explicit Make command-line variable' >&2; exit 2; }

# A package that depends on @soksak/* or @soksak-ai/* requires REGISTRY for every install, the public registry included.
guard:
	@case "$(origin REGISTRY)" in undefined|"command line") ;; *) echo 'REGISTRY from the $(origin REGISTRY) is refused: make verify REGISTRY=http://host:port/' >&2; exit 64 ;; esac
	@case "$(origin REGISTRY):$(REGISTRY)" in undefined:|"command line:http://"*|"command line:https://"*) ;; *) echo 'REGISTRY must be an absolute URL: make verify REGISTRY=http://host:port/' >&2; exit 64 ;; esac
	@dependency=$$(node -p 'const p=require("$(CURDIR)/frontend/package.json");Object.keys({...p.dependencies,...p.devDependencies,...p.peerDependencies}).find((name)=>/^@soksak(-ai)?\//.test(name))??""') || exit $$?; test -z "$$dependency" || test "$(origin REGISTRY)" = "command line" || { echo "REGISTRY required: this package depends on $$dependency: make verify REGISTRY=http://host:port/" >&2; exit 64; }

preflight:
	@scripts/ci/check-build-toolchain.sh --toolchain-only

lock: preflight
	@go mod tidy

prepare: guard preflight
	@scripts/ci/prepare-frontend-dependencies.sh $(registry_arguments)

verify: guard
	@go tool wails3 task verify PNPM_FLAGS='$(registry_arguments)'

build: guard require-target
	@case '$(TARGET)' in \
		aarch64-apple-darwin) scripts/ci/darwin-release.sh arm64 $(registry_arguments) ;; \
		x86_64-apple-darwin) scripts/ci/darwin-release.sh x86_64 $(registry_arguments) ;; \
		aarch64-unknown-linux-gnu) scripts/ci/linux-release.sh arm64 $(registry_arguments) ;; \
		x86_64-unknown-linux-gnu) scripts/ci/linux-release.sh amd64 $(registry_arguments) ;; \
		x86_64-pc-windows-msvc) scripts/ci/windows-build.sh all $(registry_arguments) ;; \
		universal-apple-darwin) echo 'use make compose TARGET=universal-apple-darwin after both thin artifacts exist' >&2; exit 2 ;; \
		*) echo 'unsupported TARGET=$(TARGET)' >&2; exit 2 ;; \
	esac

compose: require-target
	@test '$(TARGET)' = 'universal-apple-darwin' || { echo 'compose requires TARGET=universal-apple-darwin' >&2; exit 2; }
	@scripts/ci/darwin-universal.sh
