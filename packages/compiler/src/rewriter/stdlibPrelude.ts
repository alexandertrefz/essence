import type { common } from "@essence-lang/interfaces"

import { throughSnapshot } from "../cache/snapshot"
import type { NativeBindings, Stdlib } from "../enricher/stdlib"
import { isCanonicalStdlib, loadStdlib } from "../enricher/stdlib"
import { resolveOverloadedMethodName } from "../helpers/types"
import {
	defaultOptimiserOptions,
	optimise,
	type OptimiserOptions,
	optimiserOptionsKey,
	withoutCoverage,
} from "../optimiser/index"
import { simplify } from "../simplifier/index"

// The prelude holds the standard library members with Essence bodies,
// simplified and optimised once per process. This file also answers which half
// of a Namespace a member belongs to. See "The standard library prelude" in
// DEVELOPMENT.md.

// A Namespace with at least one bodied member. A wholly native Namespace
// never appears here.
export type PreludeNamespace = {
	name: string
	node: common.typedSimple.NamespaceDefinitionStatementNode
	// Set for a Protocol's provided Methods. It picks the const name through
	// `protocolMemberIdentifier`, and is a flag because a Protocol and a
	// Namespace may share a name.
	protocol?: true
	// The Protocol identity an Invocation's `providedBy` names.
	identity?: string
	// The coverage counter a provided Method's points call, bound by the
	// prelude. See "Counting provided Methods" in DEVELOPMENT.md.
	counter?: string
}

export type PreludeFreeFunction = {
	name: string
	node: common.typedSimple.FunctionStatementNode
}

type StdlibArtifacts = {
	namespaces: Array<PreludeNamespace>
	freeFunctions: Array<PreludeFreeFunction>
}

// The names a Namespace declares both as a Method and as a static Property.
// Only bodied members reach the typed node, so this reads `nativeBindings`.
// See "Const names" in DEVELOPMENT.md.
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
		// The Language Server and the tests read these typed Programs too,
		// and the copy keeps the prelude from sharing any object with them.
		let program = optimise(
			simplify(structuredClone(typedProgram)),
			currentOptimiserOptions,
		)

		for (let node of program.implementation.nodes) {
			// A bodied free Function, named as its call sites resolve it:
			// `<name>__overload$N` for an `overload function` entry. A native
			// one has no typed node and never reaches here.
			if (node.nodeType === "FunctionStatement") {
				freeFunctions.push({ name: node.name.name, node })

				continue
			}

			// A Protocol's provided Methods become one const each, shared by
			// every conformer. The Protocol poses as a Namespace, since the
			// emission reads only a name and bodied Methods.
			if (node.nodeType === "ProtocolDeclarationStatement") {
				if (Object.keys(node.methods).length > 0) {
					namespaces.push({
						name: node.name.name,
						protocol: true,
						identity: node.identity,
						node: {
							nodeType: "NamespaceDefinitionStatement",
							name: node.name,
							properties: {},
							methods: node.methods,
							nativeShims: [],
							type: {
								type: "Namespace",
								name: node.name.name,
								targetType: null,
								generics: [],
								properties: {},
								methods: {},
							},
							position: node.position,
						},
					})
				}

				continue
			}

			if (node.nodeType !== "NamespaceDefinitionStatement") {
				continue
			}

			// A Method and a static Property of one Namespace would share a
			// const, and every call of the Method would read the Property. See
			// "Const names" in DEVELOPMENT.md.
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

			// A wholly native Namespace arrives with no members and has no
			// const to contribute. A static Property with a value, or a native
			// shim, is enough to keep it.
			if (
				Object.keys(node.methods).length === 0 &&
				Object.keys(node.properties).length === 0 &&
				node.nativeShims.length === 0
			) {
				continue
			}

			namespaces.push({ name: node.name.name, node })
		}
	}

	return { namespaces, freeFunctions }
}

// The prelude's Namespaces, built uncached. It takes the whole `Stdlib`
// because `clashingMemberNames` reads the loader's `nativeBindings`.
export function buildStdlibPrelude(stdlib: Stdlib): Array<PreludeNamespace> {
	return buildStdlibArtifacts(stdlib).namespaces
}

// The options the prelude is optimised under: those of the Program that
// imports it. See "Caching the prelude" in DEVELOPMENT.md.
let currentOptimiserOptions: OptimiserOptions = defaultOptimiserOptions

// Removes coverage: the standard library is never instrumented, and a
// coverage run then shares its prelude with a plain one.
export function withOptimiserOptions<Value>(
	options: OptimiserOptions,
	build: () => Value,
): Value {
	let previous = currentOptimiserOptions

	currentOptimiserOptions = withoutCoverage(options)

	try {
		return build()
	} finally {
		currentOptimiserOptions = previous
	}
}

// A value computed from the standard library, kept per `Stdlib` object and
// per `optimiserOptionsKey`. See "Caching the prelude" in DEVELOPMENT.md.
function derivedFromStdlib<Value>(
	build: (stdlib: Stdlib) => Value,
): () => Value {
	let cache: { stdlib: Stdlib; values: Map<string, Value> } | null = null

	return () => {
		let stdlib = loadStdlib()
		let key = optimiserOptionsKey(currentOptimiserOptions)

		if (cache === null || cache.stdlib !== stdlib) {
			cache = { stdlib, values: new Map() }
		}

		if (!cache.values.has(key)) {
			cache.values.set(key, build(stdlib))
		}

		return cache.values.get(key) as Value
	}
}

