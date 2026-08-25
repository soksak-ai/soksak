package install

import "github.com/soksak-ai/soksak-core/core/i18n"

// The refusals this package answers a caller with. A caller reads these over
// the command registry, so they are declared here rather than formatted at the
// call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"install.transaction.unsupportedKind": {
			EN: "artifact kind {kind} is not installable",
			KO: "{kind} 유형의 아티팩트는 설치할 수 없습니다",
		},
		"install.transaction.manifestPathMismatch": {
			EN: "artifact manifest {manifest} must be {expected}",
			KO: "아티팩트 매니페스트 {manifest}은(는) {expected}이어야 합니다",
		},
		"install.transaction.manifestIdentityInvalid": {
			EN: "artifact {artifact} has an invalid manifest identity",
			KO: "아티팩트 {artifact}의 매니페스트 식별자가 올바르지 않습니다",
		},
		"install.transaction.manifestIdentityMismatch": {
			EN: "artifact {artifact} does not match its manifest identity",
			KO: "아티팩트 {artifact}가 매니페스트 식별자와 일치하지 않습니다",
		},
		"install.npm.noRunner": {
			EN: "npm_global_dirs cannot run anything in this build — set install.Deps.Run",
			KO: "이 빌드의 npm_global_dirs 는 아무것도 실행할 수 없습니다 — install.Deps.Run 을 넣으십시오",
		},
		"install.npm.exitCode": {
			EN: "npm_global_dirs: {program} answered {code} for `npm prefix -g`; npm is not on the login shell's PATH",
			KO: "npm_global_dirs: {program} 이(가) `npm prefix -g` 에 {code} 을(를) 반환했습니다 — npm 이 로그인 셸의 PATH 에 없습니다",
		},
		"install.npm.noPlatform": {
			EN: "npm_global_dirs needs the host platform and this process was not given one — set install.Deps.OS",
			KO: "npm_global_dirs 에는 호스트 플랫폼이 필요하며 이 프로세스는 받지 못했습니다 — install.Deps.OS 를 넣으십시오",
		},
		"install.npm.noWindowsLayout": {
			EN: "npm_global_dirs has no measured Windows layout: npm puts global launchers at <prefix>\\<name>.cmd and packages at <prefix>\\node_modules, so the bin/lib join this command answers would make every installed tool read as missing",
			KO: "npm_global_dirs 에는 측정된 Windows 배치가 없습니다: npm 은 전역 실행기를 <prefix>\\<name>.cmd 에, 패키지를 <prefix>\\node_modules 에 둡니다 — 이 명령이 답하는 bin/lib 조합은 설치된 모든 도구를 없는 것으로 읽게 만듭니다",
		},
		"install.npm.noLoginShell": {
			EN: "npm_global_dirs needs a login shell and this process was not given one — set install.Deps.LoginShell (never $SHELL, which answers about whatever launched this process)",
			KO: "npm_global_dirs 에는 로그인 셸이 필요하며 이 프로세스는 받지 못했습니다 — install.Deps.LoginShell 을 넣으십시오($SHELL 은 이 프로세스를 실행한 대상을 답하므로 쓰지 마십시오)",
		},
		"install.npm.emptyPrefix": {
			EN: "npm_global_dirs: `npm prefix -g` printed nothing; npm did not answer",
			KO: "npm_global_dirs: `npm prefix -g` 이(가) 아무것도 출력하지 않았습니다 — npm 이 답하지 않았습니다",
		},
	})
}

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"install.transaction.noFetcher":                {EN: "installer requires a fetcher", KO: "인스톨러에 fetcher 가 필요합니다"},
		"install.transaction.identityRequired":         {EN: "installer requires registry and root identity", KO: "인스톨러에 registry 와 root identity 가 필요합니다"},
		"install.transaction.localStoreInvalid":        {EN: "local install requires registryId local and one absolute local release store", KO: "local install에는 registryId local과 절대 local release store 하나가 필요합니다"},
		"install.transaction.notFound":                 {EN: "install transaction not found: {id}", KO: "설치 트랜잭션이 없습니다: {id}"},
		"install.transaction.registryMismatch":         {EN: "registry does not match the install transaction", KO: "registry 가 설치 트랜잭션과 일치하지 않습니다"},
		"install.transaction.unsupportedFormat":        {EN: "unsupported artifact format: {format}", KO: "지원하지 않는 아티팩트 형식입니다: {format}"},
		"install.transaction.digestMismatch":           {EN: "artifact SHA-256 mismatch: {digest}", KO: "아티팩트 SHA-256 이 일치하지 않습니다: {digest}"},
		"install.transaction.sizeMismatch":             {EN: "artifact byte size mismatch", KO: "아티팩트 바이트 크기가 일치하지 않습니다"},
		"install.transaction.entrypointUnsafe":         {EN: "unsafe entrypoint path: {path}", KO: "안전하지 않은 entrypoint 경로입니다: {path}"},
		"install.transaction.entrypointNotRegular":     {EN: "entrypoint is not a regular file: {path}", KO: "entrypoint 가 일반 파일이 아닙니다: {path}"},
		"install.transaction.ended":                    {EN: "install transaction ended during artifact staging", KO: "아티팩트 스테이징 중 설치 트랜잭션이 종료되었습니다"},
		"install.transaction.stagedPathUnsafe":         {EN: "unsafe staged path: {path}", KO: "안전하지 않은 스테이징 경로입니다: {path}"},
		"install.transaction.stagedNotFound":           {EN: "staged artifact not found", KO: "스테이징된 아티팩트가 없습니다"},
		"install.transaction.stagedNotRegular":         {EN: "staged path is not a regular file: {path}", KO: "스테이징 경로가 일반 파일이 아닙니다: {path}"},
		"install.transaction.stagedNotUTF8":            {EN: "staged path is not UTF-8: {path}", KO: "스테이징 경로가 UTF-8 이 아닙니다: {path}"},
		"install.transaction.archivePathUnsafe":        {EN: "unsafe archive path: {path}", KO: "안전하지 않은 아카이브 경로입니다: {path}"},
		"install.transaction.archiveEntryType":         {EN: "archive entry is not a regular file or directory: {path}", KO: "아카이브 항목이 일반 파일 또는 디렉터리가 아닙니다: {path}"},
		"install.transaction.archiveLimit":             {EN: "archive extraction limit exceeded", KO: "아카이브 추출 한도를 초과했습니다"},
		"install.transaction.homeAbsolute":             {EN: "installer home must be absolute", KO: "인스톨러 home 은 절대 경로여야 합니다"},
		"install.transaction.commitArtifactsRequired":  {EN: "installer commit requires artifacts", KO: "인스톨러 commit 에 아티팩트가 필요합니다"},
		"install.transaction.duplicateArtifact":        {EN: "duplicate verified artifact: {artifact}", KO: "검증된 아티팩트가 중복되었습니다: {artifact}"},
		"install.transaction.stagedArtifactMismatch":   {EN: "staged artifact does not match verified artifact: {artifact}", KO: "스테이징된 아티팩트가 검증된 아티팩트와 일치하지 않습니다: {artifact}"},
		"install.transaction.manifestArtifactMismatch": {EN: "staged manifest does not match verified artifact: {artifact}", KO: "스테이징된 매니페스트가 검증된 아티팩트와 일치하지 않습니다: {artifact}"},
		"install.transaction.destinationExists":        {EN: "install destination already exists: {path}", KO: "설치 대상 경로가 이미 존재합니다: {path}"},
		"install.transaction.versionArtifactConflict":  {EN: "VERSION_ARTIFACT_CONFLICT: {artifact} is installed with SHA-256 {installed}; requested SHA-256 {requested}", KO: "VERSION_ARTIFACT_CONFLICT: {artifact} 설치 SHA-256은 {installed}이고 요청 SHA-256은 {requested}입니다"},
		"install.transaction.journalIdentity":          {EN: "installer commit journal identity mismatch", KO: "인스톨러 commit journal identity 가 일치하지 않습니다"},
		"install.transaction.journalGeneration":        {EN: "installer journal generation is not current", KO: "인스톨러 journal generation 이 현재 값이 아닙니다"},
		"install.fetch.noClient":                       {EN: "installer HTTP client is required", KO: "인스톨러 HTTP client 가 필요합니다"},
		"install.fetch.httpStatus":                     {EN: "artifact download returned HTTP {status}", KO: "아티팩트 다운로드가 HTTP {status} 을(를) 반환했습니다"},
		"install.fetch.sizeLimit":                      {EN: "artifact download exceeds size limit", KO: "아티팩트 다운로드가 크기 한도를 초과했습니다"},
		"install.fetch.localReferenceInvalid":          {EN: "local release asset reference is invalid", KO: "local release asset reference가 올바르지 않습니다"},
		"install.fetch.localReleaseMissing":            {EN: "local release is missing: {artifact}", KO: "local release가 없습니다: {artifact}"},
		"install.fetch.localReleaseInvalid":            {EN: "local release directory is invalid: {artifact}", KO: "local release directory가 올바르지 않습니다: {artifact}"},
		"install.fetch.localAssetInvalid":              {EN: "local release asset is invalid: {name}", KO: "local release asset이 올바르지 않습니다: {name}"},
		"install.progress.notFound":                    {EN: "artifact install progress not found for {id}", KO: "{id}의 아티팩트 설치 진행 상태가 없습니다"},
		"install.progress.timedOut":                    {EN: "artifact install {id} had no event after sequence {sequence} within {timeout}", KO: "아티팩트 설치 {id}에서 {timeout} 동안 sequence {sequence} 이후 이벤트가 없었습니다"},
		"install.progress.invalidTimeout":              {EN: "artifact progress timeout must be between 1 and 30000 ms, got {timeout}", KO: "아티팩트 진행 상태 제한 시간은 1~30000ms이어야 합니다: {timeout}"},
	})
}

