// soksak-formatter — JSON 포메터 (soksak-plugin-spec v1).
// "editor" 권한만 사용. 매니페스트 contributes.formatters 의 선언 id "json" 에
// 핸들러를 바인딩한다 — 선언 없는 id 는 registerFormatter 가 거부(§0-3).

// 파싱 실패 위치를 사람이 읽을 메시지로. V8 류 "at position N" 이 있으면
// 행/열로 환산하고, 엔진이 위치를 안 주면(WebKit) 원문 메시지를 그대로 쓴다.
function describeParseError(text, err) {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /position\s+(\d+)/i.exec(msg);
  if (!m) return msg;
  const pos = Number(m[1]);
  const before = text.slice(0, pos);
  const line = before.split("\n").length;
  const col = pos - before.lastIndexOf("\n");
  return `${line}행 ${col}열 — ${msg}`;
}

export default {
  activate(ctx) {
    const app = ctx.app;
    // 권한 표면 게이트(§0-2): editor 미선언이면 undefined — 침묵 대신 즉시 실패.
    if (!app.editor) throw new Error('"editor" 권한 표면이 없음');

    // 등록 Disposable 은 호스트 tracker 가 자동 수거하지만, subscriptions 에도
    // 넣어 소유를 명시한다(해제는 멱등이라 이중 dispose 무해).
    ctx.subscriptions.push(
      app.editor.registerFormatter({
        id: "json",
        format(text) {
          let value;
          try {
            value = JSON.parse(text);
          } catch (e) {
            // 깨진 텍스트를 절대 돌려주지 않는다 — editor.format 이 이 메시지를
            // INTERNAL 로 그대로 노출한다(§0-4 정직한 실패).
            throw new Error("JSON 파싱 실패: " + describeParseError(text, e));
          }
          // 2칸 들여쓰기 + 마지막 개행 1개.
          return JSON.stringify(value, null, 2) + "\n";
        },
      }),
    );
  },

  deactivate() {
    // 등록 해제는 호스트 tracker + ctx.subscriptions 가 수행 — 추가 정리 없음.
  },
};
