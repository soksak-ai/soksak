const SHA = "1".repeat(64);

function asset(repository: string, tag: string, name: string): string {
  return `${repository}/releases/download/${tag}/${name}`;
}

export function pluginRelease(over: Record<string, unknown> = {}): Record<string, unknown> {
  const repository = "https://github.com/example/weather-plugin";
  const releaseTag = "v0.0.1";
  return {
    spec: "soksak-spec-release@0.0.1",
    kind: "plugin",
    id: "weather-plugin",
    version: "0.0.1",
    source: { repository, commit: "a".repeat(40) },
    releaseTag,
    dependencies: [{ kind: "kit", id: "terminal-common", range: ">=0.0.1 <1.0.0" }],
    artifacts: [{
      target: "any",
      url: asset(repository, releaseTag, "weather-plugin-0.0.1.tgz"),
      sha256: SHA,
      format: "tgz",
      entrypoint: { kind: "plugin", manifest: "plugin.json" },
    }],
    ...over,
  };
}

export function sidecarRelease(over: Record<string, unknown> = {}): Record<string, unknown> {
  const repository = "https://github.com/example/weather-sidecar";
  const releaseTag = "weather-sidecar-v0.0.1";
  const entrypoint = (suffix: string) => ({
    kind: "sidecar",
    interface: { id: "soksak-spec-sidecar-weather", version: "0.0.1" },
    process: [{ name: "weather-service", path: "bin/weather-service" }],
    library: [{ name: "weather-engine", path: `lib/libweather_engine.${suffix}` }],
  });
  return {
    spec: "soksak-spec-release@0.0.1",
    kind: "sidecar",
    id: "weather-sidecar",
    version: "0.0.1",
    source: { repository, commit: "b".repeat(40) },
    releaseTag,
    dependencies: [],
    artifacts: [
      {
        target: "aarch64-apple-darwin",
        url: asset(repository, releaseTag, "weather-sidecar-aarch64-apple-darwin.tar.gz"),
        sha256: "2".repeat(64),
        format: "tar.gz",
        entrypoint: entrypoint("dylib"),
      },
      {
        target: "x86_64-unknown-linux-gnu",
        url: asset(repository, releaseTag, "weather-sidecar-x86_64-unknown-linux-gnu.tar.gz"),
        sha256: "3".repeat(64),
        format: "tar.gz",
        entrypoint: entrypoint("so"),
      },
    ],
    ...over,
  };
}

export function kitRelease(over: Record<string, unknown> = {}): Record<string, unknown> {
  const repository = "https://github.com/example/terminal-common";
  const releaseTag = "terminal-common-v0.0.1";
  return {
    spec: "soksak-spec-release@0.0.1",
    kind: "kit",
    id: "terminal-common",
    version: "0.0.1",
    source: { repository, commit: "c".repeat(40) },
    releaseTag,
    dependencies: [],
    artifacts: [{
      target: "any",
      url: asset(repository, releaseTag, "terminal-common-0.0.1.tgz"),
      sha256: "4".repeat(64),
      format: "tgz",
      entrypoint: { kind: "kit", packageManifest: "package.json" },
    }],
    ...over,
  };
}
