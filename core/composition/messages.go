package composition

import "github.com/soksak-ai/soksak-core/core/i18n"

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"composition.home.absolute":            {EN: "installation settings home must be absolute: {path}", KO: "설치 설정 홈 경로는 절대 경로여야 합니다: {path}"},
		"composition.home.required":            {EN: "installation settings home is required", KO: "설치 설정 홈 경로가 필요합니다"},
		"composition.installPath.symlink":      {EN: "install path is a symbolic link: {path}", KO: "설치 경로가 심볼릭 링크입니다: {path}"},
		"composition.installPath.notDirectory": {EN: "install path is not a directory: {path}", KO: "설치 경로가 디렉터리가 아닙니다: {path}"},
		"composition.manifest.notRegular":      {EN: "manifest is not a regular file: {path}", KO: "매니페스트가 일반 파일이 아닙니다: {path}"},
		"composition.development.absolute":     {EN: "development source path must be absolute", KO: "개발 소스 경로는 절대 경로여야 합니다"},
		"composition.development.notDirectory": {EN: "development source must be a regular directory", KO: "개발 소스는 일반 디렉터리여야 합니다"},
		"composition.development.identity":     {EN: "development manifest id or version does not match settings", KO: "개발 매니페스트의 id 또는 version이 설정과 일치하지 않습니다"},
		"composition.development.entrypoint":   {EN: "development manifest is not a regular file", KO: "개발 매니페스트가 일반 파일이 아닙니다"},
		"composition.enabled.pluginsRequired":  {EN: "at least one plugin is required", KO: "플러그인을 하나 이상 지정해야 합니다"},
		"composition.enabled.duplicatePlugin":  {EN: "the same plugin was specified more than once: {plugin}", KO: "같은 플러그인이 두 번 지정되었습니다: {plugin}"},
		"composition.enabled.pluginNotFound":   {EN: "plugin is not in installation settings: {plugin}", KO: "설치 설정에 플러그인이 없습니다: {plugin}"},
	})
}
