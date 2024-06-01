implementation {

	function greaterThanTwo(_ item: Number) -> Boolean {
		<- match item -> Boolean {
			case Fraction { <- @::isGreaterThan(2) }
			case Integer  { <- @::isGreaterThan(2) }
		}
	}

	variable list: List<Fraction> = []
	variable tao = list::append(Number.TAO)::firstItem()

	list = list::append(1/1)
	list = list::append(contentsOf [2/1])

	__print(list)

	list = list::append(contentsOf [3/1, 4/1, 5/1])

	__print(list)
	__print(list::removeEvery(where (_ item: Fraction) -> Boolean {
		<- item::isGreaterThan(2)
	}))

	__print(list::removeEvery(where greaterThanTwo))
	__print([0, 1, 2, 3, 4/1, 5/1]::removeEvery(where greaterThanTwo))

}