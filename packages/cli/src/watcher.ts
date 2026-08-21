import { watch as watchPath } from "node:fs"
import { stat } from "node:fs/promises"
import * as path from "node:path"

// NOTE: The file watching every long-running command shares — `esc watch` and
// `esc test --watch` differ in what they DO with a change and not at all in how
// they notice one. The discipline is the client package's `watchModule`, which
// learned it the hard way:
//
// - One watcher per DIRECTORY rather than per file. Editors rarely write a file
//   in place; many write a temporary file and rename it over the original,
//   which destroys a watch on the file itself. Watching the directory survives
//   that, and also catches a file deleted and recreated.
// - A directory event says only that something happened in that directory — on
//   macOS the rename is reported under the temporary file's name — so the
//   event's file name is never trusted. It is a prompt to re-read the
//   signatures.
// - A signature is `mtimeMs:size`, and is captured only for a file not seen
//   before: a rebuild takes long enough for a save to land while it runs, and
//   adopting that save as the baseline would mean waiting for a change that has
//   already happened.

export const DEFAULT_DEBOUNCE = 60

// NOTE: Every file of every entry's graph, and which entries a change to it
// reaches — a dependency is never rebuilt as an entry of its own, because what
// it changes is the output of the Modules that import it. A file two entries
// reach wakes both.
export type DependentsIndex = {
	record(entry: string, fileNames: Array<string>): void
	entriesFor(fileNames: Array<string>): Array<string>
	files(): Array<string>
}

export function createDependentsIndex(): DependentsIndex {
	let dependents = new Map<string, Set<string>>()

	return {
		record(entry: string, fileNames: Array<string>): void {
			// NOTE: The entry is taken out of every set first, so that a Module
			// an import was just deleted from stops waking it. A file nothing
			// reaches any more leaves the map with the last entry that did.
			for (let entries of dependents.values()) {
				entries.delete(entry)
			}

			for (let fileName of [path.resolve(entry), ...fileNames]) {
				let entries = dependents.get(fileName)

				if (entries === undefined) {
					dependents.set(fileName, new Set([entry]))
				} else {
					entries.add(entry)
				}
			}

			for (let [fileName, entries] of dependents) {
				if (entries.size === 0) {
					dependents.delete(fileName)
				}
			}
		},
		entriesFor(fileNames: Array<string>): Array<string> {
			let entries = new Set<string>()

			for (let fileName of fileNames) {
				for (let entry of dependents.get(fileName) ?? []) {
					entries.add(entry)
				}
			}

			return [...entries]
		},
		files: () => [...dependents.keys()],
	}
}

export type SourceWatcher = {
	// NOTE: Adds files to the watched set — the graphs GROW, because an import
	// written during a session brings a directory with it and a session that
	// never watched it would stop noticing saves there.
	watch(fileNames: Array<string>): Promise<void>
	// NOTE: What is being watched, for a caller that keeps its own map of what
	// a file affects.
	files(): Array<string>
	close(): void
}

export type SourceWatcherOptions = {
	onChange: (changed: Array<string>) => void
	// NOTE: Something happened in a watched directory and no watched file
	// changed — which is what the CREATION of a file looks like from in here,
	// since a file nobody is watching has no signature to differ from. A caller
	// that has to notice a new source (a test session watching a project rather
	// than a fixed list of entries) looks again; one watching a graph it was
	// given ignores it.
	onActivity?: () => void
	onError?: (directory: string, error: unknown) => void
	debounce?: number
}

async function signature(fileName: string): Promise<string> {
	try {
		let info = await stat(fileName)

		return `${info.mtimeMs}:${info.size}`
	} catch {
		return "missing"
	}
}

export function createSourceWatcher(
	options: SourceWatcherOptions,
): SourceWatcher {
	let debounce = options.debounce ?? DEFAULT_DEBOUNCE
	let signatures = new Map<string, string>()
	let watchers = new Map<string, ReturnType<typeof watchPath>>()
	let watched = new Set<string>()
	let pending = new Set<string>()
	let timer: ReturnType<typeof setTimeout> | null = null
	let closed = false

	let schedule = (changed: Array<string>): void => {
		for (let fileName of changed) {
			pending.add(fileName)
		}

		if (timer !== null) {
			clearTimeout(timer)
		}

		timer = setTimeout(() => {
			timer = null

			let batch = [...pending]

			pending.clear()

			if (closed) {
				return
			}

			if (batch.length > 0) {
				options.onChange(batch)

				return
			}

			options.onActivity?.()
		}, debounce)
	}

	let checkForChanges = async (): Promise<void> => {
		let changed: Array<string> = []

		await Promise.all(
			[...watched].map(async (fileName) => {
				let current = await signature(fileName)

				if (
					current === "missing" ||
					signatures.get(fileName) === current
				) {
					return
				}

				signatures.set(fileName, current)
				changed.push(fileName)
			}),
		)

		if (changed.length > 0 || options.onActivity !== undefined) {
			schedule(changed)
		}
	}

	return {
		async watch(fileNames: Array<string>): Promise<void> {
			for (let fileName of fileNames) {
				watched.add(path.resolve(fileName))
			}

			await Promise.all(
				[...watched]
					.filter((fileName) => !signatures.has(fileName))
					.map(async (fileName) => {
						signatures.set(fileName, await signature(fileName))
					}),
			)

			for (let fileName of watched) {
				let directory = path.dirname(fileName)

				if (watchers.has(directory)) {
					continue
				}

				try {
					watchers.set(
						directory,
						watchPath(directory, () => {
							void checkForChanges()
						}),
					)
				} catch (error) {
					options.onError?.(directory, error)
				}
			}
		},
		files: () => [...watched],
		close(): void {
			closed = true

			if (timer !== null) {
				clearTimeout(timer)
				timer = null
			}

			for (let watcher of watchers.values()) {
				watcher.close()
			}

			watchers.clear()
		},
	}
}
