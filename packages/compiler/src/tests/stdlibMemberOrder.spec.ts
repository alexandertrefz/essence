import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import * as path from "node:path"

import type { common } from "@essence-lang/interfaces"
import { readStdlibFiles } from "@essence-lang/standard-library"

import { loadStdlib, parseStdlibSource } from "../enricher/stdlib"

// NOTE: One member order for every Namespace in the standard library, written
// down in `packages/standard-library/DEVELOPMENT.md` under "Member order" and
// enforced here. A reader who has found their way around `String` has found
// their way around `List`: the statics open the Namespace, the Protocol
// witnesses come next, and what a Method ANSWERS decides the rest.
//
// The check is that the group index never DECREASES down a declaration. It is
// deliberately not an exact order: inside a group the sources keep the order
// they already had, so adding a Method costs a decision about which group it
// joins and nothing else. Groups 2 and 3 are the exception — each is a short
// fixed set where the reader can be given the same order every time.
//
// Only Namespaces are held to this. `Loop.es` declares free Functions, which
// belong to no Namespace and have no order to keep.

const GROUP_NAMES: Record<number, string> = {
	1: "static creators and constants",
	2: "Protocol witnesses",
	3: "arithmetic",
	4: "predicates",
	5: "accessors",
	6: "transforms and everything else",
}

// NOTE: The Methods a Protocol asks for, in the order a reader meets the
// Protocols themselves: equality, then ordering, then printing.
//
// NOTE: A Method a Protocol PROVIDES never reaches this file, and can not: the
// order checked here is the order of the DECLARATIONS a Namespace body holds,
// and a conformer declares nothing for a provided Method. `isNot` is still
// listed because a Namespace may override one, and `Optional` does.
const WITNESS_ORDER = ["is", "isNot", "compare", "toString"]

// NOTE: The four operations in the order arithmetic is taught, then the four
// that build on them.
const ARITHMETIC_ORDER = [
	"add",
	"subtract",
	"multiply",
	"divide",
	"remainder",
	"quotient",
	"raise",
	"squareRoot",
]

// NOTE: Spelled out rather than derived, because an accessor is named for the
// part it answers and no signature says that. `reciprocal` is deliberately
// absent: it BUILDS a Rational out of the receiver rather than reading a part
// of it, which is a transform. `enumerate` is absent for the same reason: the
// Records it answers are built out of the List rather than held by it, and it
// is the one member here named with a verb.
const ACCESSORS = new Set([
	"length",
	"numerator",
	"denominator",
	"absolute",
	"item",
	"firstItem",
	"lastItem",
	"firstIndex",
	"lastIndex",
	"indices",
	"keys",
	// NOTE: A Dictionary's two other halves, beside the keys it shares
	// with `Record`. An entry is the pair a Dictionary is written in terms
	// of rather than a Record built out of one, which is what separates
	// `entries` from `enumerate`.
	"values",
	"entries",
	"characters",
	"words",
	"lines",
	"character",
	// NOTE: A String's two ends, which `List` names `firstItem` and `lastItem`
	// — the same part of a value read under the name its own Type gives it.
	"firstCharacter",
	"lastCharacter",
	"value",
])

type Member = {
	namespace: string
	name: string
	group: number
	file: string
	line: number
}

// NOTE: Every Namespace the sources declare, keyed by name — including any
// `Prelude.es` does not forward. `loadStdlib().members` holds the PUBLIC
// surface, so an internal helper would quietly go unchecked; the typed
// Programs carry each declaration's own complete Namespace Type instead. There
// is no such helper today — `Scalar` was the last one, and preluding it under
// its own name is what took the level's only occupant away.
function declaredNamespaces(): Map<string, common.NamespaceType> {
	let namespaces = new Map<string, common.NamespaceType>()

	for (let program of loadStdlib().typedPrograms) {
		for (let node of program.implementation.nodes) {
			if (node.nodeType === "NamespaceDefinitionStatement") {
				namespaces.set(node.name.content, node.type)
			}
		}
	}

	return namespaces
}

