import { beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { fixturePath } from "@essence-lang/fixtures"
import type { common, enricher } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import {
	derivedEnumerableNamespaceForChoice,
	derivedEnumerableNamespaceName,
	derivedEquatableNamespace,
	derivedPrintableNamespace,
	enumerableMethodName,
	enumerableProtocolName,
} from "../enricher/resolvers"
import { loadStdlib } from "../enricher/stdlib"
import { applyGenericBindings } from "../helpers/types"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { printSignature, signaturesOf } from "../printType"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// The failure message prints the short names, and the paths are read.
const harnessFile = "StdlibExhaustive.es"
const goldenFile = "__golden__/stdlibExhaustive.txt"

const harnessPath = fixturePath(harnessFile)
const goldenPath = resolve(import.meta.dirname, goldenFile)

type CompiledProgram = {
	output: Array<string>
	// The simplified Program before the Optimiser, which the label and call
	// spec walks. The Optimiser replaces calls with operations, while the spec
	// asks which Method the harness as written calls. The optimised Program is
	// what runs.
	program: common.typedSimple.Program
}

// The CLI's stages without bundling. Unlike `codeGeneration.spec.ts`, it
// reads from disk and says which stage refused before anything is compared.
async function compileProgram(source: string): Promise<CompiledProgram> {
	let parsed = parseWithDiagnostics(source)

	if (containsErrors(parsed.diagnostics)) {
		throw new Error(`${harnessFile} does not parse`)
	}

	let enriched = enrich(parsed.program)

	if (containsErrors(enriched.diagnostics)) {
		throw new Error(`${harnessFile} does not enrich`)
	}

	if (containsErrors(validate(enriched.program))) {
		throw new Error(`${harnessFile} does not validate`)
	}

	let simplified = simplify(enriched.program)
	let javaScript = rewrite(optimise(simplified))
	let directory = mkdtempSync(join(tmpdir(), "essence-golden-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

	let output: Array<string> = []
	let originalLog = console.log

	console.log = (...args: Array<unknown>) => {
		output.push(args.map((argument) => String(argument)).join(" "))
	}

	try {
		// The harness completes work at its top level, so it is emitted with a
		// top-level `await`. `import` waits for it where `require` would not, and
		// the capture stays installed across the wait.
		await import(file)
	} finally {
		console.log = originalLog
		rmSync(directory, { recursive: true, force: true })
	}

	return { output, program: simplified }
}

// Each harness line is the quoted String `"Label => value"`. The separator is
// not ` -> `, which a label's Function Parameters use.
function labelOf(line: string): string {
	let text = line.startsWith('"') ? line.slice(1, -1) : line
	let separator = text.indexOf(" => ")

	return unescaped(separator === -1 ? text : text.slice(0, separator))
}

// The quoted printer escapes a label's braces, as in `Record.is(_ \{\})`. The
// declared signatures hold bare braces, so the escapes are undone.
function unescaped(label: string): string {
	let text = ""
	let index = 0

	while (index < label.length) {
		if (label[index] !== "\\") {
			text += label[index]
			index++

			continue
		}

		text += label[index + 1]
		index += 2
	}

	return text
}

// The harness prints through `Terminal`, so `terminal.spec.ts` covers it. A
// capture of `Randomness` would pin the generator's words, so the `randomness`
// specs cover it. `Http` would record a host's answers, so `http.spec.ts`
// covers it. `Response` sends nothing, so the harness covers it.
const COVERED_ELSEWHERE = new Set(["Terminal", "Randomness", "Http"])

// Every Method a Program can call, spelled the way `StdlibExhaustive.es`
// labels it: the signature `printSignature` produces, minus its return Type.
// A static Property has no signature and is named on its own.
function declaredSignatures(): Array<string> {
	let signatures: Array<string> = []

	// A derived Method with no Parameter, such as `Choice_Printable.toString()`,
	// prints one signature for every Choice. A Set lists it once, so the
	// uniqueness check stays meaningful.
	let derivedSignatures = new Set<string>()

	// The names a derive answers for the Namespace being walked. A derive
	// answers ahead of a provided Method of the same name, as in
	// `namespacesDeclaringMethod`, so the provided one is not listed.
	let derivedNames = new Set<string>()

	let collectDerived = (namespace: common.NamespaceType): void => {
		for (let [methodName, method] of Object.entries(namespace.methods)) {
			derivedNames.add(methodName)

			for (let signature of signaturesOf(method) ?? []) {
				let label = printSignature(
					signature,
					`${namespace.name}.${methodName}`,
				)

				derivedSignatures.add(
					label.slice(0, label.lastIndexOf(") -> ") + 1),
				)
			}
		}
	}

	for (let [namespaceName, member] of Object.entries(loadStdlib().members)) {
		if (
			member.type !== "Namespace" ||
			COVERED_ELSEWHERE.has(namespaceName)
		) {
			continue
		}

		for (let propertyName of Object.keys(member.properties)) {
			signatures.push(`${namespaceName}.${propertyName}`)
		}

		for (let [methodName, method] of Object.entries(member.methods)) {
			for (let signature of signaturesOf(method) ?? []) {
				let label = printSignature(
					signature,
					`${namespaceName}.${methodName}`,
				)

				signatures.push(label.slice(0, label.lastIndexOf(") -> ") + 1))
			}
		}

		// A Choice's derived `is`, `isNot` and `toString` are declared by no
		// Namespace, so they are listed here under the Namespace that answers at
		// run time. The Scope only resolves the Choice's name to its target.
		if (member.targetType === null) {
			continue
		}

		derivedNames.clear()

		let scope: enricher.Scope = {
			parent: null,
			members: {},
			declarations: {},
			constants: new Set(),
			types: { [namespaceName]: member.targetType },
			protocols: {},
		}

		let equatable = derivedEquatableNamespace(member.targetType, scope)

		if (equatable !== null && !Object.hasOwn(member.methods, "is")) {
			collectDerived(equatable)
		}

		// The printing derive answers only where the Namespace declared
		// `is Printable`, so the Namespace itself is what it is asked about.
		let printable = derivedPrintableNamespace(
			member.targetType,
			[member],
			scope,
		)

		if (printable !== null && !Object.hasOwn(member.methods, "toString")) {
			collectDerived(printable)
		}

		// The Case listing is derived for a Choice whose Cases carry no payload,
		// unless the Namespace writes `cases`.
		let enumerable = loadStdlib().protocols[enumerableProtocolName]
		let listing =
			enumerable === undefined ||
			Object.hasOwn(member.methods, enumerableMethodName)
				? null
				: derivedEnumerableNamespaceForChoice(
						member.targetType,
						enumerable,
					)

		if (listing !== null) {
			collectDerived(listing)
		}

		// A Protocol's provided Methods are listed per conformer with `Self`
		// bound, as `Integer.isNot(_ Integer)`, so one call cannot stand for every
		// conformer. The label names the Namespace the Invocation carries. A
		// written Method or a derive answers the name instead, as in the Enricher.
		for (let protocol of Object.values(loadStdlib().protocols)) {
			if (member.conformsTo?.includes(protocol.name) !== true) {
				continue
			}

			for (let [methodName, writtenBy] of Object.entries(
				protocol.providedMethods ?? {},
			)) {
				let method = protocol.methods[methodName]

				if (
					// Only the Methods this Protocol wrote. The walk reaches an
					// inherited one under the Protocol that wrote it.
					writtenBy !== protocol.name ||
					method === undefined ||
					Object.hasOwn(member.methods, methodName) ||
					derivedNames.has(methodName)
				) {
					continue
				}

				let bound = applyGenericBindings(
					method,
					new Map([["Self", member.targetType]]),
				) as common.MethodType

				for (let signature of signaturesOf(bound) ?? []) {
					let label = printSignature(
						signature,
						`${namespaceName}.${methodName}`,
					)

					signatures.push(
						label.slice(0, label.lastIndexOf(") -> ") + 1),
					)
				}
			}
		}
	}

	signatures.push(...derivedSignatures)

	// Overloaded free Functions such as `loop`. Each entry is a label of its
	// own, as an overloaded Method's are, with no Namespace prefix.
	for (let [name, member] of Object.entries(loadStdlib().members)) {
		if (member.type !== "OverloadedStaticMethod") {
			continue
		}

		for (let signature of signaturesOf(member) ?? []) {
			let label = printSignature(signature, name)

			signatures.push(label.slice(0, label.lastIndexOf(") -> ") + 1))
		}
	}

	return signatures
}

// The Simplifier appends `__overload$N` to an Overload entry's emitted
// name. The label names the Method, not the entry, so the suffix is stripped
// before the two are compared.
function demangle(name: string): string {
	return name.replace(/__overload\$\d+$/, "")
}

// Every `Namespace.method` a call anywhere in an Expression resolves to: a
// `MethodInvocation`'s `base`, each target of a `UnionMethodInvocation`, and a
// `FunctionInvocation` off a Namespace `Lookup`. The whole subtree is searched,
// so a call wrapped as `x::foo()::toString()` still counts.
function callTargetsIn(node: unknown): Set<string> {
	let targets = new Set<string>()

	let visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (let entry of value) {
				visit(entry)
			}

			return
		}

		if (value === null || typeof value !== "object") {
			return
		}

		let candidate = value as { nodeType?: string }

		if (candidate.nodeType === "MethodInvocation") {
			let invocation = value as common.typedSimple.MethodInvocationNode

			targets.add(
				`${invocation.base.name}.${demangle(invocation.member.name)}`,
			)
		}

		if (candidate.nodeType === "UnionMethodInvocation") {
			let invocation =
				value as common.typedSimple.UnionMethodInvocationNode

			for (let dispatch of invocation.cases) {
				targets.add(
					`${dispatch.namespaceName}.${demangle(dispatch.methodName)}`,
				)
			}
		}

		if (candidate.nodeType === "FunctionInvocation") {
			let callee = (value as common.typedSimple.FunctionInvocationNode)
				.name

			if (
				callee.nodeType === "Lookup" &&
				callee.base.nodeType === "Identifier" &&
				callee.base.type.type === "Namespace" &&
				callee.member.nodeType === "Identifier"
			) {
				// A derived `cases` belongs to no Namespace, so its target is the
				// derive's name, which the label names, not the Choice's.
				targets.add(
					`${
						callee.derivedCases === undefined
							? callee.base.name
							: derivedEnumerableNamespaceName
					}.${demangle(callee.member.name)}`,
				)
			} else if (callee.nodeType === "Identifier") {
				// A bare free-Function call such as `loop(…)`, named by its
				// demangled name with no Namespace prefix.
				targets.add(demangle(callee.name))
			}
		}

		for (let entry of Object.values(value)) {
			visit(entry)
		}
	}

	visit(node)

	return targets
}

// The `Namespace.member` each Property `Lookup` reads, such as `Number.Pi`,
// for checking a Property label against its value.
function propertyReadsIn(node: unknown): Set<string> {
	let reads = new Set<string>()

	let visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (let entry of value) {
				visit(entry)
			}

			return
		}

		if (value === null || typeof value !== "object") {
			return
		}

		let candidate = value as { nodeType?: string }

		if (candidate.nodeType === "Lookup") {
			let lookup = value as common.typedSimple.LookupNode

			if (
				lookup.base.nodeType === "Identifier" &&
				lookup.base.type.type === "Namespace"
			) {
				reads.add(`${lookup.base.name}.${lookup.member.name}`)
			}
		}

		for (let entry of Object.values(value)) {
			visit(entry)
		}
	}

	visit(node)

	return reads
}

