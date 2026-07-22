implementation {

	§ Essence has no loop Statement — repetition is a List pipeline. `List.of`
	§ and `List.repeating` build the sequence a loop would count over, and the
	§ transforming Methods do what a loop body would.
	constant numbers = List.of(integersFrom 1, through 5)

	__print(numbers)                       § [ 1, 2, 3, 4, 5 ]

	§ Visiting every item is a map.
	__print(numbers::map((item) { <- item::multiplyWith(item) }))  § [ 1, 4, 9, 16, 25 ]

	§ Accumulating across items is a reduce.
	__print(numbers::reduce(startingWith 0, (sum, item) {
		<- sum::add(item)
	}))                                    § 15

	§ Skipping items is keepEvery, and pairedWith carries the index a
	§ counting loop would otherwise track.
	__print(numbers::keepEvery(where (item) { <- item::isEven() }))  § [ 2, 4 ]
	__print(["a", "b"]::pairedWith(List.of(integersFrom 0, through 1)))

	§ Whether a dedicated loop Statement (`for item of list { … }`) ever
	§ joins the language is an open design question — these pipelines are
	§ the idiom today.

}
