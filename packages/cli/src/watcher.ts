import { watch as watchPath } from "node:fs"
import { stat } from "node:fs/promises"
import * as path from "node:path"

// The file watching that `esc watch` and `essence test --watch` share. See
// "Watching files" in DEVELOPMENT.md.

export const DEFAULT_DEBOUNCE = 60

// How often, in milliseconds, the signatures are read without an event.
export const DEFAULT_POLL = 500

// Every file of every entry's graph, and the entries a change to it reaches. A
// dependency is never rebuilt on its own, and a file two entries reach wakes both.
type DependentsIndex = {
	record(entry: string, fileNames: Array<string>): void
	entriesFor(fileNames: Array<string>): Array<string>
	files(): Array<string>
}

export function createDependentsIndex(): DependentsIndex {
	let dependents = new Map<string, Set<string>>()

	return {
		record(entry: string, fileNames: Array<string>): void {
			// The entry leaves every set first, so a Module whose import was just deleted
			// stops waking it.
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

type SourceWatcher = {
	// Adds files to the watched set, since an import written during a session can
	// bring a new directory.
	watch(fileNames: Array<string>): Promise<void>
	// What is being watched.
	files(): Array<string>
	close(): void
}

type SourceWatcherOptions = {
	onChange: (changed: Array<string>) => void
	// Activity in a watched directory that changed no watched file, which is how a
	// new file looks. A session watching a project searches again.
	onActivity?: () => void
	onError?: (directory: string, error: unknown) => void
	debounce?: number
	// The timer's interval in milliseconds; `DEFAULT_POLL` when absent, zero for
	// none.
	poll?: number
	// How a directory watcher is made, `fs.watch` when absent. A spec passes a silent
	// one to prove the timer alone.
	watchDirectory?: (
		directory: string,
		listener: () => void,
	) => DirectoryWatcher
}

// What `fs.watch` answers with, as far as this file reads it.
type DirectoryWatcher = {
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

	// One read of every signature. After an event it always reports activity. After
	// a tick it does only when a directory's signature moved, as when a file appears.
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

	// Reads run one after another, so an event and a tick together never report one
	// save twice.
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

				// Taken before the watcher exists, so anything landing in between is a change
				// the timer finds.
				directorySignatures.set(directory, await signature(directory))

				try {
					let watcher = watchDirectory(directory, () => {
						void checkForChanges(true)
					})

					// A watcher can fail after it starts, when its directory goes or handles run out.
					// An unheard "error" event would crash the session, so it goes to `onError`.
					watcher.on("error", (error) => {
						options.onError?.(directory, error)
					})

					watchers.set(directory, watcher)
				} catch (error) {
					options.onError?.(directory, error)
				}
			}

			// The timer never keeps the process alive: the directory watchers do, until they
			// are closed.
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
