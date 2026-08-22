implementation {

	§ The everyday Integer Methods. The Compiler reads a written divisor, so it
	§ knows `3` is not zero and this remainder answers a bare Integer. It reads a
	§ written exponent the same way, so a power with a non-negative one answers a
	§ bare Integer. A Method that can fail answers an `Optional`, and
	§ `Terminal.inspect` shows the whole answer: `Optional#Value(1/4)` rather than
	§ `1/4`. A Method that can answer empty offers a `defaultingTo:` entry beside
	§ it. An Optional already held in data collapses with `value(defaultingTo:)`.
	§ Both forms are shown below.
	Terminal.inspect(-7::remainder(dividingBy 3)) § 2 — Euclidean, so a negative dividend still leaves a non-negative
	§ remainder. `7::remainder(dividingBy 3)` is the plain `1`.
	Terminal.inspect(2::raise(to 10)) § 1024 — the exponent is not negative, so there certainly is a power
	Terminal.inspect(2::raise(to -2)) § Optional#Value(1/4) — negative powers stay exact
	Terminal.inspect(-5::absolute()) § 5
	Terminal.inspect(4::isEven()) § true
	Terminal.inspect(0::isPositive()) § false — zero is neither sign
	Terminal.inspect(15::clamp(between 1, and 10)) § 10 — the bounds are taken in either order

	§ The everyday Rational Methods, and the way back to Integer.
	constant sevenHalves = 7/2
	Terminal.inspect(sevenHalves::round()) § 4 — halves round away from zero
	Terminal.inspect(sevenHalves::round(toward #Down)) § 3
	Terminal.inspect(sevenHalves::negate()::round(toward #TowardZero)) § -3 — towards zero
	Terminal.inspect(3/4::numerator()) § 3
	Terminal.inspect(3/4::reciprocal()) § Optional#Value(4/3)
	Terminal.inspect(2/3::raise(to 2)) § 4/9 — a Rational takes a proven exponent too

	§ Reading a Number from text. A text that spells no Number answers the fallback.
	Terminal.inspect(Integer.parse("42", defaultingTo 0)) § 42
	Terminal.inspect(Integer.parse("nope", defaultingTo 0)) § 0
	Terminal.inspect(Rational.parse("0.75", defaultingTo 0/1)) § 3/4

	§ Exact aggregates, asked of the List that holds the Numbers.
	constant scores = [1, 2, 3]
	Terminal.inspect(scores::sum()) § 6
	Terminal.inspect([1, 1/2, 1/2]::sum()) § 2 — a whole mixed sum is an Integer
	Terminal.inspect([1/2, 2/3]::product()) § 1/3
	Terminal.inspect([1, 2]::average(defaultingTo 0/1)) § 3/2

	§ The sign Methods reach the whole tower.
	Terminal.inspect(Number.Pi::negate()::absolute()) § π

	§ `isBetween` reads the tower's one order, and includes both bounds. It
	§ is `Orderable`'s, which Integer offers over Integers and the covering
	§ `Number` offers over the whole tower — so a question that mixes kinds is
	§ answered by `Number`, and one that does not is answered by `Integer`.
	Terminal.inspect(5::isBetween(1, and 10)) § true
	Terminal.inspect(Number.Pi::isBetween(3, and 22/7)) § true — π is above 3 and below 22/7
	Terminal.inspect(Number.Pi::isBetween(22/7, and 4)) § false — π is below 22/7

	§ Splitting a String answers a List, and joining that List answers a String.
	Terminal.inspect("a,b,c"::split(on ",")::join(with " + ")) § "a + b + c"

	§ A Method that can answer empty takes the fallback itself.
	Terminal.inspect([1, 2, 3]::firstItem(defaultingTo 0)) § 1
	Terminal.inspect([1]::removeFirst()::firstItem(defaultingTo 99)) § 99

	§ An Optional already held in data collapses with `value(defaultingTo:)`.
	constant reciprocalPower = 2::raise(to -2)
	Terminal.inspect(reciprocalPower::value(defaultingTo 0)) § 1/4

	§ Sorting reads the items' own `Comparable`, so no comparison is written here.
	Terminal.inspect([3, 1, 2]::sort()) § [ 1, 2, 3 ]
	Terminal.inspect(["banana", "apple"]::sort()) § [ "apple", "banana" ]
	Terminal.inspect([3/2, 1, 1/2]::sort()) § [ 1/2, 1, 3/2 ] — the mixed List orders through Number

	§ The Methods that reshape a List.
	Terminal.inspect([[1, 2], [3]]::flatten()) § [ 1, 2, 3 ]
	Terminal.inspect([1, 2, 3, 2]::lastIndex(of 2)) § Optional#Value(3)
	Terminal.inspect([1, 2, 3, 4]::hasItems(where (n) { <- n::isEven() })) § true
	Terminal.inspect([1, 2, 3, 4]::everyItem(where (n) { <- n::isEven() })) § [ 2, 4 ] — the filter
	Terminal.inspect([1, 2, 3, 4]::partition(where (n) { <- n::isEven() }))
	Terminal.inspect(["a", "b"]::pair(with [1, 2, 3])) § pairs stop with the shorter List
	Terminal.inspect([1, 2, 3, 4, 5]::split(intoGroupsOf 2)) § [ [ 1, 2 ], [ 3, 4 ], [ 5 ] ]

	§ Building a List to walk. Essence has no Range Type, so `List.of` writes one.
	Terminal.inspect(List.of(integersFrom 1, through 5)) § [ 1, 2, 3, 4, 5 ]
	Terminal.inspect(List.repeat("x", times 3)) § [ "x", "x", "x" ]
}
