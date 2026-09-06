implementation {

	§ What a Dictionary COSTS, written down so that a change to the store has
	§ a number to answer to. Every benchmark below reads inputs this section
	§ built ONCE: what is timed is the operation, never the building of what
	§ it works on.
	§
	§ Two of them are written twice — once on a Dictionary and once on a List
	§ of entries, which is what a Program without a Dictionary reaches for —
	§ so the ratio between the two containers is on record rather than
	§ assumed. Both pairs are measured on a thousand keys: a List of entries
	§ is quadratic to build and to read, so ten times the keys is a hundred
	§ times the wait, and ten thousand of them measure nothing a reader would
	§ sit through.
	§
	§ WHAT THEY MEASURED, on an Apple M3 Pro under Bun 1.4.0 — the median of
	§ eight runs, and the same time divided by the keys the body touched:
	§
	§   Dictionary, ten thousand String keys
	§     counted in, `update(at:defaultingTo:with:)`   683 µs   68.3 ns/key
	§     set in, `set(_:to:)`                          487 µs   48.7 ns/key
	§     read out, `value(at:defaultingTo:)`           280 µs   28.0 ns/key
	§     printed, `toString()`                         635 µs   63.5 ns/entry
	§   Dictionary, a hundred writes from ONE base     32.7 ms    327 µs/fork
	§   Record keys — the scan path — a thousand of them
	§     set in, `set(_:to:)`                         7.48 ms   7.48 µs/key
	§     read out, `value(at:defaultingTo:)`          8.00 ms   8.00 µs/key
	§   A List becoming a Dictionary, ten thousand items
	§     `tallied()`                                   254 µs   25.4 ns/item
	§     `groupedBy(key:)`                             337 µs   33.7 ns/item
	§
	§   A thousand keys, the same two questions, both containers
	§                          Dictionary   List of entries    ratio
	§     counted in             67.8 µs           4.13 ms      61×
	§     read out               30.1 µs           3.58 ms     119×
	§
	§ The two ratios are the whole point of the pair. A Dictionary answers a
	§ key in one step whatever it holds; a List of entries walks half of
	§ itself to answer the same question. So the gap grows with the keys, and
	§ 119× at a thousand of them would be ten times that at ten thousand.
	§
	§ And the times say what the runtime's NOTEs promise. A String key reads
	§ out of a thousand entries in 30.1 ns and out of ten thousand in 28.0 ns
	§ — flat, which is what an O(1) lookup means — and a key is written into
	§ a thousand entries in 67.8 ns and into ten thousand in 68.3 ns, flat in
	§ the same way. A Record key costs a hundred times more and grows with
	§ the entries, which is the scan path being exactly what it says it is. A
	§ write taken from a base that has already been written from costs 327 µs
	§ against 48.7 ns on the tip: 32.7 ns for each of the ten thousand
	§ entries it repacks, once per fork, which is the O(n) the NOTE names.

	§ An entry as the baseline holds it. It is the Record a Dictionary hands
	§ every callback, written down as the Type of a List's items.
	type Entry = { key: String, value: Integer }

	§ A key with no canonical encoding. A Record is found by asking the
	§ Record's own `is`, which is a walk over the entries rather than one
	§ step into an index — the scan path, measured for what it is.
	type Seat = { row: Integer, seat: Integer }

	§ One row of a season, for the two Methods that turn a List into a
	§ Dictionary.
	type Result = { team: String, goals: Integer }

	constant keys: List<String> = List.of(integersFrom 0, through 9999)::map(
		(number) { <- "key {number}" },
	)

	constant fewKeys: List<String> = keys::firstItems(1000)

	constant noCounts: Dictionary<String, Integer> = [=]

	§ The Dictionary every reading benchmark reads. It is built here rather
	§ than in a body, so a benchmark that looks a key up times the lookup.
	constant built: Dictionary<String, Integer> = keys::reduce(
		startingWith noCounts,
		(counted, key) { <- counted::set(key, to 1) },
	)

	§ The thousand of them a Dictionary again, so that the pair measured
	§ against the List of entries below reads a container of the same size —
	§ and so that a lookup measured here and one measured on `built` say what
	§ the size costs.
	constant few: Dictionary<String, Integer> = fewKeys::reduce(
		startingWith noCounts,
		(counted, key) { <- counted::set(key, to 1) },
	)

	§ The same thousand entries as a List, which is the baseline's whole
	§ representation.
	constant entries: List<Entry> = fewKeys::map((key) {
		<- { key, value = 1 }
	})

	constant noEntries: List<Entry> = []

	constant seats: List<Seat> = List.of(integersFrom 0, through 999)::map(
		(number) { <- { row = number, seat = 1 } },
	)

	constant noSeats: Dictionary<Seat, Integer> = [=]

	constant taken: Dictionary<Seat, Integer> = seats::reduce(
		startingWith noSeats,
		(dictionary, seat) { <- dictionary::set(seat, to 1) },
	)

	§ Ten thousand results over a hundred teams, so grouping and tallying
	§ have something to put together rather than one item under every key.
	constant results: List<Result> = List.of(integersFrom 0, through 9999)::map(
		(number) {
			<- {
				team = "team {number::remainder(dividingBy 100)}",
				goals = number::remainder(dividingBy 7),
			}
		},
	)

	constant teams: List<String> = results::map(.team)
}

