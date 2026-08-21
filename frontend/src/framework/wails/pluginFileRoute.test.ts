// The route the webview requests on is the route the host answers on.
//
// Each side states it once, in its own language, and neither compiles against
// the other. A changed route on one side is not an error anywhere: the request
// falls through to the embedded asset handler, which answers the index page,
// and the plugin loader reports a bundle that is HTML.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const HOST = join(__dirname, "../../../../frameworks/wails/pluginassets.go");

describe("the plugin file route", () => {
  it("is the same string on both sides", () => {
    const adapter = readFileSync(join(__dirname, "index.ts"), "utf8");
    const declared = /const PLUGIN_FILE_ROUTE = "([^"]+)"/.exec(adapter);
    expect(declared, "the adapter declares no PLUGIN_FILE_ROUTE").not.toBeNull();

    const host = readFileSync(HOST, "utf8");
    const served = /PluginFileRoute\s*=\s*"([^"]+)"/.exec(host);
    expect(served, "the host declares no PluginFileRoute").not.toBeNull();

    expect(declared?.[1]).toBe(served?.[1]);
  });

  it("asks with the query name the host reads", () => {
    const adapter = readFileSync(join(__dirname, "index.ts"), "utf8");
    const host = readFileSync(HOST, "utf8");
    const query = /pluginFileQuery\s*=\s*"([^"]+)"/.exec(host);
    expect(query, "the host declares no pluginFileQuery").not.toBeNull();
    expect(adapter).toContain(`?${query?.[1]}=`);
  });
});

// The stream event and the argument key are stated once on each side, in
// different languages, and neither compiles against the other. A rename on one
// side is not an error anywhere: frames go out on an event nobody hears, and
// the feature reads as a backend that produces nothing.
describe("the stream transport", () => {
  const STREAMS = join(__dirname, "streams.ts");
  const CONTRACT = join(__dirname, "../../../../core/control/stream.go");

  it("names the same delivery event on both sides", () => {
    const adapter = /STREAM_EVENT = "([^"]+)"/.exec(readFileSync(STREAMS, "utf8"));
    const core = /StreamEvent\s*=\s*"([^"]+)"/.exec(readFileSync(CONTRACT, "utf8"));
    expect(adapter, "the adapter declares no STREAM_EVENT").not.toBeNull();
    expect(core, "the core declares no StreamEvent").not.toBeNull();
    expect(adapter?.[1]).toBe(core?.[1]);
  });

  it("uses the same argument key for a receiver", () => {
    const adapter = readFileSync(STREAMS, "utf8");
    const key = /streamKey\s*=\s*"([^"]+)"/.exec(readFileSync(CONTRACT, "utf8"));
    expect(key, "the core declares no streamKey").not.toBeNull();
    expect(adapter).toContain(`${key?.[1]}: id`);
  });
});
