§ A season is data: the teams that played it and everything that happened
§ on the pitch, written down. Nothing here computes — `Standings.es` reads
§ this and works the table out, and `Main.es` asks the questions.

implementation {

	§ A team is a Record. Records compare structurally, so two mentions of the
	§ same team — in a fixture and in the team list — are `is` each other with
	§ nothing declared to make them so.
	type Team = { name: String, code: String }

	§ What can happen to a fixture. A match that was played carries its score;
	§ a forfeit names who conceded it; a postponement is a fixture without a
	§ result yet — and it is a Case of its own rather than an `Optional` score,
	§ because it is a different thing that happened, not a missing number.
	§
	§ A played fixture is nil-nil until somebody scores, which is what the
	§ payload default says: the goals may be left out of a construction, and a
	§ scoreline that writes one side's goals writes only that side's.
	choice Fixture {
		Played {
			home: Team,
			away: Team,
			homeGoals: Integer,
			awayGoals: Integer,
		} = { homeGoals = 0, awayGoals = 0 },
		Forfeited { by: Team, against: Team },
		Postponed { home: Team, away: Team },
	}

	§ A fixture prints itself the way a results page would, so a List of them
	§ joins into a page and a hole in a String takes one directly.
	namespace Fixture for Fixture is Printable {
		toString() -> String {
			<- match @ -> String {
				case #Played({ home, away, homeGoals, awayGoals }) {
					<- "{home.code} {homeGoals}–{awayGoals} {away.code}"
				}
				case #Forfeited({ by, against }) {
					<- "{by.code} forfeited to {against.code}"
				}
				case #Postponed({ home, away }) {
					<- "{home.code} v {away.code} — postponed"
				}
			}
		}

		§§ Both teams the fixture is between, home side first.
		teams() -> List<Team> {
			<- match @ -> List<Team> {
				case #Played({ home, away })     { <- [home, away] }
				case #Forfeited({ by, against }) { <- [by, against] }
				case #Postponed({ home, away })  { <- [home, away] }
			}
		}

		§§ Whether the fixture involves the given team, on either side.
		involves(_ team: Team) -> Boolean {
			<- @::teams()::contains(team)
		}
	}

	constant harbour    = { name = "Harbour Rovers", code = "HAR" }
	constant northfield = { name = "Northfield United", code = "NOR" }
	constant ashgrove   = { name = "Ashgrove Athletic", code = "ASH" }
	constant riverside  = { name = "Riverside", code = "RIV" }
	constant kestrel    = { name = "Kestrel Town", code = "KES" }
	constant quarry     = { name = "Old Quarry", code = "OLD" }

	§ `NonEmptyList` is a refinement of `List` — a List proven to have items.
	§ Writing the items down IS the proof, so the annotation holds without a
	§ check, and every consumer that needs "at least one team" can ask for
	§ this Type and never handle the empty case.
	constant teams: NonEmptyList<Team> = [
		harbour,
		northfield,
		ashgrove,
		riverside,
		kestrel,
		quarry,
	]

	§ A scoreline the way it is read out — home side, home goals, away goals,
	§ away side — so the season below reads like a results page.
	function result(
		_ home: Team,
		_ homeGoals: Integer,
		_ awayGoals: Integer,
		_ away: Team,
	) -> Fixture {
		<- #Played({ home, away, homeGoals, awayGoals })
	}

	§ The season so far, in the order it was played. The annotation on the
	§ List is what lets an entry write a bare `#Case` — the Choice is known
	§ from the Type, so no entry has to spell `Fixture#Forfeited`.
	constant fixtures: List<Fixture> = [
		§ Round 1
		result(harbour, 2, 1, northfield),
		result(ashgrove, 0, 0, riverside),
		result(kestrel, 3, 1, quarry),
		§ Round 2
		result(northfield, 1, 1, ashgrove),
		result(riverside, 2, 2, kestrel),
		result(quarry, 0, 4, harbour),
		§ Round 3
		result(harbour, 1, 0, ashgrove),
		result(kestrel, 1, 3, northfield),
		result(quarry, 1, 2, riverside),
		§ Round 4
		result(ashgrove, 2, 0, kestrel),
		result(northfield, 5, 0, quarry),
		result(riverside, 1, 1, harbour),
		§ Round 5 — Old Quarry could not raise a side against Ashgrove.
		result(harbour, 2, 3, kestrel),
		result(northfield, 0, 1, riverside),
		#Forfeited({ by = quarry, against = ashgrove }),
		§ Round 6
		result(ashgrove, 1, 1, quarry),
		result(kestrel, 0, 2, riverside),
		result(northfield, 2, 2, harbour),
		§ Round 7 — the return fixtures begin; one is still waiting for a date.
		result(riverside, 3, 1, ashgrove),
		result(harbour, 3, 0, quarry),
		#Postponed({ home = kestrel, away = northfield }),
	]
}

export {
	Fixture
	Team
	fixtures
	teams
}

tests {

	constant lions  = { name = "Lions", code = "LIO" }
	constant tigers = { name = "Tigers", code = "TIG" }

	suite "Fixture" {
		test "reads a played fixture out like a results page" {
			expect result(lions, 2, 1, tigers)::toString()::is("LIO 2–1 TIG")
		}

		test "names who conceded a forfeit" {
			expect #Forfeited({ by = lions, against = tigers })
				::toString()
				::is("LIO forfeited to TIG")
		}

		test "says a postponed fixture has no result yet" {
			expect #Postponed({ home = lions, away = tigers })
				::toString()
				::is("LIO v TIG — postponed")
		}

		§ Printable is what lets a hole in a String take a Fixture directly.
		test "prints itself into a String that holds one" {
			expect "Result: {result(lions, 3, 0, tigers)}"::is(
				"Result: LIO 3–0 TIG",
			)
		}

		test "names both sides of a fixture, home side first" {
			expect result(lions, 0, 0, tigers)::teams()::is([lions, tigers])
			expect #Forfeited({ by = lions, against = tigers })
				::teams()
				::is([lions, tigers])
			expect #Postponed({ home = tigers, away = lions })
				::teams()
				::is([tigers, lions])
		}

		test "knows which teams it is between, on either side" {
			constant fixture = result(lions, 1, 1, tigers)

			expect fixture::involves(lions)
			expect fixture::involves(tigers)
			expect fixture::involves({ name = "Bears", code = "BEA" })::negate()
		}

		§ The Case carries a payload default, so a fixture written without
		§ goals is nil-nil rather than a fixture missing a score.
		test "is nil-nil until somebody scores" {
			expect Fixture#Played({ home = lions, away = tigers })
				::toString()
				::is("LIO 0–0 TIG")
		}
	}

	suite "the season" {
		test "is played between six teams" {
			expect teams::length()::is(6)
			expect teams::map(.code)::contains("HAR")
		}

		test "has a fixture for every result written down" {
			expect fixtures::length()::is(21)
		}

		§ Every team named in a fixture is a team of this season — the two
		§ lists are written apart, and nothing but structural equality keeps
		§ them in step.
		test "is played by the teams it says it is" {
			expect fixtures::hasOnlyItems(where (fixture) {
				<- fixture
					::teams()
					::hasOnlyItems(where (team) { <- teams::contains(team) })
			})
		}

		test "carries the forfeit and the postponement it is known for" {
			expect fixtures::hasItems(where (fixture) {
				<- fixture::toString()::contains("forfeited")
			})
			expect fixtures::hasItems(where (fixture) {
				<- fixture::toString()::contains("postponed")
			})
		}
	}
}
