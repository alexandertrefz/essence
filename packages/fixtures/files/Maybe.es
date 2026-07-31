implementation {

	§ A Program's own Optional-shaped Choice. The standard library's `Optional`
	§ is exactly this shape, and this file is what shows nothing about it is
	§ privileged: a generic `choice`, a Namespace targeting it, Overloads
	§ dispatching by label, and a Case Matcher naming the payload it binds.
	choice Maybe<Value> {
		Some { value: Value },
		None,
	}

	namespace Maybe<infer Value> for Maybe<Value> {
		§ Overloads dispatch by their labels — `to` hands over a ready value,
		§ `computedBy` a Function that only runs when the value is absent.
		overload default {
			(to defaultValue: Value) -> Value {
				<- match @ -> Value {
					case #Some(value) { <- value }
					case #None        { <- defaultValue }
				}
			}

			(computedBy fallback: () -> Value) -> Value {
				<- match @ -> Value {
					case #Some(value) { <- value }
					case #None        { <- fallback() }
				}
			}
		}

		andThen<infer NewType>(
			_ transformer: (_: Value) -> Maybe<NewType>,
		) -> Maybe<NewType> {
			<- match @ -> Maybe<NewType> {
				case #Some(value) { <- transformer(value) }
				case #None        { <- #None }
			}
		}
	}

	§ Crossing from the standard library's `Optional` into this Choice is
	§ written out, because the two are different Types — which is the whole
	§ point of both being nominal.
	function asMaybe<infer Value>(_ optional: Optional<Value>) -> Maybe<Value> {
		<- match optional -> Maybe<Value> {
			case #Value(item) { <- #Some(item) }
			case #Empty       { <- #None }
		}
	}

	constant list = [1, 2, 3]

	constant maybeRational: Maybe<Rational> = asMaybe(
		list::firstItem(),
	)::andThen((_ item: Integer) -> Maybe<Rational> {
		<- #Some(item::multiply(with 1/5))
	})

	Terminal.inspect(maybeRational) § Maybe#Some(1/5)
	Terminal.inspect(asMaybe(list::firstItem())::default(to 0)) § 1

	constant empty: List<Integer> = []

	Terminal.inspect(asMaybe(empty::firstItem())::default(to 42)) § 42

	constant missing: Maybe<Integer> = #None

	Terminal.inspect(
		missing::andThen((_ item: Integer) -> Maybe<Rational> {
			<- #Some(item::multiply(with 1/5))
		}),
	) § Maybe#None
	Terminal.inspect(
		maybeRational::default(computedBy () -> Rational { <- 0/1 }),
	) § 1/5
}