// The refusals binary_integrity answers a caller with.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"install.binaryIntegrity.noBinPath": {
			EN: "binary_integrity needs binPath; an empty path would answer about the current directory",
			KO: "binary_integrity 에는 binPath 가 필요합니다 — 빈 경로는 현재 디렉터리에 대한 답이 됩니다",
		},
		"install.binaryIntegrity.noLibPath": {
			EN: "binary_integrity needs libPath; an empty path would answer about the current directory",
			KO: "binary_integrity 에는 libPath 가 필요합니다 — 빈 경로는 현재 디렉터리에 대한 답이 됩니다",
		},
	})
}

// The refusals theme_install answers a caller with.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"install.themeInstall.noHome": {
			EN: "theme_install needs the installation home and this process was not given one — set install.Deps.Home (identity.Resolved.Home, never the OS user home)",
			KO: "theme_install 에는 설치 home 이 필요하며 이 프로세스는 받지 못했습니다 — install.Deps.Home 을 넣으십시오(identity.Resolved.Home 이며, OS 사용자 home 이 아닙니다)",
		},
		"install.themeInstall.noPath": {
			EN: "theme_install needs path; an empty path names no file",
			KO: "theme_install 에는 path 가 필요합니다 — 빈 경로는 어떤 파일도 지정하지 않습니다",
		},
		"install.themeInstall.notJSONFile": {
			EN: "theme_install: {path} is not a .json theme file",
			KO: "theme_install: {path} 이(가) .json 테마 파일이 아닙니다",
		},
		"install.themeInstall.noFileName": {
			EN: "theme_install: {path} has no file name",
			KO: "theme_install: {path} 에 파일 이름이 없습니다",
		},
	})
}

// The refusals probe_binary and host_artifact_target answer a caller with.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"install.probeBinary.noBin": {
			EN: "probe_binary needs bin; an empty name has nothing to run",
			KO: "probe_binary 에는 bin 이 필요합니다 — 빈 이름은 실행할 대상이 없습니다",
		},
		"install.probeBinary.noRunner": {
			EN: "probe_binary cannot run anything in this build — set install.Deps.Run",
			KO: "이 빌드의 probe_binary 는 아무것도 실행할 수 없습니다 — install.Deps.Run 을 넣으십시오",
		},
		"install.hostArtifactTarget.noPlatform": {
			EN: "host_artifact_target needs the host platform and this process was not given one — set install.Deps.OS and install.Deps.Arch",
			KO: "host_artifact_target 에는 호스트 플랫폼이 필요하며 이 프로세스는 받지 못했습니다 — install.Deps.OS 와 install.Deps.Arch 를 넣으십시오",
		},
		"install.hostArtifactTarget.noTriple": {
			EN: "host_artifact_target has no artifact triple for {os}/{arch}",
			KO: "host_artifact_target 에는 {os}/{arch} 용 아티팩트 triple 이 없습니다",
		},
	})
}
