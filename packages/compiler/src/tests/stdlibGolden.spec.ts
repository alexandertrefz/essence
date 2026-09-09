import { describe, expect, it } from "bun:test"
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

// NOTE: The names are what the failure message prints; the paths are what is
// read. Keeping them apart means the message stays the short, greppable thing a
// reader can act on rather than two absolute paths into a checkout.
const harnessFile = "StdlibExhaustive.es"
const goldenFile = "__golden__/stdlibExhaustive.txt"

const harnessPath = fixturePath(harnessFile)
const goldenPath = resolve(import.meta.dirname, goldenFile)

type CompiledProgram = {
	output: Array<string>
	// NOTE: The simplified Program the emitted JavaScript was made from —
	// retained so the label↔call correspondence test can walk each `show(…)`
	// call's second Argument without compiling the harness twice.
	//
	// NOTE: Before the Optimiser, deliberately. That test asks which Method a
	// call invokes, which is a question about the harness as written, and the
	// Optimiser's whole business is replacing a call with the operation it
	// performs — a comparison against a payload-less Case is a tag test by the
	// time it is emitted, and invokes nothing. What RUNS below is the optimised
	// Program, so the golden file goes on holding the standard library to
	// account through every pass.
	program: common.typedSimple.Program
}

// NOTE: The same stages the CLI runs, minus bundling — mirrored from
// `codeGeneration.spec.ts` rather than shared with it, because that one folds
// `expect` assertions into the pipeline and takes its source inline. This one
// has a single caller, reads from disk, and has to say WHICH stage refused
// before anything is compared to the golden file.
function compileProgram(source: string): CompiledProgram {
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
		// NOTE: Synchronous on purpose. `await import` would make every caller
		// async for no gain — the emitted module has no top level await, and
		// Bun resolves a `require` of a freshly written file the same way.
		require(file)
	} finally {
		console.log = originalLog
		rmSync(directory, { recursive: true, force: true })
	}

	return { output, program: simplified }
}

// NOTE: Each line of the harness output is `"Label => value"`, printed as a
// String — which the runtime renders with its quotes. The separator is ` => `
// and not ` -> ` because a label spells Function Parameters with the arrow of
// their own signature: `List.everyItem<ItemType>(where: (_ ItemType) ->
// Boolean)`.
function labelOf(line: string): string {
	let text = line.startsWith('"') ? line.slice(1, -1) : line
	let separator = text.indexOf(" => ")

	return separator === -1 ? text : text.slice(0, separator)
}

// NOTE: The one Namespace this harness can not cover, and the reason is the
// harness itself: `show` works by CALLING `Terminal.inspect`, and every other
// entry of that Namespace writes to a stream too. A `show("Terminal.print(…)",
// …)` line would print twice — once for the call it is testing and once for the
// label — and `Terminal.write` would put text on stdout with no newline in the
// middle of a captured line, so the record below would stop being one value per
// line. The Namespace that PRINTS can not be held to account by a record made of
// printing; its behaviour is covered by `terminal.spec.ts`, which compiles small
// Programs and reads back what each stream actually received.
// NOTE: And the one Namespace this harness can not CAPTURE. `Randomness.seeded`
// builds a source a line here could draw from, and what the draw answers is one
// of the generator's own words — so a capture of it would pin sfc32 rather than
// the Namespace, and every change to the words would read as a broken body. So
// there is no line `StdlibExhaustive.es` writes. The entries are covered by
// `packages/runtime/src/tests/randomness.spec.ts`, which drives the natives
// directly over a fixed seed and asserts the ranges, the exactness and the
// replay, and by `packages/compiler/src/tests/randomness.spec.ts`, which runs
// Programs that build a source and draw from it.
const COVERED_ELSEWHERE = new Set(["Terminal", "Randomness"])

