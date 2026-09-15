declarations {

	§ The two ways to build a future out of nothing. Everything else builds one
	§ from a future it already has. A completing body wraps what it waits for,
	§ `start` runs one and `complete` reads one. So a Program with no native
	§ answering a Future could not write one down at all. These two are the base
	§ case the rest rests on: a computation to carry out later, and a length of
	§ time to wait.

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

		§§ Answers a Future that waits the given number of milliseconds.
		§§
		§§ Nothing waits while the Future is being built. Each start waits again, so a Future that is started twice waits twice.
		§§
		§§ A wait that is stopped never answers. The runs that `within` and `race` leave behind are stopped, and what one would have answered is never read.
		§§
		§§ @param milliseconds — how long to wait
		§§ @returns — a Future answering nothing, once the time has passed.
		static sleep(milliseconds duration: Integer) -> Future<{}>
	}
}

export {
	Async
}
