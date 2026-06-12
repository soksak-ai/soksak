// 코드 하이라이트+ — TODO/FIXME/XXX 토큰을 모든 파일에서 강조하는 전역 CM6 확장.
// 반드시 호스트 모듈(ctx.app.editor.modules)만 사용한다(§0-7 — 자체 번들 금지).
// mjs/cjs→js(javascript), svelte→html 문법 매핑은 매니페스트 선언만으로 자동 적용
// — 코드는 확장 등록만 담당한다.

export default {
  activate(ctx) {
    const { MatchDecorator, Decoration, ViewPlugin, EditorView } =
      ctx.app.editor.modules.view;

    // 단어 경계의 TODO/FIXME/XXX 만 매치(식별자 일부는 제외).
    const matcher = new MatchDecorator({
      regexp: /\b(?:TODO|FIXME|XXX)\b/g,
      decoration: Decoration.mark({ class: "cm-soksak-todo" }),
    });

    // 문서 변경/뷰포트 이동 시 데코레이션 증분 갱신.
    const todoHighlighter = ViewPlugin.fromClass(
      class {
        constructor(view) {
          this.decorations = matcher.createDeco(view);
        }
        update(update) {
          this.decorations = matcher.updateDeco(update, this.decorations);
        }
      },
      { decorations: (v) => v.decorations },
    );

    // 데코레이션 스타일 — 앱 accent(var(--acc)) 를 반투명으로 섞어 테마 추종.
    const theme = EditorView.baseTheme({
      ".cm-soksak-todo": {
        backgroundColor: "color-mix(in srgb, var(--acc) 16%, transparent)",
        outline: "1px solid color-mix(in srgb, var(--acc) 45%, transparent)",
        borderRadius: "2px",
      },
    });

    // 전역 등록(languages 미지정 = 모든 파일). 반환 Disposable 은 호스트 tracker 가
    // 자동 수거하므로 비활성화 즉시 열린 에디터에서 제거된다(레지스트리 version 신호).
    ctx.app.editor.registerExtension({
      extension: [todoHighlighter, theme],
    });
  },

  deactivate() {
    // 자체 보유 자원 없음 — 확장 해제는 호스트 tracker 가 수행.
  },
};
