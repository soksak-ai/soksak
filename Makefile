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

RELEASE_CONFIG := src-tauri/tauri.release.conf.json
DEBUG_CONFIG   := src-tauri/tauri.debug.conf.json

RELEASE_APP := src-tauri/target/release/bundle/macos/soksak.app
DEBUG_APP   := src-tauri/target/debug/bundle/macos/soksak-debug.app

.DEFAULT_GOAL := help

.PHONY: help install icons dev build build-debug run run-debug typecheck check test test-front verify clean stop cli install-cli docs plugin-repos

help: ## 사용 가능한 명령 목록
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  make %-13s %s\n", $$1, $$2}'

install: ## 의존성 설치(멱등)
	$(PNPM) install

icons: ## dev(녹색)/debug(주황) 아이콘을 기본 아이콘에서 재생성(멱등)
	@command -v magick >/dev/null || { echo "ImageMagick(magick) 필요"; exit 1; }
	magick src-tauri/icons/icon.png -fill '#2ec07a' -colorize 42% /tmp/soksak-icon-dev.png
	$(PNPM) tauri icon /tmp/soksak-icon-dev.png --output src-tauri/icons-dev
	magick src-tauri/icons/icon.png -fill '#ff8c1a' -colorize 45% /tmp/soksak-icon-debug.png
	$(PNPM) tauri icon /tmp/soksak-icon-debug.png --output src-tauri/icons-debug
	@rm -f /tmp/soksak-icon-dev.png /tmp/soksak-icon-debug.png
	@echo "아이콘 재생성 완료: icons-dev(녹색), icons-debug(주황)"

dev: ## 개발 서버(HMR). 독 이름 "soksak-dev" + DEV 배지
	$(PNPM) tauri dev

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

plugin-repos: ## 공식 플러그인 → 독립 git 레포 생성(plugins/.repos, 멱등)
	@for d in plugins/*/; do \
		id=$$(basename $$d); \
		ver=$$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' $$d/plugin.json | head -1); \
		dest=plugins/.repos/$$id; \
		rm -rf $$dest && mkdir -p $$dest && cp -R $$d. $$dest/ && \
		git -C $$dest init -q && \
		git -C $$dest -c user.email=plugins@soksak -c user.name=soksak add . && \
		git -C $$dest -c user.email=plugins@soksak -c user.name=soksak \
			-c commit.gpgsign=false commit -qm "$$id v$$ver" && \
		git -C $$dest -c user.email=plugins@soksak -c user.name=soksak tag -f v$$ver >/dev/null && \
		echo "plugins/.repos/$$id (v$$ver)"; \
	done

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

stop: ## 실행 중인 개발 서버 종료
	@pkill -f "target/debug/soksak-dev" 2>/dev/null || true
	@pkill -f "node_modules/.*tauri.js dev" 2>/dev/null || true
	@echo "개발 서버 종료(실행 중이었다면)."
