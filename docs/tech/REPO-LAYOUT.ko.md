---
kind: canonical-translation
status: active
canonical: docs/tech/REPO-LAYOUT.md
---

# 저장소 구조

폴더 이름은 내부 항목의 소유자를 선언합니다.

## L1. Workspace

```
wails3beta/
├── soksak-core/        application
├── soksak-plugins/     plugin별 독립 repository
├── soksak-kits/        plugin 공유 코드별 독립 repository
├── soksak-sidecars/    plugin 소유 process별 독립 repository
├── soksak-contracts/   공유 공개 계약과 acceptance suite
├── wails-services/     이 project가 작성한 Wails service
├── forks/              직접 유지하는 upstream fork
├── libraries/          직접 만든 재사용 library
├── externals/          수정하지 않는 제3자 source
├── tests/              제품 전용 system 및 acceptance repository
└── backup/             어떤 build도 참조하지 않는 제거 material
```

다음 규칙이 이 구조를 만듭니다.

1. Folder 이름이 ownership과 수정 정책을 드러냅니다. `forks/`는 직접 유지하는 upstream fork,
   `libraries/`는 직접 만든 재사용 library, `externals/`는 수정하지 않는 제3자 source,
   `tests/`는 Soksak 제품 전용 system 및 acceptance repository입니다. Product dependency는 계속
   정확한 공개 release를 사용합니다.
2. Plugin은 끌 수 있는 기능입니다. 공유 plugin code, 공개 contract, plugin process는 각각 독립
   version repository입니다. Wails service는 host를 확장하며 plugin처럼 끌 수 없습니다.
3. Upstream release는 정확히 pin합니다. Wails Go, CLI, frontend runtime dependency 변경은 별도
   근거와 commit을 갖습니다.
4. `backup/`은 모든 build와 gate에서 보이지 않습니다. Build에 필요한 것은 이곳에 넣지 않습니다.

`forks/` repository의 remote와 branch 계약은 하나입니다. `origin`은 유지하는 fork,
`upstream`은 원본 repository를 가리킵니다. 유지 branch 이름에는 upstream version을 포함합니다.
임시 feature branch는 GREEN 뒤 해당 version branch에 합치고 제거합니다. 같은 upstream release
line을 유지하는 branch 두 개를 남기지 않습니다.

Workspace 구조는 authoring 구조이지 runtime discovery가 아닙니다. Application은 plugin, sidecar,
kit, contract, spec을 `environment.json`에서 해석하며 형제 폴더를 scan하지 않습니다. 각 repository는
자기 test를 실행하고 cross-repository product test는 실제 설치와 같은 environment discovery 경로를
사용합니다. Application은 workspace-relative framework나 frontend package path에 의존하지 않습니다.

## L1b. Message는 그 내용의 owner가 소유합니다

모든 것을 위한 registry 하나가 아니라 owner마다 하나의 registry를 둡니다. Application 문장은
application에, plugin과 sidecar 문장은 각 repository에 있습니다. 외부 tree는 다른 tree의 registry에
문장을 선언하지 않습니다.

Component는 target, operation, 누락된 fact를 말하고 embed하는 application이 사용자 문장을
구성합니다. 이 규칙은 wording과 fact의 소유권을 분리하며 component를 한 application에 강결합하지
않게 합니다.

## L1a. 다른 tree의 material은 copy한 뒤 copy가 위치를 결정합니다

다른 곳에서 온 repository는 이 workspace에 copy하며 원본 upstream에는 쓰지 않습니다. 유지 fork는
`origin`에만 쓰고 수정하지 않는 external에는 쓰지 않습니다. 실행 중인 source tree는 읽는 동안
바뀔 수 있고, 읽을 수 있는 path는 실수로 쓸 수도 있기 때문입니다.

Product component는 자기 product kind 폴더에 둡니다. 유지 upstream fork는 `forks/`, 직접 만든
재사용 library는 `libraries/`, 수정하지 않는 비교 source는 `externals/`, product acceptance code는
`tests/`에 둡니다. 역사로만 보존하는 material은 `backup/`에 두며 build와 gate는 이를 보지
않습니다. 이 workspace path는 dependency locator가 아닙니다. Produced artifact는 copy하지 않고
symlink도 어느 방향으로도 사용하지 않습니다.

## L2. Application 내부

```
soksak-core/
├── main.go             frontend embed와 application composition 진입
├── core/               framework-independent Go: window와 vendor 없음
├── internal/
│   ├── application/    bootstrap, home claim, process wiring, lifecycle system gate
│   ├── repositorygate/ repository 전체 source, document, build, policy gate
│   └── repositoryroot/ go.mod marker 기반 checkout discovery
├── frameworks/wails/   window, capture, native surface, service list를 소유하는 host
├── cmd/sok             control-plane CLI
├── frontend/           renderer
├── docs/               contract(tech/)와 procedure(manual/)
├── build/              packaging input
└── bin/                product binary인 soksak과 sok
```

`core/`는 framework나 특정 plugin 의 이름을 담지 않습니다. `frameworks/wails/`만 Wails host를
알 수 있습니다.

Repository root의 Go file은 `main.go` 하나뿐입니다. Embed path는 선언 file의 상위로 갈 수 없으므로
root가 frontend embed를 소유하고 그 filesystem을 `internal/application`에 전달합니다. Bootstrap과
lifecycle gate는 application package에 함께 있습니다. Repository-wide gate는 자기 package에서
실행하며 `go.mod`를 위로 찾아 checkout root를 발견합니다. Gate는 검사 대상 file 옆에 놓였다는
우연에 의존하지 않습니다.

## L3. Binary는 둘뿐입니다

`bin/soksak`은 application이고 `bin/sok`은 control-plane client입니다. Repository root의 다른 Go
binary는 gate가 거부합니다.

## L4. Document 위치

`docs/tech/`는 contract를, `docs/manual/`은 procedure를 소유합니다. Canonical document는 영어이며
reader-facing document는 대응하는 `.ko.md` 번역본을 갖습니다. `docs/README.md`에 등록되지 않은
document는 product document가 아닙니다.
