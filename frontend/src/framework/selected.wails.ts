// The only adapter binding of the Wails build.
// The Vite alias `#framework-adapter` selects this file. No runtime guessing, no fallback to
// another framework: each framework's own build determines which framework is in use.
export { wailsFramework as selectedFramework } from "./wails";
