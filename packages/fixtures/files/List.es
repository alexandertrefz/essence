implementation {

	§ A week of morning temperatures, degrees Celsius, and the List Methods a
	§ Program reaches for every day. Every edit answers a NEW List — the day's
	§ readings never change behind a reader's back.

	§ A List is built by appending — one reading at a time, or a batch at once.
	variable readings: List<Integer> = []

	readings = readings::append(3)
	readings = readings::append(contentsOf [1, 4, 1, 5, 9, 2])

	Terminal.inspect(readings) § [ 3, 1, 4, 1, 5, 9, 2 ]

	§ The transforming walks — the callbacks are contextually typed, so the
	§ item Type is inferred and the answer's Type follows the body.
	Terminal.inspect(readings::map((degrees) { <- "{degrees}°" })) § the labels
	Terminal.inspect(
		readings::reduce(startingWith 0, (sum, degrees) { § 25
			<- sum::add(degrees)
		}),
	)
	Terminal.inspect(
		readings::keepEvery(where (degrees) { <- degrees::isGreaterThan(2) }),
	) § [ 3, 4, 5, 9 ]
	Terminal.inspect(
		readings::firstItem(where (degrees) { <- degrees::isGreaterThan(4) }),
	) § Optional#Value(5) — the first properly warm morning

	§ A named Function passes where a literal callback would go.
	function isWarm(_ degrees: Integer) -> Boolean {
		<- degrees::isGreaterThan(4)
	}

	Terminal.inspect(readings::removeEvery(where isWarm)) § [ 3, 1, 4, 1, 2 ]

	§ And its Parameter may be wider than the items — a callback taking
	§ `Integer | Rational` serves a List of either, or of the mix.
	function isBelowFour(_ degrees: Integer | Rational) -> Boolean {
		<- match degrees -> Boolean {
			case Integer  { <- @::isLessThan(4) }
			case Rational { <- @::isLessThan(4) }
		}
	}

	Terminal.inspect(readings::keepEvery(where isBelowFour)) § [ 3, 1, 1, 2 ]
	Terminal.inspect([3, 7/2, 9/2, 4]::keepEvery(where isBelowFour)) § [ 3, 7/2 ]

	§ Existential and universal questions read as sentences.
	Terminal.inspect(
		readings::anyItem(where (degrees) { § true — the 9
			<- degrees::isGreaterThan(8)
		}),
	)
	Terminal.inspect(
		readings::everyItem(where (degrees) { § true — no frost all week
			<- degrees::isPositive()
		}),
	)

	§ Indexing, slicing and counting — zero-based, `slice` half-open. An index
	§ outside the List is not an error and not a sentinel — the answer is
	§ simply an Optional carrying nothing.
	Terminal.inspect(readings::item(at 2)) § Optional#Value(4) — Wednesday
	Terminal.inspect(readings::item(at 99)) § Optional#Empty
	Terminal.inspect(readings::firstIndex(of 1)) § Optional#Value(1)
	Terminal.inspect(readings::slice(from 0, to 5)) § [ 3, 1, 4, 1, 5 ] — the workweek
	Terminal.inspect(readings::count(of 1)) § 2

	§ Membership, spelled both ways round.
	Terminal.inspect(readings::contains(9)) § true
	Terminal.inspect(readings::doesNotContain(0)) § true

	§ Structural edits, each answering a corrected copy.
	Terminal.inspect(readings::reverse()) § [ 2, 9, 5, 1, 4, 1, 3 ]
	Terminal.inspect(readings::remove(at 0)) § the week without Monday
	Terminal.inspect(readings::insert(2, at 0)) § a reading slipped in before Monday
	Terminal.inspect(readings::replace(8, at 5)) § Saturday's 9 was misread

	§ Sorting — through Comparable, or by a comparator written out.
	Terminal.inspect(readings::sort()) § [ 1, 1, 2, 3, 4, 5, 9 ]
	Terminal.inspect(readings::sort(by (a, b) { <- b::compare(to a) })) § [ 9, 5, 4, 3, 2, 1, 1 ] — warmest first
}
