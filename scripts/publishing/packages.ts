import * as path from "node:path"

// NOTE: The one description of what gets published. Everything else in this
// directory — staging, packing, smoke-testing, publishing — walks this list,
// so a package joins or leaves the published set by editing exactly one place.

export const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..")
export const BUILD_DIRECTORY = path.join(REPOSITORY_ROOT, "build", "publish")
export const COMPILED_DIRECTORY = path.join(BUILD_DIRECTORY, "compiled")
export const STAGE_DIRECTORY = path.join(BUILD_DIRECTORY, "packages")
export const TARBALL_DIRECTORY = path.join(BUILD_DIRECTORY, "tarballs")

export type PublishedPackage = {
	directory: string
	// NOTE: Directories shipped verbatim beside `dist/` — the standard
	// library's `.es` sources, and the runtime's TypeScript, which the
	// Bundler inlines from source so a published compiler emits the same
	// bundle bytes a workspace checkout does.
	data?: Array<string>
	// NOTE: A package that already is JavaScript. The listed files are the
	// package; there is no compilation and no `dist/`.
	prebuilt?: Array<string>
}

// NOTE: In dependency order, so `npm publish` never makes a package visible
// on the registry before the packages it depends on.
export const PUBLISHED_PACKAGES: Array<PublishedPackage> = [
	{ directory: "interfaces" },
	{
		directory: "escodegen",
		prebuilt: [
			"escodegen.js",
			"escodegen.d.ts",
			"LICENSE.BSD",
			"PATCHES.md",
			"README.md",
		],
	},
	{ directory: "ariadne" },
	{ directory: "standard-library", data: ["sources"] },
	{ directory: "runtime", data: ["src"] },
	{ directory: "compiler" },
	{ directory: "client" },
	{ directory: "formatter" },
	{ directory: "debug-adapter" },
	{ directory: "language-server" },
	{ directory: "cli" },
]

export type Manifest = {
	name: string
	version: string
	description?: string
	private?: boolean
	type?: string
	main?: string
	types?: string
	exports?: Record<string, string>
	bin?: Record<string, string>
	scripts?: Record<string, string>
	author?: string
	license?: string
	homepage?: string
	repository?: object
	bugs?: string
	keywords?: Array<string>
	engines?: Record<string, string>
	dependencies?: Record<string, string>
	optionalDependencies?: Record<string, string>
	devDependencies?: Record<string, string>
}

export function packageDirectory(name: string): string {
	return path.join(REPOSITORY_ROOT, "packages", name)
}

export function stageDirectory(name: string): string {
	return path.join(STAGE_DIRECTORY, name)
}
