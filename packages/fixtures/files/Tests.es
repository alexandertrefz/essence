implementation {

	§ A module has sections — `import`, `implementation`, `export` — and
	§ testing adds a fourth: `tests`, written below the implementation and above
	§ the exports. It shares the implementation's scope, so everything this file
	§ declares is visible inside it whether or not the file exports it, and it
	§ exists only when the Compiler is asked for it: a build drops the whole
	§ block before anything is enriched, so a test costs a shipped Program
	§ nothing.

	choice Outcome {
		Win,
		Draw,
		Loss,
	}

	type Standing = { team: String, played: Integer, points: Integer }

	§ The Type a table test's rows are read against. It is declared beside the
	§ implementation because a tests section sees everything the file declares.
	type Scoreline = { scored: Integer, conceded: Integer, points: Integer }

	§ A private Function. The tests section sees it, which is the point of
	§ living in the same file rather than beside it.
	function outcomeOf(
		_ scored: Integer,
		against conceded: Integer,
	) -> Outcome {
		if scored::isGreaterThan(conceded) {
			<- #Win
		} else if scored::is(conceded) {
			<- #Draw
		} else {
			<- #Loss
		}
	}

	§§ Answers the points a result is worth: three for a win, one for a draw.
	§§
	§§ @example
	§§   expect pointsFor(#Win)::is(3)
	§§   expect pointsFor(#Loss)::is(0)
	§§
	§§ @param _ — the Outcome to score
	§§ @returns — the points the Outcome earns.
	function pointsFor(_ outcome: Outcome) -> Integer {
		<- match outcome -> Integer {
			case #Win  { <- 3 }
			case #Draw { <- 1 }
			case #Loss { <- 0 }
		}
	}

	namespace Standing for Standing {
		record(scored: Integer, conceded: Integer) -> Standing {
			constant earned = pointsFor(outcomeOf(scored, against conceded))

			<- {
				@ with
					played = @.played::add(1),
					points = @.points::add(earned),
			}
		}

		static blank(of team: String) -> Standing {
			<- { team, played = 0, points = 0 }
		}
	}

	§ A Type whose values carry an invariant a structural generator can not
	§ know about — a supported team is one of three, and a Record of a String
	§ is any String at all. A Namespace conforming to `Generatable` replaces
	§ the derived generator for the Type it targets, and a property test over
	§ `Supported` draws through it.
	type Supported = { name: String }

	namespace Supported for Supported is Generatable {
		static generate(from source: Randomness) -> Supported {
			<- { name = source::pick(from ["Lions", "Tigers", "Bears"]) }
		}
	}

	constant lions = Standing.blank(of "Lions")

	Terminal.inspect(lions::record(scored 2, conceded 0).points) § 3
	Terminal.inspect(lions::record(scored 1, conceded 1).points) § 1
	Terminal.inspect(outcomeOf(0, against 3)) § Outcome#Loss
}

export {
	Outcome
	Standing
}

tests {

	§ Setup is just values. Nothing here is a hook: a `constant` in a tests
	§ section is specified as indistinguishable from fresh evaluation for every
	§ test that can see it.
	constant lions  = Standing.blank(of "Lions")
	constant played = lions::record(scored 2, conceded 0)
	constant table  = [lions, Standing.blank(of "Tigers")]

	§ A suite groups tests and gives them a shared scope. Suites nest, and a
	§ Modifier written on one covers every test inside it.
	suite "Standing" {
		test "records a win as three points" {
			expect played.points::is(3)
			expect played.played::is(1)
		}

		§ There is no `toEqual`, no `toBeGreaterThan`: an assertion is any
		§ Boolean Expression, and the standard library's own Methods are the
		§ vocabulary.
		test "leaves the standing it was handed alone" {
			expect lions.points::is(0)
			expect lions::isNot(played)
		}

		§ `tagged` takes bare names. A test's effective tags are its own plus
		§ every enclosing suite's, and selection happens on the command line
		§ rather than in the source.
		test "sorts ten thousand rows in under a second" tagged slow, network {
			expect table::length()::isLessThan(10000)
		}

		§ The reason a `skipped` test carries is mandatory: a skip with no
		§ reason rots silently, and one with a reason is a TODO the report
		§ repeats on every run. It is still compiled and type-checked.
		test "renders a forfeit as 3–0"
			skipped "waiting on the Table redesign"
		{
			expect played.points::is(3)
		}

		suite "outcomeOf" tagged fast {
			test "calls a level score a draw" {
				expect outcomeOf(1, against 1)::is(#Draw)
			}

			§ While a `focused` test exists, only focused tests run — and a
			§ plain run says so with a non-zero exit code, so a stray one can
			§ not land unnoticed.
			test "calls a lower score a loss" focused {
				expect outcomeOf(0, against 3)::is(#Loss)
			}
		}
	}

	§ `require MATCHER = EXPR` is how a test takes a value apart, with the
	§ Matchers `match` already has. The Matcher stands where a Declaration's
	§ name stands, because that is where a name is introduced — and a failed
	§ one ends the test where it stands rather than letting the rest run
	§ against a value that was never there.
	§
	§ `expect` has no such form: it records its result and carries on, so one
	§ test can report several failures at once, and a name it introduced would
	§ stand below a line that may never have run.
	suite "taking a value apart" {
		test "reads the first row" {
			require #Value(first) = table::firstItem()

			expect first.team::is("Lions")
		}

		§ A Match Handler refuses `} as name` because `@` already names the
		§ whole value. An assertion has no `@`, so here the binder is how a
		§ test holds onto the whole of what it took apart — which is what the
		§ Pattern PROVED, the members it named and no others, exactly as `@` is
		§ inside a Handler.
		test "names the whole of what it takes apart" {
			require { team, points } as standing = lions

			expect team::is("Lions")
			expect points::is(0)
			expect standing.points::is(0)
		}

		§ Every kind of Matcher a `require` takes a value apart with, and what
		§ each one names: a Case's payload; the members a Pattern names, under
		§ their own name or at a Type; a member constrained by a written value,
		§ which names nothing; and a bare Case, which proves a shape and names
		§ nothing at all.
		test "takes a value apart with a Matcher of every kind" {
			require #Value(first) = table::firstItem()
			require { team: String, points = 0 } = first
			require #Empty = table::item(at 9)

			expect team::is("Lions")
		}

		§ Assertions are Statements, so they stand wherever a Statement does
		§ inside the test — an `if`, a Match Handler, any block but a Function
		§ literal's.
		test "asserts inside the blocks nested in it" {
			if table::hasItems() {
				expect table::length()::is(2)
			} else {
				expect false
			}

			expect match outcomeOf(2, against 0) -> Boolean {
				case #Win { <- true }
				case _    { <- false }
			}
		}
	}

	§ A name is a String so that it can say what the test proves — and an
	§ interpolated one, because a table test names each row out of the row's
	§ own values.
	constant scored   = 2
	constant conceded = 0

	test "{scored}–{conceded} is a win" {
		expect outcomeOf(scored, against conceded)::is(#Win)
	}

	§ A table test runs once per row of a written List. The rows are written
	§ where the test is because each of them is a test in its own right: it
	§ carries its row number as the last step of the identity everything
	§ durable is keyed by. The annotation on the row Parameter is what lets a
	§ bare Case stand in a row.
	test "{scored}–{conceded} scores {points}" across [
		{ scored = 2, conceded = 0, points = 3 },
		{ scored = 1, conceded = 1, points = 1 },
		{ scored = 0, conceded = 3, points = 0 },
	] ({ scored, conceded, points }: Scoreline) {
		expect pointsFor(outcomeOf(scored, against conceded))::is(points)
	}

	§ A row Parameter can simply name the row, and the rows themselves can be
	§ any Expression — it is the brackets that have to be written here.
	test "every standing starts blank" across [
		table::item(at 0),
		table::item(at 1),
	] (row: Optional<Standing>) {
		require #Value(standing) = row

		expect standing.played::is(0)
	}

	§ `matches snapshot` compares a value against one a run recorded. Written
	§ bare it is recorded INLINE — the first run writes the value back into the
	§ source through the formatter, and the diff is where it is reviewed.
	§ Written `from "name"` it is kept in `__snapshots__` beside the file, which
	§ is where output too large to read inline belongs.
	suite "snapshots" {
		test "renders a standing" {
			expect played.points::toString() matches snapshot "3"

			§ Written bare, a snapshot is one no run has recorded yet: the
			§ first run writes the value back here, through the formatter, so
			§ what lands in the file is formatted source. This one has run.
			expect played.team matches snapshot "Lions"
		}

		test "renders the whole table" {
			expect table matches snapshot from "the-table"
		}
	}

	§ A property test says what holds for EVERY value rather than for the ones
	§ a reader thought of. `for any` declares typed Parameters, and the runner
	§ generates a value of each Type once per case — a hundred of them by
	§ default, `--cases` for another number. A failure is shrunk to the smallest
	§ value that still fails and reported with the seed it was drawn from, so
	§ `--seed` runs it again exactly.
	suite "properties" {
		§ The generator is derived from the Type, structurally: a Record member
		§ by member, a Choice Case by Case, a List from its item Type.
		test "an outcome is worth what it scores" for any (
			scored: Integer,
			conceded: Integer,
		) {
			expect pointsFor(
				outcomeOf(scored, against conceded),
			)::isGreaterThanOrEqualTo(0)
		}

		§ A checked refinement is honoured: `NonEmptyList` is never empty and
		§ `NonZeroInteger` is never zero, because the generator holds the
		§ predicate rather than drawing values and hoping.
		test "a team always has a name" for any (
			names: NonEmptyList<String>,
			seats: NonZeroInteger,
		) {
			expect names::hasItems()
			expect seats::isNot(0)
		}

		§ A Choice generates every one of its Cases, and a shrink walks towards
		§ the ones that carry no payload.
		test "every outcome scores at most three" for any (outcome: Outcome) {
			expect pointsFor(outcome)::isLessThanOrEqualTo(3)
		}

		§ A Type whose values carry an invariant no structure can state
		§ conforms to `Generatable` instead, and that Namespace's own Method is
		§ what a case is drawn from.
		test "a supported team is one of ours" for any (team: Supported) {
			expect ["Lions", "Tigers", "Bears"]::contains(team.name)
		}
	}
}
