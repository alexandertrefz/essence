import { plugin } from "bun"

// One timeout for every spec, preloaded by `bunfig.toml` into each test
// process. Compiles take as long as a loaded host takes, so the budget is a
// minute. See "The test budget" in DEVELOPMENT.md.
const budget = budgetFrom(process.env.ESSENCE_TEST_BUDGET)

// A timeout of zero or NaN turns timeouts off, so anything but a positive
// number keeps the minute.
export function budgetFrom(requested: string | undefined): number {
	let milliseconds = Number(requested)

	return Number.isFinite(milliseconds) && milliseconds > 0
		? milliseconds
		: 60_000
}

// The files the budget reaches.
export const specFileName = /\.spec\.ts$/

// `setDefaultTimeout` reaches only the file it runs in, and a plain `bun test`
// runs this preload once for all its files. So each spec file sets the budget
// itself, on its first line, through a call that declares no name.
const call = `import.meta.require("bun:test").setDefaultTimeout(${budget});`

plugin({
	name: "test budget",
	setup(build) {
		build.onLoad({ filter: specFileName }, async (spec) => {
			let source = await Bun.file(spec.path).text()
			// A `#!` line must come first, so the call takes its place.
			let start = source.startsWith("#!") ? source.search(/\n|$/) : 0

			return { contents: call + source.slice(start), loader: "ts" }
		})
	},
})
