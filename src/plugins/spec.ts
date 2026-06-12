// 플러그인 스펙 — soksak-plugin-spec v1.
//
// ── §0 불변 원칙 ─────────────────────────────────────────────────────────────
// 1. 단일진실 = Command Registry. 플러그인 명령은 기존 registry 에 등록되고 그 즉시
//    sok CLI/MCP/문서에 자동 노출된다. 플러그인 전용 호출 경로를 만들지 않는다.
// 2. 전체신뢰 + 정직한 고지. main.js 는 메인 윈도우 컨텍스트에서 그대로 실행된다.
//    샌드박스는 없다. 권한은 API 표면 게이트(미선언 권한의 API 는 제공되지 않음)이지
//    격리가 아니다. 이 사실을 사용자 동의 화면에 그대로 알린다.
// 3. 검증은 all-or-nothing. 불량 매니페스트는 부분 수용 없이 사유와 함께 거부된다
//    (테마 모델과 동일). 침묵 실패 금지 — 거부는 rejected 목록으로 노출된다.
// 4. 플러그인 실패는 호스트를 죽이지 못한다. activate/mount/format/이벤트 콜백은
//    전부 try/catch 경계 안에서 실행되고, 실패는 status:"error" + 사유로 표시된다.
// 5. 활성화 동의는 사람만 한다. 원격(sok/MCP)의 plugin.enable 은 기록된 동의가
//    없으면 CONSENT_REQUIRED 로 거부된다. 플러그인 API 에서는 plugin.* 관리 명령
//    호출 자체가 차단된다(자기증식 금지).
// 6. 뷰 구현과 배치는 직교한다. 뷰 등록 API 는 registerView 하나이고, 우측/좌측
//    사이드바·콘텐츠 영역 배치는 동일한 provider 를 소비한다.
// 7. 에디터 확장은 호스트의 CodeMirror 모듈만 사용한다. @codemirror/* 를 플러그인이
//    자체 번들하면 인스턴스 이중화로 동작이 깨진다 — api.editor.modules 로 호스트
//    모듈을 제공받아 사용한다(번들 금지).
// 8. 기준 불변. 테스트/검증 기준 미달이면 코드를 고친다. 기준 자체가 잘못이면
//    기준을 낮추는 대신 열린 질문으로 기록해 정정한다.
//
// ── 배포 모델 ────────────────────────────────────────────────────────────────
// 플러그인 = git 레포(또는 디렉토리) 하나. 루트에 plugin.json + 단일 번들 entry
// (기본 main.js). 설치는 ~/.soksak/plugins/<id>/ 로 clone — 테마(~/.soksak/themes)와
// 동일한 외부 파일 모델이다. entry 는 ESM 단일 파일이어야 한다(Blob import 는 상대
// import 를 해석할 수 없다 — 외부 라이브러리는 저자가 번들에 포함).

// ── §1 권한 ──────────────────────────────────────────────────────────────────

export type PluginPermission =
  | "ui" // 뷰 등록(사이드바/콘텐츠)
  | "commands" // registry 명령 실행(danger 없는 것) + 자기 명령 등록
  | "commands:destructive" // danger:"destructive" 명령 실행(닫기·제거)
  | "commands:inject" // danger:"inject" 명령 실행(term.send/exec, browser.eval …)
  | "editor" // CM6 확장/언어 매핑/포매터 + 활성 버퍼 읽기/쓰기
  | "storage" // 전용 저장소(~/.soksak/plugins-data/<id>/)
  | "fs:read" // 임의 경로 파일 읽기
  | "fs:write" // 임의 경로 파일 쓰기
  | "git:read" // git log/show/diff/status (읽기 전용)
  | "network"; // fetch 사용 고지 — 기술적 강제 불가(§0-2 전체신뢰), 동의 화면 고지용

export const PERMISSIONS: readonly PluginPermission[] = [
  "ui",
  "commands",
  "commands:destructive",
  "commands:inject",
  "editor",
  "storage",
  "fs:read",
  "fs:write",
  "git:read",
  "network",
];

// 동의 화면용 권한 설명(§0-2 정직한 고지). caution = 강조 표시 대상.
export const PERMISSION_INFO: Record<
  PluginPermission,
  { label: string; detail: string; caution?: true }
