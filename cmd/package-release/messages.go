package main

import "github.com/soksak-ai/soksak-core/core/i18n"

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"release.sourceCommit": {EN: "source commit must be a full lowercase SHA-1", KO: "source commit은 전체 소문자 SHA-1이어야 합니다"},
		"release.version":      {EN: "VERSION must contain one semantic version and a trailing newline", KO: "VERSION에는 semantic version 하나와 마지막 줄바꿈만 있어야 합니다"},
		"release.matrix":       {EN: "release inputs must match every declared target exactly once", KO: "릴리스 입력은 선언된 모든 target과 정확히 한 번씩 일치해야 합니다"},
		"release.input":        {EN: "invalid release input for {target}", KO: "{target} 릴리스 입력이 잘못되었습니다"},
		"release.executable":   {EN: "{path} is not a {target} executable: {reason}", KO: "{path}은(는) {target} 실행 파일이 아닙니다: {reason}"},
		"release.architecture": {EN: "{path} does not contain exactly the {target} architecture", KO: "{path}에 정확한 {target} architecture가 없습니다"},
		"release.trailingJSON": {EN: "release JSON contains trailing data", KO: "릴리스 JSON 뒤에 추가 데이터가 있습니다"},
		"release.symlink":      {EN: "release input contains a symbolic link: {path}", KO: "릴리스 입력에 symbolic link가 있습니다: {path}"},
		"release.empty":        {EN: "{path} is empty", KO: "{path}이(가) 비었습니다"},
	})
}
