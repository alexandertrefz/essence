import { type Context, delayOf, type FutureType, of, waitFor } from "./Future"
import type { IntegerType } from "./Integer"
import type { RecordType } from "./Record"
import { type AnyType, typeKeySymbol } from "./type"

// The natives that build a Future out of nothing: a computation to carry out
// later, and a length of time to wait. `Future.ts` holds what a Future is.

// `compute` runs at every start rather than here, so building the Future runs
// nothing and two starts run it twice. A synchronous computation can not stop
// partway, so the context goes unread.
export function deferred<Value extends AnyType>(
	compute: () => Value,
): FutureType<Value> {
	return of(() => compute())
}

// The unit value a finished wait answers with. Built here rather than through
// `createRecord`, so this module needs no runtime import of `Record.ts`.
const unit: RecordType = { [typeKeySymbol]: "Record" }

// `Async.sleep(milliseconds duration)`. Nothing is scheduled until the Future
// starts, and starting it twice waits twice.
//
// A stopped wait clears its timer and never settles, which is what cancellation
// is in this runtime. Rejecting would hand a Program a failure no Case can hold.
// The timer stays referenced, so a host stays open while a sleep is pending.
export function sleep(duration: IntegerType): FutureType<RecordType> {
	return of(
		(context: Context) =>
			new Promise((resolve) => {
				if (context.signal.aborted) {
					return
				}

				let finished = waitFor(delayOf(duration), () => resolve(unit))

				context.signal.addEventListener("abort", finished, {
					once: true,
				})
			}),
	)
}
