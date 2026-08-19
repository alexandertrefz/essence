implementation {

	§§ Anything with an area to measure.
	protocol Measurable {
		area() -> Number

		§ A Method written with a BODY is provided rather than required: every
		§ conforming Type answers it without writing anything, and the body is
		§ emitted once for all of them. It is written on `@` and may call what
		§ this Protocol declares and nothing else.
		§§ Answers whether the area is nothing at all.
		§§
		§§ @returns — `true` when the area is zero.
		isEmpty() -> Boolean {
			<- @::area()::is(0)
		}
	}

	type Rectangle = { width: Integer, height: Integer }
	type Circle = { radius: Integer }

	namespace RectangleMeasurable for Rectangle is Measurable {
		area() -> Number {
			<- @.width::multiply(with @.height)
		}
	}

	namespace CircleMeasurable for Circle is Measurable {
		area() -> Number {
			§ Close enough to π for a demonstration.
			<- @.radius::multiply(with @.radius)::multiply(with 355/113)
		}
	}

	§§ Works for any Type with a Measurable conformance in scope.
	function describeArea<infer Shape is Measurable>(_ shape: Shape) -> String {
		<- match shape::area() -> String {
			case Integer        { <- @::toString() }
			case Rational       { <- @::toString() }
			case Algebraic      { <- @::toString() }
			case Transcendental { <- @::toString() }
		}
	}

	Terminal.print(describeArea({ width = 3, height = 4 }))
	Terminal.print(describeArea({ radius = 2 }))

	§ `isEmpty` is nobody's Method and everybody's — neither Namespace above
	§ writes it, and both answer it.
	Terminal.print({ width = 0, height = 4 }::isEmpty())
	Terminal.print({ radius = 2 }::isEmpty())

	§ A Protocol may EXTEND others. Conforming to `Ordered` owes every
	§ requirement of `Comparable` too, and grants conformance to it — so a
	§ Namespace declaring only `is Ordered` answers an `is Comparable` bound.
	protocol Ordered is Comparable {
		§§ Answers whether this value sorts before another.
		§§
		§§ @param _ — the value to compare with
		§§ @returns — `true` when this value sorts first.
		isBefore(_ other: Self) -> Boolean {
			<- @::compare(to other)::is(Ordering#Less)
		}
	}

	type Weight = { grams: Integer }

	namespace Weights for Weight is Ordered {
		compare(to other: Weight) -> Ordering {
			<- @.grams::compare(to other.grams)
		}
	}

	§ `sort` asks for `Comparable`; the bound below names only `Ordered`. The
	§ one conformance answers both.
	function lightestOf<infer Item is Ordered>(
		_ items: List<Item>,
	) -> Optional<Item> {
		<- items::sort()::firstItem()
	}

	Terminal.print({ grams = 1 }::isBefore({ grams = 2 }))
	Terminal.print(
		lightestOf([{ grams = 3 }, { grams = 1 }])::value(defaultingTo {
			grams = 0,
		}).grams,
	)

	§ The builtin Types conform to the core Protocols — Equatable and
	§ Printable for all of them, and Comparable for the ordered ones:
	§ Integer, Rational, Algebraic and String. (Transcendentals order only
	§ through Number, so they carry no Comparable conformance of their own.)
	§ The numeric ones say `is Orderable`, which extends Comparable and
	§ provides the four inequalities, `isBetween` and `clamp` on top of it —
	§ so the bound below is satisfied by a conformance that never names it.

	function smallerOf<infer Item is Comparable>(_ a: Item, _ b: Item) -> Item {
		<- match a::compare(to b) -> Item {
			case #Less    { <- a }
			case #Equal   { <- a }
			case #Greater { <- b }
		}
	}

	Terminal.print(smallerOf(5, 3))
	Terminal.print(smallerOf(1/2, 1/3))
	Terminal.print(1::compare(to 2))
	Terminal.print(Ordering#Less::is(1::compare(to 2)))
}
