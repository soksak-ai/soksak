package files

import "github.com/soksak/soksak-core/core/i18n"

// The refusals this group answers a caller with. A caller reads these over the
// command registry, so they are declared here rather than formatted at the
// call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"files.readBase64.notAFile": {
			EN: "not a file: {path}",
			KO: "파일이 아닙니다: {path}",
		},
		"files.readBase64.sizeLimit": {
			EN: "read limit exceeded: {bytes} bytes",
			KO: "읽기 한도를 넘었습니다: {bytes} 바이트",
		},
	})
}

// The refusals shell_which answers a caller with. A caller reads these over the
// command registry, so they are declared here rather than formatted at the call
// site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"files.shellWhich.notABinaryName": {
			EN: `shell_which: "{bin}" is not a binary name — only letters, digits, '-', '_' and '.'`,
			KO: `shell_which: "{bin}" 은(는) 실행 파일 이름이 아닙니다 — 문자, 숫자, '-', '_', '.' 만 허용됩니다`,
		},
		"files.shellWhich.noLoginShell": {
			EN: "shell_which needs a login shell and this process was not given one — set files.Deps.LoginShell",
			KO: "shell_which 에는 로그인 셸이 필요하지만 이 프로세스에 지정되지 않았습니다 — files.Deps.LoginShell 을 설정하십시오",
		},
		"files.shellWhich.noRunner": {
			EN: "shell_which cannot run anything in this build — set files.Deps.Run",
			KO: "이 빌드의 shell_which 는 아무것도 실행할 수 없습니다 — files.Deps.Run 을 설정하십시오",
		},
	})
}

// The refusals the text read and the directory watch answer a caller with. A
// caller reads these over the command registry, so they are declared here
// rather than formatted at the call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"files.readText.notAFile": {
			EN: "not a file: {path}",
			KO: "파일이 아닙니다: {path}",
		},
		"files.readText.binaryFile": {
			EN: "binary file: {path}",
			KO: "바이너리 파일입니다: {path}",
		},
		"files.watch.noWatcher": {
			EN: "watch_dir has no filesystem watcher in this build — set files.Deps.Watch",
			KO: "이 빌드에는 파일 감시기가 없습니다 — files.Deps.Watch 를 넣으십시오",
		},
		"files.watch.noSink": {
			EN: "watch_dir has nowhere to deliver changes — set files.Deps.EmitChange",
			KO: "watch_dir 에 변경을 전달할 곳이 없습니다 — files.Deps.EmitChange 를 넣으십시오",
		},
		"files.watch.noPath": {
			EN: "watch_dir needs a path",
			KO: "watch_dir 에는 경로가 필요합니다",
		},
		"files.watch.relativePath": {
			EN: "watch_dir needs an absolute path, and {path} is relative — core reads no working directory to resolve it against",
			KO: "watch_dir 에는 절대 경로가 필요하며 {path} 은(는) 상대 경로입니다 — 코어는 이를 해석할 작업 디렉터리를 읽지 않습니다",
		},
	})
}

// The refusal a directory listing answers a caller with. A caller reads it over
// the command registry, so it is declared here rather than formatted at the
// call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"files.listChildren.notADirectory": {
			EN: "not a directory: {path}",
			KO: "디렉터리가 아닙니다: {path}",
		},
	})
}
