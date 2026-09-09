import {
	from "./Standings.es" {
		Outcome
		Standing
		Standings
	}
}

implementation {

	§ A column of the table: what it is headed with, which end its cells are
	§ padded at, and how wide it is. Padding at `#Start` puts a cell against
	§ the RIGHT edge of its column, which is where a number reads; text is
	§ padded at the end and reads from the left. The width written here is
	§ nothing — `render` measures every column against the cells that stand
	§ in it.
	type Column = { heading: String, padded: Side, width: Integer }

	function column(_ heading: String, padded side: Side = #Start) -> Column {
		<- { heading, padded = side, width = 0 }
	}

	§ The table, declared as its columns. Adding one here and a cell for it in
	§ `Table.cells` is the whole of adding a column: nothing else knows how
	§ many there are or how wide any of them is.
	constant columns: List<Column> = [
		column("#"),
		column("Team", padded #End),
		column("P"),
		column("W"),
		column("D"),
		column("L"),
		column("F:A"),
		column("GD"),
		column("Pts"),
		column("Form", padded #End),
	]

	§ One line of the table: every cell padded to the width its column was
	§ measured at, with two spaces between columns. The last column is padded
	§ like every other and then trimmed back off, so no line ends in a space.
	function line(_ cells: List<String>, in measured: List<Column>) -> String {
		<- cells
			::pair(with measured)
			::map(({ first as cell, second as column }) {
				<- cell::pad(to column.width, at column.padded)
			})
			::join(with "  ")
			::trim(at #End)
	}

	namespace Table {
		§§ The table as text: a title, a header, and one row per Standing in
		§§ the order given — so it renders whatever order it is handed, and
		§§ `Standings.ranked` is what makes that the league order.
		static render(
			_ standings: NonEmptyList<Standing>,
			titled title: String,
		) -> String {
			§ `enumerate` walks the rows beside the positions they stand at,
			§ and a table counts from one where a List counts from zero.
			constant rows = standings
				::enumerate()
				::map(({ index, item }) {
					<- Table.cells(item, at index::add(1))
				})

			§ The headings and the rows are one grid, and `transpose` turns
			§ that grid into one List per column — so a column is measured
			§ against everything that stands in it, its own heading included.
			§ No width is written down anywhere, which is what makes renaming
			§ a team move the whole table.
			constant grid = [columns::map(.heading)]::append(contentsOf rows)

			constant measured = grid::transpose()
				::pair(with columns)
				::map(({ first as cells, second as column }) {
					<- {
						column with
							width = cells
								::map((cell) { <- cell::length() })
								::highestNumber(defaultingTo 0),
					}
				})

			constant header = line(columns::map(.heading), in measured)

			<- [title, "-"::repeat(times header::length()), header]
				::append(
					contentsOf rows::map((cells) {
						<- line(cells, in measured)
					}),
				)
				::join(with "\n")
		}

		§§ One row, as its cells in column order — how wide each of them sits
		§§ is `render`'s business. The five most recent outcomes are the form
		§§ guide, and a goal difference reads with its sign, zero included.
		static cells(
			_ standing: Standing,
			at position: Integer,
		) -> List<String> {
			<- [
				"{position}",
				standing.team.name,
				"{standing.played}",
				"{standing.won}",
				"{standing.drawn}",
				"{standing.lost}",
				"{standing.goalsFor}:{standing.goalsAgainst}",
				standing::goalDifference()::toString(showingSign #Always),
				"{standing.points}",
				standing::recentForm()::join(with ""),
			]
		}
	}
}

export {
	Table
}

tests {

	constant longNamed = Standings.blank(of {
		team = { name = "Association Sportive", code = "ASS" },
	})

	suite "Table" {
		§ Nothing writes a width down, so the widest cell in a column is what
		§ the column is: a name nobody planned for widens it and every row
		§ moves with it, where a written width would have cut it off.
		test "makes every column as wide as the widest cell in it" {
			constant lines = Table.render([longNamed], titled "One row")
				::split(on "\n")

			require #Value(header) = lines::item(at 2)
			require #Value(row) = lines::item(at 3)

			expect header::starts(with "#  Team                  P")
			expect row::starts(with "1  Association Sportive  0")
		}

		§ A goal difference reads with its sign, and a table that has not been
		§ played is all zeroes — `+0` rather than `0`.
		test "writes a goal difference with its sign" {
			expect Table.cells(longNamed, at 1)::contains("+0")
		}
	}
}
