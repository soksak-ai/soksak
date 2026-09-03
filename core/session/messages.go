package session

import "github.com/soksak-ai/soksak-core/core/i18n"

// The refusals this package answers a caller with. A caller reads these over the command registry,
// so they are declared here rather than formatted at the call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"session.attach.noSession": {
			EN: "an attachment names no session, so nothing states which session a view holds",
			KO: "attachment 이 session 을 명시하지 않아, view 가 어느 session 을 드는지 아무것도 말하지 않습니다",
		},
		"session.close.notInIndex": {
			EN: "no session {session} in this index, so nothing names the component that would end it",
			KO: "이 index 에 session {session} 이 없어, 그것을 끝낼 컴포넌트를 아무것도 명시하지 않습니다",
		},
		"session.close.ownerDown": {
			EN: "the component {owner} that owns session {session} is not running, so the close was not performed",
			KO: "session {session} 을 소유하는 컴포넌트 {owner} 가 실행 중이 아니어서 종료가 수행되지 않았습니다",
		},
		"session.close.refused": {
			EN: "the component {owner} did not end session {session}",
			KO: "컴포넌트 {owner} 가 session {session} 을 끝내지 않았습니다",
		},
		"session.owner.refused": {
			EN: "the component {owner} refused the session question: {reason}",
			KO: "컴포넌트 {owner} 가 session 질문을 거부했습니다: {reason}",
		},
	})
}
