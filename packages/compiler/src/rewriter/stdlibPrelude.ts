import type { common } from "@essence/interfaces"

import type { NativeBindings, Stdlib } from "../enricher/stdlib"
import { loadStdlib } from "../enricher/stdlib"
import { resolveOverloadedMethodName } from "../helpers/index"
import { optimise } from "../optimiser/index"
import { simplify } from "../simplifier/index"

// NOTE: A standard library Namespace is written in TWO languages at once: some
// of its members are bound to a runtime module in `__internal/`, the rest are
// implemented in Essence in `packages/stdlib/sources/`. Emitted user code can
// not tell the two apart — it says `Boolean.isNot(…)` either way — so this
// module is what the Rewriter asks which half a member belongs to. The prelude
// is the Essence-implemented half: the typed Nodes of the BODIED members,
// simplified and optimised once per process.
//
// NOTE: The two halves are not merged into one object. A native member stays a
// read off the plain `import * as <Namespace>`, which esbuild can rewrite to a
// direct symbol reference and therefore tree-shake; an Essence-implemented one
// is emitted as its OWN top-level const, named by `essenceMethodIdentifier`, so
// nothing has to materialise the module namespace object to reach it. A
// Method's const holds a Function expression and may sit anywhere; a static
// Property's const holds the value itself, so those are emitted in a band of
// their own, after the Function-valued consts and ordered against each other by
// what they read.

// NOTE: The Namespaces the prelude has anything to say about — the ones with at
// least one Essence-implemented member. A Namespace whose every member is
// native never appears here, and the Rewriter keeps importing it directly.
export type PreludeNamespace = {
	name: string
	node: common.typedSimple.NamespaceDefinitionStatementNode
}

// NOTE: The Simplifier is the stage that turns `is__overload$1` into a name and
// unshifts the hidden `_self` Parameter, and it does both by WRITING INTO the
// typed Node it was handed. The standard library's typed Programs are a
// process-wide singleton every consumer shares, so they are copied before they
// are simplified — otherwise the first compilation would leave overload-mangled
// names behind in a table the Language Server and the tests read afterwards,
// and a second simplification would mangle them a second time.
export type PreludeFreeFunction = {
	name: string
	node: common.typedSimple.FunctionStatementNode
}

type StdlibArtifacts = {
	namespaces: Array<PreludeNamespace>
	freeFunctions: Array<PreludeFreeFunction>
}

// NOTE: The member names a Namespace spells BOTH as a Method and as a static
// Property. The typed Node can not answer this on its own — only the BODIED
// members reach it, so a native `yes() -> Boolean` beside a bodied
// `static yes: Boolean = true` looks like a lone Property there, and the clash
// would slip through to be emitted. The loader's `nativeBindings` lists every
// DECLARED member of both kinds, native or not, so the intersection is taken
// over that; the typed Node stands in for a Namespace the bindings do not know,
// which no loaded standard library produces.
function clashingMemberNames(
	node: common.typedSimple.NamespaceDefinitionStatementNode,
	nativeBindings: NativeBindings,
): Array<string> {
	let bindings = nativeBindings[node.name.name]

	let methodNames = new Set(Object.keys(bindings?.methods ?? node.methods))

	return Object.keys(bindings?.properties ?? node.properties).filter((name) =>
		methodNames.has(name),
	)
}

