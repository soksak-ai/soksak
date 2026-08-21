package composition

import "github.com/soksak-ai/soksak-core/core/i18n"

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"composition.home.absolute":            {EN: "composition home must be absolute: {path}", KO: "composition home 은 절대 경로여야 합니다: {path}"},
		"composition.home.required":            {EN: "composition home is required", KO: "composition home 이 필요합니다"},
		"composition.installPath.symlink":      {EN: "install path is a symbolic link: {path}", KO: "설치 경로가 심볼릭 링크입니다: {path}"},
		"composition.installPath.notDirectory": {EN: "install path is not a directory: {path}", KO: "설치 경로가 디렉터리가 아닙니다: {path}"},
		"composition.manifest.notRegular":      {EN: "manifest is not a regular file: {path}", KO: "매니페스트가 일반 파일이 아닙니다: {path}"},
		"composition.development.absolute":     {EN: "development composition paths must be absolute", KO: "개발 composition 경로는 절대 경로여야 합니다"},
		"composition.development.notDirectory": {EN: "development source must be a regular directory", KO: "개발 소스는 일반 디렉터리여야 합니다"},
		"composition.development.identity":     {EN: "development manifest identity mismatch", KO: "개발 매니페스트 identity 가 일치하지 않습니다"},
		"composition.development.entrypoint":   {EN: "development entrypoint is not a regular file", KO: "개발 entrypoint 가 일반 파일이 아닙니다"},
	})
}
