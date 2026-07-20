implementation {

	type Maybe<Value> = Value | Nothing

	namespace Maybe<infer Value> for Maybe<Value> {
		overload default {
			(to defaultValue: Value) -> Value {
				<- match @ -> Value {
					case Nothing { <- defaultValue }
					case _ { <- @ }
				}
			}

			(to defaultValue: Value, _: Boolean) -> Value {
				<- match @ -> Value {
					case Nothing { <- defaultValue }
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

	constant maybeFraction: Maybe<Fraction> = list::firstItem()::andThen((_ item: Integer) -> Fraction {
		<- item::multiplyWith(1/5)
	})

	constant integer: Integer = list::firstItem()::default(to 1)

}