> = {
  ui: {
    label: "뷰 표시",
    detail: "사이드바·콘텐츠 영역에 자체 화면을 띄웁니다.",
  },
  commands: {
    label: "명령 실행·등록",
    detail: "앱 명령을 실행하고 자기 명령을 등록합니다(위험 분류 명령 제외).",
  },
  "commands:destructive": {
    label: "파괴적 명령",
    detail: "탭·패널 닫기, 항목 제거 등 파괴적 명령을 실행할 수 있습니다.",
    caution: true,
  },
  "commands:inject": {
    label: "입력 주입",
    detail: "터미널 입력 전송·브라우저 스크립트 실행 등 주입 명령을 쓸 수 있습니다.",
    caution: true,
  },
  editor: {
    label: "에디터 확장",
    detail: "에디터 확장·문법 매핑·포매터를 등록하고 열린 파일 내용을 읽고 바꿉니다.",
  },
  storage: {
    label: "전용 저장소",
    detail: "이 플러그인 전용 폴더(~/.soksak/plugins-data)에 데이터를 저장합니다.",
  },
  "fs:read": {
    label: "파일 읽기",
    detail: "디스크의 임의 경로 파일을 읽을 수 있습니다.",
    caution: true,
  },
  "fs:write": {
    label: "파일 쓰기",
    detail: "디스크의 임의 경로 파일을 쓸 수 있습니다.",
    caution: true,
  },
  "git:read": {
    label: "git 읽기",
    detail: "저장소의 커밋 이력·변경 내용을 읽습니다(쓰기 없음).",
  },
  network: {
    label: "네트워크",
    detail:
      "외부 네트워크 요청을 사용한다고 밝힌 플러그인입니다. 전체신뢰 모델에서 기술적으로 막을 수는 없습니다.",
    caution: true,
  },
};

// ── §2 뷰 배치 ───────────────────────────────────────────────────────────────
// 뷰 구현(provider)과 배치는 직교(§0-6). placements = 지원 배치, 기본 우측 사이드바.

export type ViewPlacement = "sidebar-right" | "sidebar-left" | "content";

export const VIEW_PLACEMENTS: readonly ViewPlacement[] = [
  "sidebar-right",
  "sidebar-left",
  "content",
];

export interface ContributedView {
  id: string; // 플러그인 내 고유. 전역 키는 "<pluginId>.<id>"
  title: string;
  icon: string; // 아이콘 레일용 짧은 글리프(문자 1~2개/이모지). v1 은 SVG 미지원
  placements: ViewPlacement[]; // 파싱 시 기본 ["sidebar-right"] 로 채움
  defaultPlacement: ViewPlacement; // 파싱 시 placements[0] 으로 채움
}

export interface ContributedCommand {
  name: string; // 등록명은 plugin.<pluginId>.<name> — 선언 외 등록은 거부됨
  title: string;
}

export interface ContributedFormatter {
  id: string;
  title: string;
  languages: string[]; // 확장자 목록(점 없이): ["json","ts",…]
}

export interface ContributedLanguage {
  ext: string; // 확장자(점 없이)
  lang: string; // CM6 언어 키(@uiw/codemirror-extensions-langs)
}

export interface ContributedIconSet {
  id: string; // 플러그인 내 고유. 전역 키는 "<pluginId>.<id>"
  title: string; // 설정 드롭다운 표시 이름
}

// ── §3 매니페스트 ────────────────────────────────────────────────────────────

export const SPEC_VERSION = "soksak-plugin-spec@1";
export const DEFAULT_ENTRY = "main.js";

export interface PluginManifest {
  spec: typeof SPEC_VERSION; // 필수 — 불일치 시 거부
  id: string; // ^[a-z0-9][a-z0-9-]*$ + 설치 디렉토리명과 일치 강제
  name: string;
  version: string; // semver(major.minor.patch)
  description: string;
  author?: string;
  entry: string; // 파싱 시 기본 main.js 로 채움. 디렉토리 내부 상대경로만
  minAppVersion?: string;
  permissions: PluginPermission[];
  contributes: {
    views: ContributedView[]; // "ui" 권한 필수
    commands: ContributedCommand[]; // "commands" 권한 필수
    formatters: ContributedFormatter[]; // "editor" 권한 필수
    languages: ContributedLanguage[]; // "editor" 권한 필수
    iconSets: ContributedIconSet[]; // "ui" 권한 필수
  };
}

