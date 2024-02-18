implementation {

	function greaterThanTwo(_ item: Fraction) -> Boolean {
		<- item::isGreaterThan(2)
	}

	constant Tao = 710/113
	variable list: [Fraction] = []
	variable myFraction = list::append(Tao)::firstItem()

	list = list::append(1/1)
	list = list::append(contentsOf [2/1])
	
	__print(list)

	list = list::append(contentsOf [3/1, 4/1, 5/1])

	__print(list)
	__print(list::removeEvery(where greaterThanTwo))
	__print(list::removeEvery(where (_ item: Fraction) -> Boolean {
		<- item::isGreaterThan(2)
	}))

}