// The shape a snapshot must have before it is believed, as `isStdlib` checks
// for the loader's. The snapshot key answers for the nodes inside.
function isStdlibArtifacts(value: unknown): boolean {
	let artifacts = value as StdlibArtifacts

	return (
		typeof artifacts === "object" &&
		artifacts !== null &&
		Array.isArray(artifacts.namespaces) &&
		Array.isArray(artifacts.freeFunctions)
	)
}

// The artifacts kept between processes, for the canonical library only.
// See "Caching the prelude" in DEVELOPMENT.md.
function snapshotStdlibArtifacts(stdlib: Stdlib): StdlibArtifacts {
	if (!isCanonicalStdlib(stdlib)) {
		return buildStdlibArtifacts(stdlib)
	}

	return throughSnapshot<StdlibArtifacts>({
		kind: "prelude",
		variant: optimiserOptionsKey(currentOptimiserOptions),
		isValid: isStdlibArtifacts,
		build: () => buildStdlibArtifacts(stdlib),
	})
}

// The Namespaces and the free Functions come from one pass, so both
// accessors share this cache.
const stdlibArtifacts = derivedFromStdlib(snapshotStdlibArtifacts)

export function stdlibPrelude(): Array<PreludeNamespace> {
	return stdlibArtifacts().namespaces
}

// The bodied free Functions. The Rewriter emits only those a Program reaches.
export function stdlibFreeFunctions(): Array<PreludeFreeFunction> {
	return stdlibArtifacts().freeFunctions
}

// The prefix on its own, so the Rewriter can check that every name wearing
// it in a finished tree has a const.
export const ESSENCE_METHOD_PREFIX = "$es_"

// The const name of a bodied standard library member. No user identifier
// contains `_`, so none can collide. See "Const names" in DEVELOPMENT.md.
export function essenceMethodIdentifier(
	namespaceName: string,
	memberName: string,
): string {
	return `${ESSENCE_METHOD_PREFIX}${namespaceName}_${memberName}`
}

// The const name of a Protocol's provided Method. The double `_` keeps it
// apart from a Namespace member of the same name. See "Const names" in
// DEVELOPMENT.md.
export function protocolMemberIdentifier(
	protocolName: string,
	memberName: string,
): string {
	return `${ESSENCE_METHOD_PREFIX}${protocolName}__${memberName}`
}

// The `(Namespace, member)` pairs the prelude gives a body. Both halves of a
// lookup arrive overload-mangled. The set is complete before any body is
// rewritten, since `buildStdlibArtifacts` never calls the Rewriter. See "Which
// member is which" in DEVELOPMENT.md.
const essenceMethodNames = derivedFromStdlib(
	() =>
		new Set(
			stdlibPrelude()
				// A provided Method is reached through `providedBy`, never by
				// a Namespace lookup.
				.filter((namespace) => namespace.protocol !== true)
				.flatMap((namespace) =>
					Object.keys(namespace.node.methods).map(
						(name) => `${namespace.name}\u0000${name}`,
					),
				),
		),
)

// No name contains `\u0000`, so the join needs no escape.
export function essenceMethodName(
	namespaceName: string,
	memberName: string,
): string | null {
	return essenceMethodNames().has(`${namespaceName}\u0000${memberName}`)
		? essenceMethodIdentifier(namespaceName, memberName)
		: null
}

// The native `(Namespace, member)` pairs that declare a default, keyed like
// `essenceMethodNames`. Only a call that leaves an Argument out goes through
// the shim.
const nativeShimNames = derivedFromStdlib(
	() =>
		new Set(
			stdlibPrelude().flatMap((namespace) =>
				namespace.node.nativeShims.map(
					(shim) => `${namespace.name}\u0000${shim.memberName}`,
				),
			),
		),
)

export function nativeShimName(
	namespaceName: string,
	memberName: string,
): string | null {
	return nativeShimNames().has(`${namespaceName}\u0000${memberName}`)
		? essenceMethodIdentifier(namespaceName, memberName)
		: null
}

// The shims whose default is a Record, which the shim's `prologue` merges
// into a written Argument. Every call goes through such a shim.
const mergingShimNames = derivedFromStdlib(
	() =>
		new Set(
			stdlibPrelude().flatMap((namespace) =>
				namespace.node.nativeShims
					.filter((shim) => shim.prologue.length > 0)
					.map((shim) => `${namespace.name}\u0000${shim.memberName}`),
			),
		),
)

export function mergingNativeShimName(
	namespaceName: string,
	memberName: string,
): string | null {
	return mergingShimNames().has(`${namespaceName}\u0000${memberName}`)
		? essenceMethodIdentifier(namespaceName, memberName)
		: null
}

// The static Properties the prelude gives a value. They are asked apart from
// Methods because a Property's const is ordered by what it reads.
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

// The native free Functions, which the Rewriter reads off the runtime
// `functions` module. A free Function is bodied unless this set names it.
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
