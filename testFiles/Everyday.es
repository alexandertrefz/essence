implementation {

	§ The everyday Integer Methods.
	__print(0::subtract(7)::remainderOf(dividingBy 3))   § 2 — Euclidean, never negative
	__print(2::toThePowerOf(10))                         § 1024
	__print(2::toThePowerOf(0::subtract(2)))             § 1/4 — negative powers stay exact
	__print(0::subtract(5)::absolute())                  § 5
	__print(4::isEven())                                 § true
	__print(0::isPositive())                             § false — zero is neither sign
	__print(15::clampedBetween(1, and 10))               § 10

	§ The everyday Rational Methods — and the way back to Integer.
	constant sevenHalves = 7/2
	__print(sevenHalves::rounded())                      § 4 — halves round away from zero
	__print(sevenHalves::roundedDown())                  § 3
	__print(sevenHalves::negated()::truncated())         § -3 — towards zero
	__print(3/4::numerator())                            § 3
	__print(3/4::reciprocal())                           § 4/3
	__print(2/3::toThePowerOf(2))                        § 4/9

	§ Reading Numbers from text — the return trip of toString.
	__print(Integer.parse("42")::otherwise(0))           § 42
	__print(Integer.parse("nope")::otherwise(0))         § 0
	__print(Rational.parse("0.75")::otherwise(0/1))      § 3/4

	§ Exact aggregates over whole Lists.
	__print(Number.sum([1, 2, 3]))                       § 6
	__print(Number.sum([1, 1/2, 1/2]))                   § 2 — a whole mixed sum is an Integer
	__print(Number.product([1/2, 2/3]))                  § 1/3
	__print(Number.average([1, 2])::otherwise(0/1))      § 3/2

	§ The sign Methods reach the whole tower.
	__print(Number.PI::negated()::absolute())            § π

	§ isBetween reads the tower's one order, bounds included.
	__print(5::isBetween(1, and 10))                     § true
	__print(Number.PI::isBetween(3, and 22/7))           § true — the classic enclosure
	__print(Number.PI::isBetween(22/7, and 4))           § false — π is below 22/7

	§ Splitting a String is no longer a one-way door.
	__print("a,b,c"::splitOn(",")::joinWith(" + "))      § "a + b + c"

	§ otherwise collapses `… | Nothing` back to a bare value.
	__print([1, 2, 3]::firstItem()::otherwise(0))        § 1
	__print([1]::removeFirst()::firstItem()::otherwise(99)) § 99

	§ Sorting through Comparable — no comparison to write.
	__print([3, 1, 2]::sorted())                         § [ 1, 2, 3 ]
	__print(["banana", "apple"]::sorted())               § [ "apple", "banana" ]
	__print([3/2, 1, 1/2]::sorted())                     § [ 1/2, 1, 3/2 ] — via Number

	§ The new List shapes.
	__print([[1, 2], [3]]::flattened())                  § [ 1, 2, 3 ]
	__print([1, 2, 3, 2]::lastIndexOf(2))                § 3
	__print([1, 2, 3, 4]::partitioned(where (n) { <- n::isEven() }))
	__print(["a", "b"]::pairedWith([1, 2, 3]))           § pairs stop with the shorter List
	__print([1, 2, 3, 4, 5]::splitInto(groupsOf 2))      § [ [ 1, 2 ], [ 3, 4 ], [ 5 ] ]

	§ Loop fuel — Essence has no Range Type by design.
	__print(List.of(integersFrom 1, through 5))          § [ 1, 2, 3, 4, 5 ]
	__print(List.repeating("x", times 3))                § [ "x", "x", "x" ]
}
