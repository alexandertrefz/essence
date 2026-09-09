implementation {

	§ Essence has no loop Statement — a loop is a value-driven walk instead. The
	§ `loop` family threads a State from one turn to the next, and where a `step`
	§ callback answers with a `Step`, `#Continue` carries the State on while
	§ `#Done` stops with a Result. Early exit is an ordinary value, so a Match
	§ sees it and `<-` keeps its one meaning.

	§ The counted loop — once per Integer from `from` through `through`,
	§ threading a running total. The body is positional, because it runs the
	§ walk to its end.
	constant sum = loop(from 1, through 10, startingWith 0, (index, total) {
		<- total::add(index)
	})

	Terminal.print(sum) § 55

	§ The direction is the label. `through` counts up and answers the seed
	§ where the end is behind the start, and `downTo` counts down.
	constant digits = loop(
		from 3,
		downTo 1,
		startingWith "",
		(index, gathered) { <- gathered::append(index::toString()) },
	)

	Terminal.print(digits) § 321

	§ The general loop — a Record State threaded with `{ state with … }`,
	§ stopping on the first `#Done`, which finishes with the running total. The
	§ payload is written with the single-value `#Done(…)` shorthand.
	§
	§ The step takes its State apart into the two fields it reads and names the
	§ whole of it with `as` besides, which is what keeps `{ state with … }`
	§ writable — the two halves of the body each read the way they want to.
	constant limit = 5

	constant result = loop(
		startingWith { index = 1, total = 0 },
		step ({ index, total } as state) {
			if index::isGreaterThan(limit) {
				<- #Done(total)
			}

			<- #Continue({
				state with
					index = index::add(1),
					total = total::add(index),
			})
		},
	)

	Terminal.print(result) § 15

	§ The condition-driven loops — `while` steps while its predicate holds,
	§ `until` steps until its predicate holds. Both check BEFORE each step, so a
	§ predicate already decided returns the seed untouched.
	constant doubledWhile = loop(
		startingWith 1,
		while (n) { <- n::isLessThan(100) },
		(n) { <- n::multiply(with 2) },
	)

	Terminal.print(doubledWhile) § 128

	constant doubledUntil = loop(
		startingWith 1,
		until (n) { <- n::isGreaterThanOrEqualTo(100) },
		(n) { <- n::multiply(with 2) },
	)

	Terminal.print(doubledUntil) § 128

	§ The counted loop that can leave early — the same labels as the first one
	§ with a `step` body, which answers a `Step` rather than the next State. The
	§ count ending answers what the last step carried, and a `#Done` answers
	§ before the count runs out.
	constant firstOver = loop(
		from 1,
		through 100,
		startingWith 0,
		step (index, total) {
			constant next = total::add(index)

			if next::isGreaterThan(10) {
				<- #Done(next)
			}

			<- #Continue(next)
		},
	)

	Terminal.print(firstOver) § 15

	§ The early-stopping fold — `reduce`'s `step` sibling leaves the walk on the
	§ first `#Done`, where the plain fold always runs to the end. Here the
	§ accumulator counts the items seen and stops itself at two.
	constant firstTwo = [10, 20, 30, 40]
		::reduce(startingWith 0, step (count, item) {
			constant next = count::add(1)

			if next::isGreaterThanOrEqualTo(2) {
				<- #Done(next)
			}

			<- #Continue(next)
		})

	Terminal.print(firstTwo) § 2
}