// A label is a printed signature such as `List.map<ItemType, Result>(_ …)`, or
// a Property's bare `Number.Pi`. Its base is what stands before the Type
// Parameters or the Parameters, without the ` [note]` suffix.
function baseOfLabel(label: string): string {
	let withoutNote = label.replace(/ \[[^\]]*\]$/, "")
	let boundary = withoutNote.search(/[<(]/)

	return boundary === -1 ? withoutNote : withoutNote.slice(0, boundary)
}

// Every `show(…)` and `showMaybe(…)` call with a String label, paired with the
// Expression it prints. The helper's own `show(label, match …)` call is
// skipped, since its label is an Identifier.
function labelledCalls(
	program: common.typedSimple.Program,
): Array<{ label: string; value: unknown }> {
	let calls: Array<{ label: string; value: unknown }> = []

	let visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (let entry of value) {
				visit(entry)
			}

			return
		}

		if (value === null || typeof value !== "object") {
			return
		}

		let candidate = value as {
			nodeType?: string
			name?: { nodeType?: string; name?: string }
			arguments?: Array<{ value?: unknown }>
		}

		if (
			candidate.nodeType === "FunctionInvocation" &&
			candidate.name?.nodeType === "Identifier" &&
			(candidate.name.name === "show" ||
				candidate.name.name === "showMaybe")
		) {
			let labelNode = candidate.arguments?.[0]?.value as {
				nodeType?: string
				value?: string
			}

			if (labelNode?.nodeType === "StringValue") {
				calls.push({
					label: labelNode.value!,
					value: candidate.arguments![1]!.value,
				})
			}
		}

		for (let entry of Object.values(value)) {
			visit(entry)
		}
	}

	visit(program.implementation.nodes)

	return calls
}

