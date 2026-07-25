import type { common } from "@essence/interfaces"

import { loadStdlib } from "../enricher/stdlib"
import { resolveOverloadedMethodName } from "../helpers/index"
import { optimise } from "../optimiser/index"
import { simplify } from "../simplifier/index"

// NOTE: A standard library Namespace is now written in TWO languages at once:
// some of its Methods are bound to a runtime module in `__internal/`, the rest
// are implemented in Essence in `packages/stdlib/sources/`. Emitted user code can not tell
// the two apart — it says `Boolean.isNot(…)` either way — so the Rewriter has
// to hand it ONE object that answers to both halves. That object is the prelude:
// the runtime module spread into an object literal, with the Essence-implemented
// Methods laid on top.
//
// NOTE: An object literal rather than a class, because a class body can not
// spread anything, and every alternative (assigning onto the imported module
// namespace, subclassing, a Proxy) either mutates a frozen module object or
// costs a lookup on every call.

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

function buildStdlibArtifacts(
	typedPrograms: Array<common.typed.Program>,
): StdlibArtifacts {
	let namespaces: Array<PreludeNamespace> = []
	let freeFunctions: Array<PreludeFreeFunction> = []

	for (let typedProgram of typedPrograms) {
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

			// NOTE: A bodied static Property can NOT be merged, and is refused
			// here rather than emitted wrongly. Its initialiser would be
			// evaluated inside the const's own object literal — and every
			// Essence literal compiles to a call on a Namespace, so
			// `static YES: Boolean = true` emits
			// `const Boolean = { …, YES: Boolean.createBoolean(true) }`, which
			// reads `Boolean` before the const it is initialising exists. The
			// cross-Namespace spelling is no better: the const that needs the
			// value may be emitted above the one that provides it. Neither
			// produces a Diagnostic — it type checks, compiles, and crashes at
			// import — so the compiler developer who writes the first one has to
			// be stopped here.
			//
			// NOTE: `Number.PI` and `Number.TAU` are the proof this refusal is
			// narrow rather than a wall: a value-LESS `static PI:
			// Transcendental` is a native, never reaches this Node, and arrives
			// at a call site through the spread — which is how the numeric tower
			// converted with its constants intact. Giving one a value needs the
			// Rewriter to emit Properties as assignments AFTER every const —
			// `Number.PI = …` — at which point the ordering between two
			// Properties that name each other becomes the next thing to answer.
			let bodiedProperties = Object.keys(node.properties)

			if (bodiedProperties.length > 0) {
				throw new Error(
					`The standard library Namespace '${node.name.name}' gives a value to the static ${
						bodiedProperties.length === 1
							? "Property"
							: "Properties"
					} ${bodiedProperties.map((name) => `'${name}'`).join(", ")}, which the Rewriter can not emit yet — declare it without a value, so it binds to the runtime`,
				)
			}

			// NOTE: Only the BODIED members reach the typed Node — a native has
			// no body to emit — so a Namespace that is entirely native arrives
			// here empty and is dropped. Merging it would emit a const that
			// spreads the runtime module and adds nothing, which is only a
			// slower way of importing it.
			if (Object.keys(node.methods).length === 0) {
				continue
			}

			namespaces.push({ name: node.name.name, node })
		}
	}

	return { namespaces, freeFunctions }
}

// NOTE: The prelude proper — the Essence-implemented Namespace members — keeps
// its name and shape now that free Functions are collected beside it, so every
// existing caller and test reads the Namespaces exactly as before.
export function buildStdlibPrelude(
	typedPrograms: Array<common.typed.Program>,
): Array<PreludeNamespace> {
	return buildStdlibArtifacts(typedPrograms).namespaces
}

// NOTE: Built once per process, exactly like the standard library it is built
// from. Simplifying and optimising six Programs for every user file compiled in
// a worker would be paid over and over for a result that can not differ. The
// Namespaces and the free Functions come out of the one simplify pass, so both
// accessors share this cache rather than each walking the library again.
let cachedArtifacts: StdlibArtifacts | null = null

function stdlibArtifacts(): StdlibArtifacts {
	if (cachedArtifacts === null) {
		cachedArtifacts = buildStdlibArtifacts(loadStdlib().typedPrograms)
	}

	return cachedArtifacts
}

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
let cachedEssenceMethodNames: Set<string> | null = null

// NOTE: The ` ` join can not occur inside either name, so the pair is
// keyed without an escape.
export function essenceMethodName(
	namespaceName: string,
	memberName: string,
): string | null {
	if (cachedEssenceMethodNames === null) {
		cachedEssenceMethodNames = new Set(
			stdlibPrelude().flatMap((namespace) =>
				Object.keys(namespace.node.methods).map(
					(name) => `${namespace.name} ${name}`,
				),
			),
		)
	}

	return cachedEssenceMethodNames.has(`${namespaceName} ${memberName}`)
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
let cachedNativeFreeFunctionNames: Set<string> | null = null

export function nativeFreeFunctionNames(): Set<string> {
	if (cachedNativeFreeFunctionNames === null) {
		let stdlib = loadStdlib()
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

		cachedNativeFreeFunctionNames = names
	}

	return cachedNativeFreeFunctionNames
}