function buildStdlibArtifacts(stdlib: Stdlib): StdlibArtifacts {
	let namespaces: Array<PreludeNamespace> = []
	let freeFunctions: Array<PreludeFreeFunction> = []

	for (let typedProgram of stdlib.typedPrograms) {
		let program = optimise(simplify(structuredClone(typedProgram)))

		for (let node of program.implementation.nodes) {
			// NOTE: A bodied free Function is emitted as its own top-level
			// Function, reached by the bare name a call site resolves to — a
			// bodied `overload function` entry, whose name the Simplifier
			// carried through as `<name>__overload$N`, or a plain bodied
			// `function`. A native free Function never reaches here: it carries
			// no typed Node, and the Rewriter reads it off the runtime
			// `functions` module instead.
			if (node.nodeType === "FunctionStatement") {
				freeFunctions.push({ name: node.name.name, node })

				continue
			}

			if (node.nodeType !== "NamespaceDefinitionStatement") {
				continue
			}

			// NOTE: A Method and a static Property of one Namespace are emitted
			// under the SAME `$es_<Namespace>_<member>` const name. Nothing
			// upstream refuses it — the two live in records of their own, so
			// `static yes: Boolean = true` beside `yes() -> Boolean` type checks
			// — and what it produces is not a file that fails to parse but one
			// that is silently wrong: the Rewriter keys its candidates by that
			// const name, so the two collapse into ONE entry, and every call
			// site of the Method reads the Property's value instead. The
			// compiler developer who writes it is stopped here. Which half is
			// native does not matter — either kind of read is misrouted — so the
			// clash is looked for over the DECLARED members, not the bodied ones.
			let shadowedMethods = clashingMemberNames(
				node,
				stdlib.nativeBindings,
			)

			if (shadowedMethods.length > 0) {
				throw new Error(
					`The standard library Namespace '${node.name.name}' spells the static ${
						shadowedMethods.length === 1 ? "Property" : "Properties"
					} ${shadowedMethods.map((name) => `'${name}'`).join(", ")} exactly like a Method of its own, and the two are emitted under the one const — rename one of them`,
				)
			}

			// NOTE: Only the BODIED members reach the typed Node — a native has
			// no body to emit — so a Namespace that is entirely native arrives
			// here empty and is dropped. Keeping it would put a Namespace in the
			// prelude that has no const to contribute, and every read of it is
			// already the plain member read off the imported runtime module.
			//
			// NOTE: A bodied static Property counts as a member here, so a
			// Namespace whose every Method is native but which gives one Property
			// a value still belongs in the prelude. Its value is emitted as a
			// const of its own, in the band the Rewriter orders AFTER every
			// Function-valued one — a Property initialiser runs where its const
			// is emitted, not when something calls it.
			if (
				Object.keys(node.methods).length === 0 &&
				Object.keys(node.properties).length === 0
			) {
				continue
			}

			namespaces.push({ name: node.name.name, node })
		}
	}

	return { namespaces, freeFunctions }
}

// NOTE: The prelude proper — the Essence-implemented Namespace members — kept
// beside the free Functions collected in the same pass. It is handed a WHOLE
// standard library rather than its typed Programs alone, because the clash
// refusal above has to read the loader's `nativeBindings` to see the members no
// typed Program carries.
export function buildStdlibPrelude(stdlib: Stdlib): Array<PreludeNamespace> {
	return buildStdlibArtifacts(stdlib).namespaces
}

// NOTE: A value read off the standard library and kept, so that walking the
// library again is paid once per process rather than once per file compiled in a
// worker. It is keyed by the Stdlib OBJECT and not by a flag some caller has to
// clear: `useStdlib` can put a DIFFERENT library in place — a test's, built from
// sources of its own — and a cache someone has to remember to invalidate is one
// that will one day answer for a library that is no longer loaded. `loadStdlib`
// is a null check and a return once the library is in hand, so asking it on
// every lookup costs nothing.
function derivedFromStdlib<Value>(
	build: (stdlib: Stdlib) => Value,
): () => Value {
	let cache: { stdlib: Stdlib; value: Value } | null = null

	return () => {
		let stdlib = loadStdlib()

		if (cache === null || cache.stdlib !== stdlib) {
			cache = { stdlib, value: build(stdlib) }
		}

		return cache.value
	}
}

// NOTE: Simplifying and optimising the standard library's Programs for every
// user file would be paid over and over for a result that can not differ. The
// Namespaces and the free Functions come out of the one simplify pass, so both
// accessors share this cache rather than each walking the library again.
const stdlibArtifacts = derivedFromStdlib(buildStdlibArtifacts)

export function stdlibPrelude(): Array<PreludeNamespace> {
	return stdlibArtifacts().namespaces
}

// NOTE: The Essence-bodied free Functions — a bodied `overload function` entry
// (named `<name>__overload$N`) or a plain bodied `function` — built and cached
// alongside the Namespace prelude. The Rewriter emits only the ones a Program
// reaches; the rest cost nothing, exactly as an unreferenced Essence Method does.
export function stdlibFreeFunctions(): Array<PreludeFreeFunction> {
	return stdlibArtifacts().freeFunctions
}

// NOTE: The prefix on its own, so that a finished tree can be swept for the
// names spelled with it — the Rewriter checks that every one it emitted has a
// const, which only holds because nothing a user writes can wear this prefix.
export const ESSENCE_METHOD_PREFIX = "$es_"

