import {
	Boolean   from "./Boolean.es"
	Equatable from "./Protocols.es"
	Printable from "./Protocols.es"
}

declarations {

	§ The global spelling of fallibility — the answer of every Method that can
	§ come back empty. It is a nominal Choice rather than a Union with
	§ `Nothing` in it, which buys three things a Union could not:
	§
	§ Nesting. `Optional<Optional<Integer>>` is a value with two levels, and
	§ `#Value(#Empty)` is not `#Empty`. A Union flattened them together, so a
	§ `List<Optional<Integer>>` could not say whether `firstItem()` had found
	§ an empty Optional or had found nothing at all.
	§
	§ Conformance. An `Integer | Nothing` belonged to no Namespace, so an
	§ Optional could not be printed, compared, or held by anything asking for a
	§ bound. `Optional<ItemType>` is one Type with a Namespace of its own, and
	§ conforms exactly when its payload does.
	§
	§ One spelling. There is no second way to write "maybe an Integer" —
	§ `Nothing` does not exist, and no Union can be Optional-shaped by accident.
	§
	§ The cost is that widening is gone: a Method answering `Optional<Integer>`
	§ writes `<- #Value(0)`, not `<- 0`. That is the price of the value saying
	§ what it is, and it is paid at every site that produces one.
	choice Optional<ItemType> {
		Value { item: ItemType },
		Empty,
	}

	§ The Namespace every Optional reaches. `value(withDefault:)` collapses it
	§ back to a bare value, `hasValue`/`isEmpty` ask without taking it apart,
	§ `is`/`isNot` ask against a value at either level, and `map` and `keep`
	§ carry a value through a step that does not know it might be missing.
	§ Matching is always available and always exhaustive — these are the
	§ shorthands for the shapes worth a name.
	§
	§ The payload member is `item`, not `value`: `Value { value: … }` doubles
	§ the word everywhere it is written, and `item` is what `List` already
	§ calls the thing it holds. The Method that reads it out is still `value`,
	§ because that is what `hasValue` already calls it, and a Method named
	§ `value` doubles nothing.
	§
	§ `Equatable` is written here rather than derived, because `is` takes two
	§ shapes: the whole (`#Value(1)::is(#Value(1))`, which is what a Choice
	§ derives on its own) and the bare item (`#Value(1)::is(1)`), which no
	§ derivation could offer. A Namespace that writes its own `is` stands in
	§ for the derived one entirely, so the whole-Optional entry is spelled out
	§ too, and FIRST — see the note on `is`. Both are conditional on the
	§ payload's own `is`, exactly as `List`'s are. `Printable` is written for
	§ the reason it always was: what an Optional should READ as is a decision.
	namespace Optional<infer ItemType> for Optional<ItemType>
		is Equatable where ItemType is Equatable,
		is Printable where ItemType is Printable {
		§§ Represents the Optional as `Value(…)` or `Empty`, the payload rendered by its own `toString`. Available whenever the payload conforms to `Printable`.
		§§
		§§ @returns — `Value(…)` around the payload, or `Empty`.
		toString<infer ItemType is Printable>() -> String {
			§ Spelled without the `#` sigil, exactly as `Ordering` prints
			§ `Less` rather than `#Less` — a rendering names the Case, it does
			§ not quote the Expression that would build it. The parentheses
			§ stay: without them `#Value("Empty")` and `#Empty` would read
			§ alike.
			<- match @ -> String {
				case #Value(item) { <- "Value({item})" }
				case #Empty       { <- "Empty" }
			}
		}

		§§ The value itself — or, when there is none, the given default. Collapses an Optional back to a bare value: `list::firstItem()::value(withDefault 0)`.
		§§
		§§ @param withDefault — the value to answer with when there is none
		§§ @returns — the value, or the default in its place.
		value(withDefault fallback: ItemType) -> ItemType {
			<- match @ -> ItemType {
				case #Value(item) { <- item }
				case #Empty       { <- fallback }
			}
		}

		§ `is` reads at either level: against another Optional it is the equality
		§ a Choice derives — same Case, equal payloads — and against a bare item
		§ it asks whether the Optional IS that item, wrapped: `#Value(x)::is(y)`
		§ is `x::is(y)`, and `#Empty::is(y)` is false for every `y`. Together they
		§ let a lookup be tested in one breath — `codes::item(at index)::is(code)`
		§ — where the only alternative was collapsing through a default the item
		§ might genuinely equal.
		§
		§ The whole-Optional entry is declared FIRST, and that order is
		§ load-bearing. An Overload is selected by the first entry the Arguments
		§ match, and for an `Optional<Optional<Integer>>` the Argument `#Empty`
		§ matches both. Whole first reads `#Empty::is(#Empty)` as "the receiver is
		§ `#Empty`" — true — and `#Value(#Empty)::is(#Empty)` as false. Item first
		§ would compare a MISSING payload against `#Empty` and answer the first of
		§ those false, which is not what `is` says. `#Value(3)::is(#Value(3))` on
		§ that receiver still lands on the item entry, because `#Value(3)` is no
		§ `Optional<Optional<Integer>>` and the whole entry can not take it.

		§§ Checks whether the Optional is the given one — the same Case, holding an equal value — or, given a bare value, whether it holds exactly that value. Available whenever the payload conforms to `Equatable`.
		overload is {
			§§ @param other — the Optional to compare against
			§§ @returns — `true` when both are empty, or both hold equal values.
			<infer ItemType is Equatable>(
				_ other: Optional<ItemType>,
			) -> Boolean {
				<- match @ -> Boolean {
					case #Value(item) {
						<- match other -> Boolean {
							case #Value(otherItem) { <- item::is(otherItem) }
							case #Empty            { <- false }
						}
					}
					case #Empty { <- other::isEmpty() }
				}
			}

			§§ @param other — the bare value to compare against
			§§ @returns — `true` when the Optional holds a value equal to it; `false` when it is empty.
			<infer ItemType is Equatable>(_ other: ItemType) -> Boolean {
				<- match @ -> Boolean {
					case #Value(item) { <- item::is(other) }
					case #Empty       { <- false }
				}
			}
		}

		§§ Checks whether the Optional differs from the given one, or, given a bare value, whether it does not hold exactly that value — which an empty Optional never does. Available whenever the payload conforms to `Equatable`.
		overload isNot {
			§§ @param other — the Optional to compare against
			§§ @returns — `true` when the two differ in Case or in value.
			<infer ItemType is Equatable>(
				_ other: Optional<ItemType>,
			) -> Boolean {
				<- @::is(other)::negate()
			}

			§§ @param other — the bare value to compare against
			§§ @returns — `true` when the Optional is empty or holds a different value.
			<infer ItemType is Equatable>(_ other: ItemType) -> Boolean {
				<- @::is(other)::negate()
			}
		}

		§ The two Methods that let a Program ASK, rather than only collapse.
		§ Without them the only way to test an Optional is to match it apart at
		§ the use site, or to pick a fallback that can not occur and compare
		§ against it — which is a lie whenever the payload can equal the
		§ fallback. They spell the `isEmpty`/`has…` pair that every other
		§ Namespace already has: `String::hasAnyContent`, `List::hasItems`.

		§§ Whether the Optional holds a value.
		§§
		§§ @returns — `true` when there is a value.
		hasValue() -> Boolean {
			<- match @ -> Boolean {
				case #Value { <- true }
				case #Empty { <- false }
			}
		}

		§§ Whether the Optional holds no value — the opposite of `hasValue`.
		§§
		§§ @returns — `true` when there is no value.
		isEmpty() -> Boolean {
			<- @::hasValue()::negate()
		}

		§§ Transforms the value, if there is one, and leaves an empty Optional empty — `List::map` for the at-most-one case.
		§§
		§§ @param transform — the step to run on the value
		§§ @returns — the transformed value in an Optional, or an empty Optional.
		map<infer ResultType>(
			_ transform: (_: ItemType) -> ResultType,
		) -> Optional<ResultType> {
			<- match @ -> Optional<ResultType> {
				case #Value(item) { <- #Value(transform(item)) }
				case #Empty       { <- #Empty }
			}
		}

		§§ Keeps the value only when it passes the check — `List::keepEvery(where:)` for the at-most-one case.
		§§
		§§ @param check — the question asked of the value
		§§ @returns — the Optional unchanged when the value passes, an empty Optional otherwise.
		keep(where check: (_: ItemType) -> Boolean) -> Optional<ItemType> {
			§ Named `keep` rather than `keepEvery`: there is no "every" here,
			§ and the plural would promise a traversal that can not happen.
			<- match @ -> Optional<ItemType> {
				case #Value(item) {
					if check(item) {
						<- #Value(item)
					} else {
						<- #Empty
					}
				}
				case #Empty { <- #Empty }
			}
		}
	}

	§ `flatten` is not available on every Optional, and every Method of
	§ `Optional` above is — so it lives in a Namespace that says what its
	§ receiver has to be, exactly as `NestedList::flatten` does. `ItemType`
	§ here binds to the INNER payload, which is what lets the result be an
	§ `Optional<Integer>` rather than the `Optional<Optional<Integer>>` it
	§ started as.
	§
	§ There is deliberately no `andThen`: it is `map` followed by `flatten`,
	§ and spelling the two separately says which step is the transform and
	§ which is the collapse. There is no `orElse` either — an Optional whose
	§ payload is itself an Optional makes "or else what" genuinely ambiguous,
	§ and `value(withDefault:)` already answers the unambiguous half.
	namespace NestedOptional<infer ItemType> for Optional<Optional<ItemType>> {
		§§ Collapses a nested Optional by one level — the inner Optional, or an empty Optional when the outer one is empty.
		§§
		§§ @returns — the flattened Optional.
		flatten() -> Optional<ItemType> {
			<- match @ -> Optional<ItemType> {
				case #Value(inner) { <- inner }
				case #Empty        { <- #Empty }
			}
		}
	}
}

export {
	NestedOptional
	Optional
}
