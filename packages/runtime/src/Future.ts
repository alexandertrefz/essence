import type { IntegerType } from "./Integer"
import { createList, type ListType, materialise } from "./List"
import type { OptionalType } from "./Optional"
import { createEmpty, createValue } from "./Optional"
import { registerKind } from "./registry"
import type { ResultType } from "./Result"
import { type AnyType, typeKeySymbol } from "./type"

// The runtime of asynchrony and the `Future` Namespace in one module. A Future
// is a description, and a Started is one run of it. See "Futures" in
// DEVELOPMENT.md.
//
// The signal a run reads and the controller that stops it. See "Run contexts"
// in DEVELOPMENT.md.
export type Context = {
	signal: AbortSignal
	controller: AbortController
}

export type FutureType<Value> = {
	[typeKeySymbol]: "Future"
	// Synchronous work answers its value rather than a promise.
	run: (context: Context) => Value | Promise<Value>
}

export type StartedType<Value> = {
	[typeKeySymbol]: "Started"
	promise: Promise<Value>
	controller: AbortController
}

// Registered on first construction. Both kinds render as their bare name and
// compare by identity. See "Futures" in DEVELOPMENT.md.
let registered = false

function registerFutureKinds(): void {
	if (registered) {
		return
	}

	registered = true

	for (let tag of ["Future", "Started"]) {
		registerKind(tag, {
			open: `${tag}(`,
			close: ")",
			render: () => tag,
			parts: () => [],
			equals: (first, second) => first === second,
			equalsBy: (first, second) => first === second,
		})
	}
}

// What a completing body's emitted code calls. The closure is the description,
// handed a context at every start.
export function of<Value>(
	run: (context: Context) => Value | Promise<Value>,
): FutureType<Value> {
	registerFutureKinds()

	return { [typeKeySymbol]: "Future", run }
}

// A fresh context with no parent, for each start at a Program's top level.
export function root(): Context {
	let controller = new AbortController()

	return { signal: controller.signal, controller }
}

// A context stopped with its parent or on its own. `release` says the run it
// was made for is over.
type Child = {
	context: Context
	release: () => void
}

// What a context linked by a forwarding listener still holds open on its
// parent, for hosts without `AbortSignal.any`. See "Run contexts" in
// DEVELOPMENT.md.
type Link = {
	holds: number
	unlinked: boolean
	unlink: () => void
}

let links = new WeakMap<Context, Link>()

function retain(context: Context): void {
	let link = links.get(context)

	if (link !== undefined) {
		link.holds += 1
	}
}

function unlink(link: Link): void {
	if (link.unlinked) {
		return
	}

	link.unlinked = true
	link.unlink()
}

function releaseOne(context: Context): void {
	let link = links.get(context)

	if (link === undefined) {
		return
	}

	link.holds -= 1

	if (link.holds <= 0) {
		unlink(link)
	}
}

// `AbortSignal.any` where the host has it, and otherwise a listener on the
// parent, held by a count of what still needs it. See "Run contexts" in
// DEVELOPMENT.md.
function childOf(parent: Context): Child {
	let controller = new AbortController()

	if (typeof AbortSignal.any === "function") {
		return {
			context: {
				signal: AbortSignal.any([parent.signal, controller.signal]),
				controller,
			},
			release: () => {},
		}
	}

	if (parent.signal.aborted) {
		controller.abort(parent.signal.reason)

		return {
			context: { signal: controller.signal, controller },
			release: () => {},
		}
	}

	let context = { signal: controller.signal, controller }
	let forward = () => controller.abort(parent.signal.reason)

	parent.signal.addEventListener("abort", forward, { once: true })

	// One hold for this context's run, and one on the parent while this
	// context is open under it.
	let link: Link = {
		holds: 1,
		unlinked: false,
		unlink: () => {
			parent.signal.removeEventListener("abort", forward)
			releaseOne(parent)
		},
	}

	links.set(context, link)
	retain(parent)

	controller.signal.addEventListener("abort", () => unlink(link), {
		once: true,
	})

	return { context, release: () => releaseOne(context) }
}

// One run under its own context, released when it settles. A throw is kept on
// the promise. See "Throws inside a run" in DEVELOPMENT.md.
function runUnder<Value>(
	work: FutureType<Value>,
	child: Child,
): Promise<Value> {
	let answered: Value | Promise<Value>

	try {
		answered = work.run(child.context)
	} catch (thrown) {
		child.release()

		return Promise.reject(thrown)
	}

	return Promise.resolve(answered).then(
		(value) => {
			child.release()

			return value
		},
		(thrown) => {
			child.release()

			throw thrown
		},
	)
}

// Every Started is built here, and its promise is marked handled so a run
// nobody completes can not end the process. See "Throws inside a run" in
// DEVELOPMENT.md.
export function started<Value>(
	promise: Promise<Value>,
	controller: AbortController,
): StartedType<Value> {
	promise.catch(() => {})

	return { [typeKeySymbol]: "Started", promise, controller }
}

// `start x`: one run under a child context, with `run` called at once.
export function start<Value>(
	work: FutureType<Value> | StartedType<Value>,
	context: Context,
): StartedType<Value> {
	registerFutureKinds()

	if (work[typeKeySymbol] !== "Future") {
		// `needless-start` is a Warning, so the keyword is a no-op.
		return work as StartedType<Value>
	}

	let child = childOf(context)

	return started(runUnder(work, child), child.context.controller)
}

