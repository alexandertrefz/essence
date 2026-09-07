implementation {

	§ A lending shelf — who has how many books out — and the Dictionary
	§ Methods a Program reaches for. Every edit answers a NEW Dictionary: the
	§ shelf never changes behind a reader's back.

	§ A Dictionary is written in brackets, one entry to a `key = value` pair.
	§ The same brackets write a List, and the `=` is the whole difference — so
	§ the empty pair is spelled `[=]` and never `[]`.
	variable loans = ["ada" = 2, "grace" = 1]

	Terminal.inspect(loans) § [ "ada" = 2, "grace" = 1 ]

	§ Setting a key that is already there keeps the place it had. A key that is
	§ new is added at the end.
	loans = loans::set("ada", to 3)
	loans = loans::set("alan", to 1)

	Terminal.inspect(loans) § [ "ada" = 3, "grace" = 1, "alan" = 1 ]

	§ An update sets its entries against a base and answers a new Dictionary —
	§ the base never changes.
	Terminal.inspect([loans with "grace" = 2, "kim" = 1])
	Terminal.inspect(loans) § still [ "ada" = 3, "grace" = 1, "alan" = 1 ]

	§ `Dictionary.of` builds the same thing out of a List of entry Records,
	§ which is what a Program with its entries already in hand reaches for.
	Terminal.inspect(
		Dictionary.of([{ key = "ada", value = 3 }])::is(["ada" = 3]),
	) § true

	§ A lookup answers an Optional, because a key can hold nothing. The
	§ `defaultingTo:` entry collapses that back to a bare value.
	Terminal.inspect(loans::value(at "grace")) § Optional#Value(1)
	Terminal.inspect(loans::value(at "nobody")) § Optional#Empty
	Terminal.inspect(loans::value(at "nobody", defaultingTo 0)) § 0
	Terminal.inspect(loans::hasKey("alan")) § true

	§ `update` reads a value, transforms it and sets it back. Its
	§ `defaultingTo:` entry starts from a value of the caller's where the key
	§ holds none, which is what makes counting one call rather than three.
	loans = loans::update(at "grace", with (count) { <- count::add(1) })
	loans = loans::update(at "brian", defaultingTo 0, with (count) {
		<- count::add(1)
	})

	Terminal.inspect(loans) § [ "ada" = 3, "grace" = 2, "alan" = 1, "brian" = 1 ]

	§ The parts a Dictionary answers, each in the order the keys were first set.
	Terminal.inspect(loans::keys()) § [ "ada", "grace", "alan", "brian" ]
	Terminal.inspect(loans::values()) § [ 3, 2, 1, 1 ]
	Terminal.inspect(loans::entries()) § one { key, value } Record per entry
	Terminal.inspect(loans::length()) § 4

	§ Every callback here is handed the entry, so a Pattern takes it apart
	§ where it stands.
	Terminal.inspect(
		loans::everyEntry(where ({ key, value }) { § the borrowers with more
			<- value::isGreaterThan(1) § than one book out
		}),
	)
	Terminal.inspect(
		loans::removeEvery(where ({ key, value }) { <- value::is(1) }),
	) § the same two, asked the other way round

	§ `map` transforms the values and keeps the keys, so the answer holds the
	§ same keys in the same order.
	constant summary = ["ada" = 3, "kim" = 1]::map(({ key, value }) {
		<- "{key} has {value}"
	})

	Terminal.inspect(summary) § [ "ada" = "ada has 3", "kim" = "kim has 1" ]

	§ Removing a key and setting it again puts it at the END. The order is the
	§ order the keys were FIRST set, and a key that left is new when it comes
	§ back.
	Terminal.inspect(loans::remove(at "ada")::set("ada", to 1))

	§ Merging: the Argument wins on a key both hold, unless the caller says how
	§ to settle it.
	constant returned = ["ada" = 1, "kim" = 4]

	Terminal.inspect(loans::merge(with returned))
	Terminal.inspect(
		loans::merge(with returned, choosing (out, back) {
			<- out::subtract(back)
		}),
	)

	§ An update whose right side is ONE whole Dictionary merges it in, which is
	§ `merge(with:)` written in brackets.
	Terminal.inspect([loans with returned]::is(loans::merge(with returned)))

	§ Two Dictionaries are equal when they hold the same keys with equal
	§ values, whatever order they were written down in.
	Terminal.inspect(
		loans::is(["brian" = 1, "alan" = 1, "grace" = 2, "ada" = 3]),
	) § true

	§ A key is any Equatable value, not only a String. A Record key whose
	§ members all encode is found in one step, exactly as a String key is; a
	§ key with no canonical encoding is found by asking its own `is` over the
	§ entries, which is a walk rather than a lookup.
	constant seats = [
		{ row = 1, seat = 2 } = "ada",
		{ row = 4, seat = 1 } = "grace",
	]

	Terminal.inspect(seats::value(at { row = 4, seat = 1 })) § Optional#Value("grace")

	§ `hasEntries(where:)` asks the same question of an entry rather than of
	§ the whole Dictionary, and stops at the entry that decides the answer.
	Terminal.inspect(
		loans::hasEntries(where ({ key, value }) {
			<- value::isGreaterThan(2)
		}),
	) § true

	§ A Dictionary written down with an entry in it is proven to have one, and
	§ so is one an update set an entry into. That proof is a Type of its own —
	§ `NonEmptyDictionary` — and the Methods it changes answer better for it:
	§ counting can not answer zero, and the three halves a Dictionary is read
	§ as can not answer the empty List.
	constant shelf: NonEmptyDictionary<String, Integer> = ["ada" = 2]

	Terminal.inspect(shelf::keys()::firstItem()) § "ada", and no Optional
	Terminal.inspect(shelf::entries()::firstItem().value) § 2

	§ Setting a key answers the proof, whatever it was handed. An empty
	§ Dictionary with a key set into it is not empty.
	constant nobody: Dictionary<String, Integer> = [=]

	Terminal.inspect(nobody::set("ada", to 1)::values()::firstItem()) § 1

	§ A Dictionary a Program is handed carries no proof, so it goes through an
	§ `if` to reach the same Methods. The `if` narrows a Constant, which can
	§ not be assigned something else inside the branch that asked.
	constant outNow = loans

	if outNow::hasEntries() {
		Terminal.inspect(outNow::keys()::firstItem()) § "ada"
	} else {
		Terminal.inspect("nothing is out")
	}

	§ The bridges: a List becomes a Dictionary keyed by something read off its
	§ items. Every group holds an item and every count is above zero, so the
	§ groups answer a first item bare.
	constant returns = [
		{ title = "Emma", borrower = "ada" },
		{ title = "Mill", borrower = "grace" },
		{ title = "Ruth", borrower = "ada" },
	]

	Terminal.inspect(
		returns
			::group(on (loan) { <- loan.borrower })
			::map(({ key, value }) { <- value::firstItem().title }),
	) § [ "ada" = "Emma", "grace" = "Mill" ]

	Terminal.inspect(["ada", "grace", "ada"]::tally()) § [ "ada" = 2, "grace" = 1 ]
}
