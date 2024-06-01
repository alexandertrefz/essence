implementation {
	
	namespace FunctionalList<infer Item> for List<Item> {
		map<infer TargetType>(
			_ mappingFunction: (_ item: Item, _ index: Integer) -> TargetType
		) -> List<TargetType> {
			variable result = []

			for item, index of @ {
				result = result::append(mappingFunction(item, index))
			}

			<- result
		}

		reduce<infer TargetType>(
			initialValue: TargetType,
			_ reducingFunction (_ accumulator: TargetType, _ item: Item, _ index: number) -> TargetType
		) -> TargetType {
			variable reducedValue = initialValue

			for item, index of @ {
				reducedValue = reducingFunction(reducedValue, item, index)
			}

			<- reducedValue
		}
	}

	constant list = [0, 1]

	list::reduce(initialValue: "", (accumulator, item, index) {
		<- accumulator::append(",")::append(item::toString())
	}) § "0,1"
	§ `accumulator` is String, due to `initialValue` being a String, which is the first occurence of `TargetType`.
	§ `item` is Integer since it's the Item Type of the List.
	§ We know the callback needs to return a String, since that is TargetType again

	list::map((item) { <- item::toString() }) § ["0", "1"]
	§ `item` is Integer since it's the Item Type of the List.
	§ The Callback returns a String, which is the first occurence of TargetType,
	§ which then informs the return type of map to be
	
}