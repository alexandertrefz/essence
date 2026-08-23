implementation {

	§ A board is four rows of four tiles; `0` is an empty square. It is a
	§ plain List of Lists, and everything below answers a NEW board — nothing
	§ is ever moved in place, which is what makes undo free: the board before
	§ a move is a value that still exists.
	type Board = List<List<Integer>>

	type Cell = { row: Integer, column: Integer }

	§ The four ways a player can push. No payloads, so on the JavaScript side
	§ each Case is its bare name — `"Up"` — which is what an arrow key already
	§ says.
	choice Direction {
		Up,
		Down,
		Left,
		Right,
	}

	§ What sliding answers: the tiles after the slide, the points the merges
	§ along the way were worth, and where every tile that ended up somewhere
	§ came from — a merged tile from two places — which is what lets a page
	§ animate the push rather than redraw it.
	type Placed = { value: Integer, sources: List<Integer> }

	type Slid = { cells: List<Integer>, gained: Integer, placed: List<Placed> }

	§ One tile's journey under a push. A tile that did not move is not one.
	type Movement = { from: Cell, to: Cell }

	type Pushed = { board: Board, gained: Integer, movements: List<Movement> }

	§ The state a slide carries from tile to tile: the tiles placed so far —
	§ each with the positions it was made from — the points gained, and
	§ whether the last tile placed may still take a partner.
	type Merging = { placed: List<Placed>, gained: Integer, open: Boolean }

	constant nothingMerged: Merging = { placed = [], gained = 0, open = false }

	constant size = 4

	constant last = size::subtract(1)

	constant indices = List.of(integersFrom 0, through last)

	§ The annotation is what tells `#Up` apart from the standard library's
	§ `Rounding#Up`.
	constant directions: List<Direction> = [#Up, #Down, #Left, #Right]

	§ The two turns of the board, on a Cell — each is its own inverse, so
	§ the same Function takes a Cell into the turned board and back out.
	function mirrored(_ cell: Cell) -> Cell {
		<- { cell with column = last::subtract(cell.column) }
	}

	function transposed(_ cell: Cell) -> Cell {
		<- { row = cell.column, column = cell.row }
	}

	function turned(
		_ pushed: Pushed,
		by turn: (_ cell: Cell) -> Cell,
	) -> Pushed {
		<- {
			pushed with
				movements = pushed.movements::map(({ from, to }) {
					<- { from = turn(from), to = turn(to) }
				}),
		}
	}

	§ Every move is one row sliding toward its start; the other three
	§ directions are this one, seen through a mirror or a transpose.
	namespace Row for List<Integer> {
		§§ The row pushed toward its start. Tiles close up, equal neighbours
		§§ merge once — `[2, 2, 2, 2]` is `[4, 4, 0, 0]`, never `[8, 0, 0, 0]`
		§§ — and the row is padded back to its length.
		slide() -> Slid {
			§ Each tile beside the position it started at.
			constant tiles = @::pair(with indices)
				::everyItem(where ({ first }) { <- first::isNot(0) })

			§ One walk over the tiles. `open` is false right after a merge, so
			§ a tile merges once.
			constant merged = tiles::reduce(
				startingWith nothingMerged,
				(
					{ placed, gained, open },
					{ first as tile, second as origin },
				) {
					constant previous = placed::lastItem()

					§ `lastItem` is an Optional; a Match takes it apart, and
					§ the merge happens only where the last placed tile is
					§ open and holds this value.
					<- match previous -> Merging {
						case #Value({ value, sources }) where open::and(
							value::is(tile),
						) {
							constant doubled = tile::multiply(with 2)

							<- {
								placed = placed
									::removeLast()
									::append({
										value = doubled,
										sources = sources::append(origin),
									}),
								gained = gained::add(doubled),
								open = false,
							}
						}
						case _ {
							<- {
								placed = placed::append({
									value = tile,
									sources = [origin],
								}),
								gained,
								open = true,
							}
						}
					}
				},
			)

			constant values  = merged.placed::map(.value)
			constant padding = List.repeat(
				0,
				times size::subtract(values::length()),
			)

			<- {
				cells = values::append(contentsOf padding),
				gained = merged.gained,
				placed = merged.placed,
			}
		}
	}

	namespace Board for Board {
		static empty: Board = List.repeat(
			List.repeat(0, times size),
			times size,
		)

		§§ Rows become columns.
		transpose() -> Board {
			constant board = @

			<- indices::map((column) {
				<- board::map((row) { <- row::item(at column, defaultingTo 0) })
			})
		}

		§§ Every row reversed.
		mirror() -> Board {
			<- @::map((row) { <- row::reverse() })
		}

		§§ The board after every row slides toward its start, with the points
		§§ and every tile's journey — a source that is already where the tile
		§§ ended up is no journey.
		slideRows() -> Pushed {
			constant slid = @::map((row) { <- row::slide() })

			constant movements = slid::pair(with indices)
				::map(({ first as { placed }, second as row }) {
					<- placed
						::pair(with indices)
						::map(({ first as { sources }, second as column }) {
							<- sources
								::everyItem(where (source) {
									<- source::isNot(column)
								})
								::map((source) {
									<- {
										from = { row, column = source },
										to = { row, column },
									}
								})
						})
						::flatten()
				})
				::flatten()

			<- {
				board = slid::map(.cells),
				gained = slid::sum(on .gained),
				movements,
			}
		}

		§§ The board pushed in a direction. Left is the slide itself; the
		§§ others turn the board so that their push IS a slide left, slide,
		§§ and turn it back — the same turn, because each is its own inverse
		§§ — and every journey is turned back with it.
		slide(toward direction: Direction) -> Pushed {
			constant board = @

			<- match direction -> Pushed {
				case #Left { <- board::slideRows() }
				case #Right {
					constant slid = board::mirror()::slideRows()

					<- turned(
						{ slid with board = slid.board::mirror() },
						by mirrored,
					)
				}
				case #Up {
					constant slid = board::transpose()::slideRows()

					<- turned(
						{ slid with board = slid.board::transpose() },
						by transposed,
					)
				}
				case #Down {
					constant slid = board::transpose()::mirror()::slideRows()

					§ Two turns going in, so two coming out, in reverse.
					<- turned(
						turned(
							{
								slid with
									board = slid.board::mirror()::transpose(),
							},
							by mirrored,
						),
						by transposed,
					)
				}
			}
		}

		§§ Every empty square, row by row — where a new tile may go. The
		§§ host picks one; this side has no dice, and needs none.
		emptyCells() -> List<Cell> {
			<- @::pair(with indices)
				::map(({ first as row, second as rowIndex }) {
					<- row::pair(with indices)
						::everyItem(where ({ first }) { <- first::is(0) })
						::map(({ second }) {
							<- { row = rowIndex, column = second }
						})
				})
				::flatten()
		}

		§§ The board with one tile set. A cell off the board changes nothing.
		place(_ value: Integer, at cell: Cell) -> Board {
			<- @::pair(with indices)
				::map(({ first as row, second as rowIndex }) {
					if rowIndex::is(cell.row) {
						<- row::replace(value, at cell.column)
					}

					<- row
				})
		}

		§§ The highest tile on the board.
		highest() -> Integer {
			<- @::flatten()::highestNumber(defaultingTo 0)
		}

		§§ Whether any push would change the board. Lists compare by value, so
		§§ "would change" is "is not the same List".
		hasMoves() -> Boolean {
			constant board = @

			<- directions::hasItems(where (direction) {
				<- board::slide(toward direction).board::isNot(board)
			})
		}
	}
}

