// **A refusal message must say what to do.**
//
// The sentence a user received: "This node is a projection of another realm (plugin-view) — an event
// dispatched at the host does not reach inside it: <address>. This command has no path into that
// realm yet (pointer gestures and fill are passed through)."
//
// That sentence describes our internal structure — realm, projection, event dispatched at the host.
// The reader does not know what those words mean, and after reading all of it still does not know
// **what to call next**. A code comment must state structure; a sentence that goes to a person must
// state the next action.
//
// So refusal sentences get two rules: no internal vocabulary, and name what to call instead.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Internal vocabulary banned where text goes to a person — names of our structure, not the user's
 *  words. */
const INTERNAL_WORDS = [
  "realm",
  "투영",
  "꽂은",
  "꽂으면",
  "plugin-view",
  "renderer",
];

/** These files produce the sentences that go to a person. */
function messageStrings(): { file: string; text: string }[] {
  const dir = join(__dirname);
  const out: { file: string; text: string }[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts") || name.includes(".test.")) continue;
    const source = readFileSync(join(dir, name), "utf8");
    // Reading only the `message:` line misses **the tail** of a concatenated sentence — the advice
    // is usually appended at the end, so measuring half of it turns this check into an unpassable
    // rule. Read the whole expression: from `message:` to the comma at bracket depth 0.
    for (const m of source.matchAll(/message:\s/g)) {
      let depth = 0;
      let index = m.index! + m[0].length;
      const start = index;
      for (; index < source.length; index += 1) {
        const ch = source[index]!;
        if (ch === "(" || ch === "[" || ch === "{") depth += 1;
        else if (ch === ")" || ch === "]" || ch === "}") {
          if (depth === 0) break;
          depth -= 1;
        } else if (ch === "," && depth === 0) break;
        else if (ch === "\n" && depth === 0 && /^\s*[a-zA-Z_}]/.test(source.slice(index + 1, index + 40))) {
          // A next line that starts with a new key means this expression ended.
          if (!/[+\\(]\s*$/.test(source.slice(start, index))) break;
        }
      }
      const text = source.slice(start, index).trim();
      if (text.startsWith("`") || text.startsWith('"')) out.push({ file: name, text });
    }
  }
  return out;
}

describe("a refusal sentence uses the reader's words", () => {
  it("no internal vocabulary goes out to a person", () => {
    const leaked = messageStrings().filter((row) =>
      INTERNAL_WORDS.some((word) => row.text.includes(word)),
    );
    expect(leaked.map((r) => `${r.file}: ${r.text.slice(0, 90)}`)).toEqual([]);
  });

  // Ending at "there is no path" leaves the reader assuming their own mistake, so they call the same
  // thing again.
  it("never stops at cannot — names what to call instead", () => {
    const dead = messageStrings().filter(
      (row) =>
        /없습니다|못했습니다|불가/.test(row.text) &&
        !/\$\{/.test(row.text.slice(row.text.indexOf("없습니다"))) &&
        !/(하세요|하십시오|씁니다|쓰세요|부르세요|필요|먼저)/.test(row.text),
    );
    expect(dead.map((r) => `${r.file}: ${r.text.slice(0, 90)}`)).toEqual([]);
  });
});