export interface ManifestValidation {
  ok: boolean;
  errors: string[]; // 거부 사유(§0-3: 부분 수용 금지)
  warnings: string[];
}

// 전역 키 규칙 — 산문이 아니라 함수가 단일진실.
export function qualifiedViewId(pluginId: string, viewId: string): string {
  return `${pluginId}.${viewId}`;
}
export function pluginCommandName(pluginId: string, name: string): string {
  return `plugin.${pluginId}.${name}`;
}

export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const VIEW_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const COMMAND_NAME_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;
const EXT_RE = /^[a-z0-9]+$/;
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

// a ≥ b (major.minor.patch 비교, pre-release 무시). 형식 불량이면 null.
export function semverGte(a: string, b: string): boolean | null {
  const ma = SEMVER_RE.exec(a);
  const mb = SEMVER_RE.exec(b);
  if (!ma || !mb) return null;
  for (let i = 1; i <= 3; i++) {
    const da = Number(ma[i]);
    const db = Number(mb[i]);
    if (da !== db) return da > db;
  }
  return true;
}

// ── §4 검증 ──────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

// 선언 안 된 키는 거부(registry.validate 와 동일 철학 — 오타 조기 발견).
function checkKnownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  errors: string[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${label}: 알 수 없는 키 "${key}"`);
  }
}

interface EntryRule<T> {
  label: string;
  required: readonly string[];
  optional?: readonly string[];
  parse: (v: Record<string, unknown>, errors: string[]) => T | null;
}

// 배열 항목 공통 검증: 객체 + 키 화이트리스트 + 항목 파서.
function parseEntries<T>(
  raw: unknown,
  rule: EntryRule<T>,
  errors: string[],
): T[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${rule.label}: 배열이어야 함`);
    return [];
  }
  const out: T[] = [];
  raw.forEach((item, i) => {
    const label = `${rule.label}[${i}]`;
    if (!isRecord(item)) {
      errors.push(`${label}: 객체가 아님`);
      return;
    }
    checkKnownKeys(item, [...rule.required, ...(rule.optional ?? [])], label, errors);
    for (const key of rule.required) {
      if (item[key] === undefined) errors.push(`${label}.${key}: 필수`);
    }
    const parsed = rule.parse(item, errors);
    if (parsed !== null) out.push(parsed);
  });
  return out;
}

function checkDuplicates(
  values: string[],
  label: string,
  errors: string[],
): void {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) errors.push(`${label}: 중복 "${v}"`);
    seen.add(v);
  }
}

