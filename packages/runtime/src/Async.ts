import { type Context, type FutureType, of } from "./Future"
import type { IntegerType } from "./Integer"
import type { RecordType } from "./Record"
import { type AnyType, typeKeySymbol } from "./type"

// NOTE: The two natives that build a Future out of nothing — a computation to
// carry out later, and a length of time to wait. `Future.ts` is where a future
// IS — what it holds, how a run is started and how one is waited for — and this
// module is the Namespace a Program reaches those doors through. Kept apart from
// `Future.ts` for the reason the sources keep the two Namespaces apart: `Async`
// is where a Program says "run this later", and `Future` is what it has once it
// has said so.

// NOTE: The Function is called at every START rather than here, which is what
// makes the answer a DESCRIPTION: building one runs nothing, and two starts run
// it twice. The context is ignored — a synchronous computation has nothing to
// stop partway, so there is no signal for it to read.
export function deferred<Value extends AnyType>(
	compute: () => Value,
): FutureType<Value> {
	return of(() => compute())
}

// NOTE: The unit value a finished wait answers with. `{}` is the language's unit
// Type and an empty Record is what one is at run time, built here rather than
// through `Record.createRecord` for the reason `Terminal.ts` builds its own: a
// runtime cycle between two modules is a cost every Program pays for one object
// literal.
const unit: RecordType = { [typeKeySymbol]: "Record" }

// NOTE: `Async.sleep(milliseconds duration)` — the wait itself, as a value. It
// is a DESCRIPTION like every other Future, so nothing is scheduled until it is
// started, and starting it twice waits twice.
//
// NOTE: A stopped wait never answers. The timer is cleared and the promise is
// left unsettled, which is what cancellation is throughout this runtime: the
// work is signalled and its answer is dropped, never observed. Rejecting instead
// would put a failure in front of a Program that has no Case for one — a Future
// can not fail — and would surface out of whatever raced it away.
//
// NOTE: The timer is NOT unreferenced. A host with an event loop stays open for
// as long as a pending sleep has left to run, which is exactly what
// `complete Async.sleep(…)` means: unreferencing it would let the host exit out
// from under the wait. A sleep nobody is waiting for is stopped by whatever
// raced it, and the timer goes with it.
export function sleep(duration: IntegerType): FutureType<RecordType> {
	return of(
		(context: Context) =>
			new Promise((resolve) => {
				if (context.signal.aborted) {
					return
				}

				let timer = setTimeout(
					() => resolve(unit),
					Number(duration.value),
				)

				context.signal.addEventListener(
					"abort",
					() => clearTimeout(timer),
					{ once: true },
				)
			}),
	)
}
