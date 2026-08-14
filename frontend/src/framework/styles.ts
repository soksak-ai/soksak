// Where a framework installs its own styles into the document.
//
// With `import "./styles.css"`, one bundle holds the CSS of both frameworks and the rules of the
// unselected one stand in the document too (measured 2026-08-03: `electron.css` was in the Tauri build too).
// So the CSS is taken **as a string** and installed at install time — only the selected one is in the document.
//
// No framework name in the selector. **The file is the condition**: if it is not installed, the rule is not
// in the document at all. A name in the selector forces a third framework to read another framework's condition.

/** Installs this framework's styles into the document (idempotent). Diagnostics and gates read the marker. */
export function adoptFrameworkStyles(name: string, css: string): void {
  const doc = document;
  const mark = `framework-styles-${name}`;
  if (doc.getElementById(mark)) return;
  const el = doc.createElement("style");
  el.id = mark;
  el.dataset.framework = name;
  el.textContent = css;
  doc.head.appendChild(el);
}
