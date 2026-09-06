import {
	from "./Boolean.es" { Boolean }
	from "./Protocols.es" {
		Equatable
		Printable
	}
}

declarations {

	§ Optional is what every Method that can come back empty answers. It is a
	§ nominal Choice, not a Union holding a `Nothing` Type. A Choice nests, so
	§ `#Value(#Empty)` is not `#Empty` and a `List<Optional<Integer>>` can say
	§ whether `firstItem()` found an empty Optional or found nothing. A Choice
	§ conforms: `Optional<ItemType>` is one Type with a Namespace, and it
	§ conforms exactly when its payload does. An `Integer | Nothing` belongs to
	§ no Namespace at all. A Choice has one spelling, because `Nothing` does
	§ not exist. The cost is that widening is gone: a Method answering
	§ `Optional<Integer>` writes `<- #Value(0)`, not `<- 0`.
	choice Optional<ItemType> {
		Value { item: ItemType },
		Empty,
	}

	§ The payload member is `item`, not `value`, because `Value { value: … }`
	§ doubles the word at every site that writes it. The Method that reads the
	§ payload out is still `value`, which doubles nothing.
	§
	§ `Equatable` is written here rather than derived, because `is` takes a
	§ bare item as well as another Optional, and no derivation offers that. A
	§ Namespace that writes its own `is` replaces the derived conformance, so
	§ the whole-Optional entry is spelled out too. The `Printable` conformance
	§ is written here because `#Value` carries a payload, and only a Choice of
	§ Cases that carry none derives a `toString`.
	namespace Optional<infer ItemType> for Optional<ItemType>
		is Equatable where ItemType is Equatable,
		is Printable where ItemType is Printable {
		§ `is` reads at either level. Against another Optional it compares Case
		§ and payload. Against a bare item it asks whether the Optional holds
		§ that item: `#Value(x)::is(y)` is `x::is(y)`, and `#Empty::is(y)` is
		§ false. One Expression then tests a lookup,
		§ `codes::item(at index)::is(code)`. The alternative was collapsing
		§ through a default the item can genuinely equal. The whole-Optional
		§ entry stands first, and the order decides `#Empty::is(#Empty)`; see
		§ DEVELOPMENT.md, Why bodies look the way they do.

		§§ Answers whether the Optional is the given one, or whether it holds the given bare value.
		§§
		§§ Two Optionals are equal when they are the same Case and hold equal values. An empty Optional is never equal to a bare value. The Method is available whenever the payload conforms to `Equatable`.
		overload is {
			§§ @param _ — the Optional to compare against
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

			§§ @param _ — the bare value to compare against
			§§ @returns — `true` when the Optional holds a value equal to it; `false` when it is empty.
			<infer ItemType is Equatable>(_ other: ItemType) -> Boolean {
				<- match @ -> Boolean {
					case #Value(item) { <- item::is(other) }
					case #Empty       { <- false }
				}
			}
		}

		§ A Protocol provides a body every conformer answers with, and a written
		§ Method replaces a provided one whole. Optional's takes a bare item as
		§ well as another Optional, and a provided Method over `Self` can not
		§ offer that entry. The same holds of `Integer` and `Rational`, each
		§ over the other numeric kind.
		§§ Answers whether the Optional differs from the given one, or whether it does not hold the given bare value.
		§§
		§§ An empty Optional holds no bare value, so it always differs from one. The Method is available whenever the payload conforms to `Equatable`.
		overload isNot {
			§§ @param _ — the Optional to compare against
			§§ @returns — `true` when the two differ in Case or in value.
			<infer ItemType is Equatable>(
				_ other: Optional<ItemType>,
			) -> Boolean {
				<- @::is(other)::negate()
			}

			§§ @param _ — the bare value to compare against
			§§ @returns — `true` when the Optional is empty or holds a different value.
			<infer ItemType is Equatable>(_ other: ItemType) -> Boolean {
				<- @::is(other)::negate()
			}
		}

		§ Native, and the one Method here that is. An Essence body renders the
		§ payload through a hole, and a hole renders a String bare, so the body
		§ could not quote a String payload. A helper it could reach instead
		§ would have to be a Method of the language, which costs more than the
		§ native does.

		§§ Answers the Optional as a String, written `Value(…)` or `Empty`.
		§§
		§§ The payload renders through its own `toString`, and a String payload is quoted: `#Value("a")` answers `Value("a")`. A String prints bare on its own and quoted inside a structure. The Method is available whenever the payload conforms to `Printable`.
		§§
		§§ @returns — the text `Value(…)` around the payload, or `Empty`.
		toString<infer ItemType is Printable>() -> String

		§ These two let a Program ask, rather than only collapse. The
		§ alternative is to match the Optional apart at the use site, or to
		§ pick a fallback that can not occur and compare against it. That
		§ fallback is wrong whenever the payload can equal it.

		§§ Answers whether the Optional holds a value.
		§§
		§§ @returns — `true` when there is a value.
		hasValue() -> Boolean {
			<- match @ -> Boolean {
				case #Value { <- true }
				case #Empty { <- false }
			}
		}

		§§ Answers whether the Optional holds no value, the opposite of `hasValue`.
		§§
		§§ @returns — `true` when there is no value.
		isEmpty() -> Boolean {
			<- @::hasValue()::negate()
		}

		§§ Answers the value, or the given fallback when there is none.
		§§
		§§ The call collapses an Optional back to a bare value: `list::firstItem()::value(defaultingTo 0)`.
		§§
		§§ @param defaultingTo — the value to answer with when there is none
		§§ @returns — the value, or the fallback in its place.
		value(defaultingTo fallback: ItemType) -> ItemType {
			<- match @ -> ItemType {
				case #Value(item) { <- item }
				case #Empty       { <- fallback }
			}
		}

		§§ Answers the value transformed, wrapped in an Optional.
		§§
		§§ An empty Optional answers empty, and the transform does not run. This is `List::map` for the at-most-one case.
		§§
		§§ @param _ — the transform to run on the value
		§§ @returns — the transformed value in an Optional, or an empty Optional.
		map<infer ResultType>(
			_ transform: (_: ItemType) -> ResultType,
		) -> Optional<ResultType> {
			<- match @ -> Optional<ResultType> {
				case #Value(item) { <- #Value(transform(item)) }
				case #Empty       { <- #Empty }
			}
		}

		§§ Answers with the Optional the step answers for the value.
		§§
		§§ The two Optionals do not nest: the answer has one level. An empty Optional answers empty, and the step does not run.
		§§
		§§ @param _ — the step to run on the value
		§§ @returns — the Optional the step answers, or an empty Optional.
		andThen<infer ResultType>(
			_ step: (_: ItemType) -> Optional<ResultType>,
		) -> Optional<ResultType> {
			<- match @ -> Optional<ResultType> {
				case #Value(item) { <- step(item) }
				case #Empty       { <- #Empty }
			}
		}

		§§ Answers the Optional when its value passes the check, and empty otherwise.
		§§
		§§ An empty Optional answers empty, and the check does not run. This is `List::everyItem(where:)` for the at-most-one case.
		§§
		§§ @param where — the question asked of the value
		§§ @returns — the Optional unchanged when the value passes, an empty Optional otherwise.
		keep(where check: (_: ItemType) -> Boolean) -> Optional<ItemType> {
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

	§ `flatten` needs a receiver that not every Optional is, so it lives in a
	§ Namespace that states one, as `NestedList::flatten` does. Here `ItemType`
	§ binds to the inner payload, which makes the answer an `Optional<Integer>`
	§ rather than the `Optional<Optional<Integer>>` it started as. The
	§ `andThen` Method needs no such Namespace: a step that answers an Optional
	§ never builds a nested one. There is no `orElse`, because an Optional
	§ whose payload is an Optional makes "or else what" ambiguous, and
	§ `value(defaultingTo:)` answers the unambiguous half.
	namespace NestedOptional<infer ItemType> for Optional<Optional<ItemType>> {
		§§ Answers the inner Optional, one level down.
		§§
		§§ An empty outer Optional answers empty.
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
