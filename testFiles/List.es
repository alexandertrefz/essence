implementation {

	function greaterThanTwo(_ item: Integer | Rational) -> Boolean {
		<- match item -> Boolean {
			case Rational { <- @::isGreaterThan(2) }
			case Integer  { <- @::isGreaterThan(2) }
		}
	}

	variable list: List<Rational> = []

	list = list::append(1/1)
	list = list::append(contentsOf [2/1])

	__print(list)

	list = list::append(contentsOf [3/1, 4/1, 5/1])

	__print(list)
	__print(list::removeEvery(where (_ item: Rational) -> Boolean {
		<- item::isGreaterThan(2)
	}))

	__print(list::removeEvery(where greaterThanTwo))
	__print([0, 1, 2, 3, 4/1, 5/1]::removeEvery(where greaterThanTwo))

	§ Transforming pipelines — the callbacks are contextually typed, so the
	§ item Type is inferred and the return Type of `map` follows the body.
	constant numbers = [3, 1, 2, 1, 4]

	__print(numbers::map((n) { <- n::toString() }))            § the Strings
	__print(numbers::reduce(startingWith 0, (sum, n) {         § 11
		<- sum::add(n)
	}))
	__print(numbers::keepEvery(where (n) { <- n::isGreaterThan(1) }))  § [3, 2, 4]
	__print(numbers::firstItem(where (n) { <- n::isGreaterThan(2) }))  § 3

	§ Existential and universal checks read as sentences.
	__print(numbers::anyItem(matches (n) { <- n::isGreaterThan(3) }))   § true
	__print(numbers::everyItem(matches (n) { <- n::isGreaterThan(0) })) § true

	§ Indexing, slicing and counting — all zero-based, `slice` half-open.
	__print(numbers::itemAt(2))              § 2
	__print(numbers::itemAt(99))             § Nothing
	__print(numbers::firstIndexOf(1))        § 1
	__print(numbers::slice(from 1, to 3))    § [1, 2]
	__print(numbers::countOf(1))             § 2

	§ Membership tests.
	__print(numbers::contains(4))            § true
	__print(numbers::doesNotContain(9))      § true

	§ Structural edits, each returning a new List.
	__print(numbers::reverse())             § [4, 1, 2, 1, 3]
	__print(numbers::removeAt(2))            § [3, 1, 1, 4]
	__print(numbers::insertAt(2, with 99))   § [3, 1, 99, 2, 1, 4]
	__print(numbers::replaceAt(0, with 99))  § [99, 1, 2, 1, 4]
	__print(numbers::sortedBy((a, b) { <- a::compareTo(b) }))  § [1, 1, 2, 3, 4]

}