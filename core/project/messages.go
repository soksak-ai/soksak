package project

import "github.com/soksak/soksak-core/core/i18n"

// The refusals this package answers a caller with. A caller reads these over
// the command registry, so they are declared here rather than formatted at the
// call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"project.root.home": {
			EN: "the home directory cannot be a project root: {path}",
			KO: "홈 디렉터리는 프로젝트 루트가 될 수 없습니다: {path}",
		},
		"project.root.filesystemRoot": {
			EN: "the filesystem root cannot be a project root: {path}",
			KO: "파일시스템 루트는 프로젝트 루트가 될 수 없습니다: {path}",
		},
		"project.validateRoot.noUserHome": {
			EN: "validate_project_root needs the user home and this process was not given one",
			KO: "validate_project_root 에는 사용자 홈이 필요하며 이 프로세스는 받지 못했습니다",
		},
		"project.validateRoot.relativeUserHome": {
			EN: "validate_project_root needs an absolute user home and was given {home}",
			KO: "validate_project_root 에는 절대 경로인 사용자 홈이 필요하며 {home} 을(를) 받았습니다",
		},
		"project.validateRoot.relativePath": {
			EN: "a project root must be an absolute path: {path}",
			KO: "프로젝트 루트는 절대 경로여야 합니다: {path}",
		},
		"project.validateRoot.notDirectory": {
			EN: "not a directory: {path}",
			KO: "디렉터리가 아닙니다: {path}",
		},
	})
}

// The refusals the window manifest ledger answers with. A shape that cannot be
// merged is named, so a caller does not read a failed save as a completed one.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"project.manifest.notObject": {
			EN: "the window manifest is {type}, so its slots cannot be merged",
			KO: "창 매니페스트가 {type} 이므로 slots 를 병합할 수 없습니다",
		},
		"project.manifest.slotsNotList": {
			EN: "the window manifest has slots of type {type}, not a list, and is left untouched",
			KO: "창 매니페스트의 slots 가 목록이 아니라 {type} 이므로 그대로 둡니다",
		},
		"project.manifest.entryNoLabel": {
			EN: "a window manifest entry needs a label, and this one has {label}",
			KO: "창 매니페스트 항목에는 label 이 필요하며 이 항목의 값은 {label} 입니다",
		},
	})
}

// The refusals the claim ledger and the project folder answer a caller with. A
// caller reads these over the command registry, so they are declared here
// rather than formatted at the call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"project.claim.noRoot": {
			EN: "project_claim needs a root",
			KO: "project_claim 에는 루트가 필요합니다",
		},
		"project.claim.noWindowLabel": {
			EN: "project_claim needs the calling window label",
			KO: "project_claim 에는 호출한 창의 라벨이 필요합니다",
		},
		"project.release.noRoot": {
			EN: "project_release needs a root",
			KO: "project_release 에는 루트가 필요합니다",
		},
		"project.release.noWindowLabel": {
			EN: "project_release needs the calling window label",
			KO: "project_release 에는 호출한 창의 라벨이 필요합니다",
		},
		"project.ensureDir.noIdentityHome": {
			EN: "ensure_project_dir needs the identity home and this process was not given one",
			KO: "ensure_project_dir 에는 identity home 이 필요하며 이 프로세스는 받지 못했습니다",
		},
		"project.ensureDir.relativeIdentityHome": {
			EN: "ensure_project_dir needs an absolute identity home and was given {home}",
			KO: "ensure_project_dir 에는 절대 경로인 identity home 이 필요하며 {home} 을(를) 받았습니다",
		},
		"project.ensureDir.notASlug": {
			EN: `folder name "{folder}" is not a slug: ^[a-z0-9][a-z0-9-]*$`,
			KO: `폴더 이름 "{folder}" 은(는) 슬러그가 아닙니다: ^[a-z0-9][a-z0-9-]*$`,
		},
	})
}

// The refusal the typed argument decoder answers a caller with. A caller reads
// it over the command registry, so it is declared here rather than formatted at
// the call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"project.argument.missing": {
			EN: `missing argument "{name}"`,
			KO: `인자 "{name}" 이(가) 없습니다`,
		},
	})
}
