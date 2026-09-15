implementation {

	§ A Future is a DESCRIPTION of work that will answer with a value. Building
	§ one runs nothing at all — `Async.deferred` is the way to write a
	§ computation down as work rather than carry it out — so the line below
	§ prints before any of what it describes has happened.
	constant counting = Async.deferred(() {
		Terminal.print("counted")

		<- 3
	})

	Terminal.print("described") § described

	§ `complete` waits for what a Future answers with. Each `complete` of a
	§ FUTURE is a fresh run, which is what makes a description worth having: it
	§ can be run again.
	Terminal.print(complete counting) § counted, then 3
	Terminal.print(complete counting) § counted, then 3

	§ `start` puts a Future in flight and answers the one run of it. Everything
	§ here is on the one thread, so a future with nothing to wait for inside
	§ runs to its end the moment it is started — which is why "counted" is
	§ printed before the line below it.
	constant running = start counting

	Terminal.print("started") § counted, then started

	§ A Started can be completed any number of times, from anywhere, and always
	§ answers the same value: the work ran once.
	Terminal.print(complete running) § 3
	Terminal.print(complete running) § 3

	§ A body that writes `complete` is a COMPLETING body. It declares
	§ `-> Future<T>`, its `<-` answers with the inner `T`, and calling it is an
	§ ordinary call that builds a future and runs none of it.
	function doubled(_ value: Integer) -> Future<Integer> {
		constant held = complete Async.deferred(() { <- value })

		<- held::add(held)
	}

	Terminal.print(complete doubled(21)) § 42

	§ A Method is a completing body under the same rule, and a `complete`
	§ written inside a Match Handler belongs to the body holding the Match.
	namespace Reading for Optional<Integer> {
		orZero() -> Future<Integer> {
			<- match @ -> Integer {
				case #Value(item) { <- complete Async.deferred(() { <- item }) }

				case #Empty       { <- 0 }
			}
		}
	}

	constant found: Optional<Integer>   = #Value(7)
	constant missing: Optional<Integer> = #Empty

	Terminal.print(complete found::orZero()) § 7
	Terminal.print(complete missing::orZero()) § 0

	§ A Function literal is a completing body of its own, so a `complete`
	§ written in one belongs to the literal rather than to whatever holds it —
	§ and the literal's Type is the future it answers with.
	constant answers = [1, 2, 3]::map((value) -> Future<Integer> {
		<- complete Async.deferred(() { <- value::multiply(with 10) })
	})

	Terminal.print(complete answers::firstItem()) § 10

	§ A sync closure written inside a completing body is NOT one: it completes
	§ nothing. It still reaches what the body around it can, so the work it
	§ starts belongs to the run that built it.
	function counted() -> Future<Integer> {
		constant runs = [1, 2]::map((value) {
			<- start Async.deferred(() { <- value })
		})

		<- complete Async.deferred(() { <- runs::length() })
	}

	Terminal.print(complete counted()) § 2
}
