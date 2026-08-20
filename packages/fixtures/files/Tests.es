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

	constant lions = Standing.blank(of "Lions")

	Terminal.inspect(lions::record(scored 2, conceded 0).points) § 3
	Terminal.inspect(lions::record(scored 1, conceded 1).points) § 1
	Terminal.inspect(outcomeOf(0, against 3)) § Outcome#Loss
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
}

export {
	Outcome
	Standing
}
