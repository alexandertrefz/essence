import { watch as watchDirectory } from "node:fs"
import { stat } from "node:fs/promises"
import * as path from "node:path"

import { canonicalPath } from "@essence-lang/compiler/modules"

import type { EssenceCompileError } from "./compile-error"
import { attemptLoad, type EssenceModule, type LoadOptions } from "./load"

// NOTE: `loadModule`, kept up to date. The sources are watched, and every edit
// that compiles is handed over as a new Module — the same Module `loadModule`
// would have answered with, had it been called after the edit. A host that
// wants its Essence to follow the editor rather than the restart wires the new
// Module in wherever it held the old one, and nothing else about it changes.
//
// NOTE: The Module BEFORE an edit that does not compile stays live. It is not
// replaced, not closed and not marked; the Error is reported and the watcher
// goes on watching, so that the edit that fixes it is the next thing a host
// hears about. A first load that fails is reported the same way, and `module`
// is `null` until something compiles — a host that would rather fail outright
// on a broken start calls `loadModule` first.
//
// NOTE: What survives a swap, and what does not. Every load evaluates a bundle
// of its own with a Type key of its own, so a MARSHALLED value — the plain
// JavaScript `exports` hand over — is as good after the swap as before, and a
// RAW one is not: it is tagged by the load that built it, and the next load's
// Functions refuse it by name (see `mintedTypeKeys` in the interpreter). A host
// keeping state across reloads keeps it on the JavaScript side of the boundary.
// And a Module once evaluated can not be unloaded — JavaScript has no such door
// — so every reload leaves the one before it to the garbage collector, which
// collects it only once nothing holds a value from it any more.

export type WatchOptions = LoadOptions & {
	// NOTE: Every Module the sources load as — the first, and one more for
	// every edit that compiles to something new. An edit that compiles to the
	// same bundle (a save without a change) is not reported.
	onModule: (module: EssenceModule) => void
	// NOTE: Every load that does not compile, first or later. Required, because
	// a watcher that swallowed a failing edit would leave a host running the
	// Module from before it with nothing to say why the edit did not take.
	onError: (error: EssenceCompileError) => void
	// NOTE: How long after the last change to wait before loading, in
	// milliseconds. Editors write in bursts — a save is often a temporary file
	// renamed over the original — and a load per event would compile a file
	// halfway through being written.
	debounce?: number
}

export type ModuleWatcher = {
	// NOTE: The latest Module that compiled, or `null` before anything has.
	readonly module: EssenceModule | null
	// NOTE: The sources under watch — the graph as of the last load, whether it
	// compiled or not.
	readonly files: ReadonlyArray<string>
	// NOTE: Stops watching. Nothing loaded is affected — the last Module stays
	// as usable as it was — and no listener is called again.
	close: () => void
}

const DEFAULT_DEBOUNCE = 60

export async function watchModule(
	entryPath: string,
	options: WatchOptions,
): Promise<ModuleWatcher> {
	let entry = canonicalPath(entryPath)
	let debounce = options.debounce ?? DEFAULT_DEBOUNCE
	let current: EssenceModule | null = null
	let currentHash: string | null = null
	let files: Array<string> = []
	// NOTE: `mtime:size` per watched file, so that a directory event — which
	// says only that SOMETHING happened in that directory, and on macOS may name
	// a temporary file rather than the one it was renamed over — is checked
	// against the sources themselves before anything is loaded.
	let signatures = new Map<string, string>()
	let watchers = new Map<string, ReturnType<typeof watchDirectory>>()
	let timer: ReturnType<typeof setTimeout> | null = null
	let loading = false
	// NOTE: A change that landed WHILE a load was running. The load in flight
	// read the sources before it, so it is loaded again once it is done rather
	// than trusted to have seen it.
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

	// NOTE: Only files not seen before. A load takes long enough for a save to
	// land while it runs, and re-reading a signature already held would adopt
	// that save as the state everything is compared against — the change would
	// be watched for and never noticed.
	async function watchFiles(next: Array<string>): Promise<void> {
		files = next

		await Promise.all(
			next
				.filter((file) => !signatures.has(file))
				.map(async (file) => {
					signatures.set(file, await signature(file))
				}),
		)

		// NOTE: One watcher per DIRECTORY holding a file of the graph, never
		// per file: editors rarely write a file in place — many write a
		// temporary file and rename it over the original, which destroys a
		// watch on the file itself. A directory watch survives that, and an
		// import written during the session brings its directory along.
		for (let file of next) {
			let directory = path.dirname(file)

			if (watchers.has(directory) || closed) {
				continue
			}

			try {
				watchers.set(
					directory,
					watchDirectory(directory, () => {
						void checkForChanges()
					}),
				)
			} catch {
				// NOTE: A directory that can not be watched is one whose files
				// change unnoticed. There is nothing to do about it here that
				// a host would want done — the load still works, and the next
				// change to a directory that CAN be watched picks up any edit
				// made in this one, because every load re-reads every source.
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

				// NOTE: A file that went missing is left as it was: the load
				// that follows a real change reports it, and a rename in
				// progress reappears under its own name a moment later.
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

			for (let watcher of watchers.values()) {
				watcher.close()
			}

			watchers.clear()
		},
	}
}
