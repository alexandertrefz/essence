implementation {

	§ The everyday Integer Methods. A divisor written down is its own proof of
	§ not being zero, so this remainder can not fail and answers bare. A Method
	§ that CAN fail answers an `Optional`, and `Terminal.inspect` shows it whole —
	§ `Optional#Value(1024)` rather than `1024`. `otherwise` below is how a
	§ Program collapses one back to a bare value.
	Terminal.inspect(
		0::subtract(7)::remainder(dividingBy 3),
	) § 2 — Euclidean, so a negative dividend still leaves a non-negative
	§ remainder. `7::remainder(dividingBy 3)` is the plain `1`.
	Terminal.inspect(2::raise(to 10)) § Optional#Value(1024)
	Terminal.inspect(
		2::raise(to 0::subtract(2)),
	) § Optional#Value(1/4) — negative powers stay exact
	Terminal.inspect(0::subtract(5)::absolute()) § 5
	Terminal.inspect(4::isEven()) § true
	Terminal.inspect(0::isPositive()) § false — zero is neither sign
	Terminal.inspect(15::clamp(between 1, and 10)) § Optional#Value(10)

	§ The everyday Rational Methods — and the way back to Integer.
	constant sevenHalves = 7/2
	Terminal.inspect(sevenHalves::round()) § 4 — halves round away from zero
	Terminal.inspect(sevenHalves::round(toward #Down)) § 3
	Terminal.inspect(
		sevenHalves::negate()::round(toward #TowardZero),
	) § -3 — towards zero
	Terminal.inspect(3/4::numerator()) § 3
	Terminal.inspect(3/4::reciprocal()) § Optional#Value(4/3)
	Terminal.inspect(2/3::raise(to 2)) § Optional#Value(4/9)

	§ Reading Numbers from text — the return trip of toString.
	Terminal.inspect(Integer.parse("42")::otherwise(0)) § 42
	Terminal.inspect(Integer.parse("nope")::otherwise(0)) § 0
	Terminal.inspect(Rational.parse("0.75")::otherwise(0/1)) § 3/4

	§ Exact aggregates over whole Lists.
	Terminal.inspect(Number.sum([1, 2, 3])) § 6
	Terminal.inspect(
		Number.sum([1, 1/2, 1/2]),
	) § 2 — a whole mixed sum is an Integer
	Terminal.inspect(Number.product([1/2, 2/3])) § 1/3
	Terminal.inspect(Number.average([1, 2])::otherwise(0/1)) § 3/2

	§ The sign Methods reach the whole tower.
	Terminal.inspect(Number.Pi::negate()::absolute()) § π

	§ isBetween reads the tower's one order, bounds included.
	Terminal.inspect(5::isBetween(1, and 10)) § true
	Terminal.inspect(
		Number.Pi::isBetween(3, and 22/7),
	) § true — the classic enclosure
	Terminal.inspect(
		Number.Pi::isBetween(22/7, and 4),
	) § false — π is below 22/7

	§ Splitting a String is no longer a one-way door.
	Terminal.inspect("a,b,c"::split(on ",")::join(with " + ")) § "a + b + c"

	§ otherwise collapses `… | Nothing` back to a bare value.
	Terminal.inspect([1, 2, 3]::firstItem()::otherwise(0)) § 1
	Terminal.inspect([1]::removeFirst()::firstItem()::otherwise(99)) § 99

	§ Sorting through Comparable — no comparison to write.
	Terminal.inspect([3, 1, 2]::sort()) § [ 1, 2, 3 ]
	Terminal.inspect(["banana", "apple"]::sort()) § [ "apple", "banana" ]
	Terminal.inspect([3/2, 1, 1/2]::sort()) § [ 1/2, 1, 3/2 ] — via Number

	§ The new List shapes.
	Terminal.inspect([[1, 2], [3]]::flatten()) § [ 1, 2, 3 ]
	Terminal.inspect([1, 2, 3, 2]::lastIndex(of 2)) § Optional#Value(3)
	Terminal.inspect([1, 2, 3, 4]::partition(where (n) { <- n::isEven() }))
	Terminal.inspect(
		["a", "b"]::pair(with [1, 2, 3]),
	) § pairs stop with the shorter List
	Terminal.inspect(
		[1, 2, 3, 4, 5]::split(intoGroupsOf 2),
	) § Optional#Value([ [ 1, 2 ], [ 3, 4 ], [ 5 ] ])

	§ Loop fuel — Essence has no Range Type by design.
	Terminal.inspect(List.of(integersFrom 1, through 5)) § [ 1, 2, 3, 4, 5 ]
	Terminal.inspect(List.repeat("x", times 3)) § [ "x", "x", "x" ]
}
