implementation {

	§ A generic Choice abstracts over the Types its Cases carry, exactly like
	§ an Alias or a Namespace can. `Progress` is the early-exit value: a driver keeps
	§ going while the callback answers `#Going`, and stops with the `#Stopped`
	§ payload — so the control flow is an ordinary value the Match sees.
	choice Progress<State, Result> {
		Going { state: State },
		Stopped { value: Result },
	}

	§ The general loop driver, written in Essence — no native needed. `State`
	§ binds from `startingWith`, then the callback's Parameter and its `#Stopped`
	§ payload bind `Result`. The recursion is the loop.
	namespace Loop {
		static run<infer State, infer Result>(
			startingWith state: State,
			step advance: (_ state: State) -> Progress<State, Result>,
		) -> Result {
			<- match advance(state) -> Result {
				case #Going(next)   {
					<- Loop.run(startingWith next, step advance)
				}
				case #Stopped(done) { <- done }
			}
		}
	}

	§ Prefixed construction with an explicit payload Record.
	constant startState: Progress<{
		index: Integer,
		total: Integer,
	}, Integer> = Progress#Going({ state = { index = 1, total = 0 } })

	§ Match narrows an instantiated Case to its concrete member Types, and a
	§ Pattern in the Matcher's binder takes the payload the constructor took
	§ apart — `#Going` carries one member, so `{ total }` fits only the
	§ shorthand reading and binds straight out of the State Record, as an
	§ Integer.
	Terminal.inspect(match startState -> Integer {
		case #Going({ total }) { <- total }
		case #Stopped(total)   { <- total }
	}) § 0

	§ The driver, threading a Record State through `{ state with … }` and
	§ stopping with the one-member `#Stopped` shorthand — `#Stopped(total)`
	§ instead of `#Stopped({ value = total })`. The step names the State's
	§ fields and, with `as`, the State itself.
	constant summed: Integer = Loop.run(startingWith {
		index = 1,
		total = 0,
	}, step ({ index, total } as state) {
		if index::isGreaterThan(5) {
			<- #Stopped(total)
		}

		<- #Going({ state with index = index::add(1),
		total = total::add(index) })
	})

	Terminal.inspect(summed::toString()) § "15"

	§ A bare `#Stopped` resolves against the annotation; the shorthand wraps the
	§ lone Integer into the Case's one-member Record.
	constant answer: Progress<Integer, Integer> = #Stopped(42)

	Terminal.inspect(match answer -> Integer {
		case #Going(state)  { <- state }
		case #Stopped(done) { <- done }
	}) § 42

	§ A generic Choice with a unit Case still constructs and matches.
	choice Box<Value> {
		Full { value: Value },
		Empty,
	}

	constant full: Box<String>  = #Full("packed")
	constant empty: Box<String> = Box#Empty

	Terminal.inspect(match full -> String {
		case #Full  { <- @.value }
		case #Empty { <- "nothing" }
	}) § "packed"

	Terminal.inspect(match empty -> String {
		case #Full  { <- @.value }
		case #Empty { <- "nothing" }
	}) § "nothing"
}
