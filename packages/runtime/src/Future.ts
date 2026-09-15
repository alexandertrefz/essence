import type { IntegerType } from "./Integer"
import { createList, type ListType, materialise } from "./List"
import type { OptionalType } from "./Optional"
import { createEmpty, createValue } from "./Optional"
import { registerKind } from "./registry"
import type { ResultType } from "./Result"
import { type AnyType, typeKeySymbol } from "./type"

// NOTE: ASYNCHRONY'S RUNTIME, and the `Future` Namespace's module in one file —
// the Namespace's name and the module's name are the same name, and splitting
// them would put what a future IS and what runs one in two places. The emission
// reads this module under the alias `$future` and the Namespace import reads it
// under `Future`; both are the same module object.
//
// NOTE: A FUTURE IS A DESCRIPTION. Building one runs nothing at all: it holds a
// `run` and nothing else, and `run` is called once per START. That is the whole
// reason a Future may be started any number of times — each start is a fresh
// call — and the whole reason `::attempt` is written in Essence, as a body that
// completes the receiver again, rather than as machinery inside this module.
//
// A STARTED IS ONE RUN of such a description. It holds the promise that run
// answered with and the controller that stops it, so completing one twice
// answers the same value twice and runs nothing the second time.
//
// NOTE: Everything here runs on the one JavaScript thread. Concurrency is not
// parallelism: a future with no suspension inside it runs to its end
// synchronously the moment it is started, which is why `start` calls `run`
// rather than scheduling it.

// NOTE: The context a run belongs to — the signal the work reads and the
// controller that stops it. Every start makes a CHILD of the context it was
// written in, so stopping a run stops everything it started, and nothing else.
export type Context = {
	signal: AbortSignal
	controller: AbortController
}

export type FutureType<Value> = {
	[typeKeySymbol]: "Future"
	// NOTE: May answer with the value itself rather than with a promise of one —
	// a description of synchronous work is a Future like any other, and
	// `Promise.resolve` is what levels the two.
	run: (context: Context) => Value | Promise<Value>
}

export type StartedType<Value> = {
	[typeKeySymbol]: "Started"
	promise: Promise<Value>
	controller: AbortController
}

// NOTE: Registered from the two doors a Future and a Started are BUILT through,
// rather than at the top of this module, for the reason `Dictionary.ts` gives at
// its own registration: the head of every emitted Program imports every runtime
// module and leans on esbuild to shake the unused ones away, and a top-level
// call is a side effect a bundler has to keep. A Program that waits for nothing
// pays nothing for this file.
//
// NOTE: Both kinds render as their bare name and hold no parts. What a Future
// describes is a JavaScript closure and what a Started holds is a promise;
// neither says anything to a reader, and printing either would be printing the
// runtime's own bookkeeping. They compare by IDENTITY for the same reason: two
// descriptions of the same work are not the same work, and there is nothing
// inside one to compare structurally.
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

// NOTE: The door a completing body's emission comes through:
// `$future.of(async ($ctx) => …)`. The closure IS the description, and it is
// handed the context at every start.
export function of<Value>(
	run: (context: Context) => Value | Promise<Value>,
): FutureType<Value> {
	registerFutureKinds()

	return { [typeKeySymbol]: "Future", run }
}

// NOTE: The context work started at a Program's top level belongs to — a root
// with nothing above it, so nothing can stop it but itself. A fresh one per
// call, which is what makes two top-level starts independent of each other.
export function root(): Context {
	let controller = new AbortController()

	return { signal: controller.signal, controller }
}

// NOTE: A context that is stopped when its parent is, and separately stoppable
// on its own — which is what `::within` and `::race` stop their losers through.
// `release` is what unlinks it from its parent once its own run is over; see
// `childOf`.
type Child = {
	context: Context
	release: () => void
}

