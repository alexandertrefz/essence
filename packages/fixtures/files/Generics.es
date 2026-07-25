implementation {

	type Maybe<Value> = Value | Nothing

	namespace FunctionalList<infer Item> for List<Item> {
		transformFirst<infer TargetType>(
			_ transform: (_ item: Item) -> TargetType,
			fallback fallbackValue: TargetType,
		) -> TargetType {
			<- match @::firstItem() -> TargetType {
				case Nothing { <- fallbackValue }
				case Item { <- transform(@) }
			}
		}

		firstOr(fallback fallbackValue: Item) -> Item {
			<- match @::firstItem() -> Item {
				case Nothing { <- fallbackValue }
				case Item { <- @ }
			}
		}
	}

	function wrap <infer Value>(_ value: Value) -> Maybe<Value> {
		<- value
	}

	function unwrap <infer Value>(_ maybe: Maybe<Value>, fallback fallbackValue: Value) -> Value {
		<- match maybe -> Value {
			case Nothing { <- fallbackValue }
			case Value { <- @ }
		}
	}

	constant numbers = [1, 2, 3]

	constant firstAsString: String = numbers::transformFirst(
		(_ item: Integer) -> String { <- item::toString() },
		fallback "none",
	)

	constant wrapped: Maybe<String> = wrap("hello")

	__print(firstAsString)                          § "1"
	__print(numbers::firstOr(fallback 0))           § 1
	__print([]::firstOr(fallback 42))               § 42
	__print(unwrap(wrapped, fallback "empty"))      § "hello"
	__print(unwrap(nothing, fallback 7))            § 7

}
