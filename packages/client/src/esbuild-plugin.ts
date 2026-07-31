import { createCompiler, ESSENCE_FILE, type PluginOptions } from "./plugin-core"

export type EsbuildLoadArguments = {
	path: string
}

export type EsbuildLoadResult = {
	contents: string
	loader: "js"
	watchFiles: Array<string>
}

export type EsbuildBuild = {
	onLoad(
		options: { filter: RegExp },
		callback: (args: EsbuildLoadArguments) => Promise<EsbuildLoadResult>,
	): void
}

export type EsbuildPlugin = {
	name: string
	setup(build: EsbuildBuild): void
}

// NOTE: esbuild resolves a relative path to a file itself, whatever its
// extension, so there is nothing to claim on the way in — only the text to
// answer with once it has been asked for.
export function essenceEsbuild(options: PluginOptions = {}): EsbuildPlugin {
	return {
		name: "essence",
		// NOTE: `setup` runs once per build, which is exactly the scope the
		// compiler's memory of what it has already compiled has to have.
		setup(build) {
			let compiler = createCompiler(options)

			build.onLoad({ filter: ESSENCE_FILE }, async (args) => {
				let compiled = await compiler.compile(
					args.path,
					options.declarations ?? false,
				)

				return {
					contents: compiled.code,
					loader: "js",
					watchFiles: compiled.files,
				}
			})
		},
	}
}