tests {

	§ A benchmark is timed rather than judged, so it is left out of an
	§ ordinary run and measured by `essence test --bench`. Each one still
	§ asserts what its body answered: a measurement of work that is wrong is
	§ a number about nothing.
	§
	§ The baselines beside this file are those medians with a little over
	§ them, which is the headroom a measurement wants on a machine that is
	§ doing other things as well. What they measured is written at the top of
	§ this file.

	suite "Dictionary" {
		§ The counting idiom: one call that reads, transforms and sets, with
		§ a value to start from where the key holds none.
		benchmark "counts ten thousand keys" {
			constant counted = keys::reduce(
				startingWith noCounts,
				(counts, key) {
					<- counts::update(at key, defaultingTo 0, with (count) {
						<- count::add(1)
					})
				},
			)

			expect counted::length()::is(10000)
		}

		benchmark "sets ten thousand keys" {
			constant stored = keys::reduce(
				startingWith noCounts,
				(counts, key) { <- counts::set(key, to 1) },
			)

			expect stored::length()::is(10000)
		}

		benchmark "looks ten thousand keys up" {
			constant total = keys::reduce(startingWith 0, (sum, key) {
				<- sum::add(built::value(at key, defaultingTo 0))
			})

			expect total::is(10000)
		}

		§ A hundred Dictionaries taken from ONE base, each written once. The
		§ first write leaves the base behind the store's newest generation,
		§ so every write after it repacks the entries the base can see before
		§ writing — which is the cost a fork is measured for.
		benchmark "writes a hundred Dictionaries from one" {
			constant forks = List.of(integersFrom 1, through 100)::map(
				(number) { <- built::set("fork {number}", to number) },
			)

			expect forks::length()::is(100)
		}

		benchmark "prints ten thousand entries" {
			expect built::toString()::length()::isGreaterThan(10000)
		}

		benchmark "counts a thousand keys" {
			constant counted = fewKeys::reduce(
				startingWith noCounts,
				(counts, key) {
					<- counts::update(at key, defaultingTo 0, with (count) {
						<- count::add(1)
					})
				},
			)

			expect counted::length()::is(1000)
		}

		benchmark "looks a thousand keys up" {
			constant total = fewKeys::reduce(startingWith 0, (sum, key) {
				<- sum::add(few::value(at key, defaultingTo 0))
			})

			expect total::is(1000)
		}
	}

	§ The same two questions asked of a List of entries, which is what a
	§ Program reaches for where there is no Dictionary: every read is
	§ `firstItem(where:)` over the entries, and every write is a read and an
	§ append.
	suite "A List of entries" {
		benchmark "counts a thousand keys" {
			constant counted = fewKeys::reduce(
				startingWith noEntries,
				(held, key) {
					<- match held::firstItem(where (entry) {
						<- entry.key::is(key)
					}) -> List<Entry> {
						case #Value({ value }) {
							<- held::removeEvery(where (entry) {
								<- entry.key::is(key)
							})
								::append({ key, value = value::add(1) })
						}
						case #Empty { <- held::append({ key, value = 1 }) }
					}
				},
			)

			expect counted::length()::is(1000)
		}

		benchmark "looks a thousand keys up" {
			constant total = fewKeys::reduce(startingWith 0, (sum, key) {
				<- match entries::firstItem(where (entry) {
					<- entry.key::is(key)
				}) -> Integer {
					case #Value({ value }) { <- sum::add(value) }
					case #Empty            { <- sum }
				}
			})

			expect total::is(1000)
		}
	}

	§ A key the runtime has no encoding for is found by asking the key's own
	§ `is` over the entries the box can see. It is correct for every key Type
	§ the language has, and it is a walk.
	suite "Record keys" {
		benchmark "builds a thousand" {
			constant filled = seats::reduce(
				startingWith noSeats,
				(dictionary, seat) { <- dictionary::set(seat, to 1) },
			)

			expect filled::length()::is(1000)
		}

		benchmark "looks a thousand up" {
			constant total = seats::reduce(startingWith 0, (sum, seat) {
				<- sum::add(taken::value(at seat, defaultingTo 0))
			})

			expect total::is(1000)
		}
	}

	§ The two Methods that cross from the first container to the second.
	suite "A List becoming a Dictionary" {
		benchmark "tallies ten thousand items" {
			expect teams::tallied()::length()::is(100)
		}

		benchmark "groups ten thousand items" {
			expect results::groupedBy(key .team)::length()::is(100)
		}
	}
}
