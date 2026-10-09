// Record Types are structural, so a member renames with every shape that
// could flow into another. See "Record members" in DEVELOPMENT.md.

// The member Declarations of one file's related shapes, by name, with the
// shapes that relate them.
export type ShapeGroup<Member> = {
	shapes: Array<ReadonlySet<string>>
	members: Map<string, Member>
}

// The group of each shape, named by the index of one shape in it. Shapes
// related by subset share a group, transitively. An empty shape stays alone.
export function groupRelatedShapes(
	shapes: Array<ReadonlySet<string>>,
): Array<number> {
	let parents = shapes.map((_, index) => index)

	let find = (index: number): number => {
		while (parents[index] !== index) {
			parents[index] = parents[parents[index]]
			index = parents[index]
		}

		return index
	}

	let union = (left: number, right: number): void => {
		parents[find(left)] = find(right)
	}

	// A shape written many times is compared once.
	let distinct = new Map<string, number>()

	for (let [index, shape] of shapes.entries()) {
		if (shape.size === 0) {
			continue
		}

		let key = [...shape].sort().join(" ")
		let first = distinct.get(key)

		if (first === undefined) {
			distinct.set(key, index)
		} else {
			union(index, first)
		}
	}

	let holding = new Map<string, Array<number>>()

	for (let index of distinct.values()) {
		for (let name of shapes[index]) {
			let holders = holding.get(name)

			if (holders === undefined) {
				holding.set(name, [index])
			} else {
				holders.push(index)
			}
		}
	}

	// Every superset of a shape holds its rarest name.
	for (let index of distinct.values()) {
		let candidates: Array<number> | null = null

		for (let name of shapes[index]) {
			let holders = holding.get(name)!

			if (candidates === null || holders.length < candidates.length) {
				candidates = holders
			}
		}

		for (let other of candidates ?? []) {
			if (other !== index && isSubset(shapes[index], shapes[other])) {
				union(index, other)
			}
		}
	}

	return shapes.map((_, index) => find(index))
}

// The members one rename reaches across groups: those of one name whose
// groups hold related shapes. A group's own shapes are related already.
export function relatedMembers<Member>(
	groups: Array<ShapeGroup<Member>>,
): Array<Array<Member>> {
	let firstShapes: Array<number> = []
	let shapes: Array<ReadonlySet<string>> = []

	for (let group of groups) {
		firstShapes.push(shapes.length)
		shapes.push(...group.shapes)
	}

	let roots = groupRelatedShapes(shapes)
	let joined = new Map<number, Map<string, Array<Member>>>()

	for (let [groupIndex, group] of groups.entries()) {
		if (group.shapes.length === 0) {
			continue
		}

		let root = roots[firstShapes[groupIndex]]
		let byName = joined.get(root)

		if (byName === undefined) {
			byName = new Map()
			joined.set(root, byName)
		}

		for (let [name, member] of group.members) {
			let members = byName.get(name)

			if (members === undefined) {
				byName.set(name, [member])
			} else {
				members.push(member)
			}
		}
	}

	return [...joined.values()].flatMap((byName) =>
		[...byName.values()].filter((members) => members.length > 1),
	)
}

function isSubset(
	smaller: ReadonlySet<string>,
	larger: ReadonlySet<string>,
): boolean {
	for (let name of smaller) {
		if (!larger.has(name)) {
			return false
		}
	}

	return true
}
