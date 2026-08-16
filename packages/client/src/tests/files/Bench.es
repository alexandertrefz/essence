§ The shapes the marshalling boundary is MEASURED on — one embedding's own two
§ calls, spelled as closely as the language allows: a nested List and a List of
§ labels in, a flat List of Records out, and a mid-size Record edited and handed
§ back.
§
§ The bodies are deliberately small. What `tools/bench.ts` times is the DOOR,
§ and the door is crossed before a body runs and again after it answers — so a
§ body that costs next to nothing is what leaves the measurement about the
§ crossing rather than about the Module.

implementation {

	type Cell = { index: Integer, status: String }

	§ The mid-size Record the second call edits — seven members, one of them
	§ Optional and one of them a List, which is the row every host's own state
	§ object has.
	type Panel = {
		id: Integer,
		title: String,
		width: Integer,
		height: Integer,
		visible: Boolean,
		note: Optional<String>,
		tags: List<String>,
	}

	§ The walk's State: the row being looked at, and the Cells built so far.
	type Walk = { position: Integer, cells: List<Cell> }

	§ One Cell per row — the row's own total, under the label standing at the
	§ row's position.
	function layout(
		_ rows: List<List<Integer>>,
		_ labels: List<String>,
	) -> List<Cell> {
		constant start: Walk = { position = 0, cells = [] }

		constant walked = rows::reduce(startingWith start, (state, row) {
			constant total = row::reduce(startingWith 0, (sum, cell) {
				<- sum::add(cell)
			})

			<- {
				position = state.position::add(1),
				cells = state.cells::append({
					index = total,
					status = labels::item(at state.position)::value(withDefault "none"),
				}),
			}
		})

		<- walked.cells
	}

	§ The edit — a Record in, the same Record back with two members moved.
	function resize(_ panel: Panel, _ amount: Integer) -> Panel {
		<- {
			panel with
			width = panel.width::add(amount),
			height = panel.height::add(amount),
		}
	}
}

export {
	Cell
	Panel
	layout
	resize
}
