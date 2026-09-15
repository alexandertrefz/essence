declarations {

	§ `Future` and `Started` are bare Type tags, like `Randomness`. They have no
	§ declaration anywhere, because nothing a `type`, `choice` or `protocol`
	§ could say produces a value only the runtime can build and run. They live
	§ in `packages/compiler/src/enricher/primitives.ts` with the other tags.
	§ What is declared here is the two Namespaces the language reaches them
	§ through.
	§
	§ Both are empty. `start`, `complete` and a completing body are the whole of
	§ the language half, and none of them needs a Method. So the combinators
	§ arrive beside the natives that make them worth writing.

	§§ A description of work that will answer with a `Value`.
	§§
	§§ Building one runs nothing. `start` puts it in flight and answers the one run of it, and `complete` waits for what it answers with. A Future can be started any number of times, and each start is a fresh run.
	§§
	§§ A Function whose body writes `complete` declares `-> Future<Value>`. Calling it is an ordinary call that builds the future without running any of it.
	namespace Future<infer Value> for Future<Value> {}

	§§ One run of a Future, already in flight.
	§§
	§§ `complete` waits for it, any number of times and from anywhere. It always answers the same value, because the work runs once. Holding a Started is how a Program says "run this once, read it many times".
	namespace Started<infer Value> for Started<Value> {}
}

export {
	Future
	Started
}
