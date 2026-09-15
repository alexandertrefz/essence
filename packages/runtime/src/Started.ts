import { delayOf, started, type StartedType, waitFor } from "./Future"
import type { IntegerType } from "./Integer"
import type { OptionalType } from "./Optional"
import { createEmpty, createValue } from "./Optional"
import type { AnyType } from "./type"

// NOTE: `Started` is one RUN of a Future, and everything that builds, starts or
// waits for one lives in `Future.ts` — the two are one mechanism, and a run has
// no representation apart from the description it came from. What is here is the
// two Methods a run in flight answers, which are about the RUN rather than about
// the description, and so belong to this Namespace rather than to that one.
export type { StartedType } from "./Future"

// NOTE: `Started::map(_ transform)` — the same run, read differently. The work
// is in flight already and nothing here starts it again, so the transform runs
// once, when the run answers, however often the answer is completed.
//
// NOTE: It carries the SAME controller. What a Started holds is one run, and a
// reading of that run is still that run: stopping the mapped one is stopping the
// work, which is what a reader of `start` means by stopping it.
export function map<Value extends AnyType, Other extends AnyType>(
	run: StartedType<Value>,
	transform: (value: Value) => Other,
): StartedType<Other> {
	return started(run.promise.then(transform), run.controller)
}

// NOTE: `Started::within(milliseconds limit)` — a deadline on the WAITING, and
// on nothing else. `Future::within` stops the run it was written over, because
// that run belongs to it; a Started belongs to whoever started it, and may be
// completed from anywhere any number of times, so a deadline one holder writes
// may not stop the work the others are waiting for. The run goes on, and this
// answer stops listening for it.
//
// NOTE: The clock starts HERE rather than at a later completion, because the
// run is in flight already: "within five seconds" of a run in flight can only
// mean five seconds from now.
export function within<Value extends AnyType>(
	run: StartedType<Value>,
	limit: IntegerType,
): StartedType<OptionalType<Value>> {
	let promise = new Promise<OptionalType<Value>>((resolve, reject) => {
		let finished = waitFor(delayOf(limit), () => resolve(createEmpty()))

		run.promise.then(
			(value) => {
				finished()
				resolve(createValue(value))
			},
			(thrown) => {
				finished()
				reject(thrown)
			},
		)
	})

	return started(promise, run.controller)
}
