# vsterm-tauri 빌드/실행 명령 — 멱등하고 버전관리되는 단일 진입점.
# 임의 명령 대신 항상 이 타깃을 사용한다. (`make help` 로 목록 확인)

SHELL := /bin/bash
PNPM  := pnpm

# 빌드된 안정 .app 경로(tauri.conf productName 기준).
APP := src-tauri/target/release/bundle/macos/soksak.app
# 개발 전용 설정 오버라이드(이름/아이콘/identifier 를 dev 로 분리).
DEV_CONFIG := src-tauri/tauri.dev.conf.json

.DEFAULT_GOAL := help

.PHONY: help install dev build run stable typecheck check verify clean stop

help: ## 사용 가능한 명령 목록
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  make %-12s %s\n", $$1, $$2}'

install: ## 의존성 설치(멱등)
	$(PNPM) install

dev: ## 개발 서버 실행(HMR + dev 이름/아이콘으로 릴리스와 구분)
	$(PNPM) tauri dev --config $(DEV_CONFIG)

build: ## 안정 릴리스 .app 빌드(최적화)
	$(PNPM) tauri build

run: ## 빌드된 안정 .app 을 새 인스턴스로 실행(개발 dev 와 병행)
	@test -d "$(APP)" || { echo "먼저 'make build' 를 실행하세요."; exit 1; }
	open -n "$(APP)"

stable: build run ## 안정 .app 빌드 후 실행

typecheck: ## 프론트엔드 타입 체크(tsc)
	$(PNPM) exec tsc --noEmit

check: ## Rust 컴파일 체크(cargo check)
	cd src-tauri && cargo check

verify: typecheck check ## 타입체크 + Rust 체크(커밋 전 검증)

clean: ## 빌드 산출물 제거(dist, release 번들)
	rm -rf dist src-tauri/target/release/bundle

stop: ## 실행 중인 개발 서버 종료
	@pkill -f "target/debug/soksak" 2>/dev/null || true
	@pkill -f "node_modules/.*tauri.js dev" 2>/dev/null || true
	@echo "개발 서버 종료(실행 중이었다면)."
