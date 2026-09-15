import { registerKind } from "./registry"
import { typeKeySymbol } from "./type"

// NOTE: ASYNCHRONY'S RUNTIME, and the `Future` Namespace's module in one file —
// the Namespace's name and the module's name are the same name, and splitting
// them would put what a future IS and what runs one in two places. The emission
// reads this module under the alias `$future` and the Namespace import reads it
// under `Future`; both are the same module object.
//
// NOTE: A FUTURE IS A DESCRIPTION. Building one runs nothing at all: it holds a
// `run` and nothing else, and `run` is called once per START. That is the whole
// reason a Future may be started any number of times — each start is a fresh
// call — and the whole reason `::retried` can be written as a loop over starts
// rather than as machinery inside the runtime.
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
//
// NOTE: Hand-rolled rather than `AbortSignal.any([parent.signal, own.signal])`,
// which is not on every host this runtime targets. The linking is one listener,
// registered `once`, and it is dropped as soon as either side fires.
function childOf(parent: Context): Context {
	let controller = new AbortController()

	if (parent.signal.aborted) {
		controller.abort(parent.signal.reason)
	} else {
		parent.signal.addEventListener(
			"abort",
			() => controller.abort(parent.signal.reason),
			{ once: true },
		)
	}

	return { signal: controller.signal, controller }
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
	let promise: Promise<Value>

	try {
		promise = Promise.resolve(work.run(child))
	} catch (thrown) {
		// NOTE: A future can not FAIL — a failure is a value in this language,
		// carried by a Result — so a throw out of `run` is a bug in the
		// Compiler or in a native, and it is kept on the promise rather than
		// raised here. Raised, it would surface at the `start`, which is not
		// where the work is, and it would escape a `start` written for its
		// effects entirely.
		promise = Promise.reject(thrown)
	}

	return {
		[typeKeySymbol]: "Started",
		promise,
		controller: child.controller,
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

	return work.run(childOf(context))
}