// `complete x`, which the emitted code awaits. A Future runs under a child
// context without building a Started.
export function complete<Value>(
	work: FutureType<Value> | StartedType<Value>,
	context: Context,
): Value | Promise<Value> {
	if (work[typeKeySymbol] === "Started") {
		return work.promise
	}

	// `needless-complete` is a Warning, so the keyword is a no-op.
	if (work[typeKeySymbol] !== "Future") {
		return work as unknown as Value
	}

	registerFutureKinds()

	return runUnder(work, childOf(context))
}

// #region Timers

// The longest delay a host timer takes. See "Timers" in DEVELOPMENT.md.
const LONGEST_DELAY = 2147483647

// Milliseconds as a number. A negative limit is no time at all, and one past
// what a number holds is `Infinity`.
export function delayOf(limit: IntegerType): number {
	let milliseconds = Number(limit.value)

	return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : Infinity
}

// A timer armed in chunks a host can take, until the delay is spent. Answers the
// way to call it off.
export function waitFor(delay: number, answer: () => void): () => void {
	let remaining = delay
	let timer: ReturnType<typeof setTimeout> | undefined
	let arm = (): void => {
		let slice = Math.min(remaining, LONGEST_DELAY)

		remaining -= slice
		timer = setTimeout(remaining > 0 ? arm : answer, slice)
	}

	arm()

	return () => clearTimeout(timer)
}

// #endregion

// #region The combinators

// The receiver with a deadline, answering empty when it runs out, so no
// `TimedOut` Case is needed. The run belongs to this call, so it is stopped.
// See "Stopping a run" in DEVELOPMENT.md.
export function within<Value extends AnyType>(
	work: FutureType<Value>,
	limit: IntegerType,
): FutureType<OptionalType<Value>> {
	return of(
		(context) =>
			new Promise((resolve, reject) => {
				let started = start(work, context)
				let finished = waitFor(delayOf(limit), () => {
					started.controller.abort()
					resolve(createEmpty())
				})

				// A timer left behind would hold the host open for nobody.
				context.signal.addEventListener("abort", finished, {
					once: true,
				})

				started.promise.then(
					(value) => {
						finished()
						resolve(createValue(value))
					},
					(thrown) => {
						finished()
						reject(thrown)
					},
				)
			}),
	)
}

// Each run starts once the one before it has answered.
export function inSequence<Value extends AnyType>(
	futures: ListType<FutureType<Value>>,
): FutureType<ListType<Value>> {
	return of(async (context) => {
		let answers: Array<Value> = []

		for (let work of materialise(futures)) {
			answers.push(await complete(work, context))
		}

		return createList(answers)
	})
}

// Every run started at once, the values in the receiver's order.
export function all__overload$1<Value extends AnyType>(
	futures: ListType<FutureType<Value>>,
): FutureType<ListType<Value>> {
	return of(async (context) => {
		let started = materialise(futures).map((work) => start(work, context))

		// `Promise.all` answers a fresh Array, which `createList` takes over.
		return createList(await Promise.all(started.map((run) => run.promise)))
	})
}

// `all` with at most `count` runs in flight. A count below one runs them one at
// a time.
export function all__overload$2<Value extends AnyType>(
	futures: ListType<FutureType<Value>>,
	count: IntegerType,
): FutureType<ListType<Value>> {
	return of(async (context) => {
		let items = materialise(futures)
		let total = items.length
		let answers: Array<Value> = Array.from({ length: total })
		let inFlight = Math.max(1, Math.min(Number(count.value), total))
		let next = 0
		// One walker per slot takes the next item until none is left, so no
		// slot waits for a slow neighbour.
		let walkers: Array<Promise<void>> = []

		for (let slot = 0; slot < inFlight; slot++) {
			walkers.push(
				(async () => {
					while (next < total) {
						let index = next

						next += 1
						answers[index] = await complete(items[index]!, context)
					}
				})(),
			)
		}

		await Promise.all(walkers)

		return createList(answers)
	})
}

// Every run started at once, the first answer taken and the others stopped.
// The index rides with the value, so the winner is not stopped.
export function race<Value extends AnyType>(
	futures: ListType<FutureType<Value>>,
): FutureType<Value> {
	return of(async (context) => {
		let started = materialise(futures).map((work) => start(work, context))
		let winner = await Promise.race(
			started.map((run, index) =>
				run.promise.then((value) => ({
					index,
					value,
				})),
			),
		)

		for (let [index, run] of started.entries()) {
			if (index !== winner.index) {
				run.controller.abort()
			}
		}

		return winner.value
	})
}

// The first value any run answers. A failure is skipped, and only a List whose
// every run fails answers empty.
export function firstValue<Value extends AnyType, Failure extends AnyType>(
	futures: ListType<FutureType<ResultType<Value, Failure>>>,
): FutureType<OptionalType<Value>> {
	return of((context) => {
		let started = materialise(futures).map((work) => start(work, context))

		if (started.length === 0) {
			return createEmpty()
		}

		let awaited = started.length
		// Settled once. A later value must not stop the other runs, which
		// include the winner by then.
		let found = false

		return new Promise<OptionalType<Value>>((resolve, reject) => {
			for (let run of started) {
				run.promise.then((answer) => {
					if (found) {
						return
					}

					if (answer[typeKeySymbol] !== "Result#Value") {
						awaited -= 1

						if (awaited === 0) {
							resolve(createEmpty())
						}

						return
					}

					found = true

					for (let other of started) {
						if (other !== run) {
							other.controller.abort()
						}
					}

					resolve(createValue(answer.item))
				}, reject)
			}
		})
	})
}

// #endregion
