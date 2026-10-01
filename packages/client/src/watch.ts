import { watch as watchDirectory } from "node:fs"
import { stat } from "node:fs/promises"
import * as path from "node:path"

import { canonicalPath } from "@essence-lang/compiler/modules"

import type { EssenceCompileError } from "./compile-error"
import { attemptLoad, type EssenceModule, type LoadOptions } from "./load"

// `loadModule` kept up to date: each edit that compiles arrives as a new Module.
// After an edit that does not compile, the Error is reported and the Module
// before it stays live. A first load that fails leaves `module` as `null`.
//
// Each load evaluates its own bundle with its own Type key, so a marshalled
// value survives a swap and a raw one is refused (`mintedTypeKeys`). An
// evaluated Module is never unloaded, only collected once nothing holds it.

export type WatchOptions = LoadOptions & {
	// Called with the first Module and with each edit that compiles to a new
	// bundle. A save that changes nothing is not reported.
	onModule: (module: EssenceModule) => void
	// Called for each load that does not compile, the first one included.
	// Required, so a failing edit is never silently ignored.
	onError: (error: EssenceCompileError) => void
	// How long after the last change to wait before loading, in milliseconds.
	// Editors write in bursts, and a load per event could read a half-written file.
	debounce?: number
	// How often to check the sources without a directory event, in
	// milliseconds, or zero for never. A watcher is not armed when `fs.watch`
	// returns, and a busy machine drops events, so polling finds what they miss.
	poll?: number
}

export type ModuleWatcher = {
	// The latest Module that compiled, or `null` before anything has.
	readonly module: EssenceModule | null
	// The sources under watch: the graph of the last load, compiled or not.
	readonly files: ReadonlyArray<string>
	// Stops watching. The last Module stays usable, and no listener is called
	// again.
	close: () => void
}

const DEFAULT_DEBOUNCE = 60
const DEFAULT_POLL = 500

export async function watchModule(
	entryPath: string,
	options: WatchOptions,
): Promise<ModuleWatcher> {
	let entry = canonicalPath(entryPath)
	let debounce = options.debounce ?? DEFAULT_DEBOUNCE
	let poll = options.poll ?? DEFAULT_POLL
	let current: EssenceModule | null = null
	let currentHash: string | null = null
	let files: Array<string> = []
	// `mtime:size` per watched file. A directory event says only that something
	// in the directory changed, so the sources are checked before a load.
	let signatures = new Map<string, string>()
	let watchers = new Map<string, ReturnType<typeof watchDirectory>>()
	let timer: ReturnType<typeof setTimeout> | null = null
	let ticker: ReturnType<typeof setInterval> | null = null
	let loading = false
	// A change landed while a load ran, which may have read the sources before
	// it, so another load follows.
	let again = false
	let closed = false

	async function signature(file: string): Promise<string> {
		try {
			let info = await stat(file)

			return `${info.mtimeMs}:${info.size}`
		} catch {
			return "missing"
		}
	}

	// Signs only files not seen before. Re-reading a held signature would adopt
	// a save that landed during the load, and that change would go unnoticed.
	async function watchFiles(next: Array<string>): Promise<void> {
		files = next

		await Promise.all(
			next
				.filter((file) => !signatures.has(file))
				.map(async (file) => {
					signatures.set(file, await signature(file))
				}),
		)

		// One watcher per directory, since many editors rename a temporary file
		// over the original, which ends a watch on the file itself.
		for (let file of next) {
			let directory = path.dirname(file)

			if (watchers.has(directory) || closed) {
				continue
			}

			try {
				let watcher = watchDirectory(directory, () => {
					void checkForChanges()
				})

				// A watcher that fails later emits "error", which an
				// EventEmitter with no listener throws as an uncaught exception.
				// The failure is ignored, as an unwatchable directory is.
				watcher.on("error", () => {})

				watchers.set(directory, watcher)
			} catch {
				// An edit here waits for polling or for a change elsewhere, since
				// every load re-reads every source.
			}
		}
	}

	async function checkForChanges(): Promise<void> {
		if (closed) {
			return
		}

		let changed = false

		await Promise.all(
			files.map(async (file) => {
				let now = await signature(file)

				// A missing file is skipped. A rename in progress reappears
				// under its own name, and a real loss is reported by the next load.
				if (now === "missing" || signatures.get(file) === now) {
					return
				}

				signatures.set(file, now)
				changed = true
			}),
		)

		if (changed) {
			schedule()
		}
	}

	function schedule(): void {
		if (timer !== null) {
			clearTimeout(timer)
		}

		timer = setTimeout(() => {
			timer = null
			void load()
		}, debounce)
	}

	async function load(): Promise<void> {
		if (closed) {
			return
		}

		if (loading) {
			again = true

			return
		}

		loading = true

		try {
			let attempt = await attemptLoad(entry, options)

			if (closed) {
				return
			}

			await watchFiles(attempt.files)

			if (attempt.module === null) {
				options.onError(attempt.error!)
			} else if (attempt.bundleHash !== currentHash) {
				current = attempt.module
				currentHash = attempt.bundleHash
				options.onModule(attempt.module)
			}
		} finally {
			loading = false
		}

		if (again) {
			again = false
			await load()
		}
	}

	await load()

	// The poll does not keep the process alive. The directory watchers do,
	// until `close`.
	if (poll > 0 && !closed) {
		ticker = setInterval(() => {
			void checkForChanges()
		}, poll)

		ticker.unref()
	}

	return {
		get module() {
			return current
		},
		get files() {
			return files
		},
		close() {
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
