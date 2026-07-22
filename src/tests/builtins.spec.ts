import { describe, expect, it } from "bun:test"

import { builtinNamespaces } from "../enricher/builtins"
import { resolveOverloadedMethodName } from "../helpers/index"
import * as algebraic from "../rewriter/__internal/Algebraic"
import * as boolean from "../rewriter/__internal/Boolean"
import * as integer from "../rewriter/__internal/Integer"
import * as list from "../rewriter/__internal/List"
import * as nothing from "../rewriter/__internal/Nothing"
import * as number from "../rewriter/__internal/Number"
import * as optional from "../rewriter/__internal/Optional"
import * as ordering from "../rewriter/__internal/Ordering"
import * as rational from "../rewriter/__internal/Rational"
import * as record from "../rewriter/__internal/Record"
import * as string from "../rewriter/__internal/String"
import * as transcendental from "../rewriter/__internal/Transcendental"

// NOTE: The Rewriter imports one runtime module per builtin Namespace, under
// the Namespace's own name (`src/rewriter/index.ts:17-34`), so the mapping is
// the identity — and this table is the only place it is written twice.
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
	Record: record,
	List: list,
}

// NOTE: What the Simplifier will emit for a declared Method — the bare name for
// a single signature, `name__overload$N` for each overload of an Overloaded
// one (`simplifier/index.ts:142`).
function expectedExportNames(
	name: string,
	method: { type: string },
): Array<string> {
	if (
		method.type === "OverloadedMethod" ||
		method.type === "OverloadedStaticMethod"
	) {
		return (
			method as unknown as { overloads: Array<unknown> }
		).overloads.map((_, index) => resolveOverloadedMethodName(name, index))
	}

	return [name]
}

describe("Builtins", () => {
	// NOTE: The Enricher's tables promise a Method exists; the runtime module
	// has to keep that promise. Nothing between the two stages checks it — a
	// declared Method with no matching export type-checks, compiles, and then
	// emits a call to `undefined`. `removeLast` shipped that way: declared with
	// two overloads, implemented as one plain function, so every
	// `list::removeLast()` was broken. The per-function unit tests missed it
	// because they call the runtime directly, under the name it happens to
	// have, rather than the name the Simplifier will ask for.
	describe("every declared Method has a runtime implementation", () => {
		for (let namespace of builtinNamespaces) {
			it(`implements ${namespace.name}`, () => {
				let runtime = runtimeModules[namespace.name]

				expect(runtime).toBeDefined()

				let missing: Array<string> = []

				for (let [name, method] of Object.entries(namespace.methods)) {
					for (let exportName of expectedExportNames(name, method)) {
						if (typeof runtime[exportName] !== "function") {
							missing.push(`${namespace.name}.${exportName}`)
						}
					}
				}

				for (let name of Object.keys(namespace.properties)) {
					if (runtime[name] === undefined) {
						missing.push(`${namespace.name}.${name}`)
					}
				}

				expect(missing).toEqual([])
			})
		}
	})

	// NOTE: "Every stdlib Method is documented" is a completion gate, not an
	// aspiration — Hover and Signature Help surface these descriptions, so an
	// undocumented Method ships a blank tooltip. The backfill of 2026-07-22
	// took coverage to 100%; this keeps it there.
	describe("every declared Method carries documentation", () => {
		for (let namespace of builtinNamespaces) {
			it(`documents ${namespace.name}`, () => {
				let undocumented: Array<string> = []

				for (let [name, method] of Object.entries(namespace.methods)) {
					let documentation = (
						method as unknown as {
							documentation?: { description?: string }
						}
					).documentation

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
