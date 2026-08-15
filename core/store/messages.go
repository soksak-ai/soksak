package store

import "github.com/soksak/soksak-core/core/i18n"

// The refusals this package answers a caller with. A caller reads these over
// the command registry, so they are declared here rather than formatted at the
// call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"store.backup.noDestination": {
			EN: "store: a backup needs a destination",
			KO: "store: 백업에는 대상 경로가 필요합니다",
		},
		"store.backup.destinationOccupied": {
			EN: "store: {path} already holds something, and a backup does not overwrite",
			KO: "store: {path} 에 이미 내용이 있습니다 — 백업은 덮어쓰지 않습니다",
		},
		"store.restore.storeClosed": {
			EN: "store: the store at {path} is closed",
			KO: "store: {path} 의 스토어가 닫혀 있습니다",
		},
		"store.restore.candidateIsDirectory": {
			EN: "store: {path} is a directory, not a backup",
			KO: "store: {path} 은(는) 디렉터리이며 백업이 아닙니다",
		},
		"store.restore.integrityFailed": {
			EN: "store: {path} fails its integrity check: {verdict}",
			KO: "store: {path} 의 무결성 검사가 실패했습니다: {verdict}",
		},
		"store.restore.shapeMismatch": {
			EN: "store: {path} is not this store's shape — {table} is missing",
			KO: "store: {path} 은(는) 이 스토어의 형태가 아닙니다 — {table} 테이블이 없습니다",
		},
		"store.entries.valueNotJSON": {
			EN: "store: the value at {ns}/{key} is not JSON",
			KO: "store: {ns}/{key} 의 값이 JSON 이 아닙니다",
		},
		"store.deleteMany.noKeys": {
			EN: "store: a delete batch for {ns} names no keys",
			KO: "store: {ns} 의 삭제 배치에 키가 하나도 없습니다",
		},
		"store.deleteMany.tooManyKeys": {
			EN: "store: a delete batch names {count} keys, and {max} is the most",
			KO: "store: 삭제 배치가 키 {count} 개를 지정했고 최대는 {max} 개입니다",
		},
		"store.deleteMany.emptyKey": {
			EN: "store: a delete batch for {ns} names an empty key",
			KO: "store: {ns} 의 삭제 배치에 빈 키가 있습니다",
		},
	})
}

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"store.define.missingAfterWrite": {
			EN: "store: {ns}/{coll} is not there after defining it",
			KO: "store: 정의한 뒤에도 {ns}/{coll} 이 없습니다",
		},
		"store.put.documentNotObject": {
			EN: "store: the document for {ns}/{coll} is not an object",
			KO: "store: {ns}/{coll} 의 문서가 객체가 아닙니다",
		},
		"store.put.reservedKey": {
			EN: "store: the document for {ns}/{coll} has the reserved key {key}, and this build has no vault to open it",
			KO: "store: {ns}/{coll} 의 문서에 예약 키 {key} 가 있습니다 — 이 빌드에는 열 볼트가 없습니다",
		},
		"store.put.recordNoID": {
			EN: "store: the record for {ns}/{coll} has no id",
			KO: "store: {ns}/{coll} 의 레코드에 id 가 없습니다",
		},
	})
}

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"store.import.noKey": {
			EN: `store: import line {line} names no key`,
			KO: `store: 가져오기 {line} 번째 줄에 키가 없습니다`,
		},
		"store.import.unknownKind": {
			EN: `store: import line {line} names an unknown kind "{kind}"`,
			KO: `store: 가져오기 {line} 번째 줄의 종류 "{kind}" 는 알 수 없습니다`,
		},
	})
}

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"store.deps.noDatabase": {
			EN: "store: this process holds no database handle",
			KO: "store: 이 프로세스에 데이터베이스 핸들이 없습니다",
		},
		"store.deps.noClock": {
			EN: "store: this process supplied no clock, and this command stamps what it writes",
			KO: "store: 이 프로세스에 시계가 없습니다 — 이 명령은 기록하는 내용에 시각을 찍습니다",
		},
		"store.deps.noHome": {
			EN: "store: this process supplied no home, and this command answers from one",
			KO: "store: 이 프로세스에 home 이 없습니다 — 이 명령은 home 을 근거로 답합니다",
		},
		"store.args.missing": {
			EN: `store: missing argument "{name}"`,
			KO: `store: 인자 "{name}" 이(가) 없습니다`,
		},
	})
}