// A whole-file `toEqual` on five hundred lines prints five hundred lines
// of red. What a reader needs is the first few lines that differ, each named by
// the Method its label carries.
function describeDifferences(
	golden: Array<string>,
	actual: Array<string>,
): string | null {
	let differences: Array<string> = []

	for (
		let index = 0;
		index < Math.max(golden.length, actual.length);
		index++
	) {
		let goldenLine = golden[index]
		let actualLine = actual[index]

		if (goldenLine === actualLine) {
			continue
		}

		if (differences.length < 5) {
			differences.push(
				[
					`line ${index + 1} — ${labelOf(goldenLine ?? actualLine ?? "")}`,
					`  golden: ${goldenLine ?? "(no line — the golden file is shorter)"}`,
					`  actual: ${actualLine ?? "(no line — the output is shorter)"}`,
				].join("\n"),
			)
		} else {
			differences.push("")
		}
	}

	if (differences.length === 0) {
		return null
	}

	let shown = differences.filter((difference) => difference !== "")
	let hidden = differences.length - shown.length

	// The line counts are always stated, since one added or lost call
	// shifts every later line.
	return [
		`${differences.length} lines differ — ${golden.length} in the golden file, ${actual.length} printed`,
		...shown,
		hidden === 0 ? "" : `… and ${hidden} more`,
	]
		.filter((part) => part !== "")
		.join("\n")
}

