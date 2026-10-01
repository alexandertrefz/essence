import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import * as path from "node:path"

import type { common } from "@essence-lang/interfaces"
import { readStdlibFiles } from "@essence-lang/standard-library"

import { loadStdlib, parseStdlibSource } from "../enricher/stdlib"

// One member order for every Namespace in the standard library. See "Member
// order" in packages/standard-library/DEVELOPMENT.md.
//
// The group index never decreases down a declaration. Inside a group the
// sources keep their own order, except for the short fixed sets of groups 2
// and 3. Free Functions, as in `Loop.es`, have no order to keep.

const GROUP_NAMES: Record<number, string> = {
	1: "static creators and constants",
	2: "Protocol witnesses",
	3: "arithmetic",
	4: "predicates",
	5: "accessors",
	6: "transforms and everything else",
}

// Equality, then ordering, then printing. A provided Method has no declaration
// to order, but `Optional` overrides `isNot`, so it is listed.
const WITNESS_ORDER = ["is", "isNot", "compare", "toString"]

// The basic operations in the order arithmetic is taught, then the ones that
// build on them.
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

// Spelled out, because no signature says an accessor answers a named part.
// `reciprocal` and `enumerate` build their answers, so they are transforms.
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
	// The item of a List that holds exactly one.
	"onlyItem",
	// Every position an item stands at.
	"everyIndex",
	"keys",
	// A Dictionary's other halves. An entry is the pair a Dictionary is
	// written in terms of, unlike the Records `enumerate` builds.
	"values",
	"entries",
	// What `firstItem` is to a List.
	"firstEntry",
	"characters",
	// The level below a character, under the name Unicode gives it.
	"codePoints",
	"words",
	"lines",
	"character",
	// A String's two ends, which `List` names `firstItem` and `lastItem`.
	"firstCharacter",
	"lastCharacter",
	"value",
	// A Result's failure read apart, and its List-side plural, as `value`
	// pluralises to `values`.
	"reason",
	"reasons",
])

type Member = {
	namespace: string
	name: string
	group: number
	file: string
	line: number
}

// Every Namespace the sources declare, keyed by name, including any
// `Prelude.es` does not forward. `loadStdlib().members` holds only the public
// surface, so the typed Programs are read instead.
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

// An Overload counts as a predicate only when every entry answers a Boolean.
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

// Read off the sources, since a Namespace Type keeps Properties and Methods
// apart. A Property and a Method are ordered by the Position of their names.
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

			// A Namespace Property is always static, so it belongs with the
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

// One line per member that stands too late, naming the member it must move
// before.
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

// The order inside a group that states one, over the members the Namespace
// declares.
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
		// A guard on `declaredMembers`, since every other check passes on an
		// empty list. A Choice of payload-free Cases declares no member, so the
		// two counts differ.
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

	// The written rule and `ACCESSORS` are one list, so the written rule is
	// held to the set.
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

	// The order checks rest on `groupOf`, so the shapes it tells apart are
	// pinned here.
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
			// An Overload counts only when every entry answers a Boolean. Both
			// `hasItems` entries do.
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
			// `reciprocal` builds a Rational, so it is not an accessor.
			expect(group("Rational", "reciprocal")).toBe(6)
		})
	})
})
