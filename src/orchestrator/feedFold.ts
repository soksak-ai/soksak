// 활동 피드 폴딩(순수) — 스트림 엔트리를 표시 단위로 접는다. 두 상관이 공존한다:
// ① parentId 정확 상관(정본): chat.prompt(turnId) 가 연 대화 세트로 payload.parentId 가
//    일치하는 엔트리(command.executed 자식·command.progress 델타·chat.answer 닫음)를 접합.
//    세트는 부모(prompt)의 seq 에 정박한다 — 카드 가시성은 부모 기준(자식 창 무관).
// ② 휴리스틱(레거시): parentId 없는 command.progress 를 같은 창+명령명+실행 시간창으로
//    command.executed 턴에 접합(플러그인 events.progress 발행 — 상관 id 가 없는 세계).
// 렌더·필터는 소비자 몫 — 여기는 접기만 한다(테스트 격리).

export interface ActivityEntry {
  seq: number;
  ts: number;
  kind: string;
  source: string;
  payload: Record<string, unknown>;
}

// 대화 세트 카드 — body 는 세트 구성원 전부(자식 명령·델타·답변)를 seq 순 그대로 담는다.
// 답변이 마지막이 아닐 수 있다(stop 후 지각 자식 — 사실 그대로 표시). closed = 답변 존재.
export interface ChatCard {
  kind: "chat";
  prompt: ActivityEntry;
  body: ActivityEntry[];
  closed: boolean;
}
export interface PlainItem {
  kind: "entry";
  entry: ActivityEntry;
  deltas?: ActivityEntry[];
}
export type FeedItem = ChatCard | PlainItem;

const parentIdOf = (e: ActivityEntry): string =>
  typeof e.payload.parentId === "string" ? e.payload.parentId : "";

/** 표시 단위의 창 label — 카드는 부모(prompt)의 창(세트 가시성=부모 기준). */
export function itemWindow(it: FeedItem): string {
  const e = it.kind === "chat" ? it.prompt : it.entry;
  return String(e.payload.window ?? "");
}

export function foldFeed(entries: ActivityEntry[]): FeedItem[] {
  // ① 대화 세트 — turnId 로 카드 개설, parentId 일치 엔트리를 흡수.
  const cards = new Map<string, ChatCard>();
  for (const e of entries) {
    if (e.kind === "chat.prompt" && typeof e.payload.turnId === "string" && e.payload.turnId) {
      cards.set(e.payload.turnId, { kind: "chat", prompt: e, body: [], closed: false });
    }
  }
  const claimed = new Set<number>();
  for (const e of entries) {
    const card = cards.get(parentIdOf(e));
    if (!card || e.seq === card.prompt.seq) continue;
    card.body.push(e);
    if (e.kind === "chat.answer") card.closed = true;
    claimed.add(e.seq);
  }
  // 부모가 링/캡 밖으로 밀려난 고아 parentId 엔트리는 단독 표시(정보 유실 없음).

  // ② 휴리스틱(레거시) — parentId 없는 진행 델타만 대상. 매칭 = 같은 창 + 명령명(플러그인
  //    발행은 짧은 이름) + 실행 시간창(±1.5s). 완료 전(진행 중) 델타는 단독 표시.
  const rest = entries.filter((e) => !claimed.has(e.seq) && !(e.kind === "chat.prompt" && cards.has(String(e.payload.turnId ?? ""))));
  const matches = (full: string, short: string) => full === short || full.endsWith(`.${short}`);
  const consumed = new Set<number>();
  const deltasFor = new Map<number, ActivityEntry[]>();
  for (const e of rest) {
    if (e.kind !== "command.executed") continue;
    const p = e.payload;
    const started = Number(p.startedAt ?? 0);
    const finished = Number(p.finishedAt ?? e.ts);
    const list = rest.filter(
      (d) =>
        d.kind === "command.progress" &&
        !parentIdOf(d) &&
        !consumed.has(d.seq) &&
        String(d.payload.window ?? "") === String(p.window ?? "") &&
        matches(String(p.command ?? ""), String(d.payload.command ?? "")) &&
        d.ts >= started - 1500 &&
        d.ts <= finished + 1500,
    );
    if (list.length) {
      deltasFor.set(e.seq, list);
      for (const d of list) consumed.add(d.seq);
    }
  }

  // 표시 순서 = 정박 seq(카드는 prompt 위치) — 원 스트림 순서 보존.
  const items: FeedItem[] = [];
  for (const e of rest) {
    if (e.kind === "command.progress" && consumed.has(e.seq)) continue;
    items.push({ kind: "entry", entry: e, deltas: deltasFor.get(e.seq) });
  }
  for (const card of cards.values()) {
    items.push(card);
  }
  items.sort((a, b) => (a.kind === "chat" ? a.prompt.seq : a.entry.seq) - (b.kind === "chat" ? b.prompt.seq : b.entry.seq));
  return items;
}
