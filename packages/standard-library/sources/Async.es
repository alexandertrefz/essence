declarations {

	§ The one way to build a future out of nothing. Everything else in the
	§ language builds one from a future it already has. A completing body wraps
	§ what it waits for, `start` runs one, and `complete` reads one. So a
	§ Program with no native answering a Future can not write one down at all.
	§ This is the base case the rest rests on.

	§§ Work a Program describes for later.
	namespace Async {
		§§ Answers a Future that runs the given Function when it is started.
		§§
		§§ Nothing runs while the Future is being built. Each start calls the Function again, so two starts answer two values, and a Function reading something that changes reads it at each start.
		§§
		§§ The Function runs on the Program's own thread, from beginning to end, with nothing else in between. It is the way to describe a computation as work rather than to carry one out somewhere else.
		§§
		§§ @param _ — the computation to run when the Future is started
		§§ @returns — a Future answering what the computation answers.
		static deferred<infer Value>(_ compute: () -> Value) -> Future<Value>
	}
}

export {
	Async
}
