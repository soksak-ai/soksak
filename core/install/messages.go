package install

import "github.com/soksak-ai/soksak-core/core/i18n"

// The refusals this package answers a caller with. A caller reads these over
// the command registry, so they are declared here rather than formatted at the
// call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
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
		"install.transaction.noFetcher":            {EN: "installer requires a fetcher", KO: "인스톨러에 fetcher 가 필요합니다"},
		"install.transaction.identityRequired":     {EN: "installer requires registry and root identity", KO: "인스톨러에 registry 와 root identity 가 필요합니다"},
		"install.transaction.notFound":             {EN: "install transaction not found: {id}", KO: "설치 트랜잭션이 없습니다: {id}"},
		"install.transaction.registryMismatch":     {EN: "registry does not match the install transaction", KO: "registry 가 설치 트랜잭션과 일치하지 않습니다"},
		"install.transaction.unsupportedFormat":    {EN: "unsupported artifact format: {format}", KO: "지원하지 않는 아티팩트 형식입니다: {format}"},
		"install.transaction.digestMismatch":       {EN: "artifact SHA-256 mismatch: {digest}", KO: "아티팩트 SHA-256 이 일치하지 않습니다: {digest}"},
		"install.transaction.entrypointUnsafe":     {EN: "unsafe entrypoint path: {path}", KO: "안전하지 않은 entrypoint 경로입니다: {path}"},
		"install.transaction.entrypointNotRegular": {EN: "entrypoint is not a regular file: {path}", KO: "entrypoint 가 일반 파일이 아닙니다: {path}"},
		"install.transaction.ended":                {EN: "install transaction ended during artifact staging", KO: "아티팩트 스테이징 중 설치 트랜잭션이 종료되었습니다"},
		"install.transaction.stagedPathUnsafe":     {EN: "unsafe staged path: {path}", KO: "안전하지 않은 스테이징 경로입니다: {path}"},
		"install.transaction.stagedNotFound":       {EN: "staged artifact not found", KO: "스테이징된 아티팩트가 없습니다"},
		"install.transaction.stagedNotRegular":     {EN: "staged path is not a regular file: {path}", KO: "스테이징 경로가 일반 파일이 아닙니다: {path}"},
		"install.transaction.stagedNotUTF8":        {EN: "staged path is not UTF-8: {path}", KO: "스테이징 경로가 UTF-8 이 아닙니다: {path}"},
		"install.transaction.archivePathUnsafe":    {EN: "unsafe archive path: {path}", KO: "안전하지 않은 아카이브 경로입니다: {path}"},
		"install.transaction.archiveEntryType":     {EN: "archive entry is not a regular file or directory: {path}", KO: "아카이브 항목이 일반 파일 또는 디렉터리가 아닙니다: {path}"},
		"install.transaction.archiveLimit":         {EN: "archive extraction limit exceeded", KO: "아카이브 추출 한도를 초과했습니다"},
		"install.transaction.homeAbsolute":         {EN: "installer home must be absolute", KO: "인스톨러 home 은 절대 경로여야 합니다"},
		"install.transaction.commitUnitsRequired":  {EN: "installer commit requires units", KO: "인스톨러 commit 에 units 가 필요합니다"},
		"install.transaction.duplicateUnit":        {EN: "duplicate verified unit: {unit}", KO: "검증된 유닛이 중복되었습니다: {unit}"},
		"install.transaction.stagedUnitMismatch":   {EN: "staged artifact does not match verified unit: {unit}", KO: "스테이징된 아티팩트가 검증된 유닛과 일치하지 않습니다: {unit}"},
		"install.transaction.manifestUnitMismatch": {EN: "staged manifest identity does not match verified unit: {unit}", KO: "스테이징된 매니페스트 identity 가 검증된 유닛과 일치하지 않습니다: {unit}"},
		"install.transaction.destinationExists":    {EN: "install destination already exists: {path}", KO: "설치 대상 경로가 이미 존재합니다: {path}"},
		"install.transaction.closureUnresolved":    {EN: "installed closure unit is not resolved: {unit}", KO: "설치 closure 유닛이 resolved 상태가 아닙니다: {unit}"},
		"install.transaction.journalIdentity":      {EN: "installer commit journal identity mismatch", KO: "인스톨러 commit journal identity 가 일치하지 않습니다"},
		"install.transaction.journalGeneration":    {EN: "installer journal generation is not current", KO: "인스톨러 journal generation 이 현재 값이 아닙니다"},
		"install.fetch.noClient":                   {EN: "installer HTTP client is required", KO: "인스톨러 HTTP client 가 필요합니다"},
		"install.fetch.httpStatus":                 {EN: "artifact download returned HTTP {status}", KO: "아티팩트 다운로드가 HTTP {status} 을(를) 반환했습니다"},
		"install.fetch.sizeLimit":                  {EN: "artifact download exceeds size limit", KO: "아티팩트 다운로드가 크기 한도를 초과했습니다"},
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

