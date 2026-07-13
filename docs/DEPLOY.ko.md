# 배포와 핫스왑 (v1)

soksak 은 유닛 단위로 배포되고, 실행 중인 앱을 최소한의 재시작으로 갱신한다. 이
문서는 빌드가 무엇을 만드는지, 커밋에서 실행 세션까지 어떻게 흐르는지, 홈이 그것을
어떻게 받는지, 버전이 어떻게 오르는지, 갱신이 세션을 무너뜨리지 않고 어떻게
반영되는지의 정본 모델이다. 사이드카 스테이징·배포 세부는 SIDECARS.md §6 에, 재시작을
매끄럽게 만드는 복원 사다리는 RESTORE.md 에 있다. 이 문서는 그 전체의 오케스트레이션을
소유한다.

## 1. 무엇이 배포되나

네 가지 아티팩트 종류, 각각 고유한 전달 방식:

| 유닛 | 아티팩트 | 전달 | CI 게이트 |
|------|----------|------|-----------|
| 플러그인 | `main.js` (repo 에 추적) | `git clone` / `git pull --ff-only` | test + esbuild drift (`git diff --exit-code main.js`) |
| 사이드카 | release asset `…-<ver>-<os>-<arch>.tar.gz` + sha256 | `gh release`, 소비 플러그인의 `reach.fetch` 로 핀 | tag `v*` → build → stage → tar (`-L`) → release |
| 계약 | 없음 | test 게이트만 (declared ≡ actual) | `node --test` / `cargo test` |
| 앱 본체 | 서명·공증된 `.app` + `latest.json` + minisign `.sig` | `tauri-plugin-updater` (release 채널) | build → codesign → notarytool → release |

플러그인은 clone 하는 소스다 — release asset 이 없다. 사이드카는 소비자 매니페스트가
선언한 sha256-핀 URL 로 받는 네이티브 바이너리다. 계약은 아무것도 배포하지 않는다 —
양쪽이 준수하는 test 게이트다. 앱 본체만이 updater 가 내려받아 설치하는 대상이다.

## 2. 파이프라인 — 커밋에서 실행 앱까지

변경은 모든 유닛에서 같은 방식으로 실행 세션에 도달하며, 아티팩트만 다르다:

1. **저자**가 유닛 repo 에 커밋한다. 플러그인은 빌드된 `main.js` 를 추적하고, 사이드카와
   앱 본체는 CI 에서 빌드된다.
2. **CI** 가 유닛 게이트를 돌린다. 플러그인: test + `main.js` 가 소스에 뒤처지면 실패하는
   esbuild drift 검사. 사이드카: `v*` 태그에 build → `stage.sh` → tar (`-L`) + sha256 →
   `gh release`. 계약: 그 인수 스위트. 앱 본체: `v*` 태그에 build → codesign → notarytool
   → `latest.json` + minisign `.sig` 로 release (§8).
3. **홈**이 종류별로 아티팩트를 받는다 (§4): 플러그인은 `git pull`, 사이드카는 소비자가
   선언한 sha256-핀 `reach.fetch` URL, 앱 본체는 `latest.json` 을 읽는
   `tauri-plugin-updater` — release 채널만.
4. **런타임**이 최소 재시작으로 반영한다 (§6): `update.apply` 가 핫 축을 순서대로 굴리고,
   앱 본체가 필요로 하는 한 번의 재시작은 복원 사다리가 덮는다.

1–2 단계는 repo 별 CI(유닛·앱 워크플로우)다. 3–4 단계는 코어의 몫 — 설치 프리미티브
(`download_unpack_verify`, `install_git_into`, `tauri-plugin-updater`)와 `update.*`
오케스트레이터다. **앱이 소비하는 빌드 산출물**(플러그인의 번들 `main.js`, 사이드카
바이너리, `@soksak-ai/plugin-spec` dist)은 소스가 바뀔 때마다 2 단계에서 재빌드돼야 한다 —
유닛 테스트는 소스를 읽어 초록으로 남지만 실행 앱은 stale 산출물을 읽으므로, 소스만 바꾼
변경은 산출물이 재빌드돼 수령되기 전까지 배포된 것이 아니다.

## 3. VER — 버전

유닛·앱 릴리스는 semver 로 오른다:

- **PATCH** — 하위 호환 버그 수정.
- **MINOR** — 하위 호환 기능. `0.x` 대역에서는 breaking 도 MINOR 다(1.0 이전 관례가 MAJOR
  자리를 0 으로 고정).
- **MAJOR** — 하위 호환이 깨지는 변경, `1.0` 이후.

계약의 major(`@N`)는 **별개 축**이다: 계약 *내용*이 깨질 때만 오르고, 구현의 버전으로는
오르지 않는다. 계약 id 를 내용 변경 없이 개명하는 것은 내용 breaking 이 아니다 — 새 wire·
발견 키를 지게 된 유닛들에게는 MINOR 이고, 계약은 `@1` 로 남는다.

## 4. HOME — 홈별 배급

identity 홈이 각 유닛의 출처를 정한다(`home.rs`, ARCHITECTURE A17):

- **dev** (`~/.soksak-dev`) — 앱 본체는 로컬 빌드; 플러그인은 로컬 개발과 내려받기 혼용
  (개발 정본 홈).
- **debug** (`~/.soksak-debug`) — 앱 본체는 로컬 빌드(`make build-debug`, 코어 저자의 자체
  검증); 플러그인·사이드카는 전부 GitHub 아티팩트. 여기서 로컬 체크아웃은 무관하다 —
  배포된 유닛을 로컬 빌드 코어에 통합 검증한다.