function isStatic(method: common.MethodType): boolean {
	return (
		method.type === "StaticMethod" ||
		method.type === "OverloadedStaticMethod"
	)
}

// NOTE: EVERY entry, so that an Overload counts as a predicate only when the
// whole family answers a Boolean. `Optional::is` is one either way; a family
// with one Boolean entry and one that answers a value is not a predicate.
function answersBoolean(method: common.MethodType): boolean {
	let returnTypes =
		method.type === "SimpleMethod" || method.type === "StaticMethod"
			? [method.returnType]
			: method.overloads.map((overload) => overload.returnType)

	return returnTypes.every((returnType) => returnType.type === "Boolean")
}

function groupOf(name: string, method: common.MethodType | null): number {
	if (method === null || isStatic(method)) {
		return 1
	}

	if (WITNESS_ORDER.includes(name)) {
		return 2
	}

	if (ARITHMETIC_ORDER.includes(name)) {
		return 3
	}

	if (answersBoolean(method)) {
		return 4
	}

	return ACCESSORS.has(name) ? 5 : 6
}

// NOTE: Read off the sources rather than off the loaded tables, because the
// rule is about the order the `.es` file WRITES its members in and a Namespace
// Type keeps its Properties and its Methods in two records. A Property and a
// Method are ordered against each other by the Position of the name each was
// declared under.
function declaredMembers(): Array<Member> {
	let namespaces = declaredNamespaces()
	let members: Array<Member> = []

	for (let { filePath, sourceText } of readStdlibFiles()) {
		let file = path.basename(filePath)
		let { program } = parseStdlibSource(filePath, sourceText)

		for (let node of program.implementation.nodes) {
			if (node.nodeType !== "NamespaceDefinitionStatement") {
				continue
			}

			let namespace = namespaces.get(node.name.content)

			if (namespace === undefined) {
				throw new Error(
					`'${node.name.content}' is declared in ${file} but loaded as no Namespace`,
				)
			}

			let declared: Array<Member> = []

			// NOTE: A Namespace Property is always static — there is no
			// per-value Property — so each one opens the Namespace with the
			// static Methods.
			for (let property of Object.values(node.properties)) {
				declared.push({
					namespace: node.name.content,
					name: property.name.content,
					group: 1,
					file,
					line: property.name.position.start.line,
				})
			}

			for (let method of Object.values(node.methods)) {
				let name = method.name.content

				declared.push({
					namespace: node.name.content,
					name,
					group: groupOf(name, namespace.methods[name] ?? null),
					file,
					line: method.name.position.start.line,
				})
			}

			members.push(
				...declared.sort((one, other) => one.line - other.line),
			)
		}
	}

	return members
}

function describeGroup(group: number): string {
	return `group ${group} (${GROUP_NAMES[group]})`
}

// NOTE: One line per member that stands too late, naming the member it stands
// after — which is the one an editor has to move it above.
function outOfOrderMembers(): Array<string> {
	let problems: Array<string> = []
	let highest: Member | null = null
	let namespace: string | null = null

	for (let member of declaredMembers()) {
		if (member.namespace !== namespace) {
			namespace = member.namespace
			highest = null
		}

		if (highest === null || member.group >= highest.group) {
			highest = member

			continue
		}

		problems.push(
			`${member.file}:${member.line} — '${member.namespace}::${member.name}' belongs in ${describeGroup(member.group)}, but it is declared after '${highest.name}', which is ${describeGroup(highest.group)}`,
		)
	}

	return problems
}

// NOTE: The order INSIDE one group, for the two groups that state one. Read off
// the members the group actually has, so a Namespace declaring three of the
// four witnesses is held to the order of the three it declares.
function outOfOrderWithin(group: number, order: Array<string>): Array<string> {
	let problems: Array<string> = []
	let previous: Member | null = null
	let namespace: string | null = null

	for (let member of declaredMembers()) {
		if (member.namespace !== namespace) {
			namespace = member.namespace
			previous = null
		}

		if (member.group !== group) {
			continue
		}

		if (
			previous !== null &&
			order.indexOf(member.name) < order.indexOf(previous.name)
		) {
			problems.push(
				`${member.file}:${member.line} — '${member.namespace}::${member.name}' is declared after '${previous.name}'; ${GROUP_NAMES[group]} are declared ${order.join(", ")}`,
			)
		}

		previous = member
	}

	return problems
}