// NOTE: The emitted name of an Essence-implemented standard library Method. A
// native Method stays a read off the plain `import * as <Namespace>`, which
// esbuild can rewrite to a direct symbol reference and therefore tree-shake; an
// Essence-implemented one is not a member of anything, it is its own top-level
// const, so nothing has to materialise the module namespace object to reach it.
//
// NOTE: The separators are `_`, which the Lexer treats as a Symbol
// (`src/lexer/index.ts`) — so no user identifier can contain one, the same
// guarantee `_self` and `_0` already rest on, and a Namespace name therefore
// contains none either. `$` on its own would not do: it IS a legal identifier
// character, so `$esNumberisBetween` is a name a user could write. Because a
// Namespace name has no `_`, the first `_` after the prefix splits the
// Namespace from the member unambiguously.
export function essenceMethodIdentifier(
	namespaceName: string,
	memberName: string,
): string {
	return `${ESSENCE_METHOD_PREFIX}${namespaceName}_${memberName}`
}

// NOTE: The set of `(Namespace, member)` pairs the prelude implements in
// Essence, memoised. Both halves of a lookup are ALREADY overload-mangled by
// the Simplifier before they reach here — the prelude's keys through
// `simplifyMethods`, every call site through the invocation simplifiers, and a
// conformance witness through `findFulfillingMethod` — all of which route
// through the one `resolveOverloadedMethodName`, so the two sides agree by
// construction. The prelude is fully built before the first `rewrite` runs
// (`buildStdlibPrelude` never calls the Rewriter), so this is complete and
// stable the moment any prelude body is rewritten.
const essenceMethodNames = derivedFromStdlib(
	() =>
		new Set(
			stdlibPrelude().flatMap((namespace) =>
				Object.keys(namespace.node.methods).map(
					(name) => `${namespace.name}\u0000${name}`,
				),
			),
		),
)

// NOTE: The `\u0000` join can not occur inside either name, so the pair is
// keyed without an escape.
export function essenceMethodName(
	namespaceName: string,
	memberName: string,
): string | null {
	return essenceMethodNames().has(`${namespaceName}\u0000${memberName}`)
		? essenceMethodIdentifier(namespaceName, memberName)
		: null
}

// NOTE: The same answer for a static Property the prelude gives a VALUE to. It
// is asked separately from the Methods, and not because the emitted name differs
// — it is the one `essenceMethodIdentifier` spells, and a member is a Method or
// a Property but never both (`buildStdlibArtifacts` refuses the overlap) — but
// because the KIND decides where the const is emitted: a Method's holds a
// Function expression and may sit anywhere, a Property's holds the value itself
// and is ordered against the other Properties it reads. A value-LESS
// `static PI: Transcendental` is a native, reaches no typed Node, and stays the
// plain `Number.PI` member read off the runtime module.
const essencePropertyNames = derivedFromStdlib(
	() =>
		new Set(
			stdlibPrelude().flatMap((namespace) =>
				Object.keys(namespace.node.properties).map(
					(name) => `${namespace.name} ${name}`,
				),
			),
		),
)

export function essencePropertyName(
	namespaceName: string,
	memberName: string,
): string | null {
	return essencePropertyNames().has(`${namespaceName} ${memberName}`)
		? essenceMethodIdentifier(namespaceName, memberName)
		: null
}

// NOTE: The emitted names of the NATIVE free Functions — the ones the Rewriter
// reaches by reading off the runtime `functions` module (`$_.<name>`) rather
// than through a top-level const. Free Functions invert the Method default: a
// Method is native unless the prelude implements it, whereas a free Function is
// a bare Identifier call — a user's own, most often — so it is Essence-bodied
// unless this set says otherwise. Built from the loader's `functionBindings`: a
// body-less `function` contributes its plain name, an `overload function` block
// one `__overload$N` name per native entry — the very numbering the Simplifier
// mangled the call site to, so the two agree by construction. `__print` appears
// here too, though it reaches the runtime through the `__` sigil instead.
export const nativeFreeFunctionNames = derivedFromStdlib((stdlib) => {
	let names = new Set<string>()

	for (let [name, flags] of Object.entries(stdlib.functionBindings)) {
		let member = stdlib.members[name]

		if (member?.type === "OverloadedStaticMethod") {
			flags.forEach((native, index) => {
				if (native) {
					names.add(resolveOverloadedMethodName(name, index))
				}
			})
		} else if (flags[0]) {
			names.add(name)
		}
	}

	return names
})
