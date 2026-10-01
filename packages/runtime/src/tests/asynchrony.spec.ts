import { describe, expect, test } from "bun:test"

import {
	complete,
	type Context,
	delayOf,
	firstValue,
	of,
	root,
	start,
	waitFor,
	within,
} from "../Future"
import { createInteger, type IntegerType } from "../Integer"
import { createList } from "../List"
import { createFailure, createValue } from "../Result"
import { map, within as startedWithin } from "../Started"
import { createString, type StringType } from "../String"
import { typeKeySymbol } from "../type"

// The runtime half of asynchrony, asked directly: what a start does to its
// context, and what a run leaves behind. The language half is
// `packages/compiler/src/tests/asynchrony.spec.ts`.

// Runs `run` with and without `AbortSignal.any`. A host without it takes a
// hand-rolled fallback, so every claim must hold on both paths.
function onEachHost(run: () => void): void {
	run()

	let host = AbortSignal.any

	// Deleted rather than replaced with a thrower, since the runtime probes it
	// with `typeof`.
	// @ts-expect-error stages a host without it
	delete AbortSignal.any

	try {
		run()
	} finally {
		AbortSignal.any = host
	}
}

// A real timer rather than a microtask: these tests need an answer in a later
// turn, as a run waiting for a host gives.
function pause(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

const endlessly = () => new Promise<never>(() => {})

const throwing = (): never => {
	throw new Error("bug in a native")
}

// Counts the abort listeners a run leaves on its context by wrapping the
// signal's Methods. Awaited past a turn, since a settled run releases its link
// in the microtask its promise settles in.
async function listeners(
	under: (parent: Context) => void,
): Promise<{ added: number; removed: number }> {
	let parent = root()
	let signal = parent.signal as AbortSignal & {
		addEventListener: (...args: Array<never>) => void
		removeEventListener: (...args: Array<never>) => void
	}
	let add = signal.addEventListener.bind(signal)
	let remove = signal.removeEventListener.bind(signal)
	let added = 0
	let removed = 0

	signal.addEventListener = (...args: Array<never>) => {
		added += 1

		return add(...args)
	}
	signal.removeEventListener = (...args: Array<never>) => {
		removed += 1

		return remove(...args)
	}

	under(parent)

	await pause(0)

	return { added, removed }
}

const one = () => createInteger(1n)

// `Number`, since an Integer holds a small value as a `number` and a large one
// as a `bigint`.
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

	// Stopping a context stops everything started under it, including work a
	// finished run left behind. The stop reaches that work through the finished
	// run's own link.
	test("stops work a finished run left behind", async () => {
		await onEachHostAsync(async () => {
			let parent = root()
			let left: AbortSignal | null = null

			await complete(
				of((context: Context) => {
					start(
						of((inner: Context) => {
							left = inner.signal

							return new Promise<never>(() => {})
						}),
						context,
					)

					return one()
				}),
				parent,
			)

			expect(left!.aborted).toBe(false)

			parent.controller.abort()

			expect(left!.aborted).toBe(true)
		})
	})

	// On the fallback path a run takes its listener off the parent once it
	// settles or is stopped, and keeps it while going. A root context lives as
	// long as the Program, so a leaked listener per start adds up.
	test("holds a listener on its parent for exactly as long as it needs one", async () => {
		let host = AbortSignal.any

		// @ts-expect-error takes the fallback path, which has a listener to take off
		delete AbortSignal.any

		try {
			expect(
				await listeners((parent) => {
					start(of(one), parent)
				}),
			).toEqual({ added: 1, removed: 1 })
			expect(
				await listeners((parent) => {
					start(of(endlessly), parent).controller.abort()
				}),
			).toEqual({ added: 1, removed: 1 })
			expect(
				await listeners((parent) => {
					start(of(endlessly), parent)
				}),
			).toEqual({ added: 1, removed: 0 })
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

describe("a length of time", () => {
	// A host keeps a timer's delay in a 32-bit signed integer and fires an
	// overflowed one after one millisecond, so a longer delay is sliced.
	test("is spent in slices no longer than a host takes", () => {
		let armed: Array<number> = []
		let host = globalThis.setTimeout
		let answered = 0

		// Fired at once rather than waited for, since the slicing is under test.
		// @ts-expect-error a stand-in that answers with no handle
		globalThis.setTimeout = (fire: () => void, delay: number) => {
			armed.push(delay)
			fire()

			return 0
		}

		try {
			waitFor(3_000_000_000, () => {
				answered += 1
			})
		} finally {
			globalThis.setTimeout = host
		}

		expect(armed).toEqual([2147483647, 852516353])
		expect(answered).toBe(1)
	})

	test("is no time at all where it is negative, and never where it is past counting", () => {
		expect(delayOf(createInteger(-5n))).toBe(0)
		expect(delayOf(createInteger(20n))).toBe(20)
		expect(delayOf(createInteger(10n ** 30n))).toBe(1e30)
		expect(delayOf(createInteger(10n ** 400n))).toBe(Infinity)
	})

	// End to end: a deadline past what a host takes must not stop the work in
	// the next millisecond.
	test("leaves a run alone under a deadline longer than a host takes", async () => {
		await onEachHostAsync(async () => {
			let answer = await complete(
				within(
					of(async () => {
						await pause(20)

						return createString("answered")
					}),
					createInteger(2147483648n),
				),
				root(),
			)

			expect(answer[typeKeySymbol]).toBe("Optional#Value")
		})
	})
})

describe("a run nobody completes", () => {
	// A `start` in Statement position is allowed, so a throw out of its run may
	// have no reader. A host raises on such a rejection. `start`, `Started::map`
	// and `Started::within` each build a promise that needs a mark.
	test("does not reach the host's unhandled-rejection hook", async () => {
		let unhandled: Array<unknown> = []
		let seen = (reason: unknown): void => {
			unhandled.push(reason)
		}

		process.on("unhandledRejection", seen)

		try {
			start(of(throwing), root())
			map(start(of(throwing), root()), (value) => value)
			startedWithin(start(of(throwing), root()), createInteger(1000n))

			await pause(20)
		} finally {
			process.off("unhandledRejection", seen)
		}

		expect(unhandled).toEqual([])
	})

	// Marking a rejected promise read does not consume it.
	test("still throws where it is completed later", async () => {
		let started = start(of(throwing), root())

		await pause(20)
		await expect(complete(started, root())).rejects.toThrow(
			"bug in a native",
		)
	})
})

describe("the first value several runs answer with", () => {
	// Both runs answer before either handler runs, so the second handler arrives
	// after the winner is chosen and must not stop it.
	test("leaves the run it handed out completable", async () => {
		await onEachHostAsync(async () => {
			let held = new Map<string, Context>()
			let answering = (name: string) =>
				of(async (context: Context) => {
					held.set(name, context)

					return createValue(createString(name))
				})
			let answer = await complete(
				firstValue(createList([answering("a"), answering("b")])),
				root(),
			)

			expect(answer[typeKeySymbol]).toBe("Optional#Value")

			let winner = ((answer as { item: StringType }).item as StringType)
				.value

			expect(held.get(winner)!.signal.aborted).toBe(false)
		})
	})

	// A later answer must not stop the winner's context, since the work it
	// started is what the Program asked for.
	test("leaves the winner's own work running", async () => {
		await onEachHostAsync(async () => {
			let ran: Array<string> = []
			let answering = (name: string, after: number) =>
				of(async (context: Context) => {
					start(
						of(async (inner: Context) => {
							await pause(40)

							if (!inner.signal.aborted) {
								ran.push(name)
							}

							return createString(name)
						}),
						context,
					)

					await pause(after)

					return createValue(createString(name))
				})

			await complete(
				firstValue(createList([answering("a", 0), answering("b", 10)])),
				root(),
			)
			await pause(60)

			expect(ran).toEqual(["a"])
		})
	})

	// The count of failed runs must not count one run twice.
	test("answers empty where every run fails", async () => {
		await onEachHostAsync(async () => {
			let failing = (reason: string) =>
				of(async () => createFailure(createString(reason)))
			let answer = await complete(
				firstValue(createList([failing("no"), failing("nor")])),
				root(),
			)

			expect(answer[typeKeySymbol]).toBe("Optional#Empty")
		})
	})
})

// The asynchronous `onEachHost`, which puts the staged host back only after the
// run has finished.
async function onEachHostAsync(run: () => Promise<void>): Promise<void> {
	await run()

	let host = AbortSignal.any

	// @ts-expect-error stages a host without it
	delete AbortSignal.any

	try {
		await run()
	} finally {
		AbortSignal.any = host
	}
}