describe("Stdlib Golden", () => {
	// Compiled and run once in a `beforeAll`, since running is asynchronous.
	let output: Array<string>
	let program: common.typedSimple.Program

	beforeAll(async () => {
		let compiled = await compileProgram(readFileSync(harnessPath, "utf8"))

		output = compiled.output
		program = compiled.program
	})

	// The golden file is a captured run, never written by hand. A Method that
	// behaves differently fails by name. Re-capture it only when a change of
	// behaviour is intended.
	it("prints what the golden file records", () => {
		let golden = readFileSync(goldenPath, "utf8").split("\n")

		// The file ends with a newline, as a text file should.
		if (golden.at(-1) === "") {
			golden.pop()
		}

		let differences = describeDifferences(golden, output)

		if (differences !== null) {
			throw new Error(
				`${harnessFile} no longer prints what ${goldenFile} records.\n\n${differences}`,
			)
		}
	})

	// A Method added to the standard library is uncovered until the harness
	// calls it. A label naming an Overload that is not declared fails too.
	it("calls every declared Method of every Namespace", () => {
		let called = new Set(
			output.map((line) => labelOf(line).replace(/ \[[^\]]*\]$/, "")),
		)
		let declared = declaredSignatures()

		let uncalled = declared.filter((signature) => !called.has(signature))
		let unknown = [...called].filter(
			(signature) => !declared.includes(signature),
		)

		expect({ uncalled, unknown }).toEqual({ uncalled: [], unknown: [] })
		expect(declared.length).toBe(new Set(declared).size)
	})

	// A label is typed text, so `show("Boolean.or(…)", x::and(y))` would cover
	// `or` untested. This checks each label's `Namespace.method` is among the
	// calls its value makes. It cannot tell Overloads apart, since the call
	// carries only a mangled `__overload$N` name.
	it("labels each call with a Method the call actually invokes", () => {
		let mismatches: Array<string> = []

		for (let { label, value } of labelledCalls(program)) {
			let base = baseOfLabel(label)
			let isProperty = !label.replace(/ \[[^\]]*\]$/, "").includes("(")
			let resolved = isProperty
				? propertyReadsIn(value)
				: callTargetsIn(value)

			if (!resolved.has(base)) {
				mismatches.push(
					`'${label}' names '${base}', but its call resolves to {${[
						...resolved,
					].join(", ")}}`,
				)
			}
		}

		expect(mismatches).toEqual([])
	})
})