// NOTE: Every Method a Program can call, spelled the way `StdlibExhaustive.es`
// labels it: the signature `printSignature` produces, minus its return Type.
// A static Property has no signature and is named on its own.
function declaredSignatures(): Array<string> {
	let signatures: Array<string> = []

	// NOTE: A Set, because a derived Method with no Parameter of its own prints
	// the same signature for every Choice that derives it —
	// `Choice_Printable.toString()` is one Method of one fabricated Namespace,
	// however many Choices reach it, and listing it once is what keeps the
	// uniqueness check below meaningful. The derived `is` and `isNot` take the
	// Choice as a Parameter and are distinct already.
	let derivedSignatures = new Set<string>()

	// NOTE: The names a derive answers for the Namespace being walked — filled
	// as the derives are collected, and read by the provided-Method pass below.
	// A derive answers AHEAD of a Protocol's provided Method of the same name
	// (`namespacesDeclaringMethod` in the Enricher), so a Choice's `isNot` is
	// `Choice_Equatable`'s and not `Equatable`'s, and listing both would ask the
	// harness for a call nothing can make.
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

		// NOTE: A Choice's `is`, `isNot` and `toString` are DERIVED — no
		// Namespace declares them, so the loop above never sees them, and
		// without this the harness could quietly stop calling them. They are
		// listed under the Namespace that answers at runtime, which is the one
		// the labels name. The Scope only has to resolve the Choice's name back
		// to the Choice, which the target Type already is.
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

		// NOTE: The printing derive answers only where the Namespace declared
		// `is Printable`, so the Namespace itself is what it is asked about.
		let printable = derivedPrintableNamespace(
			member.targetType,
			[member],
			scope,
		)

		if (printable !== null && !Object.hasOwn(member.methods, "toString")) {
			collectDerived(printable)
		}

		// NOTE: And the Case listing, which no Namespace declares and nobody
		// declares the conformance for either — it is derived wherever the
		// target is a Choice whose Cases carry no payload, and a Namespace
		// writing `cases` replaces it.
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

		// NOTE: A Protocol's PROVIDED Methods are Methods of every conformer,
		// and no Namespace declares them either — so the loop above never sees
		// them and the harness could quietly stop calling one.
		//
		// They are enumerated PER CONFORMER, with `Self` bound to that
		// conformer's target Type: `Integer.isNot(_ Integer)` beside
		// `String.isNot(_ String)`. That is the signature a call site reaches,
		// and it is what keeps the coverage this feature INHERITED — each of
		// these replaced a body that was called on its own Namespace. Listing
		// the Protocol's `isNot(_ Self)` once instead would let a single call
		// stand for every conformer.
		//
		// The label names the NAMESPACE, not the Protocol. A provided Method
		// stands on the specificity ladder under the Namespace whose conformance
		// put it in reach, and that Namespace is what the Invocation carries —
		// so `7::isNot(8)` is `Integer.isNot` and `asNumber(2)::isNot(2/1)`,
		// which Integer's rung rejects, is `Number.isNot`. The two ways a
		// conformer can answer a name itself are mirrored from the Enricher: a
		// Method it WRITES replaces the provided one on its own rung, and a
		// DERIVE answers ahead of one.
		for (let protocol of Object.values(loadStdlib().protocols)) {
			if (member.conformsTo?.includes(protocol.name) !== true) {
				continue
			}

			for (let [methodName, writtenBy] of Object.entries(
				protocol.providedMethods ?? {},
			)) {
				let method = protocol.methods[methodName]

				if (
					// NOTE: Only the Methods this Protocol WROTE. An inherited
					// one is listed under the Protocol that wrote it, which
					// this same walk reaches.
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

	// NOTE: The free Functions that belong to no Namespace — `loop` is the only
	// one, and it has several entries. Only the OVERLOADED free Functions are
	// enumerated here: each entry is a label of its own, exactly as an
	// overloaded Method's entries are, but with no Namespace to prefix its
	// name.
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

// NOTE: The Simplifier appends `__overload$N` to an Overload entry's emitted
// name. The label names the Method, not the entry, so the suffix is stripped
// before the two are compared.
function demangle(name: string): string {
	return name.replace(/__overload\$\d+$/, "")
}

// NOTE: The `Namespace.method` a call resolves to, gathered from every
// invocation Node anywhere inside an Expression — the same three spellings the
// call graph walker recognises: an instance call is a `MethodInvocation` whose
// `base` names the answering Namespace, a Union-receiver call is a
// `UnionMethodInvocation` with a target per member, and a static call is a
// `FunctionInvocation` off a Namespace `Lookup`. Searching the WHOLE subtree
// rather than only its outermost call is deliberate: it means the check does
// not depend on the tested Method being written outermost, so a later edit that
// wraps a call (`x::foo()::toString()`) does not read as a mislabel.
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
				// NOTE: A derived `cases` is a member of no Namespace at all,
				// and the Rewriter emits it under the derive's own name for
				// that reason — so the target is what the label names rather
				// than the Choice the base spells.
				targets.add(
					`${
						callee.derivedCases === undefined
							? callee.base.name
							: derivedEnumerableNamespaceName
					}.${demangle(callee.member.name)}`,
				)
			} else if (callee.nodeType === "Identifier") {
				// NOTE: A bare free-Function call — `loop(…)` — whose callee is
				// the Function's own (overload-mangled) name, with no Namespace
				// to prefix it. This is how the harness's `loop` labels are
				// checked against the call they sit beside.
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

// NOTE: The `Namespace.member` a Property Lookup reads — a `Lookup` off a
// Namespace base that is NOT a call. `Number.Pi` is the only shape this matches
// in the harness, and it is how a Property label (no `(`) is checked against
// its value.
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

// NOTE: A label is a printed signature — `List.map<ItemType, Result>(_ …)` or
// `Number.isBetween(_ Number, and: Number)` or the bare `Number.Pi` of a
// Property. Its `Namespace.method` base is everything before the Type
// Parameter clause or the Parameter list, with the ` [note]` suffix already
// gone.
function baseOfLabel(label: string): string {
	let withoutNote = label.replace(/ \[[^\]]*\]$/, "")
	let boundary = withoutNote.search(/[<(]/)

	return boundary === -1 ? withoutNote : withoutNote.slice(0, boundary)
}

// NOTE: Every `show(…)` / `showMaybe(…)` call in the harness, paired with the
// Expression Node it prints — walked out of the simplified Program. The
// helper's OWN internal `show(label, match …)` call is skipped, because there
// the first Argument is the `label` Identifier rather than a String literal.
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

// NOTE: A whole-file `toEqual` on five hundred lines prints five hundred lines
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

	// NOTE: The line count is stated even when it matches, because a harness
	// that gained or lost a call shifts every line after it and the diff below
	// reads as a wholesale change rather than the insertion it is.
	return [
		`${differences.length} lines differ — ${golden.length} in the golden file, ${actual.length} printed`,
		...shown,
		hidden === 0 ? "" : `… and ${hidden} more`,
	]
		.filter((part) => part !== "")
		.join("\n")
}

describe("Stdlib Golden", () => {
	let { output, program } = compileProgram(readFileSync(harnessPath, "utf8"))

	// NOTE: The golden file was produced by RUNNING this harness against the
	// TypeScript standard library, never written by hand. It is the record of
	// what the standard library did before its Methods began moving into
	// Essence, so a Method that comes out behaving differently says so by name
	// — which is the whole reason this file exists. Re-capture it only when a
	// change of behaviour is the intent, and never to make this test pass.
	it("prints what the golden file records", () => {
		let golden = readFileSync(goldenPath, "utf8").split("\n")

		// NOTE: The file ends with a newline, as a text file should.
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

	// NOTE: The gate that keeps the net exhaustive. A Method added to
	// `packages/standard-library/sources` is not covered by anything until it is called here, and a
	// Method that only LOOKS covered — a label that names an Overload the
	// Declaration does not have — is just as wrong.
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

	// NOTE: The coverage gate above compares label STRINGS to declared
	// signatures, and a label is just text the author typed — nothing there
	// forces the call beside it to invoke the Method it names. Without this
	// test, `show("Boolean.or(…)", x::and(y))` would satisfy coverage for `or`
	// while `or` went untested. This closes that hole for the Method NAME: it
	// walks each `show(…)` call out of the simplified Program and asserts the
	// label's `Namespace.method` is among the calls its value Argument actually
	// makes.
	//
	// LIMITATION — this verifies the base `Namespace.method`, NOT the specific
	// Overload the label spells. A label of `Integer.add(_ Rational)` beside a
	// call to the Integer Overload of `add` still passes, because the
	// simplified Node carries a mangled `add__overload$N` name and mapping that
	// number back to a printed signature would duplicate the Simplifier's
	// Overload-numbering — deep plumbing that would couple this test to an
	// internal it should not know. So: a call mislabelled to a different METHOD
	// is caught here; a call mislabelled to a different OVERLOAD of the right
	// Method is not, and the labels' Overload precision rests on the author.
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
