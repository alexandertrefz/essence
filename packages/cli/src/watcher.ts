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
// - A directory watcher is NOT armed when `watch` returns, and a busy machine
//   loses the event outright rather than delivering it late. Measured, not
//   supposed: with three test suites running, a watched file written right
//   after `fs.watch` returned went unreported 4 times in 30, and never once
//   when the write waited 300 ms. So the signatures are also read on a timer,
//   and a save the platform never mentioned is found within one tick. The
//   events stay, because a tick is slow and an event is not.

export const DEFAULT_DEBOUNCE = 60

// NOTE: How often the signatures are read without an event prompting it. Half
// a second is long enough that a session of a few hundred files costs nothing
// a reader notices, and short enough that a lost save is not a mystery.
export const DEFAULT_POLL = 500

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
	// NOTE: The timer's interval; `DEFAULT_POLL` otherwise, and zero for none.
	poll?: number
	// NOTE: How a directory watcher is made — `fs.watch` otherwise. A spec
	// hands over one that reports nothing, to prove the timer on its own.
	watchDirectory?: (
		directory: string,
		listener: () => void,
	) => DirectoryWatcher
}

// NOTE: What `fs.watch` answers with, as far as this file reads it.
export type DirectoryWatcher = {
	close(): void
	on(event: "error", listener: (error: unknown) => void): unknown
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
	let poll = options.poll ?? DEFAULT_POLL
	let watchDirectory = options.watchDirectory ?? watchPath
	let signatures = new Map<string, string>()
	let directorySignatures = new Map<string, string>()
	let watchers = new Map<string, DirectoryWatcher>()
	let watched = new Set<string>()
	let pending = new Set<string>()
	let timer: ReturnType<typeof setTimeout> | null = null
	let ticker: ReturnType<typeof setInterval> | null = null
	let reading: Promise<void> = Promise.resolve()
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

	// NOTE: One read of every signature, prompted by a directory event or by
	// the timer. A prompt from an event is activity whatever the read finds,
	// since something happened in a watched directory; the timer is activity
	// only where a directory's own signature moved, which is what a file
	// appearing or going looks like from in here, so an idle tick reports
	// nothing.
	let readSignatures = async (prompted: boolean): Promise<void> => {
		let changed: Array<string> = []
		let activity = prompted

		await Promise.all([
			...[...watched].map(async (fileName) => {
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
			...[...watchers.keys()].map(async (directory) => {
				let current = await signature(directory)

				if (
					current === "missing" ||
					directorySignatures.get(directory) === current
				) {
					return
				}

				directorySignatures.set(directory, current)
				activity = true
			}),
		])

		if (
			changed.length > 0 ||
			(activity && options.onActivity !== undefined)
		) {
			schedule(changed)
		}
	}

	// NOTE: The reads are queued behind one another rather than run at once.
	// An event and a tick landing together would otherwise both read the new
	// signature before either had recorded it, and one save would be reported
	// twice.
	let checkForChanges = (prompted: boolean): Promise<void> => {
		reading = reading.then(() => readSignatures(prompted))

		return reading
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

				// NOTE: The directory's signature is taken BEFORE its watcher
				// is made, for the reason a file's is: whatever lands between
				// the two is then a change the timer finds.
				directorySignatures.set(directory, await signature(directory))

				try {
					let watcher = watchDirectory(directory, () => {
						void checkForChanges(true)
					})

					// NOTE: A watcher can fail AFTER it was made — the
					// directory goes away, or the platform runs out of
					// handles — and it says so with an "error" event. An
					// EventEmitter with no listener for that event throws it
					// as an uncaught exception, which would take the whole
					// session down for a directory nobody is editing any
					// more. It is handed to the same `onError` a failure to
					// start reaches, and that is all that is known about it.
					watcher.on("error", (error) => {
						options.onError?.(directory, error)
					})

					watchers.set(directory, watcher)
				} catch (error) {
					options.onError?.(directory, error)
				}
			}

			// NOTE: The timer is a fallback and not a reason to stay alive:
			// the directory watchers hold the process open, and a session
			// that closed them is one the timer must not keep running.
			if (ticker === null && poll > 0 && watchers.size > 0) {
				ticker = setInterval(() => {
					void checkForChanges(false)
				}, poll)

				ticker.unref()
			}
		},
		files: () => [...watched],
		close(): void {
			closed = true

			if (timer !== null) {
				clearTimeout(timer)
				timer = null
			}

			if (ticker !== null) {
				clearInterval(ticker)
				ticker = null
			}

			for (let watcher of watchers.values()) {
				watcher.close()
			}

			watchers.clear()
		},
	}
}