export {
	Board
	Cell
	Direction
	Movement
	Row
}

tests {

	§ A board is written the way it looks: four rows of four, `0` for a square
	§ with nothing on it.
	constant twoTiles: Board = [
		[2, 0, 0, 2],
		[0, 0, 0, 0],
		[0, 0, 0, 0],
		[0, 0, 0, 0],
	]

	§ Full, and no two neighbours equal — the one board a push cannot change.
	constant locked: Board = [
		[2, 4, 2, 4],
		[4, 2, 4, 2],
		[2, 4, 2, 4],
		[4, 2, 4, 2],
	]

	suite "Row" {
		test "closes the gaps a row has in it" {
			constant slid = [0, 2, 0, 4]::slide()

			expect slid.cells::is([2, 4, 0, 0])
			expect slid.gained::is(0)
		}

		§ The rule the whole game turns on: four equal tiles are two merges,
		§ never one merge and then another on top of it.
		test "merges each pair once, and never twice" {
			constant slid = [2, 2, 2, 2]::slide()

			expect slid.cells::is([4, 4, 0, 0])
			expect slid.gained::is(8)
		}

		test "merges the pair it reaches first" {
			constant slid = [4, 2, 2, 0]::slide()

			expect slid.cells::is([4, 4, 0, 0])
			expect slid.gained::is(4)
		}

		test "leaves unequal neighbours where they are" {
			constant slid = [2, 4, 2, 4]::slide()

			expect slid.cells::is([2, 4, 2, 4])
			expect slid.gained::is(0)
		}

		test "has nothing to do to an empty row" {
			constant slid = [0, 0, 0, 0]::slide()

			expect slid.cells::is([0, 0, 0, 0])
			expect slid.gained::is(0)
			expect slid.placed::is([])
		}

		§ `placed` is what lets a page animate a push rather than redraw it: a
		§ merged tile names both of the squares it was made from.
		test "says which squares every tile it placed came from" {
			expect [2, 0, 0, 2]::slide().placed::is([
				{ value = 4, sources = [0, 3] },
			])
		}

		test "answers a row of the length it was handed" {
			expect [2, 2, 0, 0]::slide().cells::length()::is(4)
		}
	}

	suite "turns" {
		test "takes rows into columns" {
			expect twoTiles
				::transpose()
				::is([[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [2, 0, 0, 0]])
		}

		§ Both turns are their own inverse, which is what lets one slide serve
		§ all four directions.
		test "undoes itself when it is done twice" {
			expect twoTiles::transpose()::transpose()::is(twoTiles)
			expect twoTiles::mirror()::mirror()::is(twoTiles)
		}
	}

	suite "slide" {
		test "pushes toward the start of every row going left" {
			constant pushed = twoTiles::slide(toward #Left)

			expect pushed.board::firstItem()::is([4, 0, 0, 0])
			expect pushed.gained::is(4)
		}

		test "pushes toward the end of every row going right" {
			constant pushed = twoTiles::slide(toward #Right)

			expect pushed.board::firstItem()::is([0, 0, 0, 4])
			expect pushed.gained::is(4)
		}

		test "pushes along columns going up" {
			constant pushed: Board = [
				[2, 0, 0, 0],
				[2, 0, 0, 0],
				[0, 0, 0, 0],
				[0, 0, 0, 0],
			]::slide(toward #Up).board

			expect pushed::firstItem()::is([4, 0, 0, 0])
			expect pushed::item(at 1)::is([0, 0, 0, 0])
		}

		test "pushes along columns going down" {
			constant pushed: Board = [
				[2, 0, 0, 0],
				[2, 0, 0, 0],
				[0, 0, 0, 0],
				[0, 0, 0, 0],
			]::slide(toward #Down).board

			expect pushed::lastItem()::is([4, 0, 0, 0])
		}

		test "changes nothing on a board no push can change" {
			expect locked::slide(toward #Left).board::is(locked)
			expect locked::slide(toward #Up).gained::is(0)
		}

		§ The journeys come back out of the turn the push went in through, so
		§ a page reads them against the board it is drawing.
		test "answers every journey in the board's own coordinates" {
			expect twoTiles::slide(toward #Right).movements::is([
				{
					from = { row = 0, column = 0 },
					to = { row = 0, column = 3 },
				},
			])
		}

		test "leaves a tile that did not travel out of the journeys" {
			constant pushed: Board = [
				[2, 4, 0, 0],
				[0, 0, 0, 0],
				[0, 0, 0, 0],
				[0, 0, 0, 0],
			]

			expect pushed::slide(toward #Left).movements::is([])
		}
	}

	suite "the board itself" {
		test "starts empty, with nothing on it anywhere" {
			expect Board.empty::emptyCells()::length()::is(16)
			expect Board.empty::highest()::is(0)
		}

		test "lists the squares a new tile could go on" {
			expect twoTiles::emptyCells()::length()::is(14)
			expect twoTiles
				::emptyCells()
				::hasItems(where (cell) {
					<- cell::is({ row = 0, column = 1 })
				})
		}

		test "sets one square and leaves the board it was handed alone" {
			constant placed = Board.empty::place(2, at { row = 1, column = 2 })

			expect placed::emptyCells()::length()::is(15)
			expect placed::highest()::is(2)
			expect Board.empty::highest()::is(0)
		}

		test "changes nothing for a square off the board" {
			expect Board.empty
				::place(2, at { row = 9, column = 9 })
				::is(Board.empty)
		}

		test "answers the highest tile it is carrying" {
			expect locked::highest()::is(4)
		}

		test "has a move while any two neighbours are equal" {
			expect locked::place(4, at { row = 0, column = 0 })::hasMoves()
		}

		test "has no move left on a board no push would change" {
			expect locked::hasMoves()::negate()
		}
	}

	suite "properties" {
		§ A merge makes one tile worth both of the tiles it came from, so a
		§ push moves the tiles about without changing what the row is worth.
		test "a slide is worth what the row was worth" for any (
			first: Integer,
			second: Integer,
		) {
			expect [first, second, 0, 0]::slide().cells
				::sum()
				::is(first::add(second))
		}

		§ Both turns are their own inverse whatever the board is, which is the
		§ property the four directions are built out of.
		test "a mirror undoes a mirror" for any (board: List<List<Integer>>) {
			expect board::mirror()::mirror()::is(board)
		}

		test "a push answers a board of the size it was handed" for any (
			direction: Direction,
		) {
			expect Board.empty::slide(toward direction).board::is(Board.empty)
		}
	}
}
