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

.PHONY: help install dev build build-debug run run-debug typecheck check verify clean stop

help: ## 사용 가능한 명령 목록
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  make %-13s %s\n", $$1, $$2}'

install: ## 의존성 설치(멱등)
	$(PNPM) install

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

typecheck: ## 프론트엔드 타입 체크(tsc)
	$(PNPM) exec tsc --noEmit

check: ## Rust 컴파일 체크(cargo check)
	cd src-tauri && cargo check

verify: typecheck check ## 타입체크 + Rust 체크(커밋 전 검증)

clean: ## 빌드 산출물 제거(dist, 번들)
	rm -rf dist src-tauri/target/release/bundle src-tauri/target/debug/bundle

stop: ## 실행 중인 개발 서버 종료
	@pkill -f "target/debug/soksak-dev" 2>/dev/null || true
	@pkill -f "node_modules/.*tauri.js dev" 2>/dev/null || true
	@echo "개발 서버 종료(실행 중이었다면)."