// 외부 JSON(unknown) → 검증된 PluginManifest. 실패 시 errors 에 전체 사유(§0-3).
// dirName = 설치 디렉토리명 — id 와 불일치하면 거부(스캔/설치 경로의 단일진실).
export function parseManifest(
  raw: unknown,
  dirName: string,
): { manifest: PluginManifest | null; validation: ManifestValidation } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const reject = () => ({
    manifest: null,
    validation: { ok: false, errors, warnings },
  });

  if (!isRecord(raw)) {
    errors.push("매니페스트가 JSON 객체가 아님");
    return reject();
  }

  checkKnownKeys(
    raw,
    [
      "spec",
      "id",
      "name",
      "version",
      "description",
      "author",
      "entry",
      "minAppVersion",
      "permissions",
      "contributes",
    ],
    "manifest",
    errors,
  );

  if (raw.spec !== SPEC_VERSION) {
    errors.push(`spec: "${SPEC_VERSION}" 필수(현재 앱이 아는 유일한 스펙)`);
  }
  if (!isNonEmptyString(raw.id) || !PLUGIN_ID_RE.test(raw.id)) {
    errors.push("id: ^[a-z0-9][a-z0-9-]*$ 필수");
  } else if (raw.id !== dirName) {
    errors.push(`id: 설치 디렉토리명("${dirName}")과 일치해야 함`);
  }
  if (!isNonEmptyString(raw.name)) errors.push("name: 필수");
  if (!isNonEmptyString(raw.version) || !SEMVER_RE.test(raw.version)) {
    errors.push("version: semver(major.minor.patch) 필수");
  }
  if (!isNonEmptyString(raw.description)) errors.push("description: 필수");
  if (raw.author !== undefined && !isNonEmptyString(raw.author)) {
    errors.push("author: 문자열이어야 함");
  }
  if (
    raw.minAppVersion !== undefined &&
    (!isNonEmptyString(raw.minAppVersion) || !SEMVER_RE.test(raw.minAppVersion))
  ) {
    errors.push("minAppVersion: semver 형식이어야 함");
  }

  // entry: 디렉토리 내부 상대경로만(탈출 금지), ESM 단일 번들.
  let entry = DEFAULT_ENTRY;
  if (raw.entry !== undefined) {
    if (!isNonEmptyString(raw.entry)) {
      errors.push("entry: 문자열이어야 함");
    } else {
      const e = raw.entry.trim();
      if (e.startsWith("/") || e.startsWith("\\") || /^[a-zA-Z]:/.test(e)) {
        errors.push("entry: 절대경로 금지(디렉토리 내부 상대경로만)");
      } else if (e.split(/[\\/]/).includes("..")) {
        errors.push('entry: ".." 금지(디렉토리 탈출)');
      } else if (!e.endsWith(".js") && !e.endsWith(".mjs")) {
        errors.push("entry: .js/.mjs ESM 단일 번들이어야 함");
      } else {
        entry = e;
      }
    }
  }

  // permissions: 필수 배열(빈 배열 허용 — 아무 API 도 안 쓰는 플러그인).
  const permissions: PluginPermission[] = [];
  if (!Array.isArray(raw.permissions)) {
    errors.push("permissions: 배열 필수(없으면 [])");
  } else {
    for (const p of raw.permissions) {
      if (typeof p !== "string" || !PERMISSIONS.includes(p as PluginPermission)) {
        errors.push(`permissions: 알 수 없는 권한 "${String(p)}"`);
      } else {
        permissions.push(p as PluginPermission);
      }
    }
    checkDuplicates(permissions, "permissions", errors);
  }
  const has = (p: PluginPermission) => permissions.includes(p);

  // contributes — 권한-기여 정합성: 기여가 요구하는 권한이 선언되어야 한다.
  let views: ContributedView[] = [];
  let commands: ContributedCommand[] = [];
  let formatters: ContributedFormatter[] = [];
  let languages: ContributedLanguage[] = [];
  let iconSets: ContributedIconSet[] = [];
  if (raw.contributes !== undefined) {
    if (!isRecord(raw.contributes)) {
      errors.push("contributes: 객체여야 함");
    } else {
      const c = raw.contributes;
      checkKnownKeys(
        c,
        ["views", "commands", "formatters", "languages", "iconSets"],
        "contributes",
        errors,
      );

      views = parseEntries(c.views, {
        label: "contributes.views",
        required: ["id", "title", "icon"],
        optional: ["placements", "defaultPlacement"],
        parse: (v, errs) => {
          if (!isNonEmptyString(v.id) || !VIEW_ID_RE.test(v.id)) {
            errs.push("contributes.views: id 는 ^[a-z0-9][a-z0-9-]*$");
            return null;
          }
          if (!isNonEmptyString(v.title) || !isNonEmptyString(v.icon)) return null;
          let placements: ViewPlacement[] = ["sidebar-right"];
          if (v.placements !== undefined) {
            if (
              !Array.isArray(v.placements) ||
              v.placements.length === 0 ||
              v.placements.some(
                (p) => !VIEW_PLACEMENTS.includes(p as ViewPlacement),
              )
            ) {
              errs.push(
                `contributes.views["${v.id}"].placements: ${VIEW_PLACEMENTS.join("|")} 의 비어있지 않은 배열`,
              );
              return null;
            }
            placements = v.placements as ViewPlacement[];
          }
          let defaultPlacement = placements[0];
          if (v.defaultPlacement !== undefined) {
            if (!placements.includes(v.defaultPlacement as ViewPlacement)) {
              errs.push(
                `contributes.views["${v.id}"].defaultPlacement: placements 에 포함되어야 함`,
              );
              return null;
            }
            defaultPlacement = v.defaultPlacement as ViewPlacement;
          }
          return {
            id: v.id.trim(),
            title: (v.title as string).trim(),
            icon: (v.icon as string).trim(),
            placements,
            defaultPlacement,
          };
        },
      }, errors);
      checkDuplicates(views.map((v) => v.id), "contributes.views.id", errors);
      if (views.length > 0 && !has("ui")) {
        errors.push('contributes.views: "ui" 권한 선언 필요');
      }

      commands = parseEntries(c.commands, {
        label: "contributes.commands",
        required: ["name", "title"],
        parse: (v, errs) => {
          if (!isNonEmptyString(v.name) || !COMMAND_NAME_RE.test(v.name)) {
            errs.push(
              "contributes.commands: name 은 ^[a-z0-9][a-z0-9-]*(.[a-z0-9][a-z0-9-]*)*$",
            );
            return null;
          }
          if (!isNonEmptyString(v.title)) return null;
          return { name: v.name.trim(), title: (v.title as string).trim() };
        },
      }, errors);
      checkDuplicates(commands.map((v) => v.name), "contributes.commands.name", errors);
      if (commands.length > 0 && !has("commands")) {
        errors.push('contributes.commands: "commands" 권한 선언 필요');
      }

      formatters = parseEntries(c.formatters, {
        label: "contributes.formatters",
        required: ["id", "title", "languages"],
        parse: (v, errs) => {
          if (!isNonEmptyString(v.id) || !VIEW_ID_RE.test(v.id)) {
            errs.push("contributes.formatters: id 는 ^[a-z0-9][a-z0-9-]*$");
            return null;
          }
          if (!isNonEmptyString(v.title)) return null;
          if (
            !Array.isArray(v.languages) ||
            v.languages.length === 0 ||
            v.languages.some((l) => typeof l !== "string" || !EXT_RE.test(l))
          ) {
            errs.push(
              `contributes.formatters["${v.id}"].languages: 확장자(점 없이) 비어있지 않은 배열`,
            );
            return null;
          }
          return {
            id: v.id.trim(),
            title: (v.title as string).trim(),
            languages: v.languages as string[],
          };
        },
      }, errors);
      checkDuplicates(formatters.map((v) => v.id), "contributes.formatters.id", errors);
      if (formatters.length > 0 && !has("editor")) {
        errors.push('contributes.formatters: "editor" 권한 선언 필요');
      }

      languages = parseEntries(c.languages, {
        label: "contributes.languages",
        required: ["ext", "lang"],
        parse: (v, errs) => {
          if (!isNonEmptyString(v.ext) || !EXT_RE.test(v.ext)) {
            errs.push("contributes.languages: ext 는 확장자(점 없이, 소문자/숫자)");
            return null;
          }
          if (!isNonEmptyString(v.lang)) return null;
          return { ext: v.ext.trim(), lang: (v.lang as string).trim() };
        },
      }, errors);
      checkDuplicates(languages.map((v) => v.ext), "contributes.languages.ext", errors);
      if (languages.length > 0 && !has("editor")) {
        errors.push('contributes.languages: "editor" 권한 선언 필요');
      }

      iconSets = parseEntries(c.iconSets, {
        label: "contributes.iconSets",
        required: ["id", "title"],
        parse: (v, errs) => {
          if (!isNonEmptyString(v.id) || !VIEW_ID_RE.test(v.id)) {
            errs.push("contributes.iconSets: id 는 ^[a-z0-9][a-z0-9-]*$");
            return null;
          }
          if (!isNonEmptyString(v.title)) return null;
          return { id: v.id.trim(), title: (v.title as string).trim() };
        },
      }, errors);
      checkDuplicates(iconSets.map((v) => v.id), "contributes.iconSets.id", errors);
      if (iconSets.length > 0 && !has("ui")) {
        errors.push('contributes.iconSets: "ui" 권한 선언 필요');
      }
    }
  }

  if (errors.length > 0) return reject();
  return {
    manifest: {
      spec: SPEC_VERSION,
      id: (raw.id as string).trim(),
      name: (raw.name as string).trim(),
      version: (raw.version as string).trim(),
      description: (raw.description as string).trim(),
      author: raw.author !== undefined ? (raw.author as string).trim() : undefined,
      entry,
      minAppVersion:
        raw.minAppVersion !== undefined
          ? (raw.minAppVersion as string).trim()
          : undefined,
      permissions,
      contributes: { views, commands, formatters, languages, iconSets },
    },
    validation: { ok: true, errors, warnings },
  };
}
