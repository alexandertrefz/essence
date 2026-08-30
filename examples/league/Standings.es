import {
	Fixture from "./Season.es"
	Team    from "./Season.es"
}

implementation {

	§ What one fixture was worth to one of its teams.
	choice Outcome {
		Win,
		Draw,
		Loss,
	}

	§ A form guide is a run of these — `WWDLW` — so an Outcome prints as its
	§ letter, and a List of them joins into the guide with no separator.
	namespace Outcome for Outcome is Printable {
		toString() -> String {
			<- match @ -> String {
				case #Win  { <- "W" }
				case #Draw { <- "D" }
				case #Loss { <- "L" }
			}
		}

		§§ Three for a win, one for a draw.
		points() -> Integer {
			<- match @ -> Integer {
				case #Win  { <- 3 }
				case #Draw { <- 1 }
				case #Loss { <- 0 }
			}
		}

		§§ One when this is the Outcome asked about, else zero — so a column
		§§ that counts wins is the same fold as the one that adds up points.
		counted(as expected: Outcome) -> Integer {
			if @::is(expected) {
				<- 1
			}

			<- 0
		}
	}

	§ One row of the table. Everything in it is derived from the fixtures, and
	§ nothing in it is ever changed: recording a result answers a NEW Standing
	§ with the counts moved on, which is what `{ @ with … }` is for.
	type Standing = {
		team: Team,
		played: Integer,
		won: Integer,
		drawn: Integer,
		lost: Integer,
		goalsFor: Integer,
		goalsAgainst: Integer,
		points: Integer,
		form: List<Outcome>,
	}

	§ A Standing is Comparable, and its `compare` IS the ranking rule: points,
	§ then goal difference, then goals scored, then the name. A Standing that
	§ ranks AHEAD compares `#Less`, so `sort()` puts the table in order without
	§ anyone passing a comparison — the conformance is where the rule lives.
	namespace Standing for Standing is Comparable, is Printable {
		compare(to other: Standing) -> Ordering {
			§ The tie-breakers, most important first. The first one that
			§ decides is the answer; the name breaks whatever is left, and it
			§ reads the other way — A before B — because it is the one order
			§ that is not "more is better".
			constant decisions = [
				other.points::compare(to @.points),
				other::goalDifference()::compare(to @::goalDifference()),
				other.goalsFor::compare(to @.goalsFor),
				@.team.name::compare(to other.team.name),
			]

			<- decisions
				::firstItem(where (decision) { <- decision::isNot(#Equal) })
				::value(defaultingTo #Equal)
		}

		toString() -> String {
			<- "{@.team.name} — {@.points} points from {@.played}"
		}

		goalDifference() -> Integer {
			<- @.goalsFor::subtract(@.goalsAgainst)
		}

		§§ Points per game, EXACT — 5/3 stays 5/3. A team that has not played
		§§ has no rate, so this is where the one division that can fail is
		§§ answered: the `if` proves `played` is not zero, and inside that
		§§ branch dividing by it can not fail, so the quotient is bare.
		pointsPerGame() -> Rational {
			constant played = @.played

			if played::isNot(0) {
				<- @.points::divide(by played)
			}

			<- 0/1
		}

		§§ The share of games won, exact for the same reason.
		winRate() -> Rational {
			constant played = @.played

			if played::isNot(0) {
				<- @.won::divide(by played)
			}

			<- 0/1
		}

		§§ The Standing after one more result — this team scored `scored` and
		§§ conceded `conceded`. Every count moves on in one Record update.
		record(scored: Integer, conceded: Integer) -> Standing {
			constant outcome = outcomeOf(scored, against conceded)

			<- {
				@ with
					played = @.played::add(1),
					won = @.won::add(outcome::counted(as #Win)),
					drawn = @.drawn::add(outcome::counted(as #Draw)),
					lost = @.lost::add(outcome::counted(as #Loss)),
					goalsFor = @.goalsFor::add(scored),
					goalsAgainst = @.goalsAgainst::add(conceded),
					points = @.points::add(outcome::points()),
					form = @.form::append(outcome),
			}
		}

		§§ The longest run of matches without a loss. The form is walked once
		§§ with a plain fold, carrying the current run and the best so far.
		unbeatenRun() -> Integer {
			constant runs = @.form::reduce(
				startingWith { current = 0, best = 0 },
				({ current, best }, outcome) {
					if outcome::is(#Loss) {
						<- { current = 0, best }
					}

					constant extended = current::add(1)

					<- {
						current = extended,
						best = Number.highestNumber(best, extended),
					}
				},
			)

			<- runs.best
		}

		§§ The last `count` outcomes, oldest first — the form guide, which is
		§§ five long unless asked otherwise.
		recentForm(_ count: Integer = 5) -> List<Outcome> {
			§ A count is lenient here as everywhere in the library, so a form
			§ shorter than the count is answered whole. The alternative is
			§ `slice(from length::subtract(count))`, which needs a guard of
			§ its own: the subtraction goes negative on a short form, and a
			§ negative position counts back from the end.
			<- @.form::lastItems(count)
		}
	}

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

	§ A forfeit is recorded as this scoreline, in the offended side's favour.
	constant forfeitGoals = 3

	namespace Standings {
		§§ The row a team starts the season on. Every count starts at zero and
		§§ the form is empty, so the default fills eight of the nine members in
		§§ and a caller writes the team alone.
		§§
		§§ @param of — the row, of which only the team has to be written.
		§§ @returns — the row.
		static blank(
			of row: Standing = {
				played = 0,
				won = 0,
				drawn = 0,
				lost = 0,
				goalsFor = 0,
				goalsAgainst = 0,
				points = 0,
				form = [],
			},
		) -> Standing {
			<- row
		}

		§§ The table as it stands after these fixtures, in the order the teams
		§§ were given — `ranked` puts it in table order. A postponed fixture
		§§ has nothing to record and changes no row.
		§§
		§§ The rows are held in a Dictionary keyed by the team while they are
		§§ being worked out, so the season is walked ONCE and each fixture
		§§ reaches the two rows it changes. A Match on the Fixture takes each
		§§ Case apart into exactly the names it needs, and `update(at:with:)`
		§§ answers the Dictionary it was handed where the key holds nothing —
		§§ so a fixture between teams this table is not about changes nothing,
		§§ which is what an `else` had to say when every row was asked about
		§§ every fixture.
		static compute(
			from fixtures: List<Fixture>,
			among teams: NonEmptyList<Team>,
		) -> NonEmptyList<Standing> {
			§ A Team is a Record, and a Record is a key like any other: it is
			§ found by asking the Record's own `is`. `Dictionary.of` builds
			§ the starting table out of the entries a caller already has in
			§ hand — one blank row per team, in the order they were given.
			constant blanks = Dictionary.of(
				teams::map((team) {
					<- { key = team, value = Standings.blank(of { team }) }
				}),
			)

			constant rows = fixtures::reduce(
				startingWith blanks,
				(table, fixture) {
					<- match fixture -> Dictionary<Team, Standing> {
						case #Played({ home, away, homeGoals, awayGoals }) {
							<- table
								::update(at home, with (standing) {
									<- standing::record(
										scored homeGoals,
										conceded awayGoals,
									)
								})
								::update(at away, with (standing) {
									<- standing::record(
										scored awayGoals,
										conceded homeGoals,
									)
								})
						}
						case #Forfeited({ by, against })                   {
							<- table
								::update(at by, with (standing) {
									<- standing::record(
										scored 0,
										conceded forfeitGoals,
									)
								})
								::update(at against, with (standing) {
									<- standing::record(
										scored forfeitGoals,
										conceded 0,
									)
								})
						}
						case #Postponed                                    {
							<- table
						}
					}
				},
			)

			§ The rows read back in the order the teams were given, which is
			§ the order they were set in and so the order the Dictionary holds
			§ them. Reading them out through the teams rather than through
			§ `values()` is what carries the proof: a `map` over a List with
			§ something in it answers a List with something in it, and the
			§ fallback is the row a team the season never mentions would have.
			<- teams::map((team) {
				<- rows::value(
					at team,
					defaultingTo Standings.blank(of { team }),
				)
			})
		}

		§§ The rows in table order. `sort()` needs no comparison written here:
		§§ Standing is Comparable, and its `compare` is the ranking rule. The
		§§ proof of having items survives the sort, which is what lets
		§§ `leader(of:)` answer a Standing rather than an Optional.
		static ranked(
			_ standings: NonEmptyList<Standing>,
		) -> NonEmptyList<Standing> {
			<- standings::sort()
		}

		§§ The team at the top. A table with no rows has no leader, and this
		§§ Parameter's Type says there is no such table — so there is no
		§§ empty case to handle and `firstItem` answers the row itself.
		static leader(of table: NonEmptyList<Standing>) -> Standing {
			<- table::firstItem()
		}
	}
}

export {
	Outcome
	Standing
	Standings
}

tests {

	§ Setup is just values. Nothing here is a hook: a `constant` in a tests
	§ section is indistinguishable from fresh evaluation for every test that
	§ can see it, so no test can be changed by one that ran before it.
	constant lions  = { name = "Lions", code = "LIO" }
	constant tigers = { name = "Tigers", code = "TIG" }
	constant blank  = Standings.blank(of { team = lions })

	suite "Standing" {
		test "records a win as three points" {
			constant standing = blank::record(scored 2, conceded 0)

			expect standing.points::is(3)
			expect standing.won::is(1)
			expect standing.form::is([#Win])
		}

		test "records a draw as one point and no win" {
			constant standing = blank::record(scored 1, conceded 1)

			expect standing.points::is(1)
			expect standing.won::is(0)
			expect standing.drawn::is(1)
		}

		test "leaves the standing it was handed alone" {
			expect blank::record(scored 2, conceded 0)::isNot(blank)
			expect blank.played::is(0)
		}

		test "has no rate before it has played" {
			expect blank::pointsPerGame()::is(0/1)
			expect blank::winRate()::is(0/1)
		}

		test "answers points per game exactly" {
			constant played = blank
				::record(scored 2, conceded 0)
				::record(scored 1, conceded 1)
				::record(scored 0, conceded 3)

			expect played::pointsPerGame()::is(4/3)
			expect played::winRate()::is(1/3)
		}

		test "counts the longest run without a loss" {
			constant played = blank
				::record(scored 2, conceded 0)
				::record(scored 1, conceded 1)
				::record(scored 0, conceded 3)
				::record(scored 3, conceded 0)
				::record(scored 1, conceded 0)

			expect played::unbeatenRun()::is(2)
		}

		test "shows the last five outcomes as the form guide" {
			constant played = blank
				::record(scored 1, conceded 0)
				::record(scored 0, conceded 1)
				::record(scored 0, conceded 1)
				::record(scored 1, conceded 1)
				::record(scored 2, conceded 0)
				::record(scored 3, conceded 0)

			expect played::recentForm()::length()::is(5)
			expect played::recentForm()::join(with "")::is("LLDWW")
		}

		test "shows every outcome it has, where it has fewer than five" {
			constant played = blank
				::record(scored 1, conceded 0)
				::record(scored 0, conceded 1)

			expect played::recentForm()::join(with "")::is("WL")
		}

		test "shows as many as it is asked for" {
			constant played = blank
				::record(scored 1, conceded 0)
				::record(scored 0, conceded 1)
				::record(scored 1, conceded 1)

			expect played::recentForm(2)::join(with "")::is("LD")
		}

		§ Standing is Comparable, and its `compare` IS the ranking rule — so
		§ the order a sort puts two rows in is the order the table has them in.
		test "ranks more points ahead of fewer" {
			constant leader   = blank::record(scored 3, conceded 0)
			constant follower = Standings.blank(of { team = tigers })::record(
				scored 1,
				conceded 1,
			)

			expect leader::compare(to follower)::is(#Less)
		}
	}

	suite "outcomeOf" {
		§ `outcomeOf` is a private Function of this file — testable anyway,
		§ which is the point of a tests section rather than a file beside it.
		test "calls a higher score a win" {
			expect outcomeOf(2, against 1)::is(#Win)
		}

		test "calls a level score a draw" {
			expect outcomeOf(1, against 1)::is(#Draw)
		}

		test "calls a lower score a loss" {
			expect outcomeOf(0, against 3)::is(#Loss)
		}
	}

	suite "Standings" {
		test "records a forfeit as three nil to the offended side" {
			constant table = Standings.compute(
				from [#Forfeited({ by = lions, against = tigers })],
				among [lions, tigers],
			)

			require #Value(conceder) = table::item(at 0)
			require #Value(awarded) = table::item(at 1)

			expect conceder.goalsAgainst::is(3)
			expect conceder.points::is(0)
			expect awarded.goalsFor::is(3)
			expect awarded.points::is(3)
		}

		test "changes no row for a postponed fixture" {
			constant table = Standings.compute(
				from [#Postponed({ home = lions, away = tigers })],
				among [lions, tigers],
			)

			expect Standings.leader(of table).played::is(0)
		}

		test "puts the table in order" {
			constant fixtures: List<Fixture> = [
				#Played({
					home = lions,
					away = tigers,
					homeGoals = 0,
					awayGoals = 2,
				}),
			]
			constant table = Standings.ranked(
				Standings.compute(from fixtures, among [lions, tigers]),
			)

			expect Standings.leader(of table).team::is(tigers)
		}
	}
}