describe("Standard Library Member Order", () => {
	it("should find Namespaces to hold to the order", () => {
		// NOTE: A guard on the reading above. Every check below passes on an
		// empty list, so a collector that found no Namespace, or that found no
		// member in the ones it found, would make this file a no-op nobody
		// notices. Seven of the Namespaces declare no member at all — a Choice
		// of payload-free Cases derives everything it answers — so the two
		// counts do not match and neither stands in for the other.
		let members = declaredMembers()

		expect(declaredNamespaces().size).toBeGreaterThan(20)
		expect(
			new Set(members.map((member) => member.namespace)).size,
		).toBeGreaterThan(20)
		expect(members.length).toBeGreaterThan(200)
	})

	it("should declare each Namespace's members in group order", () => {
		expect(outOfOrderMembers().join("\n")).toBe("")
	})

	// NOTE: The rulebook a next editor reads and the set this file classifies
	// by are two spellings of one list, and only one of them fails a test when
	// it goes stale. So the rulebook is held to the set: an accessor added here
	// has to be written there too, or the next reader is given a list that has
	// quietly stopped being the list.
	it("should name every accessor in DEVELOPMENT.md", () => {
		let development = readFileSync(
			path.resolve(
				import.meta.dirname,
				"../../../standard-library/DEVELOPMENT.md",
			),
			"utf8",
		)
		let section = development.slice(
			development.indexOf("5. **Accessors**"),
			development.indexOf("6. **Transforms"),
		)
		let missing = [...ACCESSORS].filter(
			(name) => !section.includes(`\`${name}`),
		)

		expect(missing).toEqual([])
	})

	it("should declare the Protocol witnesses in the stated order", () => {
		expect(outOfOrderWithin(2, WITNESS_ORDER).join("\n")).toBe("")
	})

	it("should declare the arithmetic in the stated order", () => {
		expect(outOfOrderWithin(3, ARITHMETIC_ORDER).join("\n")).toBe("")
	})

	// NOTE: The classifier is what the two checks above rest on, so the shapes
	// it has to tell apart are pinned here rather than left to the sources
	// happening to hold one of each.
	describe("the classifier", () => {
		let namespaces = declaredNamespaces()

		let group = (namespaceName: string, memberName: string): number =>
			groupOf(
				memberName,
				namespaces.get(namespaceName)!.methods[memberName] ?? null,
			)

		it("should read a static Method as a creator", () => {
			expect(group("List", "of")).toBe(1)
			expect(group("Integer", "parse")).toBe(1)
		})

		it("should read a Protocol witness by name", () => {
			expect(group("String", "compare")).toBe(2)
			expect(group("Record", "toString")).toBe(2)
		})

		it("should read the arithmetic by name", () => {
			expect(group("Rational", "divide")).toBe(3)
			expect(group("Integer", "squareRoot")).toBe(3)
		})

		it("should read a Method answering a Boolean as a predicate", () => {
			expect(group("List", "contains")).toBe(4)
			expect(group("String", "starts")).toBe(4)
			// NOTE: An Overload counts only when every entry answers a
			// Boolean. All three `hasItems` entries do.
			expect(group("List", "hasItems")).toBe(4)
		})

		it("should read a named part as an accessor", () => {
			expect(group("List", "firstItem")).toBe(5)
			expect(group("Rational", "denominator")).toBe(5)
			expect(group("Optional", "value")).toBe(5)
		})

		it("should read everything else as a transform", () => {
			expect(group("List", "sort")).toBe(6)
			expect(group("Integer", "negate")).toBe(6)
			// NOTE: `reciprocal` builds a Rational rather than reading a part
			// of one, so it is not an accessor.
			expect(group("Rational", "reciprocal")).toBe(6)
		})
	})
})
