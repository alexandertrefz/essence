import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"
import * as algebraic from "@essence-lang/runtime/Algebraic"
import * as boolean from "@essence-lang/runtime/Boolean"
import * as caseModule from "@essence-lang/runtime/Case"
import * as functions from "@essence-lang/runtime/functions"
import * as integer from "@essence-lang/runtime/Integer"
import * as list from "@essence-lang/runtime/List"
import * as nestedList from "@essence-lang/runtime/NestedList"
import * as normalizationForm from "@essence-lang/runtime/NormalizationForm"
import * as nothing from "@essence-lang/runtime/Nothing"
import * as number from "@essence-lang/runtime/Number"
import * as numberFormat from "@essence-lang/runtime/NumberFormat"
import * as optional from "@essence-lang/runtime/Optional"
import * as ordering from "@essence-lang/runtime/Ordering"
import * as rational from "@essence-lang/runtime/Rational"
import * as record from "@essence-lang/runtime/Record"
import * as rounding from "@essence-lang/runtime/Rounding"
import * as side from "@essence-lang/runtime/Side"
import * as string from "@essence-lang/runtime/String"
import * as transcendental from "@essence-lang/runtime/Transcendental"

import { builtinNamespaces } from "../enricher/builtins"
import { loadStdlib } from "../enricher/stdlib"
import { resolveOverloadedMethodName } from "../helpers/index"
import { runtimeNamespaceNames } from "../rewriter/index"
import { nativeArity } from "../tools/generateNatives"

// NOTE: The Rewriter imports one runtime module per builtin Namespace, under
// the Namespace's own name, so the mapping is the identity. The keys are
// cross-checked against `runtimeNamespaceNames` below, so this table can not
// silently fall out of step with what the Rewriter actually imports.
const runtimeModules: Record<string, Record<string, unknown>> = {
	String: string,
	Boolean: boolean,
	Integer: integer,
	Rational: rational,
	Algebraic: algebraic,
	Transcendental: transcendental,
	Number: number,
	Nothing: nothing,
	Optional: optional,
	Ordering: ordering,
	Side: side,
	Case: caseModule,
	NormalizationForm: normalizationForm,
	NumberFormat: numberFormat,
	Rounding: rounding,
	Record: record,
	List: list,
	NestedList: nestedList,
}

// NOTE: What the Simplifier will emit for a declared Method — the bare name for
// a single signature, `name__overload$N` for each overload of an Overloaded
// one (`simplifier/index.ts:142`). The index is the one the Method was WRITTEN
// at, natives included, which is exactly how `nativeBindings` is indexed too.
// Each name carries the arity the runtime convention will call it with, from the
// generator's own `nativeArity`, so the two checks can never disagree about it.
function expectedExports(
	name: string,
	method: common.MethodType,
): Array<{ name: string; arity: number }> {
	if (
		method.type === "OverloadedMethod" ||
		method.type === "OverloadedStaticMethod"
	) {
		return method.overloads.map((overload, index) => ({
			name: resolveOverloadedMethodName(name, index),
			arity: nativeArity(overload),
		}))
	}

	return [{ name, arity: nativeArity(method) }]
}

// NOTE: Which entries of a Namespace member are native. Every builtin
// Namespace is declared in `packages/stdlib/sources/*.es` and so has an entry, but the
// default stays "all native": a Namespace or Method the loader did not record
// a binding for is one whose declaration carried no body, which is exactly a
// native.
function nativeFlagsFor(
	namespaceName: string,
	memberName: string,
	count: number,
): Array<boolean> {
	let bindings = loadStdlib().nativeBindings[namespaceName]

	if (bindings === undefined) {
		return Array.from({ length: count }, () => true)
	}

	return (
		bindings.methods[memberName] ??
		Array.from({ length: count }, () => true)
	)
}

