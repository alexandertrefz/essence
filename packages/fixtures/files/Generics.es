implementation {

	namespace FunctionalList<infer Item> for List<Item> {
		transformFirst<infer TargetType>(
			_ transform: (_ item: Item) -> TargetType,
			fallback fallbackValue: TargetType,
		) -> TargetType {
			<- @::firstItem()::map(transform)::otherwise(fallbackValue)
		}

		firstOr(fallback fallbackValue: Item) -> Item {
			<- @::firstItem()::otherwise(fallbackValue)
		}
	}

	function wrap<infer Value>(_ value: Value) -> Optional<Value> {
		<- #Value(value)
	}

	function unwrap<infer Value>(
		_ maybe: Optional<Value>,
		fallback fallbackValue: Value,
	) -> Value {
		<- maybe::otherwise(fallbackValue)
	}

	constant numbers = [1, 2, 3]

	constant firstAsString: String = numbers::transformFirst(
		(_ item: Integer) -> String { <- item::toString() },
		fallback "none",
	)

	constant wrapped: Optional<String> = wrap("hello")

	__print(firstAsString) § "1"
	__print(numbers::firstOr(fallback 0)) § 1
	__print([]::firstOr(fallback 42)) § 42
	__print(unwrap(wrapped, fallback "empty")) § "hello"
	__print(unwrap(#Empty, fallback 7)) § 7
}
