import { loadStdlib } from "../enricher/stdlib"
import type { common } from "../interfaces/index"
import { optimise } from "../optimiser/index"
import { simplify } from "../simplifier/index"

// NOTE: A standard library Namespace is now written in TWO languages at once:
// some of its Methods are bound to a runtime module in `__internal/`, the rest
// are implemented in Essence in `src/stdlib/`. Emitted user code can not tell
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
export function buildStdlibPrelude(
	typedPrograms: Array<common.typed.Program>,
): Array<PreludeNamespace> {
	let prelude: Array<PreludeNamespace> = []

	for (let typedProgram of typedPrograms) {
		let program = optimise(simplify(structuredClone(typedProgram)))

		for (let node of program.implementation.nodes) {
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
			// NOTE: For whoever converts `Number`, `Transcendental` or any other
			// Namespace with static Properties: a value-LESS `static PI:
			// Transcendental` is a native and never reaches this Node, so those
			// convert as they are. Giving one a value needs the Rewriter to emit
			// Properties as assignments AFTER every const — `Transcendental.PI =
			// …` — at which point the ordering between two Properties that name
			// each other becomes the next thing to answer.
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

			prelude.push({ name: node.name.name, node })
		}
	}

	return prelude
}

// NOTE: Built once per process, exactly like the standard library it is built
// from. Simplifying and optimising six Programs for every user file compiled in
// a worker would be paid over and over for a result that can not differ.
let cachedPrelude: Array<PreludeNamespace> | null = null

export function stdlibPrelude(): Array<PreludeNamespace> {
	if (cachedPrelude === null) {
		cachedPrelude = buildStdlibPrelude(loadStdlib().typedPrograms)
	}

	return cachedPrelude
}
