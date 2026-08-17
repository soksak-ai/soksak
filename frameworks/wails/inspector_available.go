//go:build !production || devtools

package wails

// inspectorAvailable is whether this build has a developer inspector compiled in.
//
// The vendored framework compiles `openDevTools` to an empty function under `production` without
// `devtools`, so the call answers and nothing opens. A command that reports OK and does nothing is
// the shape every refusal in this build exists to prevent — `watch_dir` with no watcher, a spawn
// with no vault — so the fact travels here and the command refuses by name instead.
//
// The tags are the framework's own: a build with the inspector compiled in reports true here.
const inspectorAvailable = true