// NOTE: `AbortSignal.any([parent.signal, own.signal])` is exactly this union,
// and it is taken where the host has one: the engine owns the bookkeeping, and a
// dependent signal nothing holds any more is collected with the run it belonged
// to. It arrived in Node 20.3, Bun 1.1, Deno 1.39 and Safari 17.4, so a host
// without one is a host this runtime still has to answer on — hence the
// fallback below, and hence the probe, which is read PER CALL for the reason
// `Terminal.ts` probes its streams per write: a read at the top of this module
// is a side effect esbuild has to keep, and a Program that waits for nothing
// would pay for it.
//
// NOTE: The fallback is one listener, and `release` is what takes it off again.
// Without that, every start under one context leaves a listener on it that lives
// as long as the context does — a loop starting a thousand futures under a
// Program's root context would hold a thousand of them, all for runs that
// finished. `AbortSignal.any` needs no release, because there is nothing of ours
// to take off.
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

	let forward = () => controller.abort(parent.signal.reason)

	parent.signal.addEventListener("abort", forward, { once: true })

	return {
		context: { signal: controller.signal, controller },
		release: () => parent.signal.removeEventListener("abort", forward),
	}
}

// NOTE: One run of a description, under a context of its own, as the promise it
// answers with. The release is what the run is over: a run that finished can no
// longer be stopped, so holding its link to the parent open would be holding it
// open for nothing.
//
// NOTE: A throw out of `run` is kept ON THE PROMISE rather than raised here. A
// future can not FAIL — a failure is a value in this language, carried by a
// Result — so a throw is a bug in the Compiler or in a native, and raising it
// would surface it at the `start`, which is not where the work is, and would
// escape a `start` written for its effects entirely.
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

// NOTE: `start x` — the description put in flight under a context of its own,
// answering the one run of it. `run` is called SYNCHRONOUSLY, so a future with
// nothing to wait for inside it is finished before `start` answers; what comes
// back is a promise either way, because the caller can not tell which it was and
// must not have to.
//
// NOTE: A Started handed here is answered with ITSELF. Starting one is
// `needless-start`, a Warning the Compiler reports, and the Program it reports
// on still has to mean something: one run stays one run.
export function start<Value>(
	work: FutureType<Value> | StartedType<Value>,
	context: Context,
): StartedType<Value> {
	registerFutureKinds()

	if (work[typeKeySymbol] !== "Future") {
		// NOTE: A Started is answered with itself, and so is anything else.
		// Starting a Started is `needless-start` and starting a value that
		// describes no work is the same Warning — both compile, because both
		// are Warnings, and a Program that compiles has to mean what the
		// Warning says it means: the Keyword is a no-op and the value carries
		// on. The alternative is a `TypeError` out of this module naming a
		// field the value never had.
		return work as StartedType<Value>
	}

	let child = childOf(context)

	return {
		[typeKeySymbol]: "Started",
		promise: runUnder(work, child),
		controller: child.context.controller,
	}
}

// NOTE: `complete x` — what the emission `await`s. A Started is waited for
// again, which answers the value it already has; a Future is run under a context
// of its own and waited for, without a Started object nobody would read.
export function complete<Value>(
	work: FutureType<Value> | StartedType<Value>,
	context: Context,
): Value | Promise<Value> {
	if (work[typeKeySymbol] === "Started") {
		return work.promise
	}

	// NOTE: And anything that is not a Future is its own answer, for the reason
	// `start` answers one with itself: `needless-complete` is a Warning, so the
	// Program runs, and what it runs has to be the no-op the Warning describes.
	if (work[typeKeySymbol] !== "Future") {
		return work as unknown as Value
	}

	registerFutureKinds()

	return runUnder(work, childOf(context))
}

// #region Timers

// NOTE: The longest delay a host timer takes. `setTimeout` keeps its delay in a
// 32-bit signed integer, so anything past this overflows — and what a host does
// with an overflowed delay is fire at ONE millisecond, with a warning printed
// into the Program's own output. An Essence Integer is unbounded and no `@param`
// here names a ceiling, so a deadline a Program means generously is exactly the
// one that would arrive at once.
const LONGEST_DELAY = 2147483647

