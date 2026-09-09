import {
	from "./Boolean.es" { Boolean }
	from "./Optional.es" { Optional }
	from "./Protocols.es" {
		Equatable
		Printable
	}
}

declarations {

	§ Result is what a Method that can fail answers when the failure carries a
	§ reason. An Optional says that there is nothing. A Result says why.
	§ Otherwise the two are one shape, so every Method Optional offers over its
	§ payload is offered here over the value. The names and the Argument labels
	§ are the same.
	§
	§ The Cases are `#Value` and `#Failure`. Their payload members are `item`
	§ and `reason`, and `#Value { item }` is Optional's Case spelled again. The
	§ alternative was an `Either` of `#Left` and `#Right`, which names neither
	§ half and leaves a reader to remember which side failed.

	§§ A value that is there or a reason it is not: `#Value` holds an item, and `#Failure` holds a reason.
	§§
	§§ Every Method that can fail with something to say answers one of these. The Choice nests, so a `Result` holding a `Result` is two levels.
	choice Result<ValueType, FailureType> {
		Value { item: ValueType },
		Failure { reason: FailureType },
	}

	§ `Equatable` is written here rather than derived, for the reason
	§ `Optional`'s is. Its `is` takes a bare value as well as another Result,
	§ and no derivation offers that. A Namespace that writes its own `is`
	§ replaces the derived conformance, so the whole-Result entry is spelled
	§ out too. The `Printable` conformance is written because both Cases carry
	§ a payload, and only a Choice of Cases that carry none derives a
	§ `toString`.
	namespace Result<infer ValueType, infer FailureType>
		for Result<ValueType, FailureType>
		is Equatable where ValueType is Equatable, FailureType is Equatable,
		is Printable where ValueType is Printable, FailureType is Printable
	{
		§ `is` reads at either level, as `Optional::is` does. Against another
		§ Result it compares Case and payload. Against a bare value it asks
		§ whether the Result holds that value, so a failed Result is never it.
		§ The bare entry takes the value rather than the reason: one Expression
		§ then tests an answer, `parse(text)::is(3)`. Comparing reasons is
		§ `reason()::is(…)`, one call longer. Two bare entries would be
		§ ambiguous wherever the value and the reason are one Type. The
		§ whole-Result entry stands first, and the order decides a Result of
		§ Results; see DEVELOPMENT.md, Why bodies look the way they do.

		§§ Answers whether the Result is the given one, or whether it holds the given bare value.
		§§
		§§ Two Results are equal when they are the same Case and hold equal payloads. A failed Result is never equal to a bare value. A Result holding a Result reaches the first entry, so the question is about the receiver. The Method is available whenever both payloads conform to `Equatable`.
		overload is {
			§§ @param _ — the Result to compare against
			§§ @returns — `true` when both are the same Case and hold equal payloads.
			<infer ValueType is Equatable, infer FailureType is Equatable>(
				_ other: Result<ValueType, FailureType>,
			) -> Boolean {
				<- match @ -> Boolean {
					case #Value(item) {
						<- match other -> Boolean {
							case #Value(otherItem) { <- item::is(otherItem) }
							case #Failure          { <- false }
						}
					}
					case #Failure(reason) {
						<- match other -> Boolean {
							case #Value { <- false }
							case #Failure(otherReason) {
								<- reason::is(otherReason)
							}
						}
					}
				}
			}

			§§ @param _ — the bare value to compare against
			§§ @returns — `true` when the Result holds a value equal to it; `false` when it failed.
			<infer ValueType is Equatable>(_ other: ValueType) -> Boolean {
				<- match @ -> Boolean {
					case #Value(item) { <- item::is(other) }
					case #Failure     { <- false }
				}
			}
		}

		§ A written Method replaces a Protocol's provided one. This one is
		§ written for the reason `Optional::isNot` is: the entry taking a bare
		§ value has no counterpart a Method over `Self` can offer.

		§§ Answers whether the Result differs from the given one, or whether it does not hold the given bare value.
		§§
		§§ A failed Result holds no bare value, so it always differs from one. The Method is available whenever both payloads conform to `Equatable`.
		overload isNot {
			§§ @param _ — the Result to compare against
			§§ @returns — `true` when the two differ in Case or in payload.
			<infer ValueType is Equatable, infer FailureType is Equatable>(
				_ other: Result<ValueType, FailureType>,
			) -> Boolean {
				<- @::is(other)::negate()
			}

			§§ @param _ — the bare value to compare against
			§§ @returns — `true` when the Result failed or holds a different value.
			<infer ValueType is Equatable>(_ other: ValueType) -> Boolean {
				<- @::is(other)::negate()
			}
		}

		§ Native, and the one Method here that is. The reason is
		§ `Optional::toString`'s: an Essence body renders a payload through a
		§ hole, and a hole renders a String bare. A String payload would lose
		§ its quotes.

		§§ Answers the Result as a String, written `Value(…)` or `Failure(…)`.
		§§
		§§ Each payload renders through its own `toString`, and a String payload is quoted: `#Failure("gone")` answers `Failure("gone")`. A String prints bare on its own and quoted inside a structure. The Method is available whenever both payloads conform to `Printable`.
		§§
		§§ @returns — the text `Value(…)` or `Failure(…)` around the payload.
		toString<infer ValueType is Printable, infer FailureType is Printable>()
			-> String

		§ The two questions a Program asks before it takes a Result apart. The
		§ quantified entry of `hasValue` stands beside the bare one as
		§ `List::hasItems(where:)` stands beside `hasItems()`. The alternative
		§ was `keep(where check, failingWith …)::hasValue()`, which needs a
		§ reason the caller has no use for.

		§§ Answers whether the Result holds a value, or holds a value the check accepts.
		§§
		§§ @returns — `true` when there is a value, or when the check accepts the value.
		overload hasValue {
			§§ Answers whether the Result holds a value.
			§§
			§§ @returns — `true` when there is a value.
			() -> Boolean {
				<- match @ -> Boolean {
					case #Value   { <- true }
					case #Failure { <- false }
				}
			}

			§§ Answers whether the Result holds a value the check accepts.
			§§
			§§ A failed Result answers `false`, and the check does not run.
			§§
			§§ @param where — the question asked of the value
			§§ @returns — `true` when there is a value and the check accepts it.
			(where check: (_: ValueType) -> Boolean) -> Boolean {
				<- match @ -> Boolean {
					case #Value(item) { <- check(item) }
					case #Failure     { <- false }
				}
			}
		}

		§§ Answers whether the Result failed, the opposite of `hasValue`.
		§§
		§§ @returns — `true` when there is a reason and no value.
		hasFailed() -> Boolean {
			<- @::hasValue()::negate()
		}

		§ The two halves as Optionals, and the fallback beside them. Each
		§ answers the payload of one Case and nothing for the other. That is
		§ what makes a Result readable by everything an Optional reaches. The
		§ `value()` and `value(defaultingTo:)` entries are one Overload family,
		§ for the reason every `defaultingTo:` entry stands beside the Method
		§ it collapses.

		§§ Answers the value, held in an Optional, or the given fallback in its place.
		§§
		§§ The `defaultingTo:` entry answers the given value in place of the failure, and answers a bare value rather than an Optional.
		§§
		§§ @returns — the value the Result holds.
		overload value {
			§§ Answers the value, held in an Optional.
			§§
			§§ A failed Result answers an empty Optional, and the reason is dropped. `reason()` is the same reading of the other Case.
			§§
			§§ @returns — the value in an Optional, or an empty Optional.
			() -> Optional<ValueType> {
				<- match @ -> Optional<ValueType> {
					case #Value(item) { <- #Value(item) }
					case #Failure     { <- #Empty }
				}
			}

			§§ Answers the value, or the given fallback where the Result failed.
			§§
			§§ The call collapses a Result back to a bare value: `parse(text)::value(defaultingTo 0)`.
			§§
			§§ @param defaultingTo — the value to answer with where the Result failed
			§§ @returns — the value, or the fallback in its place.
			(defaultingTo fallback: ValueType) -> ValueType {
				<- match @ -> ValueType {
					case #Value(item) { <- item }
					case #Failure     { <- fallback }
				}
			}
		}

		§§ Answers the reason the Result failed, held in an Optional.
		§§
		§§ A Result holding a value answers an empty Optional. Where a List of reasons is wanted, `ResultList::reasons()` answers it.
		§§
		§§ @returns — the reason in an Optional, or an empty Optional.
		reason() -> Optional<FailureType> {
			<- match @ -> Optional<FailureType> {
				case #Value           { <- #Empty }
				case #Failure(reason) { <- #Value(reason) }
			}
		}

		§§ Answers the value transformed, wrapped in a Result.
		§§
		§§ A failed Result answers the same failure, and the transform does not run. The reason is carried through unchanged.
		§§
		§§ @param _ — the transform to run on the value
		§§ @returns — the transformed value in a Result, or the failure unchanged.
		map<infer Other>(
			_ transform: (_: ValueType) -> Other,
		) -> Result<Other, FailureType> {
			<- match @ -> Result<Other, FailureType> {
				case #Value(item)     { <- #Value(transform(item)) }
				case #Failure(reason) { <- #Failure(reason) }
			}
		}

		§§ Answers with the Result the step answers for the value.
		§§
		§§ The two Results do not nest: the answer has one level. A failed Result answers the same failure, and the step does not run. The step fails with the receiver's own failure Type.
		§§
		§§ @param _ — the step to run on the value
		§§ @returns — the Result the step answers, or the failure unchanged.
		andThen<infer Other>(
			_ step: (_: ValueType) -> Result<Other, FailureType>,
		) -> Result<Other, FailureType> {
			<- match @ -> Result<Other, FailureType> {
				case #Value(item)     { <- step(item) }
				case #Failure(reason) { <- #Failure(reason) }
			}
		}

		§ The name is `mapFailure` and not `mapError`, because the Case is
		§ `#Failure` and Essence has no errors to name. Rust spells it
		§ `map_err` and Elm `mapError`; both name a thing this language does
		§ not have.

		§§ Answers the reason transformed, wrapped in a Result.
		§§
		§§ A Result holding a value answers the same value, and the transform does not run. This is `map` over the other Case.
		§§
		§§ @param _ — the transform to run on the reason
		§§ @returns — the transformed reason in a Result, or the value unchanged.
		mapFailure<infer Other>(
			_ transform: (_: FailureType) -> Other,
		) -> Result<ValueType, Other> {
			<- match @ -> Result<ValueType, Other> {
				case #Value(item)     { <- #Value(item) }
				case #Failure(reason) { <- #Failure(transform(reason)) }
			}
		}

		§ Recovering reads the reason and answers a value, which is what a
		§ caller holding a failure it can repair wants. The alternative was a
		§ lazy `value(computedBy:)`, which hides the reason from the body that
		§ has to stand in for it.

		§§ Answers the value, or what the given transform makes of the reason.
		§§
		§§ A Result holding a value answers it, and the transform does not run. The answer is a bare value, so the failure is gone.
		§§
		§§ @param with — the transform that answers a value for a reason
		§§ @returns — the value, or the transformed reason in its place.
		recover(with transform: (_: FailureType) -> ValueType) -> ValueType {
			<- match @ -> ValueType {
				case #Value(item)     { <- item }
				case #Failure(reason) { <- transform(reason) }
			}
		}

		§ `keep` is the name `Optional` gives its filter. It is the deliberate
		§ exception to the `everyItem(where:)` family, because a carrier of at
		§ most one value has no room for a quantifier. The second Argument is
		§ what a Result needs and an Optional does not: refusing a value here
		§ has to say why.

		§§ Answers the Result when its value passes the check, and the given failure otherwise.
		§§
		§§ A failed Result answers the same failure, and the check does not run. This is `Optional::keep(where:)` with a reason for the values it drops. The reason is read whether or not the check refuses.
		§§
		§§ @param where — the question asked of the value
		§§ @param failingWith — the reason to fail with where the value does not pass
		§§ @returns — the Result unchanged when the value passes, and a failure otherwise.
		keep(
			where check: (_: ValueType) -> Boolean,
			failingWith reason: FailureType,
		) -> Result<ValueType, FailureType> {
			<- match @ -> Result<ValueType, FailureType> {
				case #Value(item) {
					if check(item) {
						<- #Value(item)
					} else {
						<- #Failure(reason)
					}
				}
				case #Failure(failure) { <- #Failure(failure) }
			}
		}

		§§ Answers the Result when it holds a value, and the given Result otherwise.
		§§
		§§ A chain of calls reads as a list of fallbacks, and the first value in it decides the answer. The reason of a receiver that failed is dropped. The Argument is read whether or not the receiver failed.
		§§
		§§ @example
		§§   constant failed: Result<Integer, String> = #Failure("gone")
		§§
		§§   expect failed::or(#Value(2))::is(2)
		§§
		§§ @param _ — the Result to fall back on
		§§ @returns — the receiver when it holds a value, and the Argument in its place otherwise.
		or(
			_ other: Result<ValueType, FailureType>,
		) -> Result<ValueType, FailureType> {
			<- match @ -> Result<ValueType, FailureType> {
				case #Value(item) { <- #Value(item) }
				case #Failure     { <- other }
			}
		}

		§ A List literal is a language primitive, so the body names no
		§ Namespace. Naming `List` would close a cycle, since `List.es`
		§ imports this file. See DEVELOPMENT.md, The shape of the graph is
		§ frozen.

		§§ Answers a List holding the value, and the empty List where the Result failed.
		§§
		§§ The answer holds one item at most, and the reason is dropped. It is the bridge to the Methods a List answers, and `ResultList::values()` is the bridge back.
		§§
		§§ @returns — the List of the value, or the empty List.
		toList() -> List<ValueType> {
			<- match @ -> List<ValueType> {
				case #Value(item) { <- [item] }
				case #Failure     { <- [] }
			}
		}
	}

	§ `flatten` needs a receiver that not every Result is, so it lives in a
	§ Namespace that states one, as `NestedOptional::flatten` does. Both
	§ levels fail with one Type, because a `Result<Result<V, F>, G>` has two
	§ reasons to carry and one Case to carry them in.
	namespace NestedResult<infer ValueType, infer FailureType>
		for Result<Result<ValueType, FailureType>, FailureType>
	{
		§§ Answers the inner Result, one level down.
		§§
		§§ A failed outer Result answers that failure. Where the two levels fail with different Types, the answer fails with both of them joined into one Type.
		§§
		§§ @returns — the flattened Result.
		flatten() -> Result<ValueType, FailureType> {
			<- match @ -> Result<ValueType, FailureType> {
				case #Value(inner)    { <- inner }
				case #Failure(reason) { <- #Failure(reason) }
			}
		}
	}
}

export {
	NestedResult
	Result
}