// The name rules and the open handle. A caller reads these over the command
// registry, so they are declared here rather than formatted at the call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"store.name.collectionEmpty": {
			EN: "store: a collection name is empty",
			KO: "store: 컬렉션 이름이 비어 있습니다",
		},
		"store.name.collectionInvalid": {
			EN: "store: collection {name} is not lowercase alphanumeric with underscores",
			KO: "store: 컬렉션 {name} 은(는) 소문자·숫자·밑줄이 아닙니다",
		},
		"store.name.fieldEmpty": {
			EN: "store: a field name is empty",
			KO: "store: 필드 이름이 비어 있습니다",
		},
		"store.name.fieldInvalid": {
			EN: "store: field {name} is not an identifier",
			KO: "store: 필드 {name} 은(는) 식별자가 아닙니다",
		},
		"store.name.pluginIdEmpty": {
			EN: "store: a plugin id is empty",
			KO: "store: 플러그인 id 가 비어 있습니다",
		},
		"store.name.pluginIdInvalid": {
			EN: "store: plugin id {id} is not lowercase alphanumeric with hyphens",
			KO: "store: 플러그인 id {id} 은(는) 소문자·숫자·하이픈이 아닙니다",
		},
		"store.name.storageKeyInvalid": {
			EN: "store: storage key {key} is not a name",
			KO: "store: 저장 키 {key} 은(는) 이름이 아닙니다",
		},
		"store.name.storageKeyCharacter": {
			EN: "store: storage key {key} holds {char}",
			KO: "store: 저장 키 {key} 에 {char} 가 있습니다",
		},
		"store.open.noPath": {
			EN: "store: no database path was given",
			KO: "store: 데이터베이스 경로가 주어지지 않았습니다",
		},
		"store.open.closed": {
			EN: "store: the store at {path} is closed",
			KO: "store: {path} 의 스토어가 닫혀 있습니다",
		},
	})
}

// The refusal retention answers with. A negative keep count is named rather
// than read as a number, because reading it empties the scope.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"store.trim.negativeCap": {
			EN: "store: a trim of {ns}/{coll} names {cap} records to keep; the count must be zero or more",
			KO: "store: {ns}/{coll} 의 트림이 보관 개수 {cap} 을(를) 지정했습니다 — 0 이상이어야 합니다",
		},
	})
}

// The refusals the where-clause builder and the namespace rule answer a caller
// with. A caller reads these over the command registry, so they are declared
// here rather than formatted at the call site.

func init() {
	i18n.Declare(map[string]i18n.Sentence{
		"store.filter.fieldNotIndexed": {
			EN: `store: field "{field}" is not declared as an index`,
			KO: `store: 필드 "{field}" 이(가) 인덱스로 선언되어 있지 않습니다`,
		},
		"store.filter.unknownOperator": {
			EN: `store: operator "{operator}" on field "{field}" is unknown`,
			KO: `store: 필드 "{field}" 의 연산자 "{operator}" 는 알 수 없습니다`,
		},
		"store.filter.inValueNotArray": {
			EN: "store: the `in` value on field \"{field}\" is not an array",
			KO: "store: 필드 \"{field}\" 의 `in` 값이 배열이 아닙니다",
		},
		"store.order.fieldNotIndexed": {
			EN: `store: order field "{field}" is not declared as an index`,
			KO: `store: 정렬 필드 "{field}" 이(가) 인덱스로 선언되어 있지 않습니다`,
		},
		"store.name.namespaceInvalid": {
			EN: `store: namespace "{ns}" is not lowercase alphanumeric with hyphens`,
			KO: `store: 네임스페이스 "{ns}" 은(는) 소문자·숫자·하이픈이 아닙니다`,
		},
	})
}
