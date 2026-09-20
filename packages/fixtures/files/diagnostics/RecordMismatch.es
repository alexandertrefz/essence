§ Deliberately broken: what the Compiler says when one Record does not fit
§ another. Two shapes printed side by side is a diff the reader has to do by
§ eye, and the one thing the Compiler knows and they do not — WHICH member
§ disagrees — is what neither line says. So every report here names members.
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/RecordMismatch.es
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it was
§ showcasing no longer has a home.

implementation {
	type Team = { name: String, code: String }
	type Standing = {
		team: Team,
		played: Integer,
		won: Integer,
		drawn: Integer,
		lost: Integer,
		goalsFor: Integer,
		goalsAgainst: Integer,
		points: Integer,
		form: List<String>,
	}

	§ One misspelled member and one of the wrong Type, in a Record of nine. The
	§ report leads with the member that was refused rather than with the whole
	§ value, and `form = []` is no mismatch at all — an empty List fits the List
	§ it is written into.
	function blank(of team: Team) -> Standing {
		<- {
			team = team,
			played = 0,
			won = 0,
			drawn = 0,
			lost = 0,
			goalsFor = 0,
			goalAgainst = 0,
			points = "0",
			form = [],
		}
	}

	§ A member of a member, named at the depth it is wrong at and against the
	§ Alias that DECLARES it.
	constant nested: Standing = {
		team = { name = "Rovers", code = 1 },
		played = 0,
		won = 0,
		drawn = 0,
		lost = 0,
		goalsFor = 0,
		goalsAgainst = 0,
		points = 0,
		form = [],
	}

	§ Members nobody wrote. There is nothing inside the Literal to point at, so
	§ the Literal itself carries the Label — and the Label says which members.
	constant short: Standing = { team = { name = "Rovers", code = "ROV" } }

	§ A Union of Records is diffed against the one the value is closest to, and
	§ the report says which.
	type Circle = { radius: Integer, filled: Boolean }
	type Rect = { width: Integer, height: Integer }

	constant shape: Circle | Rect = { radius = 1, filled = 1 }
}
