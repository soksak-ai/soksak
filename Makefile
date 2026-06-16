# soksak 빌드/실행 명령 — 멱등하고 버전관리되는 단일 진입점.
# 임의 명령 대신 항상 이 타깃을 사용한다. (`make help` 로 목록 확인)
#
# 3-정체성 구분(독에서 한눈에):
#   soksak-dev   = HMR 개발 서버(make dev). 번들 아님 → 바이너리명이 독에 그대로.
#   soksak-debug = 디버그 번들(make build-debug). 주황 아이콘.
#   soksak       = 릴리스 번들(make build). 기본 아이콘.
# 기본 설정(tauri.conf.json)이 dev 정체성이고, 빌드 시 --config 로 정확히 푼다.

SHELL := /bin/bash
PNPM  := pnpm

# 레지스트리 카탈로그 단일 진실(P2) — 코어는 이 URL 만 안다. src/state/registry.ts 와 동일.
REGISTRY_URL := https://raw.githubusercontent.com/soksak-ai/soksak-plugin-registry/main/registry.json

RELEASE_CONFIG := src-tauri/tauri.release.conf.json
DEBUG_CONFIG   := src-tauri/tauri.debug.conf.json

RELEASE_APP := src-tauri/target/release/bundle/macos/soksak.app
DEBUG_APP   := src-tauri/target/debug/bundle/macos/soksak-debug.app

.DEFAULT_GOAL := help

.PHONY: help install icons dev build build-debug run run-debug typecheck check test test-front verify clean stop cli install-cli docs registry

help: ## 사용 가능한 명령 목록
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  make %-13s %s\n", $$1, $$2}'

install: ## 의존성 설치(멱등)
	$(PNPM) install

icons: ## 앱 아이콘 전체 재생성(SVG→마스터1024 + base/dev/debug 아이덴티티). 멱등
	@command -v magick >/dev/null || { echo "ImageMagick(magick) 필요"; exit 1; }
	bash scripts/logo/appicon.sh
	cp src-tauri/icons/icon.png /tmp/soksak-icon-master.png   # 1024 스냅샷 — tauri icon 이 icon.png 를 512 로 덮으므로 보존
	$(PNPM) tauri icon /tmp/soksak-icon-master.png --output src-tauri/icons
	magick /tmp/soksak-icon-master.png -fill '#2ec07a' -colorize 42% /tmp/soksak-icon-dev.png
	$(PNPM) tauri icon /tmp/soksak-icon-dev.png --output src-tauri/icons-dev
	magick /tmp/soksak-icon-master.png -fill '#ff8c1a' -colorize 45% /tmp/soksak-icon-debug.png
	$(PNPM) tauri icon /tmp/soksak-icon-debug.png --output src-tauri/icons-debug
	cp /tmp/soksak-icon-master.png src-tauri/icons/icon.png   # 마스터 1024 복원(커밋되는 단일 원본)
	@rm -f /tmp/soksak-icon-master.png /tmp/soksak-icon-dev.png /tmp/soksak-icon-debug.png
	@echo "아이콘 재생성 완료: 마스터(1024 SVG벡터)+base+dev(녹색)+debug(주황)"

dev: ## 개발 서버(HMR). 독 "soksak-dev"+DEV 배지. 외부 플러그인 repo 는 SOKSAK_DEV_PLUGINS_EXTRA=경로 로 추가
	SOKSAK_DEV_PLUGINS=$(PWD)/plugins$${SOKSAK_DEV_PLUGINS_EXTRA:+:$$SOKSAK_DEV_PLUGINS_EXTRA} $(PNPM) tauri dev

build: ## 릴리스 번들 빌드 → "soksak.app"(기본 아이콘)
	$(PNPM) tauri build --config $(RELEASE_CONFIG)

build-debug: ## 디버그 번들 빌드 → "soksak-debug.app"(주황 아이콘)
	$(PNPM) tauri build --debug --config $(DEBUG_CONFIG)

run: ## 릴리스 soksak.app 실행(새 인스턴스)
	@test -d "$(RELEASE_APP)" || { echo "먼저 'make build' 를 실행하세요."; exit 1; }
	open -n "$(RELEASE_APP)"

run-debug: ## 디버그 soksak-debug.app 실행(새 인스턴스)
	@test -d "$(DEBUG_APP)" || { echo "먼저 'make build-debug' 를 실행하세요."; exit 1; }
	open -n "$(DEBUG_APP)"

cli: ## sok CLI 빌드(릴리스)
	cd src-tauri && cargo build --release -p sok

install-cli: cli ## sok 를 /usr/local/bin 에 링크(멱등)
	@mkdir -p /usr/local/bin 2>/dev/null || true
	ln -sf "$(abspath src-tauri/target/release/sok)" /usr/local/bin/sok
	@echo "설치 완료: /usr/local/bin/sok → src-tauri/target/release/sok"

docs: ## 명령 레퍼런스 생성(docs/COMMANDS.md — 앱이 실행 중이어야 함)
	@mkdir -p docs
	src-tauri/target/release/sok docs > docs/COMMANDS.md
	@echo "생성: docs/COMMANDS.md"

# 발행(plugin-publish)은 코어에 두지 않는다(P1·P3) — 각 플러그인은 자기 독립 repo 에서
# 직접 커밋·태그·push 한다. 카탈로그 갱신(각 repo plugin.json → registry.json)은
# soksak-plugin-registry repo 가 소유한다.

registry: ## 레지스트리 카탈로그 스냅샷 갱신 — 라이브 registry.json 을 fetch 해 캐시(P2 소비). 멱등
	@curl -fsSL "$(REGISTRY_URL)" -o src/plugins/registrySnapshot.json
	@echo "레지스트리 스냅샷: src/plugins/registrySnapshot.json ($$(jq '.plugins | length' src/plugins/registrySnapshot.json)개, 라이브 fetch)"

typecheck: ## 프론트엔드 타입 체크(tsc)
	$(PNPM) exec tsc --noEmit

check: ## Rust 컴파일 체크(cargo check)
	cd src-tauri && cargo check

test: ## Rust 단위 테스트
	cd src-tauri && cargo test --lib

test-front: ## 프론트엔드 단위 테스트(vitest)
	$(PNPM) test

verify: typecheck check test test-front ## 타입체크 + Rust/프론트 테스트(커밋 전 검증)

e2e-resize: ## 리사이즈 E2E(기계 측정 — blank/프롬프트/TUI). macOS+앱 실행+동의 필요
	scripts/e2e/resize.sh --identity $${IDENTITY:-dev}

clean: ## 빌드 산출물 제거(dist, 번들)
	rm -rf dist src-tauri/target/release/bundle src-tauri/target/debug/bundle

stop: ## 실행 중인 개발 스택 전체 종료(tauri 바이너리 + tauri.js dev + Vite)
	@pkill -f "target/debug/soksak-dev" 2>/dev/null || true
	@pkill -f "node_modules/.*tauri.js dev" 2>/dev/null || true
	@# tauri.js dev 가 죽어도 beforeDevCommand 로 띄운 Vite(devUrl 포트 1420)는 고아로
	@# 남는다 — devUrl 포트를 점유한 프로세스를 정리해 clean stop 을 보장한다.
	@pids=$$(lsof -ti :1420 2>/dev/null); [ -n "$$pids" ] && kill $$pids 2>/dev/null || true
	@echo "개발 서버 종료(tauri + Vite)."
