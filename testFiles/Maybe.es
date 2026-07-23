implementation {

	type Maybe<Value> = Value | Nothing

	namespace Maybe<infer Value> for Maybe<Value> {
		§ Overloads dispatch by their labels — `to` hands over a ready value,
		§ `computedBy` a Function that only runs when the value is absent.
		overload default {
			(to defaultValue: Value) -> Value {
				<- match @ -> Value {
					case Nothing { <- defaultValue }
					case _ { <- @ }
				}
			}

			(computedBy fallback: () -> Value) -> Value {
				<- match @ -> Value {
					case Nothing { <- fallback() }
					case _ { <- @ }
				}
			}
		}

		andThen<infer NewType>(_ transformer: (_: Value) -> Maybe<NewType>) -> Maybe<NewType> {
			<- match @ -> Maybe<NewType> {
				case Nothing { <- nothing }
				case _ { <- transformer(@) }
			}
		}
	}

	constant list = [1, 2, 3]

	constant maybeRational: Maybe<Rational> = list::firstItem()::andThen((_ item: Integer) -> Rational {
		<- item::multiply(with 1/5)
	})

	__print(maybeRational)                             § 1/5
	__print(list::firstItem()::default(to 0))          § 1
	constant empty: List<Integer> = []

	__print(empty::firstItem()::default(to 42))        § 42

	constant missing: Maybe<Integer> = nothing

	__print(missing::andThen((_ item: Integer) -> Rational {
		<- item::multiply(with 1/5)
	}))                                                § Nothing
	__print(maybeRational::default(computedBy () -> Rational {
		<- 0/1
	}))                                                § 1/5

}
