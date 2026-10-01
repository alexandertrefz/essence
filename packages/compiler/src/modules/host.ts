import { readFileSync } from "node:fs"

// What loading a graph asks of the world: what a file says. `esc` reads disk,
// while the language server answers with the editor's unsaved text. The graph
// reports `undefined` as a Module that was not found.
export type ModuleHost = {
	readFile(filePath: string): string | undefined
}

// A directory, a missing file and an unreadable one are one answer here. The
// graph reports which Module could not be read, not why.
export const diskModuleHost: ModuleHost = {
	readFile(filePath: string): string | undefined {
		try {
			return readFileSync(filePath, "utf-8")
		} catch {
			return undefined
		}
	},
}