// NOTE: The milliseconds a limit asks for, as a number a timer can be armed
// with. An Integer is hybrid — a small one holds a `number` and a large one a
// `bigint` — and a `bigint` past 2^53 answers `Infinity` through `Number`,
// which is honest: a wait that long is a wait with no end. A negative length is
// no time at all rather than a host warning about a negative delay.
export function delayOf(limit: IntegerType): number {
	let milliseconds = Number(limit.value)

	return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : Infinity
}

// NOTE: A timer armed in chunks no longer than a host takes, re-armed until the
// time asked for is spent — which is what keeps a long deadline long. `Infinity`
// never spends, so a wait with no end re-arms forever and answers never, which
// is what it says. Answers the way to call it off.
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

// NOTE: `Future::within(milliseconds limit)` — the receiver, run under a
// context of its own, with a deadline over it. What it answers is an Optional,
// so a run that took too long is a value the Program reads rather than a failure
// it handles: there is no `TimedOut` Case anywhere, and none is needed.
//
// NOTE: The loser is STOPPED. The run belongs to this call and to nothing else —
// it was started here — so nothing else can be waiting for it, and what it
// answers after the deadline is a value nobody may observe. That is the whole of
// what cancellation is here: the work is signalled and its answer is dropped.
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

				// NOTE: And the deadline goes when the run above it does. A
				// timer left behind holds a host with an event loop open for as
				// long as it has left to run, for an answer nobody is waiting
				// for any more.
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

// NOTE: `FutureList::inSequence()` — one after another, each started only once
// the one before it has answered. It is the combinator to reach for where the
// work is not independent: a host that refuses a second request, a walk whose
// order is what the answer means.
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

// NOTE: `FutureList::all()` — every one of them started at once, and the values
// in the receiver's order however they finished. Concurrency is not parallelism:
// they share the one thread, so what this buys is the waiting rather than the
// computing.
export function all__overload$1<Value extends AnyType>(
	futures: ListType<FutureType<Value>>,
): FutureType<ListType<Value>> {
	return of(async (context) => {
		let started = materialise(futures).map((work) => start(work, context))

		// NOTE: `Promise.all` answers a fresh Array, which is what `createList`
		// demands of every caller — the box takes the Array it is handed.
		return createList(await Promise.all(started.map((run) => run.promise)))
	})
}

// NOTE: `FutureList::all(atMost count)` — the same answer with a ceiling on how
// many are in flight. A count below one runs them one at a time, which is the
// library's rule for a count that makes no sense: nothing is dropped and the
// answer still holds one value per item.
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
		// NOTE: One walker per slot, each taking the next item until there is
		// none — rather than a walk of fixed batches, which would wait for the
		// slowest of each batch before starting any of the one after it.
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

// NOTE: `NonEmptyFutureList::race()` — every one started at once, the first
// answer taken, and every other run stopped. The receiver is a List proven to
// hold something, because the first answer of nothing is no answer at all.
//
// NOTE: The index rides with the value so that the winner can be told from the
// losers. Racing the promises alone answers the value and leaves nothing to say
// WHICH run it came from, and stopping them all would signal the run that won.
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

// NOTE: `ResultFutureList::firstValue()` — every one started at once, and the
// first VALUE any of them answers with. A run that fails is not an answer here:
// the wait goes on, and only a List whose every run failed answers empty. The
// name is `OptionalList::firstValue`'s, for the same question one level along.
export function firstValue<Value extends AnyType, Failure extends AnyType>(
	futures: ListType<FutureType<ResultType<Value, Failure>>>,
): FutureType<OptionalType<Value>> {
	return of((context) => {
		let started = materialise(futures).map((work) => start(work, context))

		if (started.length === 0) {
			return createEmpty()
		}

		let awaited = started.length
		// NOTE: SETTLED ONCE, and this flag is what says so. Every run answers,
		// including the ones that answer in the same turn as the winner, and a
		// second answer arriving after the choice was made must neither stop
		// anything nor count towards the empty answer: it would abort every
		// OTHER run, which by then includes the winner, and a winner whose
		// context is aborted hands out a value nothing can complete. `race`
		// needs no flag of its own — `Promise.race` settles once by
		// construction — but a firstValue skips failures and so can not be
		// written on it.
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
