SHELL := /bin/sh

.PHONY: require-target require-project guard preflight lock prepare verify build compose
registry_flags = --@soksak:registry=$(REGISTRY) --@soksak-ai:registry=$(REGISTRY) --config.minimum-release-age=0
# Recipes forward the flags as arguments; the scripts and the Taskfile pass them to pnpm verbatim.
registry_arguments = $(if $(findstring command line,$(origin REGISTRY)),$(registry_flags))
# REGISTRY is accepted from the make command line only ($(origin) must be "command line").
# GNU make's own environment channels (MAKEFLAGS, GNUMAKEFLAGS, MAKEFILES, -e) are outside this
# Makefile's control and are not refused; setting them is a deliberate act of the caller.

require-target:
	@test '$(origin TARGET)' = 'command line' && test -n '$(TARGET)' || { echo 'TARGET must be an explicit Make command-line variable' >&2; exit 2; }

require-project:
	@case "$(origin PROJECT)" in undefined) exit 0 ;; "command line") ;; *) echo 'PROJECT must be a command-line project name' >&2; exit 64 ;; esac; \
		project='$(PROJECT)'; \
		test -n "$$project" || { echo 'PROJECT must be a command-line project name' >&2; exit 64; }; \
		case "$$project" in soksak*) ;; *) echo 'PROJECT must start with soksak' >&2; exit 64 ;; esac; \
		case "$$project" in [a-z0-9]*) ;; *) echo 'PROJECT must start with a lowercase letter or digit' >&2; exit 64 ;; esac; \
		case "$$project" in *[!a-z0-9-]*) echo 'PROJECT may contain lowercase letters, digits, and hyphens only' >&2; exit 64 ;; esac; \
		test "$${#project}" -le 31 || { echo 'PROJECT must contain at most 31 bytes' >&2; exit 64; }; \
		case '$(TARGET)' in aarch64-apple-darwin|x86_64-apple-darwin) ;; *) echo 'PROJECT is supported only by a Darwin thin build' >&2; exit 64 ;; esac

# A package that depends on @soksak/* or @soksak-ai/* requires REGISTRY for every install, the public registry included.
guard:
	@case "$(origin REGISTRY)" in undefined|"command line") ;; *) echo 'REGISTRY from the $(origin REGISTRY) is refused: make verify REGISTRY=http://host:port/' >&2; exit 64 ;; esac
	@case "$(origin REGISTRY):$(REGISTRY)" in undefined:|"command line:http://"*|"command line:https://"*) ;; *) echo 'REGISTRY must be an absolute URL: make verify REGISTRY=http://host:port/' >&2; exit 64 ;; esac
	@dependency=$$(node -p 'const p=require("$(CURDIR)/frontend/package.json");Object.keys({...p.dependencies,...p.devDependencies,...p.peerDependencies}).find((name)=>/^@soksak(-ai)?\//.test(name))??""') || exit $$?; test -z "$$dependency" || test "$(origin REGISTRY)" = "command line" || { echo "REGISTRY required: this package depends on $$dependency: make verify REGISTRY=http://host:port/" >&2; exit 64; }

preflight:
	@scripts/ci/check-build-toolchain.sh --toolchain-only

lock: guard preflight
	@go mod tidy
	@CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm --dir frontend $(registry_arguments) install --lockfile-only

prepare: guard preflight
	@scripts/ci/prepare-frontend-dependencies.sh $(registry_arguments)

verify: guard
	@go tool wails3 task verify PNPM_FLAGS='$(registry_arguments)'

build: guard require-target require-project
	@case '$(TARGET)' in \
		aarch64-apple-darwin) scripts/ci/darwin-release.sh arm64 '$(PROJECT)' $(registry_arguments) ;; \
		x86_64-apple-darwin) scripts/ci/darwin-release.sh x86_64 '$(PROJECT)' $(registry_arguments) ;; \
		aarch64-unknown-linux-gnu) scripts/ci/linux-release.sh arm64 $(registry_arguments) ;; \
		x86_64-unknown-linux-gnu) scripts/ci/linux-release.sh amd64 $(registry_arguments) ;; \
		x86_64-pc-windows-msvc) scripts/ci/windows-build.sh all $(registry_arguments) ;; \
		universal-apple-darwin) echo 'use make compose TARGET=universal-apple-darwin after both thin artifacts exist' >&2; exit 2 ;; \
		*) echo 'unsupported TARGET=$(TARGET)' >&2; exit 2 ;; \
	esac

compose: require-target
	@test '$(TARGET)' = 'universal-apple-darwin' || { echo 'compose requires TARGET=universal-apple-darwin' >&2; exit 2; }
	@scripts/ci/darwin-universal.sh
