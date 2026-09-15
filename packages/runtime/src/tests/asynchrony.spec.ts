import { describe, expect, test } from "bun:test"

import { complete, type Context, of, root, start } from "../Future"
import { createInteger, type IntegerType } from "../Integer"
import { typeKeySymbol } from "../type"

// NOTE: The runtime half of asynchrony, asked directly rather than through a
// compiled Program: what a start does to the context it was written in, and
// what a run leaves behind when it is over. What the LANGUAGE does with these
// is `packages/compiler/src/tests/asynchrony.spec.ts`.

// NOTE: Both host shapes, staged around a call. `AbortSignal.any` arrived in
// Node 20.3, Bun 1.1, Deno 1.39 and Safari 17.4, and this runtime answers on
// hosts older than all four — so the linking has a hand-rolled fallback, and
// every claim below is made of BOTH paths rather than of whichever one this
// test run happens to have.
function onEachHost(run: () => void): void {
	run()

	let host = AbortSignal.any

	// NOTE: Deleted rather than replaced with a thrower: the probe asks
	// `typeof`, which is what a host without one really answers.
	// @ts-expect-error — staging a host that does not have it
	delete AbortSignal.any

	try {
		run()
	} finally {
		AbortSignal.any = host
	}
}

const one = () => createInteger(1n)

// NOTE: `Number`, because an Integer is hybrid — a small one holds a `number`
// and a large one a `bigint` — and what these tests are about is which value
// came back, not which of the two spellings it came back in.
function integerOf(value: unknown): number {
	return Number((value as IntegerType).value)
}

describe("starting work", () => {
	test("runs the description at once, and again at every start", () => {
		onEachHost(() => {
			let runs = 0
			let work = of(() => {
				runs += 1

				return one()
			})

			expect(runs).toBe(0)

			start(work, root())

			expect(runs).toBe(1)

			start(work, root())

			expect(runs).toBe(2)
		})
	})

	test("answers one run, whose value is the same however often it is read", async () => {
		await onEachHostAsync(async () => {
			let runs = 0
			let started = start(
				of(() => {
					runs += 1

					return one()
				}),
				root(),
			)

			expect(integerOf(await complete(started, root()))).toBe(1)
			expect(integerOf(await complete(started, root()))).toBe(1)
			expect(runs).toBe(1)
		})
	})

	test("answers a Started with itself, which is what 'needless-start' means", () => {
		onEachHost(() => {
			let started = start(of(one), root())

			expect(start(started, root())).toBe(started)
		})
	})
})

describe("the context a run belongs to", () => {
	test("stops a run when the context it was written in stops", () => {
		onEachHost(() => {
			let parent = root()
			let seen: AbortSignal | null = null
			let started = start(
				of((context: Context) => {
					seen = context.signal

					return one()
				}),
				parent,
			)

			expect(started.controller.signal.aborted).toBe(false)

			parent.controller.abort()

			expect(seen!.aborted).toBe(true)
		})
	})

	test("stops nothing above it when the run itself is stopped", () => {
		onEachHost(() => {
			let parent = root()
			let started = start(of(one), parent)

			started.controller.abort()

			expect(parent.signal.aborted).toBe(false)
		})
	})

	test("starts a run stopped where the context is stopped already", () => {
		onEachHost(() => {
			let parent = root()

			parent.controller.abort()

			let seen: AbortSignal | null = null

			start(
				of((context: Context) => {
					seen = context.signal

					return one()
				}),
				parent,
			)

			expect(seen!.aborted).toBe(true)
		})
	})

	// NOTE: The claim the release is FOR. A context outlives the runs started
	// under it — a Program's root context lives as long as the Program — so a
	// link left in place after a run is over is held for the whole of that
	// life, once per start. A thousand starts under one context would hold a
	// thousand of them, all for work that finished.
	test("unlinks a finished run from the context it was started in", async () => {
		let parent = root()
		let host = AbortSignal.any

		// @ts-expect-error — the path with a listener of its own to take off
		delete AbortSignal.any

		try {
			let started = start(of(one), parent)

			await complete(started, root())

			parent.controller.abort()

			expect(started.controller.signal.aborted).toBe(false)
		} finally {
			AbortSignal.any = host
		}
	})
})

describe("completing work", () => {
	test("runs a Future under a context of its own", async () => {
		await onEachHostAsync(async () => {
			let parent = root()
			let seen: AbortSignal | null = null
			let answered = await complete(
				of((context: Context) => {
					seen = context.signal

					return one()
				}),
				parent,
			)

			expect(integerOf(answered)).toBe(1)
			expect(seen).not.toBe(parent.signal)
		})
	})

	test("answers a value that is neither with itself, which is what 'needless-complete' means", () => {
		let value = one()

		expect(complete(value as never, root())).toBe(value as never)
	})

	test("keeps a throw out of a run on the promise rather than at the start", async () => {
		await onEachHostAsync(async () => {
			let started = start(
				of(() => {
					throw new Error("bug in a native")
				}),
				root(),
			)

			expect(started[typeKeySymbol]).toBe("Started")
			await expect(complete(started, root())).rejects.toThrow(
				"bug in a native",
			)
		})
	})
})

// NOTE: The asynchronous half of `onEachHost`, written out rather than folded
// into it: a staged host has to be put back after the run it was staged for has
// finished, and awaiting inside the synchronous form would put it back while
// the run was still going.
async function onEachHostAsync(run: () => Promise<void>): Promise<void> {
	await run()

	let host = AbortSignal.any

	// @ts-expect-error — staging a host that does not have it
	delete AbortSignal.any

	try {
		await run()
	} finally {
		AbortSignal.any = host
	}
}
