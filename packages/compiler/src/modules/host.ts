import { readFileSync } from "node:fs"

// NOTE: Everything loading a graph needs of the world, which is one question:
// what does this file say? Kept an interface because the two callers answer it
// differently — `esc` reads disk, while the Language Server has to answer from
// the documents the Editor holds open, whose unsaved text is the only truthful
// version of a file that may not even exist on disk yet. Anything the host can
// not answer for is `undefined`, which the graph reports as a Module that was
// not found.
export type ModuleHost = {
	readFile(filePath: string): string | undefined
}

// NOTE: The plain answer, for every caller that is not an Editor. A directory,
// a missing file and an unreadable one are all one answer here: the graph's
// business is which Module could not be read, not why the filesystem said no.
export const diskModuleHost: ModuleHost = {
	readFile(filePath: string): string | undefined {
		try {
			return readFileSync(filePath, "utf-8")
		} catch {
			return undefined
		}
	},
}
