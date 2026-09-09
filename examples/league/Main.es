import {
	from "./Season.es" {
		Fixture
		fixtures
		teams
	}
	from "./Standings.es" {
		Standing
		Standings
	}
	from "./Table.es" { Table }
}

implementation {

	§ The season is data (`Season.es`), the rules are Methods (`Standings.es`)
	§ and this file asks the questions. Nothing below changes anything: every
	§ answer is a new value computed from the ones before, and the season it
	§ was computed from is exactly what it was.

	§ "1 point", "3 points" — the plural is the noun with an s, which is all
	§ this Program needs.
	function counted(_ count: Integer, _ noun: String) -> String {
		if count::is(1) {
			<- "{count} {noun}"
		}

		<- "{count} {noun}s"
	}

	constant standings = Standings.compute(from fixtures, among teams)
	constant table     = Standings.ranked(standings)

	Terminal.print(Table.render(table, titled "After round 7"))
	Terminal.print("")

	§ The top of the table. `leader(of:)` answers a Standing, not an Optional:
	§ the table's Type says it has rows. The second row is asked for by index,
	§ which any List answers with an Optional — and there is a fallback the
	§ Program can stand behind, so the `defaultingTo:` entry is the one to
	§ call, and the row comes back bare.
	constant leader = Standings.leader(of table)
	constant second = table::item(at 1, defaultingTo leader)

	Terminal.print(
		"{leader.team.name} lead {second.team.name} by {
			counted(leader.points::subtract(second.points), "point")
		}.",
	)

	§ Points per game, exact — the fraction is the true value and the decimal
	§ is how it is written down, rounded once, at the very end. `toPlaces:`
	§ says how many digits to write after the point, and a count below one
	§ writes the whole number with no point at all.
	constant rate = leader::pointsPerGame()

	Terminal.print(
		"They average {rate} points a game — {
			rate::toString(as #Decimal, toPlaces 2)
		} to two places — and have won {
			leader::winRate()::multiply(with 100)::toString(as #Decimal, toPlaces 0)
		}% of their matches.",
	)
	Terminal.print("")

	§ The biggest win of the season. Only a played match has a margin, so the
	§ Match answers one where there is one and nothing where there is not, and
	§ `everyValue(from:)` is the walk that keeps what is there — a map and a
	§ filter in one, without the List of Optionals in between.
	§ `highestItem(on:)` then asks the question outright, reading the key with
	§ a member path — a Record has no natural order of its own, and the margin
	§ inside it does.
	type Margin = { fixture: Fixture, margin: Integer }

	constant margins: List<Margin> = fixtures::everyValue(from (fixture) {
		<- match fixture -> Optional<Margin> {
			case #Played({ homeGoals, awayGoals }) {
				<- #Value({
					fixture,
					margin = homeGoals::subtract(awayGoals)::absolute(),
				})
			}
			case #Forfeited { <- #Empty }
			case #Postponed { <- #Empty }
		}
	})

	constant widest = margins::highestItem(on .margin)

	Terminal.print(match widest -> String {
		case #Value({ fixture, margin }) {
			<- "Biggest win: {fixture}, by {counted(margin, "goal")}."
		}
		case #Empty { <- "No match has been played." }
	})

	§ The longest unbeaten run — a question each row answers about itself,
	§ and `highestItem(on:)` asks it of every row. The table is a
	§ NonEmptyList, so the answer is a Standing and not an Optional.
	constant longestRun = table::highestItem(on (standing) {
		<- standing::unbeatenRun()
	})

	Terminal.print(
		"Longest unbeaten run: {longestRun.team.name}, {
			counted(longestRun::unbeatenRun(), "game")
		}.",
	)
	Terminal.print("")

	§ Head to head between the top two. `involves` is a Method of the Fixture
	§ Choice, so it reads the same whichever Case the fixture is; and a
	§ Fixture is Printable, so the matches print themselves.
	Terminal.print("{leader.team.name} v {second.team.name} this season:")

	fixtures
		::everyItem(where (fixture) {
			<- fixture
				::involves(leader.team)
				::and(fixture::involves(second.team))
		})
		::map((fixture) { <- Terminal.print("  {fixture}") })

	Terminal.print("")

	§ What if. One fixture is still to be played; suppose Kestrel Town win it
	§ 2–0. The supposed season is a NEW List — the postponed entry mapped to
	§ a played one, every other entry carried as it was — and the table it
	§ produces stands beside the real one. The real season is untouched, and
	§ the two tables can be compared because both still exist.
	constant supposed = fixtures::map((fixture) {
		<- match fixture -> Fixture {
			case #Postponed({ home, away }) {
				<- #Played({ home, away, homeGoals = 2 })
			}
			case #Played    { <- @ }
			case #Forfeited { <- @ }
		}
	})

	constant supposedTable = Standings.ranked(
		Standings.compute(from supposed, among teams),
	)

	Terminal.print(Table.render(supposedTable, titled "If Kestrel win 2–0"))
	Terminal.print("")

	§ Both leaders exist at once; comparing them is comparing two values.
	constant supposedLeader = Standings.leader(of supposedTable)

	if supposedLeader::is(leader) {
		Terminal.print("{leader.team.name} would still lead.")
	} else {
		Terminal.print(
			"{supposedLeader.team.name} would lead instead of {leader.team.name}.",
		)
	}

	§ Rows that would move: pair the two tables position by position and
	§ count the pairs whose teams differ.
	constant moved = table
		::pair(with supposedTable)
		::count(where ({ first, second }) { <- first.team::isNot(second.team) })

	Terminal.print("{counted(moved, "row")} would change hands.")

	§ The whole league's mean points per game — an exact aggregate over exact
	§ rates. The mean of an empty List has no answer, but the table is a
	§ NonEmptyList and `map` carries the proof, so the List of rates is one
	§ too and its `average` is bare: there is no empty case to answer.
	constant meanRate = table
		::map((standing) { <- standing::pointsPerGame() })
		::average()

	Terminal.print("League-wide points per game: {meanRate}.")
}
