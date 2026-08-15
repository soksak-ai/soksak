package install

import "github.com/soksak/soksak-core/core/i18n"

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
