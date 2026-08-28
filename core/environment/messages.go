package environment

import "github.com/soksak-ai/soksak-core/core/i18n"

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"environment.home.absolute":                {EN: "environment home must be absolute", KO: "환경 홈 경로는 절대 경로여야 합니다"},
		"environment.develop.pathAbsolute":         {EN: "development path must be absolute and clean: {path}", KO: "개발 경로는 절대 경로이며 정규화된 경로여야 합니다: {path}"},
		"environment.develop.entryInvalid":         {EN: "plugin {id}: entry {entry} is not a relative .js/.mjs path inside the plugin directory", KO: "플러그인 {id}: entry {entry}은(는) 플러그인 디렉터리 내부의 상대 .js/.mjs 경로가 아닙니다"},
		"environment.develop.directoryUnavailable": {EN: "development {kind} {id}: directory {path} is unavailable: {error}", KO: "개발 {kind} {id}: 디렉터리 {path}을(를) 사용할 수 없습니다: {error}"},
		"environment.develop.sidecarArtifactStale": {EN: "ARTIFACT_STALE: development sidecar {id} at {path}: {error}", KO: "ARTIFACT_STALE: 개발 사이드카 {id} ({path}): {error}"},
		"environment.sidecar.noInstallationRecord": {EN: "sidecar {id} has no installation record", KO: "사이드카 {id}의 설치 레코드가 없습니다"},
		"environment.remove.pathOutsideHome":       {EN: "artifact path {path} is not under {home}/components; the record is kept", KO: "아티팩트 경로 {path}이(가) {home}/components 아래에 있지 않습니다; 레코드는 유지됩니다"},
		"environment.remove.pathSymlink":           {EN: "artifact path {path}: {link} is a symlink; the record is kept", KO: "아티팩트 경로 {path}: {link}이(가) 심볼릭 링크입니다; 레코드는 유지됩니다"},
		"environment.remove.notFound":              {EN: "no {kind} record for id {id}", KO: "id {id}의 {kind} 레코드가 없습니다"},
		"environment.remove.artifactDeleteFailed":  {EN: "artifact directory {path} was not deleted: {error}; the record is kept", KO: "아티팩트 디렉터리 {path}을(를) 삭제하지 못했습니다: {error}; 레코드는 유지됩니다"},
		// Keys below keep the install.* prefix: callers match on them and the check moved here from install on 2026-08-25.
		"install.transaction.dependencyVersionConflict": {EN: "DEPENDENCY_VERSION_CONFLICT: {plugin} requires {kind} {dependency} {required}; selected version is {requested}", KO: "DEPENDENCY_VERSION_CONFLICT: {plugin}은(는) {kind} {dependency} {required}을(를) 요구하지만 선택된 version은 {requested}입니다"},
		"install.transaction.pluginManifestInvalid":     {EN: "installed Plugin manifest identity is invalid: {plugin}", KO: "설치된 Plugin manifest identity가 올바르지 않습니다: {plugin}"},
		"install.hostArtifactTarget.noPlatform":         {EN: "host artifact target needs the host platform and this process was not given one — set install.Deps.OS and install.Deps.Arch for host_artifact_target, environment.Deps.OS and environment.Deps.Arch for sidecar_develop", KO: "host artifact target 에는 호스트 플랫폼이 필요하며 이 프로세스는 받지 못했습니다 — host_artifact_target 은 install.Deps.OS 와 install.Deps.Arch 를, sidecar_develop 은 environment.Deps.OS 와 environment.Deps.Arch 를 넣으십시오"},
		"install.hostArtifactTarget.noTriple":           {EN: "host artifact target has no artifact triple for {os}/{arch}", KO: "host artifact target 에는 {os}/{arch} 용 아티팩트 triple 이 없습니다"},
	})
}
