// The page an overlay menu surface loads.
//
// The menu is composited in its own native webview surface above every terminal, so it never parks
// a terminal and never crosses the two compositing layers a document overlay does — that swap is
// what flickered (measured 2026-09-05). The page is a self-contained data: URL: it holds its
// items and its colours inline, renders the list, and posts the chosen id back through
// `window.webkit.messageHandlers.soksak`, the return channel the surface service serves.
//
// It is one page for every menu — the items decide what it shows. A leaf posts its id; a category
// opens its children in place with a row back to the parent.

export interface OverlayMenuItem {
  /** A leaf has the program id; a category has none. */
  id?: string;
  label: string;
  /** A category's children; absent or empty on a leaf. */
  items?: OverlayMenuItem[];
}

export interface OverlayMenuColors {
  bg: string;
  fg: string;
  hover: string;
  border: string;
  muted: string;
}

/** One row's fixed height and the menu's chrome, so the caller sizes the surface to the content. */
export const OVERLAY_MENU_ROW_H = 30;
export const OVERLAY_MENU_PAD = 6;
export const OVERLAY_MENU_WIDTH = 220;

/** The card (and surface) height that shows `rows` rows, capped so a long list scrolls. */
export function overlayMenuCardHeight(rows: number): number {
  const shown = Math.max(1, Math.min(rows, 12));
  return shown * OVERLAY_MENU_ROW_H + OVERLAY_MENU_PAD * 2;
}

/** The count of rows the top level of a menu shows, for sizing the surface. */
export function overlayMenuTopRows(items: readonly OverlayMenuItem[]): number {
  return items.length;
}

/**
 * Builds the data: URL for an overlay menu.
 *
 * The items and colours are embedded, so the surface's whole content is its source and a new menu
 * is a new source — which the compositor rebuilds the surface for. The page speaks back only through
 * the message channel; it opens no window and loads nothing else.
 */
export function overlayMenuDataUrl(
  items: readonly OverlayMenuItem[],
  colors: OverlayMenuColors,
): string {
  // Embedded inside a <script>, so a "<" in a label must not open a tag and break out of it.
  const itemsJson = JSON.stringify(items).replace(/</g, "\\u003c");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;box-sizing:border-box;overflow:hidden;background:${colors.bg};
    font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:${colors.fg};
    -webkit-user-select:none;user-select:none;cursor:default}
  body{border:1px solid ${colors.border};border-radius:8px}
  #menu{padding:${OVERLAY_MENU_PAD}px 0;height:100%;box-sizing:border-box;overflow-y:auto}
  .row{display:flex;align-items:center;gap:8px;height:${OVERLAY_MENU_ROW_H}px;padding:0 12px;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:5px;margin:0 4px}
  .row:hover{background:${colors.hover}}
  .row .chev{margin-left:auto;color:${colors.muted}}
  .back{color:${colors.muted}}
  </style></head><body><div id="menu"></div><script>
  var ITEMS=${itemsJson};
  var menu=document.getElementById("menu");
  function post(m){try{window.webkit.messageHandlers.soksak.postMessage(m);}catch(e){}}
  function render(list,parent){
    menu.innerHTML="";
    if(parent){var b=document.createElement("div");b.className="row back";b.textContent="‹ "+parent.label;
      b.onclick=function(){render(parent.up,parent.upParent);};menu.appendChild(b);}
    list.forEach(function(it){
      var r=document.createElement("div");r.className="row";
      var t=document.createElement("span");t.textContent=it.label;r.appendChild(t);
      if(it.items&&it.items.length){var c=document.createElement("span");c.className="chev";c.textContent="›";r.appendChild(c);
        r.onclick=function(){render(it.items,{label:it.label,up:list,upParent:parent});};}
      else if(it.id){r.onclick=function(){post({pick:it.id});};}
      menu.appendChild(r);
    });
  }
  render(ITEMS,null);
  window.addEventListener("keydown",function(e){if(e.key==="Escape")post({dismiss:true});});
  </script></body></html>`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}