// The refusals unit_source_validate answers a caller with.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"install.unitSourceValidate.noSource": {
			EN: "unit_source_validate needs source; an empty path names no directory",
			KO: "unit_source_validate 에는 source 가 필요합니다 — 빈 경로는 어떤 디렉터리도 지정하지 않습니다",
		},
		"install.unitSourceValidate.relative": {
			EN: "unit_source_validate: {path} is relative — a development source is an absolute path, because a relative one is resolved against a working directory this process does not have",
			KO: "unit_source_validate: {path} 이(가) 상대 경로입니다 — 개발 소스는 절대 경로여야 합니다. 상대 경로는 이 프로세스에 없는 작업 디렉터리를 기준으로 해석됩니다",
		},
		"install.unitSourceValidate.missing": {
			EN: "unit_source_validate: {path} does not exist",
			KO: "unit_source_validate: {path} 이(가) 없습니다",
		},
		"install.unitSourceValidate.notDirectory": {
			EN: "unit_source_validate: {path} is not a directory",
			KO: "unit_source_validate: {path} 이(가) 디렉터리가 아닙니다",
		},
		"install.unitSourceValidate.parentComponent": {
			EN: "unit_source_validate: {path} walks through '..' — a development source names where it is, so the path that is judged is the path that is stored",
			KO: "unit_source_validate: {path} 이(가) '..' 를 지납니다 — 개발 소스는 자기 위치를 그대로 지정해야 하며, 검사한 경로와 저장하는 경로가 같아야 합니다",
		},
		"install.unitSourceValidate.symlink": {
			EN: "unit_source_validate: {path} is a symlink — a named path answers for itself or not at all",
			KO: "unit_source_validate: {path} 이(가) 심볼릭 링크입니다 — 지정된 경로는 그 자신으로만 응답합니다",
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

// The refusals probe_binary and host_unit_target answer a caller with.

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
		"install.hostUnitTarget.noPlatform": {
			EN: "host_unit_target needs the host platform and this process was not given one — set install.Deps.OS and install.Deps.Arch",
			KO: "host_unit_target 에는 호스트 플랫폼이 필요하며 이 프로세스는 받지 못했습니다 — install.Deps.OS 와 install.Deps.Arch 를 넣으십시오",
		},
		"install.hostUnitTarget.noTriple": {
			EN: "host_unit_target has no artifact triple for {os}/{arch}",
			KO: "host_unit_target 에는 {os}/{arch} 용 아티팩트 triple 이 없습니다",
		},
	})
	i18n.Declare(map[string]i18n.Sentence{
		// The refusals unit_source_set and unit_source_list answer a caller with.
		"install.devSource.noHome": {
			EN: "unit_source_set needs the installation home and this process was not given one — set install.Deps.Home",
			KO: "unit_source_set 에는 설치 홈이 필요한데 이 프로세스는 받지 못했습니다 — install.Deps.Home 을 넣으십시오",
		},
		"install.devSource.kind": {
			EN: `unit_source_set: {kind} is not a unit kind — it is "plugin", "sidecar" or "kit", and the loader reads a different manifest for each`,
			KO: `unit_source_set: {kind} 은(는) 유닛 종류가 아닙니다 — "plugin"·"sidecar"·"kit" 중 하나여야 하며, 종류마다 로더가 읽는 매니페스트가 다릅니다`,
		},
		"install.devSource.unreadable": {
			EN: "unit_source_list could not read {path} as a declaration — it exists, so it is not treated as an empty one",
			KO: "unit_source_list 가 {path} 을(를) 선언으로 읽지 못했습니다 — 파일이 있으므로 빈 선언으로 취급하지 않습니다",
		},
		"install.devSource.version": {
			EN: "unit_source_list: {path} declares version {found} and this build reads {want} — a file from another version is not migrated, because reading it as this shape answers with a source nobody declared",
			KO: "unit_source_list: {path} 은(는) 버전 {found} 을(를) 선언하고 이 빌드는 {want} 을(를) 읽습니다 — 다른 버전의 파일은 마이그레이션하지 않습니다. 이 모양으로 읽으면 아무도 선언하지 않은 소스를 답하게 됩니다",
		},
	})

}