describe("Builtins", () => {
	// NOTE: The stronger, per-signature form of this cross-check now lives in
	// `natives.generated.ts`, which tsc holds against every runtime module. This
	// stays because it gives a friendlier, Namespace-grouped message at test
	// time and is the only check that covers a Namespace with NO runtime module
	// at all. The set cross-check below closes the registration-site drift the
	// README warns about: a Namespace declared in `packages/stdlib/sources` but missing from
	// the Rewriter's import list, or vice versa, emits a call to `undefined`.
	it("registers every builtin Namespace at every site", () => {
		let declared = builtinNamespaces()
			.map((namespace) => namespace.name)
			.sort()
		let imported = [...runtimeNamespaceNames].sort()
		let tabled = Object.keys(runtimeModules).sort()

		// NOTE: Every declared Namespace has a runtime module the Rewriter
		// imports, and the Rewriter imports nothing the standard library does not
		// declare.
		expect(imported).toEqual(declared)
		// NOTE: This spec's own module table agrees with the Rewriter's list.
		expect(tabled).toEqual(imported)
	})

	// NOTE: The Enricher's tables promise a Method exists; the runtime module
	// has to keep that promise. Nothing between the two stages checks it — a
	// declared Method with no matching export type-checks, compiles, and then
	// emits a call to `undefined`. `removeLast` shipped that way: declared with
	// two overloads, implemented as one plain function, so every
	// `list::removeLast()` was broken. The per-function unit tests missed it
	// because they call the runtime directly, under the name it happens to
	// have, rather than the name the Simplifier will ask for.
	//
	// NOTE: The check runs in BOTH directions now that a standard library
	// Method may be implemented in Essence rather than bound to the runtime. A
	// native without an export is the broken call above; an Essence-bodied
	// Method WITH an export is dead code — the leftover TypeScript nobody
	// deleted when the Method moved, which will never be called again and will
	// quietly rot out of step with the Essence that replaced it.
	//
	// NOTE: The export's own `.length` is checked against the declared arity as
	// well — the shape `natives.generated.ts` can not see, because a default or
	// rest Parameter hides the real count from the type system.
	describe("every declared Method has a runtime implementation", () => {
		for (let namespace of builtinNamespaces()) {
			it(`implements ${namespace.name}`, () => {
				let missing: Array<string> = []
				let stale: Array<string> = []
				let wrongArity: Array<string> = []
				let runtime = runtimeModules[namespace.name] ?? {}

				for (let [name, method] of Object.entries(namespace.methods)) {
					let exports = expectedExports(name, method)
					let native = nativeFlagsFor(
						namespace.name,
						name,
						exports.length,
					)

					exports.forEach(({ name: exportName, arity }, index) => {
						let implementation = runtime[exportName]

						if (native[index] ?? true) {
							if (typeof implementation === "function") {
								// NOTE: `natives.generated.ts` pins the same
								// arity under tsc, but only for a plain
								// signature — a default or rest Parameter makes
								// `Parameters<T>['length']` non-literal, and
								// then the only way to see the real count is to
								// ask the function itself.
								if (implementation.length !== arity) {
									wrongArity.push(
										`${namespace.name}.${exportName} takes ${implementation.length}, declares ${arity}`,
									)
								}
							} else {
								missing.push(`${namespace.name}.${exportName}`)
							}
						} else if (typeof implementation === "function") {
							stale.push(`${namespace.name}.${exportName}`)
						}
					})
				}

				let propertyBindings =
					loadStdlib().nativeBindings[namespace.name]?.properties

				for (let name of Object.keys(namespace.properties)) {
					let native = propertyBindings?.[name] ?? true

					if (native) {
						if (runtime[name] === undefined) {
							missing.push(`${namespace.name}.${name}`)
						}
					} else if (runtime[name] !== undefined) {
						stale.push(`${namespace.name}.${name}`)
					}
				}

				// NOTE: A Namespace whose every member is written in Essence
				// needs no runtime module at all — only one that still binds
				// something native does.
				if (missing.length > 0) {
					expect(runtimeModules[namespace.name]).toBeDefined()
				}

				expect(missing).toEqual([])
				expect(stale).toEqual([])
				expect(wrongArity).toEqual([])
			})
		}
	})

	// NOTE: The free Functions — the ones that belong to no Namespace, like
	// `__print` — are held to the same two promises a Namespace Method is: a
	// native one must have a runtime export under the name the Simplifier will
	// ask for, and every one must be documented. `natives.generated.ts` checks
	// the SHAPE of each export under tsc; this gives the friendlier miss-by-name
	// message and covers the documentation the generated contract does not.
	describe("free Functions", () => {
		// NOTE: The emitted name(s) of a free Function — its bare name when it is a
		// single `Function`, one `__overload$N` per overload otherwise — paired
		// with whether each is native, so the runtime check asks for exactly the
		// exports the Rewriter will read off the `functions` module.
		function nativeExportNames(): Array<string> {
			let stdlib = loadStdlib()
			let names: Array<string> = []

			for (let [name, flags] of Object.entries(stdlib.functionBindings)) {
				let member = stdlib.members[name]

				if (member?.type === "OverloadedStaticMethod") {
					flags.forEach((native, index) => {
						if (native) {
							names.push(resolveOverloadedMethodName(name, index))
						}
					})
				} else if (flags[0]) {
					names.push(name)
				}
			}

			return names
		}

		it("binds every native free Function to a runtime export", () => {
			let runtime = functions as Record<string, unknown>
			let missing = nativeExportNames().filter(
				(name) => typeof runtime[name] !== "function",
			)

			expect(missing).toEqual([])
		})

		it("documents every declared free Function", () => {
			let stdlib = loadStdlib()
			let undocumented: Array<string> = []

			for (let name of Object.keys(stdlib.functionBindings)) {
				let member = stdlib.members[name]
				let documentation =
					member?.type === "Function" ||
					member?.type === "OverloadedStaticMethod"
						? member.documentation
						: undefined

				if (
					documentation === undefined ||
					documentation === null ||
					typeof documentation.description !== "string" ||
					documentation.description.length === 0
				) {
					undocumented.push(name)
				}
			}

			expect(undocumented).toEqual([])
		})

		// NOTE: `__print` is the one SINGLE-signature free Function — a body-less
		// native bound to `functions.__print`, beside the overloaded `loop`. It is
		// listed in `builtinMemberOrder` and resolves to a `Function`, which is
		// what its `__`-sigil invocation reads.
		it("declares __print as a native free Function", () => {
			let stdlib = loadStdlib()

			expect(stdlib.functionBindings["__print"]).toEqual([true])
			expect(stdlib.members["__print"]?.type).toBe("Function")
			expect(typeof functions.__print).toBe("function")
		})
	})

	// NOTE: "Every stdlib Method is documented" is a completion gate, not an
	// aspiration — Hover and Signature Help surface these descriptions, so an
	// undocumented Method ships a blank tooltip. The backfill of 2026-07-22
	// took coverage to 100%; this keeps it there.
	describe("every declared Method carries documentation", () => {
		for (let namespace of builtinNamespaces()) {
			it(`documents ${namespace.name}`, () => {
				let undocumented: Array<string> = []

				for (let [name, method] of Object.entries(namespace.methods)) {
					let documentation = method.documentation

					if (
						documentation === undefined ||
						documentation === null ||
						typeof documentation.description !== "string" ||
						documentation.description.length === 0
					) {
						undocumented.push(`${namespace.name}::${name}`)
					}
				}

				expect(undocumented).toEqual([])
			})
		}
	})
})
