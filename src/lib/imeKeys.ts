// 한국어 등 IME 조합 중 Enter 처리 — 조합 확정 Enter(keydown isComposing=true,
// 또는 레거시 keyCode 229)는 "입력 확정"이지 "커밋 명령"이 아니다. 이를 무시하지
// 않으면 미확정 텍스트로 rename/검색/이동이 커밋되는 오동작이 난다(WebKit 포함
// 전 브라우저 표준 패턴).

export function isComposingEnter(
  e: Pick<React.KeyboardEvent, "key" | "nativeEvent" | "keyCode">,
): boolean {
  return (
    e.key === "Enter" && (e.nativeEvent.isComposing || e.keyCode === 229)
  );
}
