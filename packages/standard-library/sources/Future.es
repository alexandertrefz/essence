import {
	from "./Async.es" { Async }
	from "./Integer.es" { Integer }
	from "./List.es" { NonEmptyList }
	from "./Optional.es" { Optional }
	from "./Result.es" { Result }
}

declarations {

	§ `Future` and `Started` are bare Type tags, like `Randomness`. They have no
	§ declaration anywhere, because nothing a `type`, `choice` or `protocol`
	§ could say produces a value only the runtime can build and run. They live
	§ in `packages/compiler/src/enricher/primitives.ts` with the other tags.
	§ What is declared here is the Namespaces the language reaches them through.
	§
	§ Six of them. The four beside `Future` and `Started` are narrower targets
	§ rather than new ideas. Two of them target a List of Futures, one of them
	§ a List proven to hold something, and one a Future answering a Result.
	§ That shape is `NestedList`'s and `OptionalList`'s in `List.es`, and it is
	§ here for their reason. A Method about what the items are belongs to a
	§ Namespace that targets them.

	§§ A description of work that will answer with a `Value`.
	§§
	§§ Building one runs nothing. `start` puts it in flight and answers the one run of it, and `complete` waits for what it answers with. A Future can be started any number of times, and each start is a fresh run.
	§§
	§§ A Function whose body writes `complete` declares `-> Future<Value>`. Calling it is an ordinary call that builds the future without running any of it.
	namespace Future<infer Value> for Future<Value> {
		§ The first three are written in Essence, on `complete` and on the
		§ Keyword's own rule. A body that completes something is a Future. So a
		§ combinator that waits for the receiver and answers something else is
		§ one line, with no runtime of its own.

		§§ Answers a Future that runs this one and hands its value to the transform.
		§§
		§§ Nothing runs while the answer is being built. Each start of the answer starts the receiver again, so two starts run the work twice and call the transform twice.
		§§
		§§ @param _ — the transform the value is handed to
		§§ @returns — a Future answering what the transform answers.
		map<infer Other>(_ transform: (_: Value) -> Other) -> Future<Other> {
			<- transform(complete @)
		}

		§§ Answers a Future that runs this one, and then work that follows it.
		§§
		§§ @returns — a Future answering what the work that follows answers.
		overload andThen {
			§§ Answers a Future that runs this one, and then the one the next Function builds from its value.
			§§
			§§ The Function is called once the receiver has answered, so what it builds can read that value. Nothing runs while the answer is being built.
			§§
			§§ @param _ — the Function building the work to run next
			§§ @returns — a Future answering what the next work answers.
			<infer Other>(
				_ next: (_: Value) -> Future<Other>,
			) -> Future<Other> {
				<- complete next(complete @)
			}

			§§ Answers a Future that runs this one, and then the given one.
			§§
			§§ The value the receiver answers with is dropped. This is the entry for work run for its effect, where what comes next does not read it.
			§§
			§§ @param _ — the work to run once the receiver has answered
			§§ @returns — a Future answering what the given work answers.
			<infer Other>(_ next: Future<Other>) -> Future<Other> {
				complete @

				<- complete next
			}
		}

		§§ Answers a Future that runs this one, and answers nothing where it takes too long.
		§§
		§§ The run is stopped at the deadline. It was started by this Method and nothing else can be waiting for it, so what it would have answered is never read.
		§§
		§§ The answer is an Optional rather than a failure, because a deadline is a question the caller asked rather than something that went wrong.
		§§
		§§ @param milliseconds — how long the run has
		§§ @returns — the value, or nothing where the deadline passed first.
		within(milliseconds limit: Integer) -> Future<Optional<Value>>
	}

	§§ A Future answering a Result.
	§§
	§§ The Namespace holds what only a fallible answer makes sense of: running the work again while it fails.
	namespace ResultFuture<infer Value, infer Failure>
		for Future<Result<Value, Failure>>
	{
		§ Written in Essence on `complete` and on the Method itself. A Future is
		§ a description, so running one again is starting it again. There is
		§ nothing for a runtime to hold between two attempts, which is what makes
		§ these bodies rather than natives.

		§§ Answers a Future that runs this one again while it fails, up to the given number of attempts.
		§§
		§§ @returns — a Future answering the first value, or the last reason.
		overload attempt {
			§§ Answers a Future that runs this one until it answers a value, up to the given number of attempts.
			§§
			§§ The first attempt is one of the count, so `attempt(times 3)` runs the work three times at worst. A count below two is one attempt.
			§§
			§§ The answer is the first value, or the last reason where every attempt failed.
			§§
			§§ @param times — how many attempts to make in all
			§§ @returns — a Future answering the first value, or the last reason.
			(times count: Integer) -> Future<Result<Value, Failure>> {
				§ The receiver is bound above the `match`, where `@` is the
				§ scrutinee rather than the receiver.
				constant work     = @
				constant answered = complete work

				if count::isLessThanOrEqualTo(1) {
					<- answered
				} else {
					<- match answered -> Result<Value, Failure> {
						case #Value { <- answered }
						case #Failure {
							<- complete work::attempt(times count::subtract(1))
						}
					}
				}
			}

			§ `pausingMilliseconds` is the one label here that fuses a unit noun
			§ to a gerund. The bare word is taken by a different question:
			§ `within(milliseconds:)` and `Async.sleep(milliseconds:)` name a
			§ length. This names what to do between two attempts, and how long.
			§ `attempt(times 3, pausing 200)` was the alternative, with the unit
			§ left to the `@param`. It says nothing at the call about what the
			§ 200 is counted in.

			§§ Answers the same, waiting the given number of milliseconds between two attempts.
			§§
			§§ The wait is between attempts, and never before the first or after the last.
			§§
			§§ @param times — how many attempts to make in all
			§§ @param pausingMilliseconds — how long to wait between two attempts
			§§ @returns — a Future answering the first value, or the last reason.
			(
				times count: Integer,
				pausingMilliseconds pause: Integer,
			) -> Future<Result<Value, Failure>> {
				constant work     = @
				constant answered = complete work

				if count::isLessThanOrEqualTo(1) {
					<- answered
				} else {
					<- match answered -> Result<Value, Failure> {
						case #Value { <- answered }
						case #Failure {
							complete Async.sleep(milliseconds pause)

							<- complete work::attempt(
								times count::subtract(1),
								pausingMilliseconds pause,
							)
						}
					}
				}
			}
		}
	}

	§§ A List of Futures.
	§§
	§§ The Namespace answers the ways a List of descriptions becomes one description: in order, at once, or a few at a time.
	namespace FutureList<infer Value> for List<Future<Value>> {
		§ Each of these is native, for two reasons. An Essence body can not
		§ `complete` inside a callback. A callback that completes is a completing
		§ body, so a `map` over one answers a List of Futures rather than a List
		§ of values. And writing the walk as recursion would slice the receiver
		§ once per item.

		§ `inSequence()` is `all(atMost 1)` by construction. The ceiling clamps
		§ to one walker, which is this walk. It keeps a name of its own because
		§ the name states the intent where the count states the mechanism. A
		§ reader writing `inSequence` says the order is what the answer means,
		§ rather than picking a number. The alternative was a `Concurrency` mode
		§ on `all`, which would have made running them at once the case that
		§ names a mode.

		§§ Answers a Future running every one of them in order, each started once the one before it has answered.
		§§
		§§ The answer holds one value per item, in the receiver's order. The empty List answers the empty List.
		§§
		§§ This is the entry for work that is not independent. A host can refuse a second request at once, and a walk can have an order that is what the answer means.
		§§
		§§ @returns — a Future answering the List of values.
		inSequence() -> Future<List<Value>>

		§§ Answers a Future starting them at once, or a few at a time, and answering their values in the receiver's order.
		§§
		§§ @returns — a Future answering the List of values.
		overload all {
			§§ Answers a Future starting every one of them at once, and answering their values in the receiver's order.
			§§
			§§ The order of the answer is the receiver's, whatever order the runs finish in. The empty List answers the empty List.
			§§
			§§ Everything runs on the Program's own thread, so what this saves is the waiting rather than the computing.
			§§
			§§ @returns — a Future answering the List of values.
			() -> Future<List<Value>>

			§§ Answers the same, with at most the given number of runs in flight at once.
			§§
			§§ A count below one runs them one at a time, and a count above the length runs them all at once.
			§§
			§§ @param atMost — how many runs to have in flight at once
			§§ @returns — a Future answering the List of values.
			(atMost count: Integer) -> Future<List<Value>>
		}
	}

	§§ A List of Futures with something in it.
	§§
	§§ The proof is what makes a first answer an answer: a race between nothing has none.
	namespace NonEmptyFutureList<infer Value> for NonEmptyList<Future<Value>> {
		§§ Answers a Future starting every one of them at once, and answering with the first value any of them answers.
		§§
		§§ Every other run is stopped as soon as one has answered. What a stopped run would have answered is never read.
		§§
		§§ @returns — a Future answering the first value.
		race() -> Future<Value>
	}

	§§ A List of Futures each answering a Result.
	§§
	§§ The Namespace answers the question a fallible race asks: the first that worked, rather than the first that finished.
	namespace ResultFutureList<infer Value, infer Failure>
		for List<Future<Result<Value, Failure>>>
	{
		§§ Answers a Future starting every one of them at once, and answering with the value of the first that answers one.
		§§
		§§ A run that fails is not an answer, and the waiting goes on. Every other run is stopped as soon as one has answered a value.
		§§
		§§ A List whose every run failed answers nothing, and so does the empty List. The name is `OptionalList::firstValue`'s, for the same question one level along.
		§§
		§§ @returns — the first value, or nothing where every run failed.
		firstValue() -> Future<Optional<Value>>
	}

	§§ One run of a Future, already in flight.
	§§
	§§ `complete` waits for it, any number of times and from anywhere. It always answers the same value, because the work runs once. Holding a Started is how a Program says "run this once, read it many times".
	namespace Started<infer Value> for Started<Value> {
		§§ Answers the same run, with its value handed to the transform.
		§§
		§§ The work is in flight already and nothing here starts it again, so the transform runs once however often the answer is completed.
		§§
		§§ @param _ — the transform the value is handed to
		§§ @returns — the run, answering what the transform answers.
		map<infer Other>(_ transform: (_: Value) -> Other) -> Started<Other>

		§§ Answers the same run, giving up on it after the given number of milliseconds.
		§§
		§§ The run is not stopped. A Started can be completed from anywhere, so a deadline one holder writes can not stop the work another is waiting for. The waiting stops and the work goes on.
		§§
		§§ A host with an event loop stays open until that work is over. Giving up on an answer is not giving up on the run, so a Program can not exit ahead of it.
		§§
		§§ The time is counted from here, because the run is in flight already.
		§§
		§§ @param milliseconds — how long to wait for it
		§§ @returns — the value, or nothing where the deadline passed first.
		within(milliseconds limit: Integer) -> Started<Optional<Value>>
	}
}

export {
	Future
	FutureList
	NonEmptyFutureList
	ResultFuture
	ResultFutureList
	Started
}
