import {
	from "./Protocols.es" {
		Equatable
		Printable
	}
}

declarations {

	§§ How one value stands against another: below it, equal to it, or above it.
	§§
	§§ `compare` answers one of the three Cases. They are written `Ordering#Less`, `Ordering#Equal` and `Ordering#Greater`, and matched as `case #Less`. A match over them is checked for exhaustiveness like any other Choice.
	choice Ordering {
		Less,
		Equal,
		Greater,
	}

	§ `Equatable` and `Printable` are both derived for a Choice of Cases that
	§ carry no payload. This Namespace declares the two and writes neither; see
	§ DEVELOPMENT.md, Why bodies look the way they do.
	§
	§ `then` is the whole of what a Namespace over this Choice has to add. A
	§ List of orderings searched for the first decisive one says the same
	§ thing, and computes every tie-breaker whether it is reached or not. The
	§ `computedBy` entry is what leaves the later keys uncomputed. There is no
	§ `reverse`: `sort(in #Descending)` and exchanging the two operands of a
	§ `compare` each say it where it belongs.
	namespace Ordering for Ordering is Equatable, is Printable {
		§§ Answers the ordering, or a second one where the first decides nothing.
		§§
		§§ Chaining the calls is how a sort orders on a second key, and then on a third. Each ordering after the first decides only what the ones before it left equal.
		§§
		§§ @example
		§§   constant people = [
		§§     { last = "Ott", first = "Zoe" },
		§§     { last = "Ali", first = "Bo" },
		§§     { last = "Ott", first = "Al" },
		§§   ]
		§§
		§§   constant ranked = people::sort(by (a, b) {
		§§     <- a.last::compare(to b.last)::then(a.first::compare(to b.first))
		§§   })
		§§
		§§   expect ranked::map((person) { <- person.first })::join(with ", ")::is("Bo, Al, Zoe")
		overload then {
			§§ The next ordering is computed before the call, whether or not it is reached.
			§§
			§§ @example
			§§   expect Ordering#Less::then(#Greater)::is(#Less)
			§§   expect Ordering#Equal::then(#Greater)::is(#Greater)
			§§
			§§ @param _ — the ordering to answer when this one is `Ordering#Equal`
			§§ @returns — the ordering itself, or the given one in its place.
			(_ next: Ordering) -> Ordering {
				<- match @ -> Ordering {
					case #Less    { <- #Less }
					case #Equal   { <- next }
					case #Greater { <- #Greater }
				}
			}

			§§ The Function runs only where the first ordering is `Ordering#Equal`.
			§§
			§§ @example
			§§   expect Ordering#Less::then(computedBy () -> Ordering { <- #Greater })::is(#Less)
			§§
			§§ @param computedBy — answers the ordering to use when this one is `Ordering#Equal`
			§§ @returns — the ordering itself, or the one the Function answers.
			(computedBy next: () -> Ordering) -> Ordering {
				<- match @ -> Ordering {
					case #Less    { <- #Less }
					case #Equal   { <- next() }
					case #Greater { <- #Greater }
				}
			}
		}
	}
}

export {
	Ordering
}