- **release** (`~/.soksak`) — 앱 본체·플러그인·사이드카가 전부 GitHub 아티팩트(실사용자 홈).

귀결: **앱 본체 원격 updater 는 release 채널만** 돈다. debug 앱은 본체를 로컬 재빌드로
갱신한다(복원 사다리로 매끄럽게); **유닛** hot 반영(fetch + reload / respawn)은 debug·
release 공통이다 — 둘 다 유닛을 GitHub 에서 받기 때문.

## 5. HS — 핫스왑 법칙

**HS1 — 재시작 최소화.** 새 빌드가 프로세스 재시작 없이 반영될 수 있으면 그렇게 한다.
반영 비용 오름차순 축:

- **플러그인** (JS, 단일 웹뷰): `plugin.update` + `plugin.reload` — 앱 재시작 0.
- **터미널 엔진** (별도 서비스 프로세스): 재스폰 + 데몬 tee·체크포인트로 rehydrate — 앱·셸
  재시작 0.
- **PTY 데몬** (`soksak-ptyd`): fd-handoff drain — 셸이 SIGHUP 없이 생존 (§7).
- **앱 본체 + in-process 엔진 dylib**: relaunch — 단 복원 사다리가 터미널·창을 되살려
  재시작이 끊김 없이 읽힌다.

**HS2 — fd 소유 불변식.** PTY master fd 는 `soksak-ptyd` 가 소유하며 앱·엔진·데몬 세대를
넘어 생존한다. handoff 는 fd *소유권* 이전(dup)이지 프로세스 migration 이 아니다 — 셸은
slave 측에 붙어 서버 교체를 모른다. 어떤 실패 경로도 마지막 master fd 를 닫지 않는다 —
commit 된 업그레이드는 어떤 pane 프로세스 그룹에도 시그널을 보내지 않고 exit 한다.

**HS3 — never-unload 유지.** in-process 엔진 dylib 은 언로드하지 않는다(SIDECARS.md §4) —
dlclose 핫스왑은 살아있는 심볼을 댕글링시킨다. 그런 엔진의 새 빌드는 앱 relaunch 로만
반영하고, 무중단이 필요한 엔진은 별도 프로세스로 두어(터미널 엔진이 이미 그렇다) 재스폰으로
해결한다.

## 6. Update 오케스트레이터 — `update.check` / `update.apply`

`update.check` 는 반영 없이 조사한다: 앱 본체(release 채널만 — debug/dev 빌드는
`available:false`)와, `update.apply` 가 굴릴 수 있는 핫 축의 수(설치 플러그인, 실행 중
데몬).

`update.apply` 는 모든 핫 축에 걸쳐, 덜 파괴적인 것부터, 각 축을 activity 버스로 고지하며
(무음 금지) 반영한다:

1. **플러그인** — `git pull` + reload. 재시작 0. dev 소스 플러그인은 건너뛴다(update 대상
   아님).
2. **사이드카** — `sidecar_ensure` 가 지정 asset 을 받고(sha256-핀·원자 설치), 엔진이
   재스폰돼 rehydrate 한다.
3. **PTY 데몬** — fd-handoff drain (§7).
4. **앱 본체** — release 채널만: `tauri-plugin-updater` 가 서명 번들을 내려받아 설치한 뒤
   relaunch. 본체가 최후이며, 복원 사다리가 세션을 되살린다.

앱 본체 단계는 release 채널로 게이트된다 — debug/dev 홈에서는 loud 고지와 함께 건너뛰고
나머지 축은 그대로 반영된다. 본체는 실제로 새 릴리스가 있을 때만 relaunch 한다.

## 7. PTY 데몬 라이브 drain — fd-handoff

`pty.daemon.upgrade` 는 셸을 재시작하지 않고 새 `soksak-ptyd` 세대를 굴린다. 실행 중인
데몬이 새 바이너리를 스테이징한 뒤, 각 라이브 셸의 PTY master fd 를 fd 상속으로 새 데몬에
넘긴다 — master 의 kernel refcount 가 이전 데몬의 exit 를 넘어 열린 채 남아, slave 측
(셸)에 SIGHUP 이 없다. 세션 집합을 원자 기록(tmp 파일 + rename)하고 새 데몬을 스폰한 뒤
기다린다. 새 데몬은 상속받은 fd 를 adopt 하고 각 세션의 ring seq 부터 tee 를 이어 재개한 뒤
ack 한다 — 그러면 이전 데몬은 어떤 pane 에도 시그널 없이 exit 한다(HS2). ack 전 실패는
rollback — 이전 데몬이 재개해 소유를 유지하고, 어떤 fd 도 닫지 않는다. 앱은 `from_seq` 로
warm 재부착하며, 미세 gap 은 소비자가 ring 을 재생해 흡수하고 `pty.warm.gap` 으로 고지된다.

`pty.daemon.restart`(모든 셸을 죽인다)와는 다르다.

## 8. 서명 (값은 후속)

앱 CI 는 codesign(Developer ID) + notarytool + `latest.json` 의 minisign 서명을 **secret
이름**으로 배선한다. 서명 인증서, Apple ID/team/app-password, minisign 키페어는 secret *값*
으로 별도 등록한다 — 코드·워크플로우·secret 참조가 완전히 배선돼 있어 값만 채우면 추가
코드 변경 없이 서명 배포가 활성된다.
