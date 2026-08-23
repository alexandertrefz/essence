§ A file that is nothing but imports and a `tests { … }` block. It is the same
§ construct `Standings.es` writes at the bottom of itself; what it is for is the
§ questions that cross Modules — the season as data, the rules that read it, and
§ the table both of them produce together.

import {
	Fixture   from "./Season.es"
	fixtures  from "./Season.es"
	teams     from "./Season.es"
	Standing  from "./Standings.es"
	Standings from "./Standings.es"
	Decimal   from "./Table.es"
	Table     from "./Table.es"
}

tests {
	constant table  = Standings.ranked(
		Standings.compute(from fixtures, among teams),
	)
	constant leader = Standings.leader(of table)

	suite "the season as it stands" {
		test "is led by Riverside" {
			expect leader.team.name::is("Riverside")
			expect leader.points::is(15)
		}

		test "gives the leader no rival on points" {
			expect table
				::everyItem(where (standing) {
					<- standing.points::isLessThanOrEqualTo(leader.points)
				})
				::length()
				::is(table::length())
		}

		test "puts the leader one point clear of the second row" {
			require #Value(second) = table::item(at 1)

			expect leader.points::subtract(second.points)::is(1)
		}

		test "counts a postponed fixture for nobody" {
			require #Value(kestrel) = table::firstItem(where (standing) {
				<- standing.team.code::is("KES")
			})

			expect kestrel.played::is(6)
		}

		test "gives the forfeit to Ashgrove and takes it off Old Quarry" {
			require #Value(quarry) = table::firstItem(where (standing) {
				<- standing.team.code::is("OLD")
			})

			expect quarry.lost::is(6)
			expect quarry.points::is(1)
		}

		test "leaves every row with as many results as it played" {
			expect table
				::everyItem(where (standing) {
					<- standing.form::length()::is(standing.played)
				})
				::length()
				::is(table::length())
		}

		§ The longest unbeaten run of the season — a question each row answers
		§ about itself, asked of every row at once.
		test "has Riverside unbeaten all season" {
			constant longest = table::highestItem(on (standing) {
				<- standing::unbeatenRun()
			})

			expect longest.team.name::is("Riverside")
			expect longest::unbeatenRun()::is(7)
		}

		§ An exact aggregate over exact rates — the whole league's mean points
		§ per game, which stays a fraction because nothing has rounded it.
		test "averages the league's rates without rounding any of them" {
			expect table
				::map((standing) { <- standing::pointsPerGame() })
				::average()
				::is(113/84)
		}
	}

	suite "a supposed season" {
		§ One fixture is still to be played. The supposed season is a NEW List
		§ and the real one is untouched, which is what lets both tables exist
		§ at once and be compared.
		constant supposed: List<Fixture> = fixtures::map((fixture) {
			<- match fixture -> Fixture {
				case #Postponed({ home, away }) {
					<- #Played({ home, away, homeGoals = 2 })
				}
				case #Played                    { <- @ }
				case #Forfeited                 { <- @ }
			}
		})
		constant supposedTable = Standings.ranked(
			Standings.compute(from supposed, among teams),
		)

		test "leaves the real season alone" {
			expect table::is(
				Standings.ranked(Standings.compute(from fixtures, among teams)),
			)
		}

		test "still has Riverside leading" {
			expect Standings.leader(of supposedTable)::is(leader)
		}

		test "moves three rows" {
			expect table
				::pair(with supposedTable)
				::count(where ({ first, second }) {
					<- first.team::isNot(second.team)
				})
				::is(3)
		}
	}

	suite "the table as text" {
		test "writes the leader into the first row" {
			expect Table.row(leader, at 1)::contains("Riverside")
			expect Table.row(leader, at 1)::contains("WDWWW")
		}

		§ Every column of a row, to the character. What a table IS is its
		§ alignment, and a test that only asks whether a name appears would
		§ pass on a table nobody could read.
		test "lines every column of a row up under its heading" {
			constant rendered = Table.render(table, titled "After round 7")
			constant lines    = rendered::split(on "\n")

			require #Value(header) = lines::item(at 2)
			require #Value(first) = lines::item(at 3)

			expect header::is(
				" #  Team                P  W  D  L     F:A   GD  Pts  Form",
			)
			expect first::is(
				" 1  Riverside           7  4  3  0    11:5   +6   15  WDWWW",
			)
		}

		test "rules the header off across the whole width" {
			constant lines = Table.render(table, titled "After round 7")::split(
				on "\n",
			)

			require #Value(rule) = lines::item(at 1)
			require #Value(header) = lines::item(at 2)

			expect rule::is("-"::repeat(times header::length()))
		}

		test "titles the table it renders" {
			expect Table.render(table, titled "After round 7")::starts(
				with "After round 7",
			)
		}

		test "renders a row for every Standing it is handed" {
			expect Table.render(table, titled "After round 7")
				::split(on "\n")
				::length()
				::is(table::length()::add(3))
		}

		§ Every rate stays exact until it is written down, and this is the one
		§ place a number is rounded.
		test "rounds a rate once, at the very end" {
			expect Decimal.formatted(leader::pointsPerGame())::is("2.14")
			expect Decimal.formatted(
				leader::winRate()::multiply(with 100),
				places 0,
			)::is("57")
		}
	}
}
