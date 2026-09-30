import { existsSync } from "node:fs"
import * as path from "node:path"

// The runtime's location, which is what the Compiler needs of this package.
// Programs reach the other modules by absolute path in a bundle, or by package
// specifier in a host's build. The path is resolved from this module's own
// location, so it holds from any working directory. This package owns it, so
// the Rewriter and the Bundler need not count `../`s towards it.
//
// The published package runs this module as `dist/index.js`, but the Bundler
// inlines the TypeScript sources shipped in `src/` beside it. That keeps a
// published compiler's bundles identical to a workspace one's.
export function runtimeDirectoryFor(moduleDirname: string): string {
	return path.basename(moduleDirname) === "dist"
		? path.resolve(moduleDirname, "../src")
		: moduleDirname
}

// The VS Code extension bundles the Language Server into one file. Its
// `buildServer.js` copies the runtime sources into a `runtime` directory beside
// that file, since the Bundler reads them off disk by path.
const OWN_RUNTIME = runtimeDirectoryFor(import.meta.dirname)
const BUNDLED_RUNTIME = path.resolve(import.meta.dirname, "runtime")

export const RUNTIME_DIRECTORY = existsSync(path.join(OWN_RUNTIME, "type.ts"))
	? OWN_RUNTIME
	: BUNDLED_RUNTIME

// The tsconfig esbuild transpiles the runtime modules with while inlining them.
// It is the runtime's own, since the modules compile inside a user's bundle.
export const RUNTIME_TSCONFIG = path.join(RUNTIME_DIRECTORY, "tsconfig.json")
