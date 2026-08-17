implementation {

	§ A Pattern names the parts of a value. It is the Record Matcher grammar —
	§ `name: Type` constrains by Type, `name = value` by value — generalised
	§ into every position that takes a value apart, with one member form added:
	§ a bare `name`, which BINDS. Every member binds except `name = value`,
	§ which constrains without binding because the value is written right there.
	type Click = { x: Integer, y: Integer }
	type KeyPress = { key: String }

	constant input: Click | KeyPress = { x = 0, y = 7 }

	§ `{ x }` is `{ x: Integer }` with the annotation elided — the same relation
	§ `(item)` has to `(_ item: Integer)` — so the two differ in what they
	§ constrain and never in what they bind.
	Terminal.print(match input -> String {
		case { x = 0, y = 0 } { <- "clicked the origin" }
		case { x = 0, y }     { <- "y axis at {y}" }
		case { x, y }         { <- "at {x}, {y}" }
		case { key }          { <- "pressed {key}" }
	}) § y axis at 7

	§ A Guard sees the bindings. It is emitted into the Handler's test, which
	§ runs before the body the bindings stand in, so a name there resolves to
	§ the `@.member` it stands for — safely, because the Matcher's own check is
	§ ANDed in front of it and short-circuits.
	constant square: Click | KeyPress = { x = 3, y = 3 }

	Terminal.print(match square -> String {
		case { x, y } where x::is(y) { <- "the diagonal at {x}" }
		case { x, y } { <- "at {x}, {y}" }
		case { key }  { <- "pressed {key}" }
	}) § the diagonal at 3

	§ A binding shadows an outer name like any other declaration, and `as` is
	§ how a Program declines to.
	constant x = 99

	Terminal.print(match square -> String {
		case { x as column, y as row } { <- "{column}/{row}, not {x}" }
		case _                         { <- "something else" }
	}) § 3/3, not 99

	§ A Case Matcher's binder names what the CONSTRUCTOR takes, so a Pattern
	§ there takes the payload apart instead of naming it whole.
	choice Shape {
		Rectangle { width: Integer, height: Integer },
		Circle { radius: Integer },
		Empty,
	}

	constant shape: Shape = #Rectangle({ width = 3, height = 4 })

	Terminal.print(match shape -> Integer {
		case #Rectangle({ width, height }) { <- width::multiply(with height) }
		case #Circle({ radius })           { <- radius::multiply(with radius) }
		case #Empty                        { <- 0 }
	}) § 12

	§ `} as name` names the whole value alongside its parts. A payload Pattern
	§ may carry one — what the constructor took is not `@` — while a Matcher's
	§ own Pattern may not, because `@` already means exactly that.
	Terminal.print(match shape -> Integer {
		case #Rectangle({ width, height } as box) {
			<- width::add(height)::add(box.width)
		}
		case #Circle({ radius } as dot)           { <- radius::add(dot.radius) }
		case #Empty                               { <- 0 }
	}) § 10

	§ On a one-member Case the constructor takes that member's value, which is
	§ what makes `case #Value(item)` the mirror of `#Value(5)`. Both spellings
	§ bind the same thing.
	constant maybe: Optional<Integer> = #Value(5)

	Terminal.print(match maybe -> Integer {
		case #Value(item) { <- item }
		case #Empty       { <- 0 }
	}) § 5

	Terminal.print(match maybe -> Integer {
		case #Value({ item }) { <- item }
		case #Empty           { <- 0 }
	}) § 5

	§ Where both readings fit, the payload Record wins — the tie-break
	§ construction already applies to those same two spellings. `Going` carries
	§ one member `state`, and a Pattern naming `index` and `total` fits only the
	§ shorthand reading, so that is the one it gets.
	choice Progress<State, Result> {
		Going { state: State },
		Stopped { value: Result },
	}

	constant started: Progress<{
		index: Integer,
		total: Integer,
	}, Integer> = #Going({ state = { index = 1, total = 7 } })

	Terminal.print(match started -> Integer {
		case #Going({ index, total }) { <- index::add(total) }
		case #Stopped(done)           { <- done }
	}) § 8

	§ The same value through the payload Record, which is where nesting shows:
	§ a binder is a name or another Pattern, and that one rule is the whole of
	§ it.
	Terminal.print(match started -> Integer {
		case #Going({ state as { index, total } }) { <- total::subtract(index) }
		case #Stopped(done)                        { <- done }
	}) § 6

	§ A nested member may constrain by value too, which is what makes the arm
	§ conditional — exactly as a top-level one does.
	Terminal.print(match started -> String {
		case #Going({ state as { index = 1, total } }) { <- "first, {total}" }
		case _                                         { <- "later" }
	}) § first, 7

	§ A Function literal takes its Parameter apart, which is what the Methods
	§ answering a Record are for: `pair(with:)` gives a List of
	§ `{ first, second }` because Essence has no tuple, and a Pattern is how a
	§ caller reads one without naming the Record first.
	constant numbers = [1, 2, 3, 4]

	Terminal.print(
		["a", "b"]
			::pair(with numbers)
			::map(({ first, second }) { <- "{first}{second}" }),
	) § [ a1, b2 ]

	§ Naming the whole value as well is what keeps `{ state with … }` writable
	§ in a loop that threads a Record — the two halves of the body each read the
	§ way they want to.
	constant limit = 5

	constant walked = loop(
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

	Terminal.print(walked) § 15

	§ A named Parameter's Pattern stands where the internal name goes, so the
	§ label — and with it the call site — is untouched by anything it says.
	function area(
		of { width, height }: { width: Integer, height: Integer },
	) -> Integer {
		<- width::multiply(with height)
	}

	Terminal.print(area(of { width = 6, height = 7 })) § 42

	function perimeter(
		_ { width, height }: { width: Integer, height: Integer },
	) -> Integer {
		<- width::add(height)::multiply(with 2)
	}

	Terminal.print(perimeter({ width = 6, height = 7 })) § 26

	§ A Declaration takes a value apart the same way. Its Pattern must be
	§ irrefutable — a `constant` can not decline a value and has nowhere to fall
	§ through to — so a member constrained by VALUE is refused there, while one
	§ constrained by Type is an annotation and fails the way annotations do.
	constant { matching, rest } = numbers::partition(where (n) {
		<- n::isEven()
	})

	Terminal.print(matching) § [ 2, 4 ]
	Terminal.print(rest) § [ 1, 3 ]

	constant point = { origin = { x = 1, y = 2 }, label = "p" }

	constant { origin as { x as ox, y as oy } } = point

	Terminal.print(ox::add(oy)) § 3

	constant { width, height } as size: { width: Integer, height: Integer } = {
		width = 2,
		height = 5,
	}

	Terminal.print(width::multiply(with height)::add(size.width)) § 12

	§ Only the bindings follow the Declaration's own keyword — the value itself
	§ is held once, whatever it was written as — so these are two Variables.
	variable { index, total } = { index = 1, total = 2 }

	index = index::add(10)

	Terminal.print(index::add(total)) § 13

	§ `as` is a Keyword only where a binder can follow it, so a member may be
	§ called `as` — and bound under that name.
	constant { as as as } = { as = "yes" }

	Terminal.print(as) § yes
}
