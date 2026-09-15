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

// NOTE: A real timer rather than a microtask, because what these tests are
// about is a second answer arriving in a LATER turn than the first — which is
// what a run that waits for a host does.
function pause(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

const endlessly = () => new Promise<never>(() => {})

const throwing = (): never => {
	throw new Error("bug in a native")
}

// NOTE: The abort listeners a run leaves on the context it was started in,
// counted by standing in front of the signal's own two Methods. Awaited past a
// turn of the loop, because a run that settles releases its link in the
// microtask its promise settles in.
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

	// NOTE: What the link is FOR, and the claim that has to hold on BOTH host
	// shapes: stopping a context stops everything started under it, including
	// what a run that has already answered left behind. A finished run can not
	// be stopped itself — there is nothing left of it — but the work it started
	// is still going, and the stop reaches that work through the finished run's
	// own link.
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

	// NOTE: And the bookkeeping that claim is paid for with, on the one path
	// that has bookkeeping of its own. A context outlives the runs started
	// under it — a Program's root context lives as long as the Program — so a
	// listener left on it after everything that needed it is over is held for
	// the whole of that life, once per start. A hundred thousand of those is
	// tens of megabytes.
	//
	// Three cases, and the count is the whole of the rule: a run that settles
	// no longer needs it, a run stopped on its own never settles and no longer
	// needs it either, and a run still going does.
	test("holds a listener on its parent for exactly as long as it needs one", async () => {
		let host = AbortSignal.any

		// @ts-expect-error — the path with a listener of its own to take off
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
	// NOTE: A host keeps a timer's delay in a 32-bit signed integer and fires an
	// overflowed one at ONE millisecond. An Essence Integer is unbounded, so the
	// generous deadline is exactly the one that would arrive at once.
	test("is spent in slices no longer than a host takes", () => {
		let armed: Array<number> = []
		let host = globalThis.setTimeout
		let answered = 0

		// NOTE: Fired at once rather than waited for — what is under test is
		// the slicing, and three seconds of real time is not a test.
		// @ts-expect-error — a stand-in that answers with no handle
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

	// NOTE: End to end, because the two halves are only worth anything
	// together: a deadline past what a host takes has to leave the work alone
	// rather than stop it in the next millisecond.
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
	// NOTE: A `start` in Statement position is fire-and-forget, which the
	// Compiler reports once as an Information and allows. So a throw out of such
	// a run has no reader — and a rejected promise with no reader is what a host
	// raises on: Node ends the Program where it stands and Bun prints a stack
	// and exits 1. A Program that forgets a run on purpose may not take the
	// process with it.
	//
	// NOTE: Three doors, because a Started is built at three of them and the two
	// derived promises are promises of their own that nothing else marks.
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

	// NOTE: And the mark takes nothing away. A handler attached to a rejected
	// promise is what marks it read, not what consumes it, so the throw is
	// still there for whoever completes the run later.
	test("still throws where it is completed later", async () => {
		let started = start(of(throwing), root())

		await pause(20)
		await expect(complete(started, root())).rejects.toThrow(
			"bug in a native",
		)
	})
})

describe("the first value several runs answer with", () => {
	// NOTE: The shape that is settled twice in one turn: two runs that both
	// answer a value before either handler runs. The second handler arrives
	// after the winner has been chosen, and what it must not do is stop "every
	// other run" — which by then is the winner.
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

	// NOTE: And the winner's own leftover work goes on. A run that started
	// something and answered is a run whose context must stay live, because
	// what it started is what the Program asked for — and a later answer
	// aborting "every other run" would reach exactly that context.
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

	// NOTE: A List whose every run fails answers empty, and the count that says
	// so may not be reached twice by one run.
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
