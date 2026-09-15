import { type FutureType, of } from "./Future"
import type { AnyType } from "./type"

// NOTE: The one native that builds a Future out of a Function. `Future.ts` is
// where a future IS — what it holds, how a run is started and how one is waited
// for — and this module is the Namespace a Program reaches that door through.
// Kept apart from `Future.ts` for the reason the sources keep the two
// Namespaces apart: `Async` is where a Program says "run this later", and
// `Future` is what it has once it has said so.

// NOTE: The Function is called at every START rather than here, which is what
// makes the answer a DESCRIPTION: building one runs nothing, and two starts run
// it twice. The context is ignored — a synchronous computation has nothing to
// stop partway, so there is no signal for it to read.
export function deferred<Value extends AnyType>(
	compute: () => Value,
): FutureType<Value> {
	return of(() => compute())
}
