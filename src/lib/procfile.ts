// Procfile 파서·직렬화(순수) — 프로젝트 데몬 선언의 단일 진실. 표준 규약(foreman 계열,
// `name: command` 라인)을 그대로 따르고 비표준 확장을 만들지 않는다. daemon.add/remove 가
// 이 모듈로 파일을 편집하므로, 사람이 쓴 주석·빈 줄·순서를 보존하는 라운드트립이 계약이다.

export interface ProcfileEntry {
  name: string;
  cmd: string;
}

/** 라인 하나의 해석 결과 — 엔트리이거나, 보존만 하는 원문(주석·빈 줄·비형식 라인). */
type Line = { kind: "entry"; name: string; cmd: string } | { kind: "raw"; text: string };

const ENTRY = /^([A-Za-z0-9_-]+):\s*(.+?)\s*$/;

function parseLines(text: string): Line[] {
  return text.split("\n").map((raw): Line => {
    const m = ENTRY.exec(raw);
    if (m && !raw.trimStart().startsWith("#")) return { kind: "entry", name: m[1], cmd: m[2] };
    return { kind: "raw", text: raw };
  });
}

/** Procfile 본문 → 데몬 선언 목록. 같은 이름이 여러 번이면 마지막 선언이 이긴다(표준 관행). */
export function parseProcfile(text: string): ProcfileEntry[] {
  const out = new Map<string, string>();
  for (const l of parseLines(text)) {
    if (l.kind === "entry") out.set(l.name, l.cmd);
  }
  return [...out.entries()].map(([name, cmd]) => ({ name, cmd }));
}

/** 엔트리 추가·교체 — 같은 이름이 있으면 그 자리에서 cmd 만 바꾸고, 없으면 끝에 붙인다.
 *  주석·빈 줄·순서는 그대로 보존한다(사람 편집 존중). */
export function upsertEntry(text: string, name: string, cmd: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`데몬 이름 형식 오류: ${name}`);
  const lines = parseLines(text);
  let replaced = false;
  const out = lines.map((l) => {
    if (l.kind === "entry" && l.name === name && !replaced) {
      replaced = true;
      return `${name}: ${cmd}`;
    }
    return l.kind === "raw" ? l.text : `${l.name}: ${l.cmd}`;
  });
  if (!replaced) {
    // 끝의 빈 줄 앞에 끼우지 않고, 내용 마지막 뒤에 한 줄로 붙인다.
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    out.push(`${name}: ${cmd}`);
  }
  // 끝은 개행 하나로 정규화(내부 빈 줄은 보존) — 편집을 거듭해도 꼬리가 자라지 않는다.
  return out.join("\n").replace(/\n*$/, "") + "\n";
}

/** 엔트리 제거 — 그 이름의 선언 라인만 지우고 나머지는 보존한다. 없으면 원문 그대로. */
export function removeEntry(text: string, name: string): { text: string; removed: boolean } {
  const lines = parseLines(text);
  let removed = false;
  const out: string[] = [];
  for (const l of lines) {
    if (l.kind === "entry" && l.name === name) {
      removed = true;
      continue;
    }
    out.push(l.kind === "raw" ? l.text : `${l.name}: ${l.cmd}`);
  }
  return { text: out.join("\n"), removed };
}
