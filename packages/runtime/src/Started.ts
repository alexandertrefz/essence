import { delayOf, started, type StartedType, waitFor } from "./Future"
import type { IntegerType } from "./Integer"
import type { OptionalType } from "./Optional"
import { createEmpty, createValue } from "./Optional"
import type { AnyType } from "./type"

// The `Started` Namespace: the Methods a run in flight answers. Starting and
// waiting live in `Future.ts`, since a run is one mechanism with its Future.
export type { StartedType } from "./Future"

// The same run, read differently. The transform runs once, when the run
// answers. The controller is shared, so stopping the mapped run stops the work.
export function map<Value extends AnyType, Other extends AnyType>(
	run: StartedType<Value>,
	transform: (value: Value) => Other,
): StartedType<Other> {
	return started(run.promise.then(transform), run.controller)
}

// A deadline on the waiting alone. Other holders may wait on the same run, so
// the run goes on and this answer stops listening. The clock starts now, since
// the run is already in flight.
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
