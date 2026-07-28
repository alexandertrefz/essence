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

	§ The Namespace every Optional reaches. `otherwise` collapses it back to a
	§ bare value, `hasValue`/`isEmpty` ask without taking it apart, and `map`
	§ and `keep` carry a value through a step that does not know it might be
	§ missing. Matching is always available and always exhaustive — these are
	§ the shorthands for the shapes worth a name.
	§
	§ The payload member is `item`, not `value`: `Value { value: … }` doubles
	§ the word everywhere it is written, and `item` is what `List` already
	§ calls the thing it holds.
	§
	§ `Equatable` is not declared here and is not missing: a Choice derives
	§ equality from its tags and its payloads, so `#Value(1)::is(#Value(1))` is
	§ answered without a line of Essence, conditionally on the payload's own
	§ `is`. `Printable` can not be derived that way — what an Optional should
	§ READ as is a decision — so it is written, and conditional for the same
	§ reason `List`'s is.
	namespace Optional<infer ItemType> for Optional<ItemType>
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

		§§ The value itself — or, when there is none, the given fallback. Collapses an Optional back to a bare value: `list::firstItem()::otherwise(0)`.
		§§
		§§ @param fallback — the value to fall back to
		§§ @returns — the value, or the fallback in its place.
		otherwise(_ fallback: ItemType) -> ItemType {
			<- match @ -> ItemType {
				case #Value(item) { <- item }
				case #Empty       { <- fallback }
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
	§ and `otherwise` already answers the unambiguous half.
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
