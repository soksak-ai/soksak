package main

import "github.com/soksak-ai/soksak-core/core/i18n"

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"release.sourceCommit": {EN: "source commit must be a full lowercase SHA-1", KO: "source commit은 전체 소문자 SHA-1이어야 합니다"},
		"release.systemRunID":  {EN: "system run id must contain decimal digits", KO: "system run id는 10진수 숫자로 구성되어야 합니다"},
		"release.identity":     {EN: "invalid application identity: {identity}", KO: "잘못된 애플리케이션 식별자입니다: {identity}"},
		"release.notPE":        {EN: "{path} is not a Windows PE executable: {reason}", KO: "{path}은(는) Windows PE 실행 파일이 아닙니다: {reason}"},
		"release.notAMD64":     {EN: "{path} is not an AMD64 Windows PE executable", KO: "{path}은(는) AMD64 Windows PE 실행 파일이 아닙니다"},
		"release.empty":        {EN: "{path} is empty", KO: "{path}이(가) 비었습니다"},
	})
}
