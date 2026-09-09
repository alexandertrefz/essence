import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { builtinNamespaces, builtinProtocols } from "../enricher/builtins"
import { enrich } from "../enricher/index"
import {
	derivedEquatableNamespace,
	derivedPrintableNamespace,
} from "../enricher/resolvers"
import { computeConformanceMethodMap } from "../helpers/conformance"
import { parse } from "../parser/index"
import { printType } from "../printType"

function enrichSource(source: string): {
	program: common.typed.Program
	diagnostics: Array<common.Diagnostic>
} {
	return enrich(parse(source))
}

function diagnosticsFor(source: string): Array<common.Diagnostic> {
	return enrichSource(source).diagnostics
}

// NOTE: The characters a Diagnostic's Position covers — which is the text a
// Quick Fix replaces with the suggestion the same Diagnostic carries. Spelling
// them out is the only way to assert that a `#Case` span stops short of the
// sigil without counting columns by hand. Single line spans only; every
// Diagnostic asked this reports on one name.
function underlinedText(source: string, diagnostic: common.Diagnostic): string {
	let position = diagnostic.position

	if (position === null) {
		throw new Error("Diagnostic has no Position.")
	}

	return source
		.split("\n")
		[position.start.line - 1].slice(
			position.start.column - 1,
			position.end.column - 1,
		)
}

// NOTE: The characters one Position covers, for a test that means to say WHERE
// a synthesized Node stands rather than which columns it happens to have.
function spanOf(source: string, position: common.Position): string {
	return source
		.split("\n")
		[position.start.line - 1].slice(
			position.start.column - 1,
			position.end.column - 1,
		)
}

// NOTE: The typed Expression a Program's LAST Constant was declared from —
// which is how a test asks what a call resolved to: which Namespace won, which
// Overload, which dispatch branches, and what the Arguments were typed as. The
// Program is required to enrich cleanly, so a test that means to assert on a
// resolution can not silently assert on a failed one instead.
function lastConstantValue(source: string): common.typed.ExpressionNode {
	let { program, diagnostics } = enrichSource(source)

	expect(diagnostics).toEqual([])

	let constants = program.implementation.nodes.filter(
		(node) => node.nodeType === "ConstantDeclarationStatement",
	)

	return constants[constants.length - 1].value
}

function lastConstantMethodInvocation(
	source: string,
): common.typed.MethodInvocationNode {
	let value = lastConstantValue(source)

	expect(value.nodeType).toBe("MethodInvocation")

	if (value.nodeType !== "MethodInvocation") {
		throw new Error("Last Constant is not a MethodInvocation.")
	}

	return value
}

function lastConstantFunctionInvocation(
	source: string,
): common.typed.FunctionInvocationNode {
	let value = lastConstantValue(source)

	expect(value.nodeType).toBe("FunctionInvocation")

	if (value.nodeType !== "FunctionInvocation") {
		throw new Error("Last Constant is not a FunctionInvocation.")
	}

	return value
}

// NOTE: The Type an applied `Optional<ItemType>` enriches to. It is no longer
// the Union `ItemType | Nothing` an Alias expanded to, but the Union of the two
// Cases the `Optional` Choice declares — each carrying the Type Arguments the
// application bound, under the applied spelling as the display alias. Written
// once here because the shape is long and says nothing a test is about; what a
// test is about is the item Type threaded through it.
function optionalOf(itemType: common.Type): common.Type {
	return {
		type: "UnionType",
		alias: { name: "Optional", typeArguments: [itemType] },
		types: [
			{
				type: "Case",
				choice: "Optional",
				name: "Value",
				members: { item: itemType },
				typeArguments: [itemType],
			},
			{
				type: "Case",
				choice: "Optional",
				name: "Empty",
				members: {},
				typeArguments: [itemType],
			},
		],
	}
}

// NOTE: The LIVE Namespace of that name — the one read from `packages/standard-library/sources/*.es`
// and handed to every Program's top level Scope. Asserting against this rather
// than against a declaration read straight out of a source file is the point:
// a test about which Namespace declares a Method has to ask what a Program can
// actually reach. Throws rather than returning `undefined`, so a renamed or
// dropped Namespace fails as a missing Namespace instead of as a missing
// Method.
function builtinNamespace(name: string): common.NamespaceType {
	let namespace = builtinNamespaces().find(
		(candidate) => candidate.name === name,
	)

	if (namespace === undefined) {
		throw new Error(`There is no builtin Namespace named '${name}'`)
	}

	return namespace
}

// NOTE: Every Case construction in a typed subtree, in the order it was built —
// how a test asks what a Case a Program never spelled the Type Arguments of was
// finally decided as. A `GenericUse` left in `typeArguments` is a Type Parameter
// nothing decided, which is exactly what such an assertion is about.
function collectCaseTypes(value: unknown): Array<common.Type> {
	let found: Array<common.Type> = []

	let visit = (node: unknown) => {
		if (Array.isArray(node)) {
			for (let element of node) {
				visit(element)
			}

			return
		}

		if (node === null || typeof node !== "object") {
			return
		}

		let record = node as Record<string, unknown>

		if (record.nodeType === "CaseValue") {
			found.push(record.type as common.Type)
		}

		for (let key of Object.keys(record)) {
			if (key === "position" || key === "type") {
				continue
			}

			visit(record[key])
		}
	}

	visit(value)

	return found
}

// NOTE: Walks the typed Program collecting every resolved Conformance —
// wherever a bounded Type Parameter was satisfied, an Invocation carries the
// `{ genericName, protocolName, source }` shape. Used to assert which Namespace
// a bound resolved to at a call site.
function collectConformances(value: unknown): Array<common.Conformance> {
	let found: Array<common.Conformance> = []
	let seen = new WeakSet<object>()

	let visit = (node: unknown) => {
		if (Array.isArray(node)) {
			for (let element of node) {
				visit(element)
			}

			return
		}

		if (node === null || typeof node !== "object") {
			return
		}

		if (seen.has(node)) {
			return
		}

		seen.add(node)

		let record = node as Record<string, unknown>

		if (
			"genericName" in record &&
			"protocolName" in record &&
			"source" in record
		) {
			found.push(record as unknown as common.Conformance)
		}

		for (let key of Object.keys(record)) {
			visit(record[key])
		}
	}

	visit(value)

	return found
}

describe("Enricher", () => {
	describe("Diagnostics", () => {
		it("should report no Diagnostics for a valid Program", () => {
			expect(
				diagnosticsFor(`implementation {
					constant name = "essence"
					Terminal.inspect(name)
				}`),
			).toEqual([])
		})

		it("should report undeclared Variables", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = undeclaredVariable
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].message).toBe(
				"'undeclaredVariable' is not declared",
			)
			expect(diagnostics[0].position?.start.line).toBe(2)
		})

		it("should report undeclared Types", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a: UndeclaredType = "value"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Type 'UndeclaredType' is not declared",
			)
		})

		it("should report redeclared Variables", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = "first"
				constant a = "second"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Variable 'a' is already declared",
			)
			expect(diagnostics[0].position?.start.line).toBe(3)
		})

		it("should report redeclared Types", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Name = String
				type Name = Boolean
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Type 'Name' is already declared",
			)
		})

		it("should report Method Invocations without a matching Namespace method", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = "value"::undeclaredMethod()
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unknown-method")
		})

		// NOTE: The Help and the `data` must name the same thing — the Help is
		// what the reader is told and the `data` is what a Quick Fix writes,
		// and a fix that inserts a different name than the Diagnostic offered
		// is worse than no fix at all.
		it("should carry a near miss as data as well as a Help", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = "value"::lenth()
			}`)

			expect(diagnostics[0].code).toBe("unknown-method")
			expect(diagnostics[0].helps).toEqual(["Did you mean 'length'?"])
			expect(diagnostics[0].data).toEqual({
				kind: "suggestion",
				suggestion: "length",
			})
		})

		it("should carry no data when nothing is close enough to suggest", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = "value"::undeclaredMethod()
			}`)

			expect(diagnostics[0].helps).toEqual([])
			expect(diagnostics[0].data).toBeUndefined()
		})

		// NOTE: The bare name, so the Case Quick Fix replaces exactly what the
		// Diagnostic underlines — the `#` belongs to the Help's rendering.
		it("should carry an unknown Case's near miss without its sigil", () => {
			let diagnostics = diagnosticsFor(`implementation {
				choice Operation { Add, Subtract }
				constant chosen = Operation#Ad
			}`)

			expect(diagnostics[0].code).toBe("unknown-case")
			expect(diagnostics[0].helps).toEqual(["Did you mean '#Add'?"])
			expect(diagnostics[0].data).toEqual({
				kind: "suggestion",
				suggestion: "Add",
			})
		})

		// NOTE: The bare form is the spelling this codebase prefers, so it is
		// the one a near miss matters most for — and it is reported from its
		// own site, which once offered nothing while the documentation
		// promised a Quick Fix for every unknown Case.
		it("should carry a bare Case reference's near miss", () => {
			let source = `implementation {
				choice Operation { Add, Subtract }
				constant chosen: Operation = #Ad
			}`
			let diagnostics = diagnosticsFor(source)

			expect(diagnostics[0].code).toBe("unknown-case")
			expect(diagnostics[0].helps).toEqual(["Did you mean '#Add'?"])
			expect(diagnostics[0].data).toEqual({
				kind: "suggestion",
				suggestion: "Add",
			})
			expect(underlinedText(source, diagnostics[0])).toBe("Ad")
		})

		it("should carry no data for a bare Case nothing is close to", () => {
			let diagnostics = diagnosticsFor(`implementation {
				choice Operation { Add, Subtract }
				constant chosen: Operation = #Zzzzzzzz
			}`)

			expect(diagnostics[0].code).toBe("unknown-case")
			expect(diagnostics[0].helps).toEqual([])
			expect(diagnostics[0].data).toBeUndefined()
		})

		it("should carry a bare Case Matcher's near miss", () => {
			let source = `implementation {
				choice Operation { Add, Subtract }
				constant chosen: Operation = Operation#Add

				match chosen -> {} {
					case #Ad { <- {} }
					case _ { <- {} }
				}
			}`
			let diagnostics = diagnosticsFor(source)

			expect(diagnostics[0].code).toBe("unknown-case")
			expect(diagnostics[0].helps).toEqual(["Did you mean '#Add'?"])
			expect(diagnostics[0].data).toEqual({
				kind: "suggestion",
				suggestion: "Add",
			})
			expect(underlinedText(source, diagnostics[0])).toBe("Ad")
		})

		it("should carry no data for a Case Matcher nothing is close to", () => {
			let diagnostics = diagnosticsFor(`implementation {
				choice Operation { Add, Subtract }
				constant chosen: Operation = Operation#Add

				match chosen -> {} {
					case #Zzzzzzzz { <- {} }
					case _ { <- {} }
				}
			}`)

			expect(diagnostics[0].code).toBe("unknown-case")
			expect(diagnostics[0].helps).toEqual([])
			expect(diagnostics[0].data).toBeUndefined()
		})

		it("should report Method Invocations whose arguments match no overload", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = "value"::prepend()
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("no-matching-overload")
		})

		it("should accept Method Invocations with matching argument labels", () => {
			expect(
				diagnosticsFor(`implementation {
					constant a = [1]::append(contentsOf [2])
				}`),
			).toEqual([])
		})

		it("should report Method Invocations with wrong argument labels", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = [1]::append(wrongLabel [2])
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("no-matching-overload")
		})

		it("should report Combinations of non-Record Types", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = { "value" with name = "x" }
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe("Strings can not be combined")
		})

		it("should report Combinations whose right hand side is not a Partial", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = { name = "x" }
				constant b = { age = 5 }
				constant c = { a with b }
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"This is not a Partial of the value it updates",
			)
		})

		// NOTE: A Partial is judged by ASSIGNABILITY, not identity — an update
		// sets a member to a value, and a value of one arm is enough for a
		// Union-typed member, exactly as it is at the Declaration. Deep
		// equality refused every one of these.
		it("should accept an update setting one arm of a Union-typed member", () => {
			expect(
				diagnosticsFor(`implementation {
					constant c: { n: Integer | String } = { n = "a" }
					constant updated = { c with n = 5 }
				}`),
			).toEqual([])
		})

		it("should accept a Partial spelling a member's Union in another order", () => {
			expect(
				diagnosticsFor(`implementation {
					constant c: { n: Integer | String } = { n = "a" }
					constant partial: { n: String | Integer } = { n = 5 }
					constant updated = { c with partial }
				}`),
			).toEqual([])
		})

		// NOTE: `{ config with server.port = 1 }` IS
		// `{ config with server = { config.server with port = 1 } }`, and the
		// Enricher is where the one becomes the other — so the Type it answers
		// is the Type the value updated already had.
		describe("path keys", () => {
			const config = `type Tls = { enabled: Boolean }
				type Server = { host: String, port: Integer, tls: Tls }
				type Config = { name: String, server: Server }

				constant config: Config = {
					name = "api",
					server = {
						host = "localhost",
						port = 80,
						tls = { enabled = false },
					},
				}`

			it("should accept a key that reaches one level in", () => {
				expect(
					diagnosticsFor(`implementation {
						${config}
						constant moved = { config with server.port = 8080 }
					}`),
				).toEqual([])
			})

			it("should accept a key that reaches two levels in", () => {
				expect(
					diagnosticsFor(`implementation {
						${config}
						constant deep = { config with server.tls.enabled = true }
					}`),
				).toEqual([])
			})

			it("should gather keys that share a prefix into one level", () => {
				expect(
					diagnosticsFor(`implementation {
						${config}
						constant both = {
							config with
								server.port = 1,
								server.tls.enabled = true,
						}
					}`),
				).toEqual([])
			})

			it("should accept a path key beside a plain one", () => {
				expect(
					diagnosticsFor(`implementation {
						${config}
						constant mixed = {
							config with name = "b", server.port = 1
						}
					}`),
				).toEqual([])
			})

			it("should answer the Type of the value updated", () => {
				let value = lastConstantValue(`implementation {
					${config}
					constant moved = { config with server.port = 8080 }
				}`)

				expect(value.type).toEqual({
					type: "Record",
					members: {
						name: { type: "String" },
						server: {
							type: "Record",
							members: {
								host: { type: "String" },
								port: { type: "Integer" },
								tls: {
									type: "Record",
									members: { enabled: { type: "Boolean" } },
								},
							},
						},
					},
				})
			})

			// NOTE: The invariant the Language Server is built on: the member
			// Identifier of every synthesized Lookup stands where the step that
			// spelled it stands, so a rename, a Hover and a semantic token all
			// answer for a step with no code of their own.
			it("should stand each synthesized Lookup at the step that spelled it", () => {
				let source = `implementation {
					${config}
					constant deep = { config with server.tls.enabled = true }
				}`
				let outer = lastConstantValue(
					source,
				) as common.typed.CombinationNode
				let level = outer.rhs as common.typed.RecordValueNode
				let server = level.members[
					"server"
				] as common.typed.CombinationNode
				let serverLookup = server.lhs as common.typed.LookupNode
				let tls = (server.rhs as common.typed.RecordValueNode).members[
					"tls"
				] as common.typed.CombinationNode
				let tlsLookup = tls.lhs as common.typed.LookupNode

				expect(spanOf(source, serverLookup.member.position)).toBe(
					"server",
				)
				expect(spanOf(source, tlsLookup.member.position)).toBe("tls")
				expect(spanOf(source, serverLookup.position)).toBe("server")
			})

			it("should refuse a step that is not a Record", () => {
				let diagnostics = diagnosticsFor(`implementation {
					${config}
					constant renamed = { config with name.length = 1 }
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("path-step-not-a-record")
			})

			it("should refuse a step that names no member", () => {
				let diagnostics = diagnosticsFor(`implementation {
					${config}
					constant missing = { config with nope.port = 1 }
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("unknown-member")
			})

			it("should refuse a path key on a value that is worked out", () => {
				let diagnostics = diagnosticsFor(`implementation {
					${config}

					function load() -> Config {
						<- config
					}

					constant loaded = { load() with server.port = 1 }
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("path-on-computed-value")
			})

			// NOTE: `@` is a place, and the one a Method's nested update is
			// written on.
			it("should accept a path key on '@'", () => {
				expect(
					diagnosticsFor(`implementation {
						${config}

						namespace Configs for Config {
							§§ Answers this Config listening on a port.
							§§
							§§ @param _ — the port to listen on.
							§§ @returns — the moved Config.
							movedTo(_ port: Integer) -> Config {
								<- { @ with server.port = port }
							}
						}
					}`),
				).toEqual([])
			})

			// NOTE: A braced descend reaches one step in exactly as a dotted key
			// does, and is desugared into the very same nesting.
			it("should accept a braced descend", () => {
				expect(
					diagnosticsFor(`implementation {
						${config}
						constant a = {
							config with server.{ port = 1, host = "db" }
						}
					}`),
				).toEqual([])
			})

			it("should accept a descend inside a descend", () => {
				expect(
					diagnosticsFor(`implementation {
						${config}
						constant a = {
							config with server.{ tls.{ enabled = true } }
						}
					}`),
				).toEqual([])
			})

			it("should accept a descend after a longer path", () => {
				expect(
					diagnosticsFor(`implementation {
						${config}
						constant a = {
							config with server.tls.{ enabled = true }
						}
					}`),
				).toEqual([])
			})

			it("should read a descend and a dotted key to the same Type", () => {
				let descended = lastConstantValue(`implementation {
					${config}
					constant a = { config with server.{ port = 1 } }
				}`)
				let dotted = lastConstantValue(`implementation {
					${config}
					constant a = { config with server.port = 1 }
				}`)

				expect(descended.type).toEqual(dotted.type)
			})

			it("should refuse a descend through a step that is not a Record", () => {
				let diagnostics = diagnosticsFor(`implementation {
					${config}
					constant a = { config with name.{ length = 1 } }
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("path-step-not-a-record")
			})

			it("should refuse a path key in a plain Record Literal", () => {
				let diagnostics = diagnosticsFor(`implementation {
					constant blank = { server.port = 8080 }
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("path-key-outside-combination")
			})

			// NOTE: A Record Type standing over a Literal is not a value under
			// it — a Declaration writes its members from nothing exactly as an
			// unannotated Literal does.
			it("should refuse a path key under a Record annotation", () => {
				let diagnostics = diagnosticsFor(`implementation {
					${config}
					constant blank: Config = { name = "api", server.port = 1 }
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("path-key-outside-combination")
			})
		})

		// NOTE: An Argument written for a defaulted Record Parameter and a Case
		// payload written for a defaulting Case are Literals MERGED into a value
		// that is already there — the default's — so they carry path keys on the
		// terms a `with` does. `{ default with argument }` is what the merge is,
		// and this is the follow-up that made it one rule for every right-hand
		// side of one.
		describe("path keys in a Literal merged into a default", () => {
			const options = `type Server = { host: String, port: Integer }
				type Options = { retries: Integer, server: Server }

				§§ Answers the address.
				§§
				§§ @param using — how to connect.
				§§ @returns — the address.
				function connect(
					using options: Options = {
						retries = 3,
						server = { host = "localhost", port = 8080 },
					},
				) -> String {
					<- options.server.host
				}`

			it("should admit a path key in a partial Argument", () => {
				expect(
					diagnosticsFor(`implementation {
						${options}

						constant a = connect(using { server.port = 1 })
					}`),
				).toEqual([])
			})

			it("should admit a braced descend in a partial Argument", () => {
				expect(
					diagnosticsFor(`implementation {
						${options}

						constant a = connect(using { server.{ port = 1 } })
					}`),
				).toEqual([])
			})

			// NOTE: The one Argument reads as the whole of the merge, so a plain
			// key and a path key stand side by side exactly as they do after a
			// `with`.
			it("should admit a path key beside a plain one", () => {
				expect(
					diagnosticsFor(`implementation {
						${options}

						constant a = connect(using { retries = 9, server.port = 1 })
					}`),
				).toEqual([])
			})

			// NOTE: The Node keeps the Type it WROTE — a partial of the member
			// it merges into — and the merge is what the position measures it
			// by. An Argument whose Type claimed the whole member would claim it
			// to the Optimiser and the emission too, where only the members
			// really written are there.
			it("should leave the written Argument its own Type", () => {
				let value = lastConstantValue(`implementation {
					${options}

					constant a = connect(using { server.port = 1 })
				}`)

				if (value.nodeType !== "FunctionInvocation") {
					throw new Error("Expected a FunctionInvocation")
				}

				expect(value.arguments[0].value.type).toEqual({
					type: "Record",
					members: {
						server: {
							type: "Record",
							members: { port: { type: "Integer" } },
						},
					},
				})
			})

			it("should admit a path key in a partial Case payload", () => {
				expect(
					diagnosticsFor(`implementation {
						type Limits = { calls: Integer, burst: Integer }

						choice Fetch {
							Get { url: String, limits: Limits } = {
								limits = { calls = 1, burst = 2 },
							},
						}

						constant a: Fetch = #Get({ url = "/x", limits.calls = 5 })
					}`),
				).toEqual([])
			})

			// NOTE: A path key inside a member's OWN Literal reaches into
			// nothing — only the Literal that is merged is merged, and a member
			// of it writes its value from nothing like any other.
			it("should refuse a path key one level inside an Argument", () => {
				let diagnostics = diagnosticsFor(`implementation {
					${options}

					constant a = connect(using { server = { port.length = 1 } })
				}`)

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toContain("path-key-outside-combination")
			})
		})

		it("should resolve a bare Case in an update against the declared member", () => {
			expect(
				diagnosticsFor(`implementation {
					choice Status { Active, Done }

					constant c: { status: Status, n: Integer } = {
						status = #Active,
						n = 1,
					}
					constant updated = { c with status = #Done }
				}`),
			).toEqual([])
		})

		it("should still report an update whose member Type the value refuses", () => {
			expect(
				diagnosticsFor(`implementation {
					constant a = { name = "x" }
					constant c = { a with name = 5 }
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["partial-type-mismatch"])
		})

		it("should report non-Record Type Annotations on Record Literals", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = String ~> { name = "x" }
			}`)

			expect(
				diagnostics.map((diagnostic) => diagnostic.message),
			).toContain("A Record Literal must be annotated with a Record Type")
		})

		it("should report @-Expressions outside of Methods", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = @
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"There is no '@' here to refer to",
			)
		})

		it("should report Lookups on Types without members", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = "value"
				constant b = a.member
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"This value has no members to look up",
			)
		})

		it("should report missing Record members", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = { name = "x" }
				constant b = a.age
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"{ name: String } has no member 'age'",
			)
		})

		// NOTE: Regression test — the expected-members map was a plain object,
		// so a member named after one of `Object.prototype`'s found the
		// JavaScript builtin where `??=` expected a missing entry, and the
		// Enricher died with an Internal Compiler Error instead of enriching.
		it("should enrich a literal against a member named after Object.prototype's", () => {
			expect(
				diagnosticsFor(`implementation {
					type A = { toString: () -> String }
					type B = { x: Integer }

					constant input: A | B = { x = 1 }
				}`),
			).toEqual([])

			expect(
				diagnosticsFor(`implementation {
					type A = { valueOf: Integer }
					type B = { x: Integer }

					constant input: A | B = { x = 1 }
				}`),
			).toEqual([])
		})

		it("should report a Lookup of a member only Object.prototype has", () => {
			expect(
				diagnosticsFor(`implementation {
					constant a = { name = "x" }
					constant b = a.toString
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["unknown-member"])
		})

		// NOTE: A bare member name is read as well as written, and a reader who
		// did not know the spelling was a shorthand would otherwise be told
		// that a name they never meant to read is not declared.
		it("should say a bare member name is read as its own value", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant point = { x }
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unknown-name")
			expect(diagnostics[0].notes).toEqual([
				"A bare member name in a Record Literal is the member AND its value, so 'x' is read here as well as written.",
			])
		})

		it("should not say it of a member that spelled its value", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant point = { x = y }
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unknown-name")
			expect(diagnostics[0].notes ?? []).toEqual([])
		})

		it("should report all independent errors of a Program", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = undeclaredVariable
				constant b: UndeclaredType = "value"
				constant c = "value"::undeclaredMethod()
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"unknown-name",
				"unknown-type",
				"unknown-method",
			])
		})

		it("should not report follow-up errors on Error Types", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = undeclaredVariable
				constant b = a::someMethod()
				constant c = a.someMember
				constant d = { a with name = "x" }
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"'undeclaredVariable' is not declared",
			)
		})

		it("should still enrich statements after a broken statement", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				constant a = undeclaredVariable
				constant b = "value"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(program.implementation.nodes).toHaveLength(2)
		})
	})

	describe("String Interpolation", () => {
		it("should accept a Printable hole and type the whole as String", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				constant count = 3
				constant message = "count: {count}"
			}`)

			expect(diagnostics).toEqual([])

			let declaration = program.implementation.nodes[1]
			expect(declaration.nodeType).toBe("ConstantDeclarationStatement")

			if (declaration.nodeType === "ConstantDeclarationStatement") {
				expect(declaration.value.nodeType).toBe(
					"InterpolatedStringValue",
				)
				expect(declaration.value.type).toEqual({ type: "String" })
			}
		})

		// NOTE: A Function is the hole this reaches for because the answer of a
		// fallible call is no longer one. `3::squareRoot()` used to be an
		// `Integer | Algebraic | Nothing`, a bare Union belonging to no
		// Namespace and so conforming to nothing; `Optional<ItemType>` is a
		// Choice with a Namespace that conforms to `Printable` exactly when its
		// payload does, so the same call interpolates cleanly today. A Function
		// conforms to nothing at all, whatever it returns.
		it("should refuse a hole that is not Printable", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant greet = (subject: String) -> String { <- subject }
				constant message = "greeting: {greet}"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("interpolation-not-printable")
			expect(diagnostics[0].message).toBe(
				"(subject: String) -> String can not be interpolated into a String",
			)
		})

		// NOTE: The receiver is computed. A written one proves its own sign,
		// and `squareRoot` on a proven receiver answers no Optional at all.
		it("should accept an Optional hole whose payload is Printable", () => {
			expect(
				diagnosticsFor(`implementation {
					constant three = 1::add(2)
					constant maybe = three::squareRoot()
					constant message = "root: {maybe}"
				}`),
			).toEqual([])
		})

		it("should refuse an Optional hole whose payload is not Printable", () => {
			// NOTE: The conditional half of the conformance — the Optional
			// itself is the same Type as the one accepted above, and it is the
			// payload that decides. A List of Functions is the shortest way to
			// hand `firstItem` a payload nothing can print, and the List is
			// bound to a `List` Type: a written one proves it holds items and
			// `firstItem` would answer the Function bare.
			let diagnostics = diagnosticsFor(`implementation {
				constant greet = (subject: String) -> String { <- subject }
				constant greeters: List<(subject: String) -> String> = [greet]
				constant maybe = greeters::firstItem()
				constant message = "greeting: {maybe}"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("interpolation-not-printable")
			expect(diagnostics[0].message).toBe(
				"Optional<(subject: String) -> String> can not be interpolated into a String",
			)
		})

		it("should still enrich the Statements around a bad hole", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				constant greet = (subject: String) -> String { <- subject }
				constant message = "greeting: {greet}"
				constant after = 5
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(program.implementation.nodes).toHaveLength(3)
		})

		it("should warn about a 'toString' the hole would call itself", () => {
			let source = `implementation {
				constant count = 3
				constant message = "count: {count::toString()}"
			}`
			let diagnostics = diagnosticsFor(source)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe(
				"redundant-interpolation-to-string",
			)
			expect(diagnostics[0].severity).toBe("warning")
			// NOTE: The span is the call alone — the receiver stays, and the
			// greyed-out range is exactly what the Quick Fix deletes.
			expect(underlinedText(source, diagnostics[0])).toBe("::toString()")
			expect(diagnostics[0].tags).toEqual(["unnecessary"])
		})

		it("should warn about a 'toString' on a String, which is its own representation", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant name = "Ada"
				constant message = "hello, {name::toString()}"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe(
				"redundant-interpolation-to-string",
			)
		})

		it("should underline only the last call of a chained receiver", () => {
			let source = `implementation {
				constant words = ["a", "b"]
				constant message = "words: {words::length()::toString()}"
			}`
			let diagnostics = diagnosticsFor(source)

			expect(diagnostics).toHaveLength(1)
			expect(underlinedText(source, diagnostics[0])).toBe("::toString()")
		})

		it("should accept a 'toString' that takes an Argument", () => {
			// NOTE: `Rational.toString(as:)` picks a form the hole would
			// not have — dropping the call would change the String.
			expect(
				diagnosticsFor(`implementation {
					constant message = "half: {1/2::toString(as NumberFormat#Decimal)}"
				}`),
			).toEqual([])
		})

		it("should accept a 'toString' on a receiver that is not Printable itself", () => {
			// NOTE: A bare structural Union belongs to no Namespace, so nothing
			// makes it conform — the Method resolves per member and the explicit
			// call is the only spelling that works.
			expect(
				diagnosticsFor(`implementation {
					constant value: Integer | String = 1
					constant message = "value: {value::toString()}"
				}`),
			).toEqual([])
		})
	})

	describe("Constant Reassignment", () => {
		it("should allow reassigning Variables", () => {
			expect(
				diagnosticsFor(`implementation {
					variable a = "first"
					a = "second"
				}`),
			).toEqual([])
		})

		it("should report reassigned Constants", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = "first"
				a = "second"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe("'a' can not be reassigned")
			expect(diagnostics[0].position?.start.line).toBe(3)
		})

		it("should report reassigned Functions", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function getName () -> String {
					<- "essence"
				}

				getName = "value"
			}`)

			expect(
				diagnostics.map((diagnostic) => diagnostic.message),
			).toContain("'getName' can not be reassigned")
		})

		it("should report reassigned Parameters", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function greet (_ name: String) -> String {
					name = "other"
					<- name
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe("'name' can not be reassigned")
		})

		it("should allow reassigning outer Variables from inner scopes", () => {
			expect(
				diagnosticsFor(`implementation {
					variable a = "first"

					if true {
						a = "second"
					}
				}`),
			).toEqual([])
		})
	})

	describe("Declaration Hoisting", () => {
		it("should allow using Functions before their declaration", () => {
			expect(
				diagnosticsFor(`implementation {
					constant greeting = getGreeting()

					function getGreeting () -> String {
						<- "hello"
					}
				}`),
			).toEqual([])
		})

		it("should allow mutually recursive Functions", () => {
			expect(
				diagnosticsFor(`implementation {
					function isEven (_ value: Integer) -> Boolean {
						if value::is(0) {
							<- true
						}

						<- isOdd(value::subtract(1))
					}

					function isOdd (_ value: Integer) -> Boolean {
						if value::is(0) {
							<- false
						}

						<- isEven(value::subtract(1))
					}

					Terminal.inspect(isEven(4))
				}`),
			).toEqual([])
		})

		it("should allow using Type Aliases before their declaration", () => {
			expect(
				diagnosticsFor(`implementation {
					type Names = List<Name>
					type Name = String

					constant names: Names = ["essence"]
				}`),
			).toEqual([])
		})

		it("should allow Namespaces before their target Type Alias", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Person for Person {
						createWith (_ name: String) -> Person {
							<- { name = name }
						}
					}

					type Person = { name: String }

					constant person = Person.createWith("essence")
				}`),
			).toEqual([])
		})

		it("should not hoist Constants", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = b
				constant b = "value"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe("'b' is not declared")
		})

		it("should leave Namespaces referencing later Variables to in-order enrichment", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Config {
					static defaultName () -> String {
						<- fallbackName
					}
				}

				constant fallbackName = "essence"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"'fallbackName' is not declared",
			)
		})

		it("should still report duplicate hoisted declarations", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Name = String
				type Name = Boolean
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Type 'Name' is already declared",
			)
			expect(diagnostics[0].position?.start.line).toBe(3)
		})
	})

	describe("Generic Inference", () => {
		function typeOfFirstConstant(source: string): common.Type {
			let { program, diagnostics } = enrichSource(source)

			expect(diagnostics).toEqual([])

			for (let node of program.implementation.nodes) {
				if (node.nodeType === "ConstantDeclarationStatement") {
					return node.type
				}
			}

			throw new Error("No ConstantDeclarationStatement found.")
		}

		// NOTE: The answer is the item Type BARE. A written List proves it
		// holds an item, so the receiver reaches `namespace NonEmptyList`,
		// whose `firstItem` is total — and the inference under test is the
		// same one either way, since `ItemType` is decided by the receiver.
		it("should infer List item Types through Method Invocations", () => {
			expect(
				typeOfFirstConstant(`implementation {
					constant first = [1, 2]::firstItem()
				}`),
			).toEqual({ type: "Integer" })
		})

		it("should infer map's result Type from the callback's return", () => {
			// NOTE: `Result` occurs only in the callback's return position and
			// in `map`'s own return — the case 0.5b unblocked. The callback is
			// contextually typed, so `n` needs no annotation.
			// NOTE: Printed rather than compared whole, because a written
			// receiver proves it holds items and `NonEmptyList::map` carries
			// that proof onto the answer — the item Type is what this is about.
			expect(
				printType(
					typeOfFirstConstant(`implementation {
						constant texts = [1, 2]::map((n) { <- n::toString() })
					}`),
				),
			).toBe("NonEmptyList<String>")
		})

		it("should infer reduce's result Type from the starting value", () => {
			// NOTE: `Result` binds from `startingWith` before the callback is
			// checked, so both `total` and `n` are contextually typed.
			expect(
				typeOfFirstConstant(`implementation {
					constant total = [1, 2, 3]::reduce(
						startingWith 0,
						(total, n) { <- total::add(n) },
					)
				}`),
			).toEqual({ type: "Integer" })
		})

		it("should carry the item Type into map's callback body", () => {
			// NOTE: `isGreaterThan` only resolves if `n` typed as Integer, so
			// a broken item-Type substitution fails outright here.
			expect(
				printType(
					typeOfFirstConstant(`implementation {
						constant flags = [1, 2]::map((n) { <- n::isGreaterThan(1) })
					}`),
				),
			).toBe("NonEmptyList<Boolean>")
		})

		it("should find an item with the firstItem check overload", () => {
			expect(
				typeOfFirstConstant(`implementation {
					constant found = [1, 2]::firstItem(where (n) { <- n::isGreaterThan(1) })
				}`),
			).toEqual(optionalOf({ type: "Integer" }))
		})

		it("should substitute the receiver's item Type into List returns", () => {
			expect(
				typeOfFirstConstant(`implementation {
					constant shorter = ["a", "b"]::removeFirst()
				}`),
			).toEqual({ type: "List", itemType: { type: "String" } })
		})

		it("should infer Namespace Generics from the receiver", () => {
			// NOTE: `firstAgain` hands `firstItem`'s answer straight back, so
			// its return Type is written as the `Optional<Item>` that answer IS
			// — the Choice does not widen into an `Item | Nothing` the way the
			// Alias used to expand into one. What is asserted is unchanged: the
			// `Item` the Namespace abstracts over was bound to String by the
			// receiver alone.
			expect(
				typeOfFirstConstant(`implementation {
					namespace Wrapper<infer Item> for List<Item> {
						firstAgain() -> Optional<Item> {
							<- @::firstItem()
						}
					}

					constant first = ["x"]::firstAgain()
				}`),
			).toEqual(optionalOf({ type: "String" }))
		})

		it("terminates inference for a generic reduce-step folding into an Optional", () => {
			// NOTE: The exact shape `List.firstItem(where:)` is written in — a
			// Namespace generic in `ItemType` folding with `reduce`'s
			// early-stopping entry into an `Optional<ItemType>` Result. `reduce`'s
			// own Namespace Generic is ALSO `ItemType`, so binding it off the
			// receiver records `ItemType := ItemType`; treated as still open to
			// binding, matching that self-reference against the members of the
			// bound `Optional<ItemType>` Result — `Optional#Empty`, or the
			// `ItemType` the `Optional#Value` Case carries as its payload — sent
			// inference into an endless loop. `isOpenBindable` pins it as opaque,
			// so this terminates and the fold's Result is `Optional<Integer>`.
			expect(
				typeOfFirstConstant(`implementation {
					namespace Finder<infer ItemType> for List<ItemType> {
						firstMatch(where check: (_: ItemType) -> Boolean) -> Optional<ItemType> {
							constant start: Optional<ItemType> = #Empty

							<- @::reduce(startingWith start, step (found, item) {
								if check(item) { <- #Done(#Value(item)) }

								<- #Continue(found)
							})
						}
					}

					constant found = [1, 2, 3]::firstMatch(where (n) { <- n::isGreaterThan(1) })
				}`),
			).toEqual(optionalOf({ type: "Integer" }))
		})

		it("freshens callee Generics so a same-named caller Generic can not collide", () => {
			// NOTE: `myCount`'s `State` and the general `loop`'s own `State` share a
			// spelling, and the Record threaded as the loop's State MENTIONS it. By
			// name alone the callee's bindable `State` and the caller's opaque
			// `State` are one symbol, so binding `State := { carried: State }` used
			// to substitute the name into itself until the stack died — a caught
			// `internal-error`, a crash uncaught. Freshening the callee's Generics
			// to unique names for the match keeps the two distinct, so this resolves
			// cleanly with no Diagnostics at all.
			expect(
				diagnosticsFor(`implementation {
					function myCount<State>(
						startingWith state: State,
						step advance: (_: State) -> State,
					) -> State {
						<- loop(startingWith { carried = state }, step (current) {
							<- #Done(current.carried)
						})
					}
				}`),
			).toEqual([])
		})

		// NOTE: The same collision one rail over — this time between a CHOICE's
		// own Type Parameters and the caller's. `Step`'s first Parameter is
		// spelled `State`, and so is `myCount`'s, and the payload handed to
		// `#Done` is Typed as the caller's: matched by name, that payload bound
		// `Step`'s `State` to the whole `{ value: Result }` Record and left
		// `Result` — the Parameter it was there to decide — bound by nothing at
		// all. The construction's own match freshens too now, so the `Done`
		// carries the caller's `State` as its Result and the loop finishes with
		// it.
		it("freshens a Choice's own Generics against a same-named caller Generic", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				function myCount<State>(
					startingWith state: State,
					step advance: (_: State) -> State,
				) -> State {
					<- loop(startingWith { carried = state }, step (current) {
						<- #Done(current.carried)
					})
				}
			}`)

			expect(diagnostics).toEqual([])
			expect(collectCaseTypes(program)).toEqual([
				{
					type: "Case",
					choice: "Step",
					name: "Done",
					members: { value: { type: "GenericUse", name: "State" } },
					typeArguments: [
						{
							type: "Record",
							members: {
								carried: { type: "GenericUse", name: "State" },
							},
						},
						{ type: "GenericUse", name: "State" },
					],
				},
			])
		})

		it("should bind Method Generics from Function Argument return Types", () => {
			expect(
				typeOfFirstConstant(`implementation {
					namespace Mapper<infer Item> for List<Item> {
						transformFirst<infer Target>(
							_ transform: (_ item: Item) -> Target,
							fallback fallbackValue: Target,
						) -> Target {
							<- match @::firstItem() -> Target {
								case #Empty { <- fallbackValue }
								case #Value(item) { <- transform(item) }
							}
						}
					}

					constant first = [1]::transformFirst(
						(_ item: Integer) -> String { <- item::toString() },
						fallback "none",
					)
				}`),
			).toEqual({ type: "String" })
		})

		it("should check Function Argument parameters against bound Generics", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Mapper<infer Item> for List<Item> {
					transformFirst<infer Target>(
						_ transform: (_ item: Item) -> Target,
						fallback fallbackValue: Target,
					) -> Target {
						<- fallbackValue
					}
				}

				constant first = [1]::transformFirst(
					(_ item: String) -> String { <- item },
					fallback "none",
				)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("no-matching-overload")
		})

		// NOTE: A Function literal in Argument position may leave its
		// annotations out and take them from the parameter it is being passed
		// to. An unannotated Parameter takes its label from there too, which
		// is why `(item)` and `(_ item)` mean the same thing here and neither
		// spelling has to know that `removeEvery`'s callback is labelless.
		describe("Contextual Function literals", () => {
			it("infers a Parameter Type from the expected signature", () => {
				expect(
					typeOfFirstConstant(`implementation {
						constant kept = [1, 2, 3]::removeEvery(
							where (item) { <- item::isGreaterThan(2) },
						)
					}`),
				).toEqual({ type: "List", itemType: { type: "Integer" } })
			})

			it("reads the same written either way", () => {
				expect(
					typeOfFirstConstant(`implementation {
						constant kept = [1, 2, 3]::removeEvery(
							where (_ item) { <- item::isGreaterThan(2) },
						)
					}`),
				).toEqual({ type: "List", itemType: { type: "Integer" } })
			})

			it("still accepts a written return Type", () => {
				expect(
					typeOfFirstConstant(`implementation {
						constant kept = [1, 2, 3]::removeEvery(
							where (item) -> Boolean { <- item::isGreaterThan(2) },
						)
					}`),
				).toEqual({ type: "List", itemType: { type: "Integer" } })
			})

			it("types the body with the inferred Parameter", () => {
				// NOTE: `isBetween` is `Orderable`'s and a String is only
				// `Comparable`, so this fails outright rather than subtly if
				// the inferred Type never reaches the body's Scope.
				expect(
					diagnosticsFor(`implementation {
						constant kept = ["a"]::removeEvery(
							where (item) { <- item::isBetween(1, and 2) },
						)
					}`).map((diagnostic) => diagnostic.message),
				).toContain("No Method named 'isBetween' for this value")
			})

			it("reports a literal with nothing to infer from", () => {
				let diagnostics = diagnosticsFor(`implementation {
					constant standalone = (x) { <- x }
				}`)

				// NOTE: One Diagnostic, not two — the return Type could not be
				// inferred either, but only because the Parameter it depends
				// on could not be, which is what the reported message says.
				expect(
					diagnostics.map((diagnostic) => diagnostic.message),
				).toEqual(["The Type of Parameter 'x' could not be inferred"])
			})

			it("reports an omitted return Type outside Argument position", () => {
				// NOTE: The body could answer this one — every Parameter is
				// written — but a Type read off a body that nothing else
				// constrains is what makes a Program hard to follow. Only an
				// Argument, whose Type is written down elsewhere, may omit it.
				expect(
					diagnosticsFor(`implementation {
						constant describe = (_ value: Integer) { <- value::toString() }
					}`).map((diagnostic) => diagnostic.message),
				).toEqual(["This Function must write its return Type"])
			})

			it("reports more Parameters than the expected signature takes", () => {
				expect(
					diagnosticsFor(`implementation {
						constant kept = [1, 2]::removeEvery(
							where (a, b) { <- true },
						)
					}`).map((diagnostic) => diagnostic.message),
				).toContain("The Type of Parameter 'b' could not be inferred")
			})

			it("binds a Generic from an inferred return Type", () => {
				// NOTE: The hard case, and the one `map` needs. `Item` is
				// bound by the receiver, which types the Parameter; nothing
				// binds `Target` but this literal's own body, so the body is
				// what `Target` is read off — String here, which then decides
				// the Type of the whole invocation.
				expect(
					typeOfFirstConstant(`implementation {
						namespace Mapper<infer Item> for List<Item> {
							transformFirst<infer Target>(
								_ transform: (_ item: Item) -> Target,
								fallback fallbackValue: Target,
							) -> Target {
								<- fallbackValue
							}
						}

						constant first = [1]::transformFirst(
							(item) { <- item::toString() },
							fallback "none",
						)
					}`),
				).toEqual({ type: "String" })
			})

			it("unions the Types of several returns", () => {
				// NOTE: Two returns of unrelated Types — an Integer and a
				// String — is all this needs; what it is about is that the
				// literal's return Type is read as the Union of every return
				// its body makes, not off the first one the walk reaches.
				expect(
					typeOfFirstConstant(`implementation {
						namespace Mapper<infer Item> for List<Item> {
							transformFirst<infer Target>(
								_ transform: (_ item: Item) -> Target,
							) -> Target {
								<- transform(1)
							}
						}

						constant doubledOrLabel = [1]::transformFirst((value) {
							§ isEven is asked rather than isGreaterThan(0),
							§ which the standard library declares
							§ PositiveInteger by. The return would be that
							§ refinement rather than a bare Integer, and the
							§ Union is what this is about.
							if value::isEven() {
								<- value::multiply(with 2)
							}

							<- "none"
						})
					}`),
				).toEqual({
					type: "UnionType",
					types: [{ type: "Integer" }, { type: "String" }],
				})
			})

			it("infers the Parameter while the return Type is written", () => {
				expect(
					typeOfFirstConstant(`implementation {
						namespace Mapper<infer Item> for List<Item> {
							transformFirst<infer Target>(
								_ transform: (_ item: Item) -> Target,
								fallback fallbackValue: Target,
							) -> Target {
								<- fallbackValue
							}
						}

						constant first = [1]::transformFirst(
							(item) -> String { <- item::toString() },
							fallback "none",
						)
					}`),
				).toEqual({ type: "String" })
			})

			// NOTE: Resolution probes EVERY Namespace declaring the Method,
			// including the ones it goes on to reject — an unannotated literal
			// matches whatever Parameter Type it is probed against, so each
			// probe resolves it differently. Only the winning Namespace's
			// resolution may reach the literal's body: it decides which
			// Namespace `item::toString()` is looked up in, and the receiver
			// the Rewriter actually passes is the winner's.
			it("types the literal by the Namespace that won, not the last probed", () => {
				let source = `implementation {
					namespace IntApplier for Integer {
						apply(_ transform: (_ item: Integer) -> String) -> String {
							<- transform(@)
						}
					}

					namespace NumApplier for Number {
						apply(_ transform: (_ item: Boolean) -> String) -> String {
							<- transform(true)
						}
					}

					constant applied = 1::apply((item) { <- item::toString() })
				}`

				expect(diagnosticsFor(source)).toEqual([])

				let invocation = lastConstantMethodInvocation(source)

				expect(invocation.namespace.name).toBe("IntApplier")

				let literal = invocation.arguments[0].value

				expect(literal.nodeType).toBe("FunctionValue")

				if (literal.nodeType !== "FunctionValue") {
					throw new Error("The Argument is not a Function literal.")
				}

				expect(literal.value.parameters[0].internalName?.type).toEqual({
					type: "Integer",
				})

				let body = literal.value.body[0]

				expect(body.nodeType).toBe("ReturnStatement")

				if (body.nodeType !== "ReturnStatement") {
					throw new Error("The literal does not return.")
				}

				expect(body.expression.nodeType).toBe("MethodInvocation")

				if (body.expression.nodeType !== "MethodInvocation") {
					throw new Error("The literal does not return a call.")
				}

				expect(body.expression.namespace.name).toBe("Integer")
			})

			it("keeps the literal typed when resolution stays ambiguous", () => {
				// NOTE: No winner to read the literal's Types off, so the last
				// probe's stand in — the Invocation fails either way, and a
				// literal left with nothing recorded would report its
				// Parameters as uninferable on top of the real Diagnostic.
				expect(
					diagnosticsFor(`implementation {
						namespace FirstApplier for Integer {
							apply(_ transform: (_ item: Integer) -> String) -> String {
								<- transform(@)
							}
						}

						namespace SecondApplier for Integer {
							apply(_ transform: (_ item: Integer) -> String) -> String {
								<- transform(@)
							}
						}

						constant applied = 1::apply((item) { <- item::toString() })
					}`).map((diagnostic) => diagnostic.code),
				).toEqual(["ambiguous-namespace"])
			})

			// NOTE: A callee with no Type Parameters infers nothing, which is
			// why its Arguments used to be handed straight back — and a literal
			// that omitted its annotations was told it had nothing to infer
			// from, in the very Argument position the Diagnostic's own Note
			// names as the one place that works. The identical literal passed
			// to a non-Generic METHOD always resolved, because Method
			// resolution matches its Arguments on every path.
			it("takes its Parameter Type from a non-Generic free Function", () => {
				expect(
					typeOfFirstConstant(`implementation {
						function apply(_ transform: (_ item: Integer) -> Integer) -> Integer {
							<- transform(1)
						}

						constant applied = apply((item) { <- item::add(1) })
					}`),
				).toEqual({ type: "Integer" })
			})

			it("takes its return Type from a non-Generic free Function", () => {
				// NOTE: The Parameter is written out, so only the omitted
				// `-> Type` is left to come from the expected signature.
				expect(
					diagnosticsFor(`implementation {
						function apply(_ transform: (_ item: Integer) -> Integer) -> Integer {
							<- transform(1)
						}

						constant applied = apply((_ item: Integer) { <- item::add(1) })
					}`),
				).toEqual([])
			})

			it("types the body with a non-Generic free Function's Parameter", () => {
				// NOTE: `isBetween` only resolves for a Type on a line, so a
				// Parameter Type that never reaches the body fails outright
				// here rather than subtly.
				expect(
					diagnosticsFor(`implementation {
						function describe(_ transform: (_ item: String) -> String) -> String {
							<- transform("a")
						}

						constant described = describe((item) { <- item::isBetween(1, and 2) })
					}`).map((diagnostic) => diagnostic.message),
				).toContain("No Method named 'isBetween' for this value")
			})

			it("threads the expected Types past a labelled Parameter", () => {
				// NOTE: Two Parameters, the literal in front of the plain one —
				// every Argument is asked for its Type against the Parameter it
				// was written for, not just the first.
				expect(
					typeOfFirstConstant(`implementation {
						function combine(
							with combiner: (_ left: Integer, _ right: Integer) -> String,
							and seed: Integer,
						) -> String {
							<- combiner(seed, seed)
						}

						constant joined = combine(
							with (left, right) { <- left::add(right)::toString() },
							and 3,
						)
					}`),
				).toEqual({ type: "String" })
			})

			// NOTE: The same, past an Argument that does not fit: matching a
			// GENERIC free Function stopped at the first mismatch, so the
			// literal behind it was left with no context and reported as
			// uninferable — burying the Argument mismatch the Validator was
			// about to report under a Diagnostic about a literal that is
			// written perfectly well.
			it("keeps its context behind a mismatching Argument", () => {
				expect(
					diagnosticsFor(`implementation {
						function apply<infer Item>(
							_ value: Item,
							_ label: String,
							_ transform: (_ item: Integer) -> Integer,
						) -> Integer {
							<- transform(1)
						}

						constant applied = apply(1, 2, (item) { <- item::add(1) })
					}`),
				).toEqual([])
			})

			// NOTE: A callback's return position is the call's to decide, and a
			// call decides it AFTER it has matched: nothing but this literal's
			// own body binds `Result`, so while the literal is being matched its
			// position still reads `Progress<State, Result>` and the body is all
			// there is to read a return Type off. A body decides only what its
			// payloads happen to mention — `#Stopped("done")` names `Result` and
			// leaves `State` standing as the Choice's own Parameter — so the
			// position is read a second time once the call has committed and its
			// bindings are final, and THAT is what the body is enriched against.
			it("decides a Case in the callback's return by the committed Overload", () => {
				let stepped = collectCaseTypes(
					lastConstantMethodInvocation(`implementation {
						choice Progress<State, Result> {
							Going { state: State },
							Stopped { value: Result },
						}

						namespace Runner for Integer {
							overload walk {
								(
									startingWith state: String,
									step advance: (_ current: String) -> Progress<String, String>,
								) -> String {
									<- state
								}
								<infer State, infer Result>(
									startingWith state: State,
									step advance: (_ current: State) -> Progress<State, Result>,
								) -> Optional<Result> {
									<- #Empty
								}
							}
						}

						constant walked = 1::walk(startingWith 0, step (count) {
							if count::isGreaterThan(2) { <- #Stopped("done") }

							<- #Going(count::add(1))
						})
					}`),
				)

				// NOTE: `Integer` from the committed Overload's bindings and
				// `String` from the payload — neither the `State` the match was
				// still carrying, nor the `Progress<String, String>` the Overload
				// that lost would have decided.
				expect(stepped).toEqual([
					{
						type: "Case",
						choice: "Progress",
						name: "Stopped",
						members: { value: { type: "String" } },
						typeArguments: [
							{ type: "Integer" },
							{ type: "String" },
						],
					},
					{
						type: "Case",
						choice: "Progress",
						name: "Going",
						members: { state: { type: "Integer" } },
						typeArguments: [
							{ type: "Integer" },
							{ type: "String" },
						],
					},
				])
			})

			// NOTE: The same shape as the standard library spells it, which is
			// where every Program meets it: `loop`'s general entry declares its
			// `step` as `(_: State) -> Step<State, Result>`, and a `#Done` in
			// that callback is the construction the whole rail is about.
			it("decides a Case in a stdlib callback the same way", () => {
				expect(
					collectCaseTypes(
						lastConstantFunctionInvocation(`implementation {
							constant word = loop(startingWith 0, step (count) {
								if count::isGreaterThanOrEqualTo(3) { <- #Done("done") }

								<- #Continue(count::add(1))
							})
						}`),
					).map((type) =>
						type.type === "Case" ? type.typeArguments : type,
					),
				).toEqual([
					[{ type: "Integer" }, { type: "String" }],
					[{ type: "Integer" }, { type: "String" }],
				])
			})

			// NOTE: A callback inside a callback is decided by ITS own call —
			// `<-` returns from the literal it is written in, never from the walk
			// around it, so the inner `loop`'s `#Done` carries the inner Result
			// and the outer one's carries the outer's.
			it("decides a nested callback by its own call", () => {
				expect(
					collectCaseTypes(
						lastConstantFunctionInvocation(`implementation {
							constant word = loop(startingWith 0, step (outer) {
								constant inner = loop(startingWith outer, step (current) {
									if current::isGreaterThan(5) { <- #Done(current) }

									<- #Continue(current::add(1))
								})

								if inner::isGreaterThan(2) { <- #Done("stop") }

								<- #Continue(inner)
							})
						}`),
					).map((type) =>
						type.type === "Case" ? type.typeArguments : type,
					),
				).toEqual([
					[{ type: "Integer" }, { type: "Integer" }],
					[{ type: "Integer" }, { type: "Integer" }],
					[{ type: "Integer" }, { type: "String" }],
					[{ type: "Integer" }, { type: "String" }],
				])
			})

			// NOTE: The Type Parameter of the Namespace a callback is written
			// INSIDE is a decision — a generic one — and the position it makes
			// is a real one. This is `List.firstItem(where:)` spelled out: the
			// fold's `Result` is bound by the annotated seed, so `reduce` hands
			// the callback a `Step<Optional<Item>, Optional<Item>>`, and the
			// `#Done(…)` in it is decided by that rather than by the one
			// Parameter its own payload happens to mention.
			//
			// NOTE: The `#Value(item)` inside that `#Done` is the same question
			// one level down, and it is there because `Optional` is a Choice: a
			// Method answering an `Optional<Item>` hands back a Case it built,
			// never a bare `item` that widened into a Union. Both it and the
			// `#Empty` seed print terse — `Optional#Value` — because their one
			// Type Argument is still the unbound `Item`, which is exactly what
			// `caseHeader` leaves out.
			it("decides a Case in a callback by the enclosing Namespace's Type Parameter", () => {
				let { program, diagnostics } = enrichSource(`implementation {
					namespace Finder<infer Item> for List<Item> {
						firstMatch(where check: (_ item: Item) -> Boolean) -> Optional<Item> {
							constant start: Optional<Item> = #Empty

							<- @::reduce(startingWith start, step (found, item) {
								if check(item) { <- #Done(#Value(item)) }

								<- #Continue(found)
							})
						}
					}

					constant found = [1, 2, 3]::firstMatch(where (item) { <- item::isGreaterThan(1) })
				}`)

				expect(diagnostics).toEqual([])
				expect(collectCaseTypes(program).map(printType)).toEqual([
					"Optional#Empty",
					"Step<Optional<Item>, Optional<Item>>#Done",
					"Optional#Value",
					"Step<Optional<Item>, Optional<Item>>#Continue",
				])
			})

			// NOTE: What a Diagnostic from inside a callback body names is the
			// committed Overload's reading of it. The Overload that lost takes a
			// `Boolean` there and would have reported that Booleans have no
			// `add` at all; the one that won hands the call the Integer
			// signatures `add` actually offers.
			it("reports from inside a callback in the committed Overload's Types", () => {
				let diagnostics = diagnosticsFor(`implementation {
					namespace Runner for Integer {
						overload run {
							(seed first: Boolean, step advance: (_ current: Boolean) -> Boolean) -> Boolean {
								<- first
							}
							(seed first: Integer, step advance: (_ current: Integer) -> Integer) -> Integer {
								<- first
							}
						}
					}

					constant ran = 1::run(seed 1, step (current) { <- current::add("x") })
				}`)

				expect(
					diagnostics.map((diagnostic) => diagnostic.message),
				).toEqual(["No overload of 'add' accepts these Arguments"])
				expect(diagnostics[0].notes[0]).toBe(
					"'Integer::add' takes 1 Argument: Parameter 1 is Integer.",
				)
			})
		})

		it("should infer Generic Functions from their Arguments", () => {
			expect(
				typeOfFirstConstant(`implementation {
					function identity <infer T>(_ value: T) -> T {
						<- value
					}

					constant a = identity(5)
				}`),
			).toEqual({ type: "Integer" })
		})

		it("should report conflicting later occurrences as mismatches", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant a = [1, 2]::append("x")
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("no-matching-overload")
		})

		it("should report Type Parameters that can not be inferred", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function broken <infer T>() -> T {
					<- "value"
				}

				constant a = broken()
			}`)

			expect(
				diagnostics.map((diagnostic) => diagnostic.message),
			).toContain("Type Parameter 'T' could not be inferred")
		})

		// NOTE: An Error Type matches everything — that is what keeps a
		// reported mistake from being reported again at every Type it flows
		// through — but matching a Type Parameter binds nothing, so the
		// Invocation would go on to announce that it could not infer it. The
		// Diagnostic points at the enclosing call rather than at the Argument
		// that actually failed, which is the cascade poison Types exist to
		// prevent.
		it("should not report uninferable Type Parameters for an Error Argument", () => {
			// NOTE: Two generic Namespaces with the same target, so the
			// specificity order can not break the tie and the Argument really
			// is an Error — a concrete Namespace beside the stdlib's generic
			// one would simply win and leave nothing to cascade from.
			//
			// NOTE: The receiver is a bound name. A written List would prove it
			// holds items and reach `NonEmptyList`, which is more specific than
			// both of these and would break the tie this test needs.
			expect(
				diagnosticsFor(`implementation {
					namespace AnyList<infer ItemType> for List<ItemType> {
						firstItem() -> Integer {
							<- 0
						}
					}

					constant numbers: List<Integer> = [1, 2, 3]

					Terminal.inspect(numbers::firstItem())
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["ambiguous-namespace"])
		})

		it("should apply defaults for unbound plain Generics", () => {
			expect(
				typeOfFirstConstant(`implementation {
					function fallback <T = String>() -> T {
						<- "value"
					}

					constant a = fallback()
				}`),
			).toEqual({ type: "String" })
		})

		it("should expand applied Generic Type Aliases", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				type Tagged<Value> = Value | String

				constant a: Tagged<Rational> = 1/2
			}`)

			expect(diagnostics).toEqual([])

			let constant = program.implementation.nodes[1]

			expect(constant.nodeType).toBe("ConstantDeclarationStatement")

			if (constant.nodeType === "ConstantDeclarationStatement") {
				// NOTE: The applied spelling sticks around as the Union's
				// display alias — assignability ignores it.
				expect(constant.declaredType).toEqual({
					type: "UnionType",
					alias: {
						name: "Tagged",
						typeArguments: [{ type: "Rational" }],
					},
					types: [{ type: "Rational" }, { type: "String" }],
				})
			}
		})

		it("should apply Generic Type Alias defaults", () => {
			expect(
				diagnosticsFor(`implementation {
					type Fallback<Value = String> = Value | Boolean

					constant a: Fallback = "value"
				}`),
			).toEqual([])
		})

		it("should report Generic Type Aliases applied with too many Type Arguments", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Tagged<Value> = Value | String

				constant a: Tagged<Rational, Integer> = 1/2
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Type 'Tagged' was given the wrong number of Type Arguments",
			)
			expect(diagnostics[0].position?.start.line).toBe(4)
		})

		it("should report Generic Type Aliases used without Type Arguments", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Tagged<Value> = Value | String

				constant a: Tagged = 1/2
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Type 'Tagged' was given the wrong number of Type Arguments",
			)
		})

		// NOTE: The receiver is a Function's declared `Tagged<Integer>` rather
		// than a `firstItem()` — the stdlib no longer produces a bare Union of
		// this shape at all. `Optional` is a Choice now, so `[1, 2]::firstItem()`
		// is a Union of `Optional#Value` and `Optional#Empty`, and matching THAT
		// against `Tagged<Value>` binds `Value := Optional#Value` and asks
		// `unwrapped` to take one. What this is about is a Namespace whose
		// target is an APPLIED Alias, which a hand-written `Tagged` still is —
		// the second member is a plain String, because the Alias is here to be
		// applied, not to mean "missing".
		it("should match Generic Namespaces through applied Alias targets", () => {
			expect(
				typeOfFirstConstant(`implementation {
					type Tagged<Value> = Value | String

					namespace Tagged<infer Value> for Tagged<Value> {
						unwrapped(_ fallbackValue: Value) -> Value {
							<- match @ -> Value {
								case String { <- fallbackValue }
								case Value { <- @ }
							}
						}
					}

					function taggedOne() -> Tagged<Integer> {
						<- 1
					}

					constant first = taggedOne()::unwrapped(0)
				}`),
			).toEqual({ type: "Integer" })
		})
	})

	describe("Protocols", () => {
		it("should accept a well-formed Protocol declaration", () => {
			expect(
				diagnosticsFor(`implementation {
					protocol Matchable {
						is(_ other: Self) -> Boolean
						isNot(_ other: Self) -> Boolean
					}
				}`),
			).toEqual([])
		})

		it("should accept static and overloaded Protocol Method Signatures", () => {
			expect(
				diagnosticsFor(`implementation {
					protocol Creatable {
						static create() -> Self

						overload combine {
							(_ other: Self) -> Self
							(_ others: List<Self>) -> Self
						}
					}
				}`),
			).toEqual([])
		})

		it("should report duplicate Protocol declarations", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Showable {
					toString() -> String
				}

				protocol Showable {
					toString() -> String
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].message).toBe(
				"Protocol 'Showable' is already declared",
			)
		})

		it("should reject a Protocol used as a Type annotation", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Showable {
					toString() -> String
				}

				constant value: Showable = "text"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Protocol 'Showable' can not be used as a Type",
			)
		})

		it("should reject a Protocol used as a Union member", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Showable {
					toString() -> String
				}

				constant value: Showable | Boolean = true
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Protocol 'Showable' can not be used as a Type",
			)
		})

		it("should reject a Protocol used as a Match Case", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Showable {
					toString() -> String
				}

				variable value: Integer | Boolean = 1

				constant result = match value -> Integer {
					case Showable { <- 0 }
					case Integer { <- @ }
					case Boolean { <- 0 }
				}
			}`)

			expect(
				diagnostics.some(
					(diagnostic) =>
						diagnostic.message ===
						"Protocol 'Showable' can not be used as a Type",
				),
			).toBe(true)
		})

		it("should reject a Protocol used as a value", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Showable {
					toString() -> String
				}

				constant value = Showable
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Protocol 'Showable' can not be used as a value",
			)
		})

		it("should reserve Self as a Generic name", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function identity <Self>(_ value: Self) -> Self {
					<- value
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"'Self' is a reserved Type name",
			)
		})

		it("should reserve Self as a Type Alias name", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Self = String
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"'Self' is a reserved Type name",
			)
		})
	})

	describe("Protocol Conformance", () => {
		it("should accept a conforming Namespace", () => {
			expect(
				diagnosticsFor(`implementation {
					protocol Matchable {
						is(_ other: Self) -> Boolean
					}

					type Vector = { x: Number, y: Number }

					namespace VectorMatchable for Vector is Matchable {
						is(_ other: Vector) -> Boolean {
							<- true
						}
					}
				}`),
			).toEqual([])
		})

		it("should accept conformance to a Protocol declared below the Namespace", () => {
			expect(
				diagnosticsFor(`implementation {
					type Vector = { x: Number, y: Number }

					namespace VectorMatchable for Vector is Matchable {
						is(_ other: Vector) -> Boolean {
							<- true
						}
					}

					protocol Matchable {
						is(_ other: Self) -> Boolean
					}
				}`),
			).toEqual([])
		})

		it("should accept an overloaded Method fulfilling a simple requirement", () => {
			expect(
				diagnosticsFor(`implementation {
					protocol Showable {
						toString() -> String
					}

					type Vector = { x: Number, y: Number }

					namespace VectorShowable for Vector is Showable {
						overload toString {
							() -> String {
								<- "vector"
							}

							(_ prefix: String) -> String {
								<- prefix
							}
						}
					}
				}`),
			).toEqual([])
		})

		it("should report a missing Method", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Matchable {
					is(_ other: Self) -> Boolean
				}

				type Vector = { x: Number, y: Number }

				namespace VectorMatchable for Vector is Matchable {}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Namespace 'VectorMatchable' does not conform to 'Matchable'",
			)
		})

		it("should report a mismatched Method signature", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Showable {
					toString() -> String
				}

				type Vector = { x: Number, y: Number }

				namespace VectorShowable for Vector is Showable {
					toString() -> Boolean {
						<- true
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Namespace 'VectorShowable' does not conform to 'Showable'",
			)
		})

		it("should report an undeclared Protocol in a Conformance Clause", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Vector = { x: Number, y: Number }

				namespace VectorMatchable for Vector is Undeclared {}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Protocol 'Undeclared' is not declared",
			)
		})

		it("should reject a Conformance Clause on an untyped Namespace", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Showable {
					toString() -> String
				}

				namespace Helpers is Showable {}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Only a Namespace with a target Type can conform to a Protocol",
			)
		})

		it("should accept a Conformance Clause on a generic Namespace", () => {
			expect(
				diagnosticsFor(`implementation {
					protocol Showable {
						toString() -> String
					}

					namespace ListShowable<infer Item> for List<Item> is Showable {
						toString() -> String {
							<- "list"
						}
					}
				}`),
			).toEqual([])
		})

		it("should resolve a generic Namespace's conformance at a bounded call site", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				function areEqual <infer Value is Equatable>(_ a: Value, _ b: Value) -> Boolean {
					<- a::is(b)
				}

				constant result: Boolean = areEqual([1, 2], [3, 4])
			}`)

			expect(diagnostics).toEqual([])

			// NOTE: `List is Equatable` is CONDITIONAL — a List is equatable
			// exactly when its items are — so the bounded `Value` is solved by
			// List's own conformance carrying Integer's as its condition, and
			// the nested one is collected here alongside it. The generic the
			// call site had to fill is `Value`; that one is List's.
			let namespaceSources = collectConformances(program).filter(
				(conformance) =>
					conformance.protocolName === "Equatable" &&
					conformance.source.kind === "namespace",
			)

			expect(namespaceSources.length).toBeGreaterThan(0)

			let outer = namespaceSources.find(
				(conformance) => conformance.genericName === "Value",
			)

			expect(outer).toBeDefined()

			if (outer !== undefined && outer.source.kind === "namespace") {
				expect(outer.source.name).toBe("List")
				expect(outer.source.conditions).toHaveLength(1)
				expect(outer.source.conditions[0].source.kind).toBe("namespace")

				if (outer.source.conditions[0].source.kind === "namespace") {
					expect(outer.source.conditions[0].source.name).toBe(
						"Integer",
					)
				}
			}
		})

		it("should prefer a concrete Namespace over the generic blanket", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				namespace IntegerListEquatable for List<Integer> is Equatable {
					is(_ other: List<Integer>) -> Boolean { <- true }
					isNot(_ other: List<Integer>) -> Boolean { <- false }
				}

				function areEqual <infer Value is Equatable>(_ a: Value, _ b: Value) -> Boolean {
					<- a::is(b)
				}

				constant result: Boolean = areEqual([1, 2], [3, 4])
			}`)

			expect(diagnostics).toEqual([])

			let namespaceSources = collectConformances(program).filter(
				(conformance) =>
					conformance.protocolName === "Equatable" &&
					conformance.source.kind === "namespace",
			)

			expect(namespaceSources.length).toBeGreaterThan(0)
			expect(
				namespaceSources.every(
					(conformance) =>
						conformance.source.kind === "namespace" &&
						conformance.source.name === "IntegerListEquatable",
				),
			).toBe(true)
		})

		it("should report a concrete covering Union against the generic blanket", () => {
			// NOTE: The one shape the specificity order leaves ambiguous where
			// concreteness alone used to decide it: a Namespace for
			// `List<Integer> | String` covers the binding without spelling it
			// out, and `List<ItemType>` covers it without being concrete, so
			// neither target is narrower than the other. Naming the Union in
			// full is what makes it a real choice, and a hand written
			// `for List<Integer>` still wins outright.
			let diagnostics = diagnosticsFor(`implementation {
				namespace WideListEquatable for List<Integer> | String is Equatable {
					is(_ other: List<Integer> | String) -> Boolean { <- true }
					isNot(_ other: List<Integer> | String) -> Boolean { <- false }
				}

				function areEqual <infer Value is Equatable>(_ a: Value, _ b: Value) -> Boolean {
					<- a::is(b)
				}

				constant result: Boolean = areEqual([1, 2], [3, 4])
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
				"ambiguous-conformance",
			)
		})

		it("should report a Method that needs a condition", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Rankable {
					compare(to other: Self) -> Ordering
				}

				namespace ListRankable<infer Item> for List<Item> is Rankable {
					compare <infer Item is Comparable>(to other: List<Item>) -> Ordering {
						<- Ordering#Equal
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("nonconforming-namespace")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"Method 'compare' needs 'Item is Comparable'",
			)
		})

		it("should check static Method requirements", () => {
			expect(
				diagnosticsFor(`implementation {
					protocol Creatable {
						static create() -> Self
					}

					type Vector = { x: Number, y: Number }

					namespace VectorCreatable for Vector is Creatable {
						static create() -> Vector {
							<- { x = 0, y = 0 }
						}
					}
				}`),
			).toEqual([])
		})

		it("should reject a simple Method fulfilling a static requirement", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Creatable {
					static create() -> Self
				}

				type Vector = { x: Number, y: Number }

				namespace VectorCreatable for Vector is Creatable {
					create() -> Vector {
						<- { x = 0, y = 0 }
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Namespace 'VectorCreatable' does not conform to 'Creatable'",
			)
		})
	})

	describe("Conditional Conformance", () => {
		it("should accept a conditional clause whose body uses the bound", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Wrapper<infer Item> for { value: Item }
						is Comparable where Item is Comparable
					{
						compare(to other: { value: Item }) -> Ordering {
							<- @.value::compare(to other.value)
						}
					}
				}`),
			).toEqual([])
		})

		it("should help toward a where clause on a needs-condition Method", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Rankable {
					compare(to other: Self) -> Ordering
				}

				namespace ListRankable<infer Item> for List<Item> is Rankable {
					compare <infer Item is Comparable>(to other: List<Item>) -> Ordering {
						<- Ordering#Equal
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("nonconforming-namespace")
			expect(diagnostics[0].helps).toContain(
				"Add 'where Item is Comparable' to this conformance.",
			)
		})

		it("should reject a where condition naming an unknown Generic", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Wrapper<infer Item> for { value: Item }
					is Comparable where Other is Comparable
				{
					compare(to other: { value: Item }) -> Ordering {
						<- Ordering#Equal
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unknown-where-generic")
			expect(diagnostics[0].message).toBe(
				"'Other' is not a Type Parameter of this Namespace",
			)
		})

		it("should reject a where condition on a Generic the target Type never mentions", () => {
			// NOTE: Regression — a phantom Generic's condition can never be
			// witnessed at a use site, so before this Diagnostic the hidden
			// conformance Parameter arrived as `undefined` and crashed.
			let diagnostics = diagnosticsFor(`implementation {
				namespace Weird<infer Ghost, infer Item> for { value: Item }
					is Comparable where Ghost is Comparable, Item is Comparable
				{
					compare(to other: { value: Item }) -> Ordering {
						<- @.value::compare(to other.value)
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unwitnessable-where-condition")
			expect(diagnostics[0].message).toBe(
				"'Ghost' does not appear in this Namespace's target Type",
			)
		})

		it("should reject a Generic bound twice in one clause", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Wrapper<infer Item> for { value: Item }
					is Comparable where Item is Comparable, Item is Equatable
				{
					compare(to other: { value: Item }) -> Ordering {
						<- @.value::compare(to other.value)
					}
				}
			}`)

			expect(
				diagnostics.some(
					(diagnostic) =>
						diagnostic.code === "conflicting-where-condition",
				),
			).toBe(true)
		})

		it("should solve a conditional conformance at a use site", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				constant ordered: List<Integer> = [3, 1, 2]::sort()
			}`)

			expect(diagnostics).toEqual([])

			let comparable = collectConformances(program).filter(
				(conformance) => conformance.protocolName === "Comparable",
			)

			expect(comparable.length).toBeGreaterThan(0)
			expect(
				comparable.some(
					(conformance) =>
						conformance.source.kind === "namespace" &&
						conformance.source.name === "Integer",
				),
			).toBe(true)
		})

		it("should nest witness conditions ordered by the candidate's Generics", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				constant ordered = [[1, 2], [3]]::sort()
			}`)

			expect(diagnostics).toEqual([])

			let outer = collectConformances(program).find(
				(conformance) =>
					conformance.protocolName === "Comparable" &&
					conformance.source.kind === "namespace" &&
					conformance.source.name === "List",
			)

			expect(outer).toBeDefined()

			if (outer !== undefined && outer.source.kind === "namespace") {
				expect(outer.source.conditions).toHaveLength(1)
				expect(outer.source.conditions[0].source.kind).toBe("namespace")

				if (outer.source.conditions[0].source.kind === "namespace") {
					expect(outer.source.conditions[0].source.name).toBe(
						"Integer",
					)
				}
			}
		})

		it("should report a two-level because-chain for a nested failure", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant ordered = [[{ x = 1 }], [{ x = 2 }]]::sort()
			}`)

			let failure = diagnostics.find(
				(diagnostic) =>
					diagnostic.code === "unsatisfied-conformance-condition",
			)

			expect(failure).toBeDefined()
			expect(failure!.notes.length).toBeGreaterThanOrEqual(2)
			expect(failure!.notes[0]).toContain("does not conform")
			expect(
				failure!.notes.some((note) =>
					note.includes("{ x: Integer } does not conform"),
				),
			).toBe(true)
		})

		it("should demand a witness for a direct compare call", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				constant order = [1, 2]::compare(to [1, 3])
			}`)

			expect(diagnostics).toEqual([])

			let comparable = collectConformances(program).filter(
				(conformance) => conformance.protocolName === "Comparable",
			)

			expect(comparable.length).toBeGreaterThan(0)
		})

		it("should reject a List of a non-Comparable Type", () => {
			// NOTE: A Record conforms only to Equatable and Printable — sorting
			// a List of them has no item ordering to lean on. (Transcendental,
			// which the plan first named here, in fact conforms to Comparable
			// through the covering `Number` Namespace, so it is not a negative,
			// and neither is a Boolean any more.)
			let diagnostics = diagnosticsFor(`implementation {
				constant sorted = [{ x = 1 }, { x = 2 }]::sort()
			}`)

			expect(
				diagnostics.some((diagnostic) =>
					diagnostic.message.includes("does not conform"),
				),
			).toBe(true)
		})
	})

	describe("Namespace Generic Merge", () => {
		// NOTE: A Namespace Generic reaches a Method only when that Method's
		// resolved signature mentions it — anything else would be a Type
		// Parameter no call site could ever bind.
		function methodTypeFor(
			source: string,
			namespaceName: string,
			methodName: string,
		): common.MethodType {
			let { program, diagnostics } = enrichSource(source)

			expect(diagnostics).toEqual([])

			for (let node of program.implementation.nodes) {
				if (
					node.nodeType === "NamespaceDefinitionStatement" &&
					node.type.name === namespaceName
				) {
					let method = node.type.methods[methodName]

					expect(method).toBeDefined()

					return method!
				}
			}

			throw new Error(`No Namespace '${namespaceName}' in the Program`)
		}

		function genericsOf(method: common.MethodType) {
			expect(method.type === "SimpleMethod").toBe(true)

			return (method as common.SimpleMethodType).generics
		}

		it("should prune a Namespace Generic a Method never mentions", () => {
			let method = methodTypeFor(
				`implementation {
					namespace Tags<infer Item> for Integer {
						describe() -> String {
							<- "tag"
						}
					}
				}`,
				"Tags",
				"describe",
			)

			expect(genericsOf(method)).toEqual([])
		})

		it("should keep a Namespace Generic the injected self Parameter mentions", () => {
			let method = methodTypeFor(
				`implementation {
					namespace Boxes<infer Item> for List<Item> {
						describe() -> String {
							<- "box"
						}
					}
				}`,
				"Boxes",
				"describe",
			)

			expect(genericsOf(method)).toEqual([
				{
					name: "Item",
					infer: true,
					defaultType: null,
					constraint: null,
				},
			])
		})

		it("should let a same-named Method Generic shadow the Namespace one", () => {
			let method = methodTypeFor(
				`implementation {
					namespace Tags<infer Item> for Integer {
						ranked<infer Item is Comparable>(_ items: List<Item>) -> List<Item> {
							<- items
						}
					}
				}`,
				"Tags",
				"ranked",
			)

			// NOTE: Exactly one entry, and it is the METHOD's — its bound is
			// what the signature was resolved under.
			expect(genericsOf(method)).toEqual([
				{
					name: "Item",
					infer: true,
					defaultType: null,
					constraint: "Comparable",
				},
			])
		})

		it("should keep the Namespace Generics ahead of the Method's own", () => {
			let method = methodTypeFor(
				`implementation {
					namespace Boxes<infer Item> for List<Item> {
						pair<infer Other>(_ other: Other) -> Boolean {
							<- true
						}
					}
				}`,
				"Boxes",
				"pair",
			)

			expect(genericsOf(method).map((generic) => generic.name)).toEqual([
				"Item",
				"Other",
			])
		})

		it("should prune per Overload", () => {
			let method = methodTypeFor(
				`implementation {
					namespace Tags<infer Item> for Integer {
						overload static make {
							(_ item: Item) -> Boolean {
								<- true
							}

							(_ count: Integer) -> Boolean {
								<- true
							}
						}
					}
				}`,
				"Tags",
				"make",
			)

			expect(method.type).toBe("OverloadedStaticMethod")
			expect(
				(method as common.OverloadedStaticMethodType).overloads.map(
					(overload) =>
						overload.generics.map((generic) => generic.name),
				),
			).toEqual([["Item"], []])
		})

		describe("Nested mentions", () => {
			// NOTE: One case per Type shape the walk has to see through — a
			// missed shape would silently prune a Generic that IS used, leaving
			// it unbindable at the call site.
			const cases: Array<[string, string]> = [
				["the return Type alone", "produce() -> Item | String"],
				["a List item Type", "collect(_ items: List<Item>) -> Boolean"],
				[
					"a Record member",
					"unwrap(_ box: { value: Item }) -> Boolean",
				],
				["a Union member", "store(_ tagged: Item | String) -> Boolean"],
				[
					"a Function Parameter Type",
					"apply(_ transform: (_: Item) -> Boolean) -> Boolean",
				],
				[
					"a Function return Type",
					"lazily(_ make: () -> Item) -> Boolean",
				],
				[
					"a Generic Alias application",
					"hold(_ tagged: Tagged<Item>) -> Boolean",
				],
			]

			for (let [name, signature] of cases) {
				it(`should keep a Namespace Generic used in ${name}`, () => {
					let returnsUnion = signature.includes("-> Item | String")

					let method = methodTypeFor(
						`implementation {
							type Tagged<Value> = Value | String

							namespace Tags<infer Item> for Integer {
								${signature} {
									<- ${returnsUnion ? '"tag"' : "true"}
								}
							}
						}`,
						"Tags",
						signature.slice(0, signature.indexOf("(")),
					)

					expect(
						genericsOf(method).map((generic) => generic.name),
					).toEqual(["Item"])
				})
			}
		})

		it("should still bound a conditional conformance's fulfilling Method", () => {
			// NOTE: Guards the interaction with the conditional-conformance
			// Generic weaving: `compare` uses `Item`, so it survives pruning
			// and keeps its retrofitted bound — which is what makes the hidden
			// conformance Parameter emitted for it.
			let source = `implementation {
				namespace Boxes<infer Item> for { value: Item }
					is Comparable where Item is Comparable
				{
					compare(to other: { value: Item }) -> Ordering {
						<- @.value::compare(to other.value)
					}

					static describe() -> String {
						<- "box"
					}
				}
			}`

			expect(
				genericsOf(methodTypeFor(source, "Boxes", "compare")),
			).toEqual([
				{
					name: "Item",
					infer: true,
					defaultType: null,
					constraint: "Comparable",
				},
			])

			// NOTE: And the typed Node agrees — its leading Generic is the same
			// bounded `Item`, so `simplifyFunctionDefinition` emits exactly one
			// hidden conformance Parameter, first.
			let { program } = enrichSource(source)

			let namespaceNode = program.implementation.nodes.find(
				(node) => node.nodeType === "NamespaceDefinitionStatement",
			) as common.typed.NamespaceDefinitionStatementNode

			let compare = namespaceNode.methods.compare

			expect(compare?.nodeType).toBe("SimpleMethod")
			expect(
				(compare as common.typed.SimpleMethod).method.value.generics,
			).toMatchObject([{ name: "Item", constraint: "Comparable" }])

			// NOTE: A Method that does not fulfil the conformance carries
			// neither the Generic nor its hidden Parameter.
			let describe = namespaceNode.methods.describe

			expect(
				(describe as common.typed.StaticMethod).method.value.generics,
			).toEqual([])
		})

		it("should retain a bound Generic on a fulfilling Method that never mentions it", () => {
			// NOTE: The exception to the merge rule. A `where` bound is
			// witnessed by `$type.boundConformance`, which curries a witness
			// onto EVERY fulfilling Method whatever its signature mentions —
			// so a fulfilling Method keeps the bound Namespace Generic even
			// when nothing in its signature names it, and both views say so.
			let source = `implementation {
				protocol Nameable {
					static nameOf() -> String
				}

				namespace Bags<infer Item> for List<Item>
					is Nameable where Item is Comparable
				{
					static nameOf() -> String {
						<- "bag"
					}
				}
			}`

			let method = methodTypeFor(source, "Bags", "nameOf")

			expect(method.type).toBe("StaticMethod")
			expect((method as common.StaticMethodType).generics).toEqual([
				{
					name: "Item",
					infer: true,
					defaultType: null,
					constraint: "Comparable",
				},
			])

			let { program } = enrichSource(source)

			let namespaceNode = program.implementation.nodes.find(
				(node) => node.nodeType === "NamespaceDefinitionStatement",
			) as common.typed.NamespaceDefinitionStatementNode

			expect(
				(namespaceNode.methods.nameOf as common.typed.StaticMethod)
					.method.value.generics,
			).toMatchObject([{ name: "Item", constraint: "Comparable" }])
		})

		it("should retain a bound Generic on every Overload of a fulfilling Method", () => {
			// NOTE: Regression guard. Pruning per Overload while the
			// conformance witness is curried per Method let one Overload emit a
			// hidden conformance Parameter its Type never declared — the
			// Argument then landed in the wrong slot at runtime.
			let source = `implementation {
				protocol Nameable {
					static nameOf() -> String
				}

				namespace Bags<infer Item> for { items: List<Item> }
					is Nameable where Item is Comparable
				{
					overload static nameOf {
						() -> String {
							<- "bag"
						}

						(_ item: Item) -> String {
							<- "item"
						}

						<infer Other is Comparable>(_ a: Other, _ b: Other) -> String {
							<- a::compare(to b)::toString()
						}
					}
				}
			}`

			let method = methodTypeFor(source, "Bags", "nameOf")

			expect(method.type).toBe("OverloadedStaticMethod")
			expect(
				(method as common.OverloadedStaticMethodType).overloads.map(
					(overload) =>
						overload.generics.map(
							(generic) =>
								`${generic.name}:${generic.constraint}`,
						),
				),
			).toEqual([
				["Item:Comparable"],
				["Item:Comparable"],
				["Item:Comparable", "Other:Comparable"],
			])

			let { program } = enrichSource(source)

			let namespaceNode = program.implementation.nodes.find(
				(node) => node.nodeType === "NamespaceDefinitionStatement",
			) as common.typed.NamespaceDefinitionStatementNode

			// NOTE: The typed Node's Overloads carry the SAME leading bounded
			// `Item` — one hidden conformance Parameter each, first.
			expect(
				(
					namespaceNode.methods
						.nameOf as common.typed.OverloadedStaticMethod
				).methods.map((overload) =>
					overload.value.generics.map(
						(generic) => `${generic.name}:${generic.constraint}`,
					),
				),
			).toEqual([
				["Item:Comparable"],
				["Item:Comparable"],
				["Item:Comparable", "Other:Comparable"],
			])
		})

		it("should still reject a call that can not bind a retained bound Generic", () => {
			// NOTE: The other half of the same regression — with `Item`
			// retained, a static call that binds nothing is the compile error
			// it has always been, rather than a miscompile.
			let diagnostics = diagnosticsFor(`implementation {
				protocol Nameable {
					static nameOf() -> String
				}

				namespace Bags<infer Item> for { items: List<Item> }
					is Nameable where Item is Comparable
				{
					overload static nameOf {
						() -> String {
							<- "bag"
						}

						<infer Other is Comparable>(_ a: Other, _ b: Other) -> String {
							<- a::compare(to b)::toString()
						}
					}
				}

				Terminal.inspect(Bags.nameOf("a", "b"))
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"uninferable-type-parameter",
			])
		})
	})

	describe("Protocol Bounds", () => {
		const printableSetup = `
			protocol Showable {
				toString() -> String
			}

			type Vector = { x: Number, y: Number }

			namespace VectorShowable for Vector is Showable {
				toString() -> String {
					<- "vector"
				}
			}
		`

		it("should resolve Methods through a Protocol bound and pass the bound at the call site", () => {
			expect(
				diagnosticsFor(`implementation {
					${printableSetup}

					function describeValue <infer Value is Showable>(_ value: Value) -> String {
						<- value::toString()
					}

					constant text: String = describeValue({ x = 1, y = 2 })
				}`),
			).toEqual([])
		})

		it("should resolve Self Parameters through a Protocol bound", () => {
			expect(
				diagnosticsFor(`implementation {
					protocol Matchable {
						is(_ other: Self) -> Boolean
					}

					type Vector = { x: Number, y: Number }

					namespace VectorMatchable for Vector is Matchable {
						is(_ other: Vector) -> Boolean {
							<- true
						}
					}

					function areEqual <infer Value is Matchable>(_ a: Value, _ b: Value) -> Boolean {
						<- a::is(b)
					}

					constant result: Boolean = areEqual({ x = 1, y = 2 }, { x = 3, y = 4 })
				}`),
			).toEqual([])
		})

		it("should reject a mismatched Argument for a Self Parameter", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Matchable {
					is(_ other: Self) -> Boolean
				}

				function areEqual <infer Value is Matchable>(_ a: Value, _ b: Value) -> Boolean {
					<- a::is(1)
				}
			}`)

			expect(
				diagnostics.some(
					(diagnostic) => diagnostic.code === "no-matching-overload",
				),
			).toBe(true)
		})

		it("should not resolve Methods on an unbounded Type Parameter", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function describeValue <infer Value>(_ value: Value) -> String {
					<- value::toString()
				}
			}`)

			expect(diagnostics.length).toBeGreaterThan(0)
			expect(diagnostics[0].code).toBe("no-namespace-for-value")
		})

		// NOTE: And the cascade of the same shape, which is not the Program's
		// mistake at all. A refused Invocation still types its Function literal
		// Argument, from the last candidate it probed — otherwise the literal
		// would be reported as uninferable on top of the refusal — so the
		// callback's Parameter stands in the CALLEE's Type Parameter, a name
		// that is in no Scope the reader can see. Reporting against it names
		// `Held` in a file that never wrote it, under a call that has already
		// said what is wrong.
		it("should not report a Method on a Type Parameter of the callee", () => {
			let diagnostics = diagnosticsFor(`implementation {
				choice Problem {
					NotANumber,
					NotPositive,
				}

				namespace Problem for Problem is Equatable, is Printable {}

				function priceOf(_ row: String) -> Result<Integer, Problem> {
					<- Integer.parse(row)
						::toResult(failingWith #NotANumber)
						::keep(
							where (price) { <- price::isPositive() },
							failingWith #NotPositive,
						)
				}
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"no-matching-overload",
			])
		})

		it("should report a binding without a conforming Namespace", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Showable {
					toString() -> String
				}

				function describeValue <infer Value is Showable>(_ value: Value) -> String {
					<- value::toString()
				}

				constant text = describeValue(true)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Boolean does not conform to 'Showable'",
			)
		})

		it("should forward a bound between bounded Functions", () => {
			expect(
				diagnosticsFor(`implementation {
					${printableSetup}

					function inner <infer Value is Showable>(_ value: Value) -> String {
						<- value::toString()
					}

					function outer <infer Item is Showable>(_ item: Item) -> String {
						<- inner(item)
					}

					constant text: String = outer({ x = 1, y = 2 })
				}`),
			).toEqual([])
		})

		it("should reject forwarding a Type Parameter without the required bound", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Showable {
					toString() -> String
				}

				protocol Matchable {
					is(_ other: Self) -> Boolean
				}

				function inner <infer Value is Showable>(_ value: Value) -> String {
					<- value::toString()
				}

				function outer <infer Item is Matchable>(_ item: Item) -> String {
					<- inner(item)
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Type Parameter 'Item' does not conform to 'Showable'",
			)
		})

		it("should report ambiguous conforming Namespaces", () => {
			let diagnostics = diagnosticsFor(`implementation {
				${printableSetup}

				namespace VectorShowableToo for Vector is Showable {
					toString() -> String {
						<- "vector, too"
					}
				}

				function describeValue <infer Value is Showable>(_ value: Value) -> String {
					<- value::toString()
				}

				constant text = describeValue({ x = 1, y = 2 })
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("ambiguous-conformance")
			expect(diagnostics[0].message).toContain("Showable")
		})

		it("should prefer the exact target over a covering Union target", () => {
			expect(
				diagnosticsFor(`implementation {
					${printableSetup}

					namespace WideVectorShowable for Vector | Boolean is Showable {
						toString() -> String {
							<- "a vector, or else a Boolean"
						}
					}

					function describeValue <infer Value is Showable>(_ value: Value) -> String {
						<- value::toString()
					}

					constant vector: Vector = { x = 1, y = 2 }
					constant text: String = describeValue(vector)
				}`),
			).toEqual([])
		})

		it("should reject an unknown Protocol in a bound", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function describeValue <infer Value is Undeclared>(_ value: Value) -> String {
					<- ""
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Protocol 'Undeclared' is not declared",
			)
		})

		it("should reject bounds on Namespace Type Parameters", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Showable {
					toString() -> String
				}

				namespace Wrapper<infer Item is Showable> for List<Item> {
					firstText() -> String {
						<- ""
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"A Namespace's Type Parameters can not carry Protocol bounds",
			)
		})

		// NOTE: Without `infer` the Parameter is opaque and binds to nothing, so
		// the target Type matches no receiver and the Namespace is never found —
		// which no Diagnostic used to say. A generic Choice made the silence
		// dangerous: nothing declared `is`, so the DERIVED equality answered it,
		// and a Namespace that wrote the Method by hand was contradicted without
		// a word. Refused at the declaration, which is upstream of all of that.
		it("should reject Namespace Type Parameters written without 'infer'", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Wrapper<Item> for List<Item> {
					firstText() -> String {
						<- ""
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("uninferred-namespace-parameter")
			expect(diagnostics[0].message).toBe(
				"A Namespace's Type Parameters must be inferred",
			)
			expect(diagnostics[0].helps).toEqual([
				"Declare it as 'infer Item'.",
			])
		})

		// NOTE: Bounds decide which Overload a call selects, so the SAME
		// Overload set resolves the same way whichever order its entries were
		// written in — an Overload whose bound the Argument can not satisfy is
		// no candidate while another one takes the Argument. Each pair below is
		// the same call against the same two entries, swapped, and the entry
		// that accepts a Boolean is the one selected either way.
		describe("Overload selection", () => {
			const boundedFirst = `
				<infer Value is Showable>(_ value: Value) -> String {
					<- value::toString()
				}
				(_ value: Boolean) -> String {
					<- "boolean"
				}
			`

			const boundedSecond = `
				(_ value: Boolean) -> String {
					<- "boolean"
				}
				<infer Value is Showable>(_ value: Value) -> String {
					<- value::toString()
				}
			`

			function methodCall(overloads: string): string {
				return `implementation {
					${printableSetup}

					type Box = { size: Integer }

					namespace BoxNamespace for Box {
						overload render {
							${overloads}
						}
					}

					constant box: Box = { size = 1 }
					constant text: String = box::render(true)
				}`
			}

			// NOTE: `for {}` throughout this block — a Namespace that declares
			// nothing but STATIC Methods is never reached through a receiver,
			// so its target is beside the point and the unit Record is the
			// shortest Type to write that no other Namespace in these sources
			// also targets.
			function staticCall(overloads: string): string {
				return `implementation {
					${printableSetup}

					namespace Renderer for {} {
						overload static render {
							${overloads}
						}
					}

					constant text: String = Renderer.render(true)
				}`
			}

			it("should pass over a bounded Method Overload the Argument can not satisfy", () => {
				expect(
					lastConstantMethodInvocation(methodCall(boundedFirst))
						.overloadedMethodIndex,
				).toBe(1)
			})

			it("should select that same Method Overload with the entries swapped", () => {
				expect(
					lastConstantMethodInvocation(methodCall(boundedSecond))
						.overloadedMethodIndex,
				).toBe(0)
			})

			it("should pass over a bounded static Overload the Argument can not satisfy", () => {
				expect(
					lastConstantFunctionInvocation(staticCall(boundedFirst))
						.overloadedMethodIndex,
				).toBe(1)
			})

			it("should select that same static Overload with the entries swapped", () => {
				expect(
					lastConstantFunctionInvocation(staticCall(boundedSecond))
						.overloadedMethodIndex,
				).toBe(0)
			})

			// NOTE: Selecting an Overload solves its bounds, and that solve is
			// what the call carries — the Overload that wins is not solved a
			// second time on the way out.
			it("should carry the conformances the selected Overload was probed with", () => {
				let invocation =
					lastConstantFunctionInvocation(`implementation {
					${printableSetup}

					namespace Renderer for {} {
						overload static render {
							(_ value: Boolean) -> String {
								<- "boolean"
							}
							<infer Value is Showable>(_ value: Value) -> String {
								<- value::toString()
							}
						}
					}

					constant vector: Vector = { x = 1, y = 2 }
					constant text: String = Renderer.render(vector)
				}`)

				expect(invocation.overloadedMethodIndex).toBe(1)
				expect(invocation.conformances).toHaveLength(1)
				expect(invocation.conformances[0].genericName).toBe("Value")
				expect(invocation.conformances[0].protocolName).toBe("Showable")
				expect(
					invocation.conformances[0].source.kind === "namespace" &&
						invocation.conformances[0].source.name,
				).toBe("VectorShowable")
			})

			// NOTE: No candidate's bounds hold, so the call keeps the first
			// matching candidate's own Diagnostic — which bound failed and how
			// to satisfy it — rather than a bare "no overload accepts these
			// Arguments" about Arguments that were accepted.
			it("should report the first matching Overload's bound when no Overload's bounds hold", () => {
				let diagnostics = diagnosticsFor(`implementation {
					protocol Showable {
						toString() -> String
					}

					protocol Matchable {
						is(_ other: Self) -> Boolean
					}

					namespace Renderer for {} {
						overload static render {
							<infer Value is Showable>(_ value: Value) -> String {
								<- value::toString()
							}
							<infer Item is Matchable>(_ value: Item) -> String {
								<- "matchable"
							}
						}
					}

					constant text = Renderer.render(true)
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("unsatisfied-bound")
				expect(diagnostics[0].message).toBe(
					"Boolean does not conform to 'Showable'",
				)
				// NOTE: The kept Diagnostic whole, Note and Help included —
				// telling the reader how to satisfy the bound is the entire
				// reason it is kept over "no Overload accepts these Arguments",
				// so a report stripped down to its code would pass a test that
				// only asked for the code.
				expect(diagnostics[0].notes).toEqual([
					"No Namespace in scope makes Boolean conform to 'Showable'.",
				])
				expect(diagnostics[0].helps).toEqual([
					"Declare a Namespace 'for Boolean is Showable'.",
				])
			})

			// NOTE: A candidate whose bound could not be DECIDED must not drop
			// out silently — the ambiguity is the reason the call fails, and
			// probing is what would otherwise swallow the report.
			it("should report an ambiguous conformance that failed the only matching Overload", () => {
				let diagnostics = diagnosticsFor(`implementation {
					${printableSetup}

					namespace VectorShowableToo for Vector is Showable {
						toString() -> String {
							<- "vector, too"
						}
					}

					namespace Renderer for {} {
						overload static render {
							<infer Value is Showable>(_ value: Value) -> String {
								<- value::toString()
							}
							(_ value: Boolean) -> String {
								<- "boolean"
							}
						}
					}

					constant vector: Vector = { x = 1, y = 2 }
					constant text = Renderer.render(vector)
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("ambiguous-conformance")
				expect(diagnostics[0].message).toBe(
					"More than one Namespace makes { x: Number, y: Number } conform to 'Showable'",
				)
				expect(diagnostics[0].notes).toEqual([
					"'VectorShowable' conforms to 'Showable'.",
					"'VectorShowableToo' conforms to 'Showable'.",
				])
			})

			it("should still report no matching Overload when the Arguments match none", () => {
				let diagnostics = diagnosticsFor(`implementation {
					${printableSetup}

					namespace Renderer for {} {
						overload static render {
							<infer Value is Showable>(_ value: Value) -> String {
								<- value::toString()
							}
							(_ value: Boolean, _ other: Boolean) -> String {
								<- "boolean"
							}
						}
					}

					constant text = Renderer.render()
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("no-matching-overload")
				expect(diagnostics[0].message).toBe(
					"No overload accepts these Arguments",
				)
				// NOTE: Every candidate, in the order they are written — a call
				// that matched none is told what it could have passed, which is
				// what the `::` twin has always said and what this site
				// promised without saying it.
				expect(diagnostics[0].notes).toEqual([
					"'Renderer.render' takes 1 Argument: Parameter 1 is Value.",
					"'Renderer.render' takes 2 Arguments: Parameter 1 is Boolean, Parameter 2 is Boolean.",
				])
				expect(diagnostics[0].helps).toEqual([])
			})

			// NOTE: One entry is the shape a reader is likeliest to meet — an
			// `overload` block being grown, or a call that simply passed the
			// wrong thing — and "no overload accepts these Arguments" about a
			// block with a single entry says nothing at all without the Note
			// spelling that entry out.
			it("should list the one signature a single entry Overload block declares", () => {
				let diagnostics = diagnosticsFor(`implementation {
					namespace Renderer for {} {
						overload static render {
							(_ value: Boolean) -> String {
								<- "boolean"
							}
						}
					}

					constant text = Renderer.render("nope")
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("no-matching-overload")
				expect(diagnostics[0].notes).toEqual([
					"'Renderer.render' takes 1 Argument: Parameter 1 is Boolean.",
				])
			})

			// NOTE: A Namespace Generic is not something a caller wrote, so a
			// Note that spells one leaves them to work out what it stands for.
			// The signature is read off the Namespace SPECIALIZED against this
			// receiver instead — `List<Integer>` is told its `prepend` takes an
			// Integer.
			it("should spell a Namespace Generic as the receiver decided it", () => {
				let diagnostics = diagnosticsFor(`implementation {
					constant list = [1, 2]::prepend("nope")
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("no-matching-overload")
				expect(diagnostics[0].notes).toEqual([
					"'List::prepend' takes 1 Argument: Parameter 1 is Integer.",
					"'List::prepend' takes 1 Argument: Parameter 'contentsOf' is List<Integer>.",
					"'NonEmptyList::prepend' takes 1 Argument: Parameter 'contentsOf' is List<Integer>.",
				])
			})

			// NOTE: The free-Function half of the same site, which only the
			// standard library can declare — and the half whose Notes carry the
			// most, since an `overload function`'s entries are told apart by
			// their Argument LABELS rather than by a receiver.
			it("should name a free Function's Overloads by the labels they read", () => {
				let diagnostics = diagnosticsFor(`implementation {
					constant state = loop(startingWith 1)
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("no-matching-overload")
				expect(diagnostics[0].notes).toEqual([
					"'loop' takes 3 Arguments: Parameter 'startingWith' is State, Parameter 'while' is (_: State) -> Boolean, Parameter 3 is (_: State) -> State.",
					"'loop' takes 3 Arguments: Parameter 'startingWith' is State, Parameter 'until' is (_: State) -> Boolean, Parameter 3 is (_: State) -> State.",
					"'loop' takes 4 Arguments: Parameter 'from' is Integer, Parameter 'through' is Integer, Parameter 'startingWith' is State, Parameter 4 is (_: Integer, _: State) -> State.",
					"'loop' takes 2 Arguments: Parameter 'startingWith' is State, Parameter 'step' is (_: State) -> Step<State, Answer>.",
					"'loop' takes 4 Arguments: Parameter 'from' is Integer, Parameter 'upTo' is Integer, Parameter 'startingWith' is State, Parameter 4 is (_: Integer, _: State) -> State.",
					"'loop' takes 4 Arguments: Parameter 'from' is Integer, Parameter 'downTo' is Integer, Parameter 'startingWith' is State, Parameter 4 is (_: Integer, _: State) -> State.",
					"'loop' takes 4 Arguments: Parameter 'from' is Integer, Parameter 'through' is Integer, Parameter 'startingWith' is State, Parameter 'step' is (_: Integer, _: State) -> Step<State, State>.",
					"'loop' takes 4 Arguments: Parameter 'from' is Integer, Parameter 'upTo' is Integer, Parameter 'startingWith' is State, Parameter 'step' is (_: Integer, _: State) -> Step<State, State>.",
					"'loop' takes 4 Arguments: Parameter 'from' is Integer, Parameter 'downTo' is Integer, Parameter 'startingWith' is State, Parameter 'step' is (_: Integer, _: State) -> Step<State, State>.",
				])
			})

			// NOTE: Reaching past a candidate whose bound failed means typing the
			// Arguments against the candidates behind it, and an unannotated
			// Function literal reports from inside its own body when the Parameter
			// it is read against is not a signature at all. The literal below is
			// read against an `Integer` Parameter on the way to the Overload that
			// takes it — a candidate that loses says nothing.
			it("should keep the Arguments of a losing Overload from reporting", () => {
				expect(
					lastConstantMethodInvocation(`implementation {
					${printableSetup}

					namespace IntegerRunner for Integer {
						overload run {
							<infer Value is Showable>(_ value: Value, _ transform: (_ x: Integer) -> Integer) -> String {
								<- value::toString()
							}
							(_ value: Boolean, _ transform: Integer) -> String {
								<- "integer"
							}
							(_ value: Boolean, _ transform: (_ x: Integer) -> Integer) -> String {
								<- "function"
							}
						}
					}

					constant text: String = 1::run(true, (x) { <- x })
				}`).overloadedMethodIndex,
				).toBe(2)
			})

			// NOTE: The same, one stage out: a Namespace that loses the specificity
			// filter still probes its Overloads, and the Arguments it typed on the
			// way are not the call's news either.
			it("should keep the Arguments of a losing Namespace's Overloads from reporting", () => {
				expect(
					diagnosticsFor(`implementation {
					${printableSetup}

					namespace WideRunner for Integer | String {
						overload run {
							<infer Value is Showable>(_ value: Value, _ transform: (_ x: Integer) -> Integer) -> String {
								<- value::toString()
							}
							(_ value: Boolean, _ transform: Integer) -> String {
								<- "integer"
							}
						}
					}

					namespace NarrowRunner for Integer {
						run(_ value: Boolean, _ transform: (_ x: Integer) -> Integer) -> String {
							<- "narrow"
						}
					}

					constant text = 1::run(true, (x) { <- x })
				}`),
				).toEqual([])
			})

			// NOTE: The other flavour of the same order-dependence, and not a bound
			// failing: a prefixed Case construction read against `Holder<Item>` can
			// not decide its Type Arguments from a Parameter Type that mentions the
			// call's own unsolved Type Parameter, so it types as Error — which
			// matches anything and leaves `Item` unbound, so the bound never fails.
			// The generic candidate is passed over for the one that decides the
			// construction, whichever order the two are written in.
			function construction(overloads: string): string {
				return `implementation {
					choice Holder<Item is Equatable> {
						Bare,
						Full { value: Item },
					}

					namespace Takers for {} {
						overload static take {
							${overloads}
						}
					}

					constant text: String = Takers.take(Holder#Full(1))
				}`
			}

			const genericFirst = `
				<infer Item is Equatable>(_ holder: Holder<Item>) -> String {
					<- "generic"
				}
				(_ holder: Holder<Integer>) -> String {
					<- "integer"
				}
			`

			const genericSecond = `
				(_ holder: Holder<Integer>) -> String {
					<- "integer"
				}
				<infer Item is Equatable>(_ holder: Holder<Item>) -> String {
					<- "generic"
				}
			`

			it("should pass over an Overload no Argument can decide the Type Arguments of", () => {
				expect(
					lastConstantFunctionInvocation(construction(genericFirst))
						.overloadedMethodIndex,
				).toBe(1)
			})

			it("should select that same Overload with the entries swapped", () => {
				expect(
					lastConstantFunctionInvocation(construction(genericSecond))
						.overloadedMethodIndex,
				).toBe(0)
			})
		})
	})

	describe("Builtin Protocols", () => {
		// NOTE: The safety net for the builtin signatures — every declared
		// conformance must actually be fulfilled, via the same helper that
		// drives conformance checking and conformance-value codegen.
		//
		// NOTE: Driven from the ACCESSORS rather than from the TypeScript
		// tables, so it keeps testing whatever is live. A Namespace declared in
		// Essence is checked at load, but only the one that is loaded — reading
		// the tables directly would leave this asserting a property of objects
		// no compilation touches as the conversion moves them across.
		describe("Conformance of builtin Namespaces", () => {
			const protocols = builtinProtocols()
			const namespaces = builtinNamespaces().filter(
				(namespace) => (namespace.conformsTo ?? []).length > 0,
			)

			it("finds Namespaces that declare a conformance", () => {
				expect(namespaces.length).toBeGreaterThan(0)
			})

			for (const namespace of namespaces) {
				it(`${namespace.name} fulfills its declared conformances`, () => {
					expect(namespace.conformsTo).toBeDefined()
					expect(namespace.conformsTo!.length).toBeGreaterThan(0)

					for (const protocolName of namespace.conformsTo ?? []) {
						const protocol = protocols[protocolName]

						expect(protocol).toBeDefined()

						// NOTE: A conditional conformance (List's Comparable)
						// only holds under the `where` conditions it declares —
						// supply them as assumptions, exactly as the Enricher's
						// declaration-side check does.
						const assumptions = new Map(
							(
								namespace.conformanceConditions?.[
									protocolName
								] ?? []
							).map((condition) => [
								condition.generic,
								condition.protocol,
							]),
						)

						let result = computeConformanceMethodMap(
							protocol,
							namespace,
							namespace.targetType!,
							assumptions,
						)

						// NOTE: A Choice DECLARES `is Equatable` and
						// `is Printable` and writes neither Method — the
						// derives fulfill both. Checking the derived Namespace
						// instead of accepting the miss is the point: the
						// conformance still has to hold, it just holds through
						// Methods nobody wrote. The Scope only has to resolve
						// the Choice's name back to the Choice, which is the
						// target Type itself.
						if (result.kind !== "conforms") {
							const scope = {
								parent: null,
								members: {},
								declarations: {},
								constants: new Set<string>(),
								types: {
									[namespace.name]: namespace.targetType!,
								},
								protocols: {},
							}

							const derived =
								protocolName === "Printable"
									? derivedPrintableNamespace(
											namespace.targetType!,
											[namespace],
											scope,
										)
									: derivedEquatableNamespace(
											namespace.targetType!,
											scope,
										)

							expect(derived).not.toBeNull()

							result = computeConformanceMethodMap(
								protocol,
								derived!,
								namespace.targetType!,
								assumptions,
							)
						}

						expect(result.kind).toBe("conforms")
					}
				})
			}
		})

		it("should order Integers with compare and match the Ordering exhaustively", () => {
			expect(
				diagnosticsFor(`implementation {
					constant ordering = 5::compare(to 7)

					constant description = match ordering -> String {
						case #Less    { <- "smaller" }
						case #Equal   { <- "same" }
						case #Greater { <- "bigger" }
					}
				}`),
			).toEqual([])
		})

		it("should satisfy builtin Protocol bounds with builtin Types", () => {
			expect(
				diagnosticsFor(`implementation {
					function describeValue <infer Value is Printable>(_ value: Value) -> String {
						<- value::toString()
					}

					Terminal.inspect(describeValue(5))
					Terminal.inspect(describeValue(1/2))
					Terminal.inspect(describeValue("text"))
					Terminal.inspect(describeValue(true))
					Terminal.inspect(describeValue({}))
					Terminal.inspect(describeValue({ x = 1 }))
					Terminal.inspect(describeValue(Ordering#Less))
				}`),
			).toEqual([])
		})

		it("should order values through a Comparable bound", () => {
			expect(
				diagnosticsFor(`implementation {
					function smaller <infer Item is Comparable>(_ a: Item, _ b: Item) -> Item {
						<- match a::compare(to b) -> Item {
							case #Less    { <- a }
							case #Equal   { <- a }
							case #Greater { <- b }
						}
					}

					constant smallerInteger: Integer = smaller(5, 3)
					constant smallerRational: Rational = smaller(1/2, 1/3)
					constant smallerString: String = smaller("a", "b")
				}`),
			).toEqual([])
		})

		it("should sort a List of Strings, now that String is Comparable", () => {
			// NOTE: `sort__overload$2` needs no Protocol bound — the comparator does —
			// but the annotation only holds if `compare` resolves on a
			// String, which it does now that String conforms to Comparable.
			expect(
				diagnosticsFor(`implementation {
					constant ordered: List<String> = ["b", "a"]::sort(by 
						(first, second) { <- first::compare(to second) },
					)
				}`),
			).toEqual([])
		})

		it("should type the everyday String Methods", () => {
			expect(
				diagnosticsFor(`implementation {
					constant count: Integer = "hi"::length()
					constant chars: List<String> = "hi"::characters()
					constant char: Optional<String> = "hi"::character(at 0)
					constant loud: String = "hi"::uppercase()::trim()
					constant begins: Boolean = "hi"::starts(with "h")
					constant at: Optional<Integer> = "hello"::firstIndex(of "l")
					constant padded: String = "7"::pad(to 3, with "0")
				}`),
			).toEqual([])
		})

		// NOTE: The unit Record stands where `nothing` used to — a Function
		// that answers nothing useful answers `{}` now, so `{}` is the value an
		// `is` has to keep working on. It reaches Equatable through the builtin
		// Record Namespace like any other Record.
		it("should compare unit Records and Orderings with Equatable methods", () => {
			expect(
				diagnosticsFor(`implementation {
					constant unitSame: Boolean = {}::is({})
					constant orderingSame: Boolean = Ordering#Less::is(Ordering#Less)
					constant orderingText: String = Ordering#Greater::toString()
				}`),
			).toEqual([])
		})

		it("should satisfy bounds with the Number Union through its covering Namespace", () => {
			expect(
				diagnosticsFor(`implementation {
					function describeValue <infer Value is Printable>(_ value: Value) -> String {
						<- value::toString()
					}

					function smaller <infer Item is Comparable>(_ a: Item, _ b: Item) -> Item {
						<- match a::compare(to b) -> Item {
							case #Less    { <- a }
							case #Equal   { <- a }
							case #Greater { <- b }
						}
					}

					constant number: Number = 5
					constant other: Number = 1/2

					constant text = describeValue(number)
					constant smallest: Number = smaller(number, other)
					constant same: Boolean = number::is(other)
				}`),
			).toEqual([])
		})

		it("should let a concrete Record conformance beat the builtin Record Namespace", () => {
			expect(
				diagnosticsFor(`implementation {
					type Vector = { x: Number, y: Number }

					namespace VectorPrintable for Vector is Printable {
						toString() -> String {
							<- "a vector"
						}
					}

					function describeValue <infer Value is Printable>(_ value: Value) -> String {
						<- value::toString()
					}

					constant text: String = describeValue({ x = 1, y = 2 })
				}`),
			).toEqual([])
		})

		it("should resolve Methods on a Union-typed Ordering receiver", () => {
			expect(
				diagnosticsFor(`implementation {
					constant text: String = 5::compare(to 7)::toString()
					constant same: Boolean = 5::compare(to 7)::is(Ordering#Less)
				}`),
			).toEqual([])
		})

		// NOTE: The ordering family is `Comparable`'s, provided over `Self` —
		// the target of the Namespace whose conformance offered it, which is
		// the covering `Number` as much as it is `Integer`. So a comparison
		// across two kinds falls to `Number`'s rung and is answered there,
		// with nothing widened at the call. The annotation below says what the
		// Constant holds and no more; every bound stays written.
		//
		// NOTE: `squareRoot` on a written receiver answers an
		// `Integer | Algebraic`, which one match takes apart: the receiver
		// proves its own sign, so there is no Optional between the call and
		// the value. The kinds are what this is about, and both are reached.
		it("should compare across Number kinds through the Number Namespace", () => {
			expect(
				diagnosticsFor(`implementation {
					constant three: Number = 3
					constant belowPi: Boolean = three::isLessThan(Number.Pi)
					constant orderedPis: Boolean = Number.Pi::isGreaterThan(Number.Tau)
					constant rootVsHalf = match 2::squareRoot() -> Boolean {
						case Algebraic {
							constant half: Number = 3/2

							<- half::isGreaterThanOrEqualTo(@)
						}
						case Integer { <- false }
					}
				}`),
			).toEqual([])
		})

		it("should span the numeric tower for Integer::add", () => {
			// NOTE: The Transcendental annotation only type-checks if
			// `1::add(π)` resolves to the new overload. The match narrows √2 to
			// an Algebraic and adds an Integer to it — the other new overload —
			// with `toString` keeping the handler's return a String so the test
			// turns on resolution, not on the result Type.
			expect(
				diagnosticsFor(`implementation {
					constant withPi: Transcendental = 1::add(Number.Pi)
					constant withRoot: String = match 2::squareRoot() -> String {
						case Algebraic { <- 1::add(@)::toString() }
						case Integer   { <- @::toString() }
					}
				}`),
			).toEqual([])
		})

		// NOTE: NO Namespace writes `isLessThan` for a kind other than its
		// own. Integer and Rational keep the same-kind entry they always had,
		// and each holds one entry for the other kind, but neither was widened
		// to the irrationals — deciding a Transcendental ordering in general
		// is undecidable, so the claim is made once by `Number.compare`, which
		// `Comparable` provides the whole family on top of. This guards against
		// a well-meaning re-addition to a member.
		it("keeps cross-kind comparison off the member Namespaces", () => {
			// NOTE: The argument Types Integer::isLessThan accepts — no
			// Algebraic or Transcendental among them.
			let integerLessThan = builtinNamespace("Integer").methods
				.isLessThan as common.OverloadedMethodType
			let acceptedKinds = integerLessThan.overloads.map(
				(overload) => overload.parameterTypes[1].type.type,
			)

			expect(acceptedKinds).not.toContain("Algebraic")
			expect(acceptedKinds).not.toContain("Transcendental")

			expect(
				builtinNamespace("Algebraic").methods.isLessThan,
			).toBeUndefined()
			expect(
				builtinNamespace("Transcendental").methods.isLessThan,
			).toBeUndefined()
			// NOTE: And `Number` writes none either. The covering Namespace
			// declares `is Orderable`, which extends `Comparable`, and that
			// Protocol's provided `isLessThan` reads its cross-kind `compare` — so a receiver of the covering Type
			// compares against any member of the tower without a body here.
			expect(
				builtinNamespace("Number").methods.isLessThan,
			).toBeUndefined()
			expect(builtinNamespace("Number").methods.compare).toBeDefined()
			expect(builtinNamespace("Number").conformsTo).toContain("Orderable")
		})

		it("should not allow redeclaring a builtin Protocol", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Printable {
					toString() -> String
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Protocol 'Printable' is already declared",
			)
		})
	})

	describe("Union Method Dispatch", () => {
		it("should dispatch a Number receiver to every member Namespace", () => {
			let invocation = lastConstantMethodInvocation(`implementation {
				constant number: Number = 5
				constant doubled = number::multiply(with 2)
			}`)

			expect(invocation.namespace.name).toBe("")
			expect(invocation.dispatch).not.toBeNull()
			expect(
				invocation.dispatch?.map(
					(dispatchCase) => dispatchCase.namespaceName,
				),
			).toEqual(["Integer", "Rational", "Algebraic", "Transcendental"])
			expect(invocation.type).toEqual({
				type: "UnionType",
				types: [
					{ type: "Integer" },
					{ type: "Rational" },
					{ type: "Algebraic" },
					{ type: "Transcendental" },
				],
			})
		})

		it("should collapse identical branch return Types", () => {
			let invocation = lastConstantMethodInvocation(`implementation {
				constant value: Integer | Boolean = 5
				constant text = value::toString()
			}`)

			expect(invocation.dispatch).not.toBeNull()
			expect(invocation.type).toEqual({ type: "String" })
		})

		// NOTE: `Number` rather than `Ordering` — `Ordering` writes no Method
		// at all now, deriving `is`, `isNot` and `toString` alike, and a
		// derived Method would make this pass for the wrong reason. `Number`
		// covers the whole numeric Union and WRITES `toString`, while each of
		// its members writes one too, so there is a dispatch here for the
		// covering Namespace to be kept ahead of.
		it("should keep a Namespace covering the whole Union ahead of dispatch", () => {
			let invocation = lastConstantMethodInvocation(`implementation {
				constant value: Number = 5
				constant text = value::toString()
			}`)

			expect(invocation.namespace.name).toBe("Number")
			expect(invocation.dispatch).toBeNull()
			expect(invocation.type).toEqual({ type: "String" })
		})

		// NOTE: The Union is written out rather than read off `10::divide(by 0)`,
		// which used to answer a `Rational | Nothing`. That call answers an
		// `Optional<Rational>` today, and `Optional` has a Namespace covering
		// the whole of it — so it resolves the way `Ordering` does above, with
		// no dispatch at all, which is the case this one is NOT about. Two
		// Namespaces that know nothing of each other, each declaring `toString`
		// for one member, is what a dispatch has to be built out of, and
		// `Rational | String` is the shortest pair of those left to write.
		it("should dispatch across unrelated member Namespaces", () => {
			let invocation = lastConstantMethodInvocation(`implementation {
				constant quotient: Rational | String = 1/2
				constant text = quotient::toString()
			}`)

			expect(invocation.namespace.name).toBe("")
			expect(
				invocation.dispatch?.map(
					(dispatchCase) => dispatchCase.namespaceName,
				),
			).toEqual(["Rational", "String"])
			expect(invocation.type).toEqual({ type: "String" })
		})

		it("should union distinct branch return Types through user Namespaces", () => {
			let invocation = lastConstantMethodInvocation(`implementation {
				namespace IntegerTag for Integer {
					tag() -> String {
						<- "integer"
					}
				}

				namespace BooleanTag for Boolean {
					tag() -> Integer {
						<- 1
					}
				}

				constant value: Integer | Boolean = 5
				constant tagged = value::tag()
			}`)

			expect(
				invocation.dispatch?.map(
					(dispatchCase) => dispatchCase.namespaceName,
				),
			).toEqual(["IntegerTag", "BooleanTag"])
			expect(invocation.type).toEqual({
				type: "UnionType",
				types: [{ type: "String" }, { type: "Integer" }],
			})
		})

		it("should reject the call when a member Type lacks the Method", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant value: Integer | Boolean = 5
				constant bad = value::multiply(with 2)
			}`)

			expect(
				diagnostics.some(
					(diagnostic) =>
						diagnostic.message ===
						"No Method named 'multiply' for Boolean",
				),
			).toBe(true)
		})

		it("should reject the call when a member Type rejects the Arguments", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace IntegerTag for Integer {
					tag(_ flag: Integer) -> String {
						<- "integer"
					}
				}

				namespace BooleanTag for Boolean {
					tag(_ flag: Boolean) -> String {
						<- "boolean"
					}
				}

				constant value: Integer | Boolean = 5
				constant bad = value::tag(1)
			}`)

			expect(
				diagnostics.some(
					(diagnostic) =>
						diagnostic.message ===
						"No overload of 'tag' accepts these Arguments for Boolean",
				),
			).toBe(true)
		})

		it("should reject ambiguous resolution for a member Type", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace TagA for Integer {
					tag() -> String {
						<- "a"
					}
				}

				namespace TagB for Integer {
					tag() -> String {
						<- "b"
					}
				}

				namespace BooleanTag for Boolean {
					tag() -> String {
						<- "boolean"
					}
				}

				constant value: Integer | Boolean = 5
				constant bad = value::tag()
			}`)

			expect(
				diagnostics.some(
					(diagnostic) =>
						diagnostic.message ===
						"'tag' is provided by more than one Namespace for Integer",
				),
			).toBe(true)
		})

		// NOTE: The Union is written out rather than read off a `firstItem()`,
		// which used to answer an `Item | Nothing`. That call answers an
		// `Optional<Item>` today — one Type with a Namespace covering it, which
		// resolves without a dispatch at all and so says nothing about the
		// member-by-member lookup this is about. The test below covers that
		// half. What matters here is the `Item` member: it is a Type Parameter,
		// so the only thing that can answer `toString` for it is the bound.
		it("should dispatch a bounded Type Parameter member through its conformance", () => {
			expect(
				diagnosticsFor(`implementation {
					function textOrLabel <infer Item is Printable>(_ value: Item | String) -> String {
						<- value::toString()
					}

					constant text: String = textOrLabel(1)
				}`),
			).toEqual([])
		})

		// NOTE: The other half — an `Optional` conforms to `Printable` only
		// when its payload does, and the payload here is a Type Parameter
		// nothing has decided. The bound is the whole of what makes the call
		// legal: the same body with `is Printable` dropped reports that 'Item'
		// does not conform to it, which is the conformance the Optional's own
		// is conditional on.
		it("should satisfy a conditional conformance from a Type Parameter's bound", () => {
			expect(
				diagnosticsFor(`implementation {
					function firstText <infer Item is Printable>(_ items: List<Item>) -> String {
						<- items::firstItem()::toString()
					}

					constant text: String = firstText([1, 2])
				}`),
			).toEqual([])
		})

		it("should prefer the more specific member Namespace inside a dispatch", () => {
			let invocation = lastConstantMethodInvocation(`implementation {
				namespace IntegerTag for Integer {
					tag() -> String {
						<- "integer"
					}
				}

				namespace EitherTag for Integer | Boolean {
					tag() -> String {
						<- "either"
					}
				}

				namespace StringTag for String {
					tag() -> String {
						<- "string"
					}
				}

				constant value: Integer | String = 5
				constant tagged = value::tag()
			}`)

			expect(
				invocation.dispatch?.map(
					(dispatchCase) => dispatchCase.namespaceName,
				),
			).toEqual(["IntegerTag", "StringTag"])
		})

		// NOTE: Record matching is OPEN at runtime — a `{ width, height }`
		// value matches the branch for `{ width }` — so the branch for the
		// more specific Record has to be tried first or it can never be
		// reached. Such a Union arrives here because applying a Generic Alias
		// rebuilds it without the subsumption pass that would have collapsed
		// the two members.
		function dispatchOrderOf(alias: string): Array<string> | undefined {
			let invocation = lastConstantMethodInvocation(`implementation {
				type Mixed<Extra> = ${alias}

				namespace Square for { width: Integer } {
					describe() -> String {
						<- "square"
					}
				}

				namespace Flag for Boolean {
					describe() -> String {
						<- "flag"
					}
				}

				namespace Rect for { width: Integer, height: Integer } {
					describe() -> String {
						<- "rect"
					}
				}

				constant shape: Mixed<{ width: Integer, height: Integer }> = { width = 1, height = 2 }
				constant described = shape::describe()
			}`)

			return invocation.dispatch?.map(
				(dispatchCase) => dispatchCase.namespaceName,
			)
		}

		it("should order a more specific Record member ahead of an open one", () => {
			expect(
				dispatchOrderOf("{ width: Integer } | Boolean | Extra"),
			).toEqual(["Rect", "Square", "Flag"])
		})

		// NOTE: The same Union, written with its incomparable member moved.
		// Sorting with a partial order only compared the pairs the sort
		// happened to reach, so `Boolean` standing between the two Records was
		// enough to leave them in declaration order — and the Program printed
		// something else.
		it("should order the same members the same way however they are spelled", () => {
			expect(
				dispatchOrderOf("{ width: Integer } | Extra | Boolean"),
			).toEqual(dispatchOrderOf("{ width: Integer } | Boolean | Extra"))
		})
	})

	describe("Method Target Specificity", () => {
		it("should prefer the Namespace with the strictly more specific target Type", () => {
			let invocation = lastConstantMethodInvocation(`implementation {
				namespace IntegerTag for Integer {
					tag() -> String {
						<- "integer"
					}
				}

				namespace EitherTag for Integer | Boolean {
					tag() -> Integer {
						<- 1
					}
				}

				constant tagged = 5::tag()
			}`)

			expect(invocation.namespace.name).toBe("IntegerTag")
			expect(invocation.type).toEqual({ type: "String" })
		})

		it("should resolve a Union receiver through the covering Namespace", () => {
			let invocation = lastConstantMethodInvocation(`implementation {
				namespace IntegerTag for Integer {
					tag() -> String {
						<- "integer"
					}
				}

				namespace EitherTag for Integer | Boolean {
					tag() -> Integer {
						<- 1
					}
				}

				constant value: Integer | Boolean = 5
				constant tagged = value::tag()
			}`)

			expect(invocation.namespace.name).toBe("EitherTag")
			expect(invocation.dispatch).toBeNull()
			expect(invocation.type).toEqual({ type: "Integer" })
		})

		it("should route single-member receivers past the Number Namespace", () => {
			let invocation = lastConstantMethodInvocation(`implementation {
				constant same = 5::is(3)
			}`)

			expect(invocation.namespace.name).toBe("Integer")
		})

		// NOTE: An Integer against a Rational is Integer's own rung now:
		// `Integer::is` holds a Rational entry beside its Integer one, as its
		// four inequalities do. What still falls to the covering Namespace is
		// a bound of a kind neither rung names, which is what the second half
		// asks.
		it("should resolve an Integer against a Rational on Integer's rung", () => {
			let invocation = lastConstantMethodInvocation(`implementation {
				constant same = 1::is(1/1)
			}`)

			expect(invocation.namespace.name).toBe("Integer")
			expect(invocation.type).toEqual({ type: "Boolean" })
		})

		it("should resolve mixed-member comparisons through the Number Namespace", () => {
			let invocation = lastConstantMethodInvocation(`implementation {
				constant same = 1::is(Number.Pi)
			}`)

			expect(invocation.namespace.name).toBe("Number")
			expect(invocation.type).toEqual({ type: "Boolean" })
		})

		it("should order mixed members through the Number Namespace", () => {
			expect(
				diagnosticsFor(`implementation {
					constant ordered = match 5::compare(to 1/2) -> String {
						case #Less    { <- "smaller" }
						case #Equal   { <- "same" }
						case #Greater { <- "bigger" }
					}
				}`),
			).toEqual([])
		})

		it("should prefer a concrete target over a generic one", () => {
			// NOTE: `firstItem` is the stdlib's, declared for every
			// `List<ItemType>` — a Namespace naming the item Type outright is
			// the more specific of the two and answers the call.
			//
			// NOTE: The receiver is a bound name and not the `[1, 2, 3]` it
			// once was. A written List proves it holds items, which puts
			// `NonEmptyList` on the ladder as well — and that one is neither
			// more nor less specific than `List<Integer>`, so the call is
			// ambiguous rather than concrete-wins. The test below pins that.
			let invocation = lastConstantMethodInvocation(`implementation {
				namespace IntegerTally for List<Integer> {
					firstItem() -> Integer {
						<- 0
					}
				}

				constant numbers: List<Integer> = [1, 2, 3]
				constant first = numbers::firstItem()
			}`)

			expect(invocation.namespace.name).toBe("IntegerTally")
			expect(invocation.type).toEqual({ type: "Integer" })
		})

		// NOTE: A written receiver carries its proof into dispatch, and two
		// Namespaces neither of which is more specific than the other are the
		// ambiguity they have always been — a literal receiver is exactly a
		// Constant declared with what the literal proves, and answers the same
		// Diagnostic and the same Help. Nothing here is special to a literal:
		// `constant proven: NonEmptyList<Integer> = [1, 2, 3]` reports this
		// same ambiguity for the same two candidates.
		it("should report a written receiver matching two unordered Namespaces", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace IntegerTally for List<Integer> {
					firstItem() -> Integer {
						<- 0
					}
				}

				constant first = [1, 2, 3]::firstItem()
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"ambiguous-namespace",
			])
			expect(diagnostics[0].helps).toEqual([
				"Name it at the call, e.g. 'value::<NonEmptyList>firstItem(…)'.",
			])
		})

		it("should prefer a nested generic target over a flat one", () => {
			// NOTE: Both targets are generic, so neither is concrete — the
			// deeper structure is what decides: `List<List<ItemType>>` covers
			// only nested Lists, while `List<ItemType>` covers those too. Both
			// spell their Generic `ItemType`, which is the case the alpha-rename
			// in the comparison exists for: without it the two capture each
			// other and read as covering one another.
			let invocation = lastConstantMethodInvocation(`implementation {
				namespace FlatTag<infer ItemType> for List<ItemType> {
					tag() -> String {
						<- "flat"
					}
				}

				namespace NestedTag<infer ItemType> for List<List<ItemType>> {
					tag() -> Integer {
						<- 1
					}
				}

				constant tagged = [[1], [2]]::tag()
			}`)

			expect(invocation.namespace.name).toBe("NestedTag")
			expect(invocation.type).toEqual({ type: "Integer" })
		})

		it("should keep two identically targeted generic Namespaces ambiguous", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace FirstTag<infer ItemType> for List<ItemType> {
						tag() -> String {
							<- "first"
						}
					}

					namespace SecondTag<infer Item> for List<Item> {
						tag() -> String {
							<- "second"
						}
					}

					constant tagged = [1, 2]::tag()
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["ambiguous-namespace"])
		})

		// NOTE: An empty List Literal is a `List<Unknown>`, and an Unknown fits
		// anything and is fit by anything — so every List target covers it, in
		// both directions, and the order above would answer the call with the
		// nested Namespace on the strength of a Type nothing has decided. The
		// refusal comes BEFORE the order is asked, which is also what stops the
		// winner's own `ItemType` from being reported uninferable: a Type
		// Parameter of a Namespace the program never picked.
		describe("An undecided receiver", () => {
			let overlappingNamespaces = `namespace FlatTag<infer ItemType> for List<ItemType> {
					tag() -> String {
						<- "flat"
					}
				}

				namespace NestedTag<infer ItemType> for List<List<ItemType>> {
					tag() -> Integer {
						<- 1
					}
				}`

			it("should refuse a call more than one Namespace matches", () => {
				expect(
					diagnosticsFor(`implementation {
				${overlappingNamespaces}

				constant tagged = []::tag()
			}`).map((diagnostic) => diagnostic.code),
				).toEqual(["undecided-receiver-type"])
			})

			it("should point at the receiver and name what matched it", () => {
				let source = `implementation {
				${overlappingNamespaces}

				constant tagged = []::tag()
			}`
				let diagnostic = diagnosticsFor(source)[0]

				expect(diagnostic.message).toBe(
					"'tag' is called on a value whose Type is not fully known here",
				)
				expect(underlinedText(source, diagnostic)).toBe("[]")
				expect(diagnostic.labels[0]?.message).toBe(
					"this is a List<Unknown>",
				)
				expect(diagnostic.labels[1]?.kind).toBe("secondary")
				expect(diagnostic.labels[1]?.message).toBe(
					"'tag' is looked up in its Namespaces",
				)
				expect(diagnostic.notes).toContain("'FlatTag' declares 'tag'.")
				expect(diagnostic.notes).toContain(
					"'NestedTag' declares 'tag'.",
				)
				expect(diagnostic.helps).toEqual([
					"Annotate what the receiver comes from — 'constant items: List<Integer> = []' — so its Type is decided before the call.",
				])
			})

			it("should resolve once the receiver is annotated", () => {
				let invocation = lastConstantMethodInvocation(`implementation {
				${overlappingNamespaces}

				constant empty: List<Integer> = []
				constant tagged = empty::tag()
			}`)

				expect(invocation.namespace.name).toBe("FlatTag")
				expect(invocation.type).toEqual({ type: "String" })
			})

			it("should leave a lone matching Namespace alone", () => {
				// NOTE: Nothing was decided by the Unknown where there was
				// nothing to decide between — the call has the one Namespace to
				// go to whatever the receiver turns out to hold.
				let invocation = lastConstantMethodInvocation(`implementation {
				namespace IntegerTally for List<Integer> {
					tag() -> String {
						<- "integers"
					}
				}

				constant tagged = []::tag()
			}`)

				expect(invocation.namespace.name).toBe("IntegerTally")
				expect(invocation.type).toEqual({ type: "String" })
			})

			it("should refuse an undecided member of a Union receiver", () => {
				// NOTE: Per-member dispatch reaches the same order, so it
				// refuses on the same terms — one member of the Union the
				// callback's two returns build is the `List<Unknown>` both
				// Namespaces match, and the refusal comes before the Integer
				// member is ever asked for the `tag` it does not have.
				//
				// The Union is built by a callback rather than read off
				// `[[]]::firstItem()`, which used to answer one. That call
				// answers an `Optional<List<Unknown>>` today, and the undecided
				// List is the PAYLOAD of an `Optional#Value` member rather than
				// a member itself, so no member of it is undecided at all.
				let diagnostics = diagnosticsFor(`implementation {
				${overlappingNamespaces}

				namespace Picker for Integer {
					pick<infer Result>(_ choose: (_ value: Integer) -> Result) -> Result {
						<- choose(@)
					}
				}

				constant tagged = 1::pick((value) {
					if value::isGreaterThan(0) { <- [] }

					<- value
				})::tag()
			}`)

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["undecided-receiver-type"])
				expect(diagnostics[0].notes).toContain(
					"List<Unknown> is a member of this Union.",
				)
			})
		})
	})

	// NOTE: A static Method is called on its Namespace and takes no receiver.
	// Both halves of that are load-bearing for what the Rewriter emits: the
	// call passes only the written Arguments, and the definition is emitted
	// without the `_self` Parameter `@` compiles to.
	describe("Documentation", () => {
		it("should report a '@param' naming the wrong Parameter", () => {
			let diagnostics = diagnosticsFor(`implementation {
				§§ Greets.
				§§ @param subjekt — who to greet
				function greet(subject: String) -> String { <- subject }
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("warning")
			expect(diagnostics[0].code).toBe("misnamed-documentation-parameter")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"Parameter 1 is 'subject'",
			)
			expect(diagnostics[0].helps).toEqual(["Write '@param subject'."])
			// NOTE: The name alone is underlined, rather than the whole block
			// or the whole Comment.
			expect(diagnostics[0].position).toEqual({
				start: { line: 3, column: 15 },
				end: { line: 3, column: 22 },
			})
		})

		it("should match a '@param' to the Parameter at its position", () => {
			// NOTE: Both lines name a Parameter that exists, and the first
			// names the second one — which is what a line left out looks like.
			let diagnostics = diagnosticsFor(`implementation {
				§§ Joins.
				§§ @param right — the text to put after
				§§ @param left — the text to put first
				function join(left: String, right: String) -> String {
					<- left::append(right)
				}
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"misnamed-documentation-parameter",
				"misnamed-documentation-parameter",
			])
			expect(diagnostics[0].notes).toContain(
				"'right' is Parameter 2, so a line for each Parameter before it belongs above this one.",
			)
			expect(diagnostics[0].notes).toContain(
				"The Parameters are 'left', 'right', in that order.",
			)
		})

		it("should report a '@param' past the end of the Parameters", () => {
			let diagnostics = diagnosticsFor(`implementation {
				§§ Greets.
				§§ @param subject — who to greet
				§§ @param loudly — and how
				function greet(subject: String) -> String { <- subject }
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unknown-documentation-parameter")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"there is no Parameter 2",
			)
			expect(diagnostics[0].helps).toEqual([
				"Remove the tag — this signature takes 1 Parameter.",
			])
		})

		it("should take the label, or '_' where there is none", () => {
			// NOTE: A positional Parameter is documented as '_', and a
			// labelled one as its label. Nothing else names it:
			// `documentationStrictness` is `"strict"`, so the internal name a
			// body reads a labelled Parameter under is not a second spelling.
			expect(
				diagnosticsFor(`implementation {
					§§ Greets.
					§§ @param _ — who to greet
					function greet(_ subject: String) -> String { <- subject }
				}`),
			).toEqual([])

			expect(
				diagnosticsFor(`implementation {
					§§ Greets.
					§§ @param to — who to greet
					function greet(to subject: String) -> String { <- subject }
				}`),
			).toEqual([])
		})

		it("should report the internal name of a labelled Parameter", () => {
			for (let source of [
				`implementation {
					§§ Greets.
					§§ @param subject — who to greet
					function greet(_ subject: String) -> String { <- subject }
				}`,
				`implementation {
					§§ Greets.
					§§ @param subject — who to greet
					function greet(to subject: String) -> String { <- subject }
				}`,
			]) {
				let diagnostics = diagnosticsFor(source)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe(
					"misnamed-documentation-parameter",
				)
			}
		})

		it("should report a run that stops short of the last Parameter", () => {
			// NOTE: One line per Parameter, so the Parameter no line reached
			// is reported where it is declared rather than where the run ends.
			let diagnostics = diagnosticsFor(`implementation {
				§§ Joins.
				§§ @param left — the text to put first
				function join(left: String, right: String) -> String {
					<- left::append(right)
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("undocumented-parameter")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"Parameter 2 is undocumented",
			)
			expect(diagnostics[0].helps).toEqual([
				"Write '@param right — …' as line 2 of the run.",
			])
		})

		it("should let an overload block name a Parameter of any Overload", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Ladder for Integer {
						§§ Climbs.
						§§ @param count — how far
						overload climb {
							(_ count: Integer) -> Integer { <- @ }
							() -> Integer { <- @ }
						}
					}
				}`),
			).toEqual([])
		})

		it("should report an overload block naming no Overload's Parameter", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Ladder for Integer {
					§§ Climbs.
					§§ @param hight — how far
					overload climb {
						(_ height: Integer) -> Integer { <- @ }
						() -> Integer { <- @ }
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unknown-documentation-parameter")
			expect(diagnostics[0].helps).toEqual(["Did you mean 'height'?"])
			expect(diagnostics[0].notes).toHaveLength(1)
		})

		it("should report a '@param' on a Declaration that holds no Function", () => {
			let diagnostics = diagnosticsFor(`implementation {
				§§ The default.
				§§ @param subject — who to greet
				constant fallback = "Hello"
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unknown-documentation-parameter")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"what this documents takes no Parameters",
			)
			expect(diagnostics[0].helps).toEqual([
				"Remove the tag — there is no Parameter for it to describe.",
			])
		})

		it("should read a Declaration's '@param' against the Function it holds", () => {
			// NOTE: The block sits above the `constant`, and the Parameters it
			// can be describing are the held Function's.
			expect(
				diagnosticsFor(`implementation {
					§§ Greets.
					§§ @param subject — who to greet
					constant greet = (subject: String) -> String { <- subject }
				}`),
			).toEqual([])

			expect(
				diagnosticsFor(`implementation {
					§§ Greets.
					§§ @param subjekt — who to greet
					constant greet = (subject: String) -> String { <- subject }
				}`),
			).toHaveLength(1)
		})

		it("should not keep a Function it warns about out of Scope", () => {
			// NOTE: Hoisting kept a speculative resolution only when it
			// reported nothing at all, and every Diagnostic reachable from it
			// used to be an error. A Warning about the `§§` block above a
			// Function would leave that Function unhoisted, so every call
			// ABOVE it reported `unknown-name` — a typo in a Comment breaking
			// the Program underneath it.
			let diagnostics = diagnosticsFor(`implementation {
				constant greeting = greet(subject "World")

				§§ Greets.
				§§ @param subjekt — who to greet
				function greet(subject: String) -> String { <- subject }
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("misnamed-documentation-parameter")
		})

		it("should leave a Declaration whose Parameters it cannot see unchecked", () => {
			// NOTE: `alias` is function-valued, but its Parameters survive only
			// in a resolved Type, which keeps no internal names — so a `@param`
			// here cannot be told from a typo. Reporting it said "takes no
			// Parameters" about a Declaration whose Hover showed them.
			expect(
				diagnosticsFor(`implementation {
					function greet(_ subject: String) -> String { <- subject }

					§§ The greeting to use.
					§§ @param subject — who to greet
					constant alias = greet
				}`),
			).toEqual([])
		})

		it("should leave a Function literal in expression position undocumented", () => {
			// NOTE: A literal in expression position is anonymous — it
			// declares nothing, so no `§§` block is written about it, and the
			// block above the line belongs to the Declaration the expression
			// sits inside. The Parser reads Documentation by line alone, so a
			// literal sharing that Declaration's line used to claim it: the
			// block's `@param` lines were then read against the LITERAL's
			// Parameters, and `@param where` was reported as naming '_'.
			//
			// A Parameter's default is where this bites hardest, because a
			// signature and its default are one line by construction.
			expect(
				diagnosticsFor(`implementation {
					namespace Walker for List<Integer> {
						§§ Answers a new List of every item the check accepts.
						§§ @param where — the check each item is offered to
						keep(where check: (_: Integer) -> Boolean = (_ item: Integer) -> Boolean { <- true }) -> List<Integer> { <- @ }
					}
				}`),
			).toEqual([])

			expect(
				diagnosticsFor(`implementation {
					§§ Counts.
					§§ @param where — the check each item is offered to
					function count (where check: (_: Integer) -> Boolean = (_ item: Integer) -> Boolean { <- true }) -> Integer { <- 1 }
				}`),
			).toEqual([])

			// NOTE: An Argument's callback is the same shape without a default
			// in sight.
			expect(
				diagnosticsFor(`implementation {
					§§ The kept items.
					§§ @param where — the check each item is offered to
					constant kept = [1, 2]::everyItem(where (_ item: Integer) -> Boolean { <- true })
				}`),
			).toEqual([])
		})

		it("should read a block against the signature the default is on", () => {
			// NOTE: The other half of the rule above: the block is still
			// checked, and it is checked against the Method whose Parameter
			// carries the default.
			let diagnostics = diagnosticsFor(`implementation {
				§§ Counts.
				§§ @param wehre — the check each item is offered to
				function count (where check: (_: Integer) -> Boolean = (_ item: Integer) -> Boolean { <- true }) -> Integer { <- 1 }
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("misnamed-documentation-parameter")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"Parameter 1 is 'where'",
			)
		})

		it("should hand a Declaration's block to the Function it holds", () => {
			// NOTE: The block documents what the Declaration holds, so the
			// literal is HANDED it rather than reading it off the line above —
			// which is what makes the two layouts agree. Signature Help reads
			// the Function's own Type, and used to find the description only
			// where the literal shared the `constant`'s line.
			let sameLine = `implementation {
				§§ Greets.
				§§ @param subject — who to greet
				constant greet = (subject: String) -> String { <- subject }
			}`
			let ownLine = `implementation {
				§§ Greets.
				§§ @param subject — who to greet
				constant greet =
					(subject: String) -> String { <- subject }
			}`

			for (let source of [sameLine, ownLine]) {
				let type = lastConstantValue(source).type

				expect(type.type).toBe("Function")
				expect(
					type.type === "Function"
						? type.documentation?.description
						: null,
				).toBe("Greets.")
			}
		})

		it("should report nothing for the Documentation of a builtin", () => {
			// NOTE: A builtin Namespace documents itself in TypeScript and the
			// standard library's Positions are stripped as it loads, so there
			// is no `§§` line to point at and nothing to check.
			expect(
				diagnosticsFor(`implementation {
					constant length = "abc"::length()
				}`),
			).toEqual([])
		})
	})

	describe("Static Methods", () => {
		it("should reject a static Method called on a value", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Maker for Integer {
					static make(_ base: Integer) -> Integer {
						<- base
					}
				}

				constant made = 5::make(7)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("static-method-on-value")
			expect(diagnostics[0].message).toBe("'make' is a static Method")
		})

		// NOTE: `Integer.parse` — the Invocation type-checked against the
		// written Arguments alone while the Simplifier prepended the receiver
		// anyway, so every runtime Argument landed one place too far right and
		// the Program answered with the receiver instead of erroring.
		it("should reject a builtin static Method called on a value", () => {
			expect(
				diagnosticsFor(`implementation {
					constant weird = 999::parse("42")
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["static-method-on-value"])
		})

		it("should reject an overloaded static Method called on a value", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Maker for Integer {
						overload static make {
							(_ base: Integer) -> Integer {
								<- base
							}

							(_ base: String) -> Integer {
								<- 0
							}
						}
					}

					constant made = 5::make(7)
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["static-method-on-value"])
		})

		it("should reject a static Method called on a member of a Union", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace IntegerTag for Integer {
						static tag() -> String {
							<- "integer"
						}
					}

					namespace StringTag for String {
						tag() -> String {
							<- "string"
						}
					}

					constant value: Integer | String = 5
					constant tagged = value::tag()
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["static-method-on-value"])
		})

		it("should still resolve the same Method called on its Namespace", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				namespace Maker for Integer {
					static make(_ base: Integer) -> Integer {
						<- base
					}
				}

				constant made = Maker.make(7)
			}`)

			expect(diagnostics).toEqual([])

			let constants = program.implementation.nodes.filter(
				(node) => node.nodeType === "ConstantDeclarationStatement",
			)

			expect(constants[constants.length - 1].type).toEqual({
				type: "Integer",
			})
		})

		// NOTE: An instance Method of the same Namespace binds `@` right
		// beside it, which is exactly why this is an easy mistake — and why
		// the Scope has to refuse `@` rather than merely leave it undeclared.
		it("should reject '@' in a static Method body", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Maker for Integer {
					static make() -> Integer {
						<- @::add(1)
					}

					doubled() -> Integer {
						<- @::multiply(with 2)
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("at-in-static-method")
			expect(diagnostics[0].message).toBe(
				"There is no '@' in a static Method",
			)
			expect(diagnostics[0].position?.start.line).toBe(4)
		})

		it("should reject '@' in an overloaded static Method body", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Maker for Integer {
						overload static make {
							() -> Integer {
								<- @
							}

							(_ base: Integer) -> Integer {
								<- base
							}
						}
					}
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["at-in-static-method"])
		})

		// NOTE: A Match Handler binds its own `@` — the value that matched —
		// and is emitted as a Function taking it, so it keeps working inside a
		// static Method. Only the receiver `@` is gone.
		it("should keep '@' bound in a Match Handler inside a static Method", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Maker for Integer {
						static describe(_ value: Integer | Boolean) -> String {
							<- match value -> String {
								case Integer { <- @::toString() }
								case Boolean { <- "boolean" }
							}
						}
					}
				}`),
			).toEqual([])
		})

		it("should keep '@' bound in the instance Methods beside it", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Maker for Integer {
						static make() -> Integer {
							<- 1
						}

						doubled() -> Integer {
							<- @::multiply(with 2)
						}
					}
				}`),
			).toEqual([])
		})
	})

	// NOTE: A Module's Choices are identified by its canonical path, and every
	// rail that reaches a Choice BY NAME has to keep working: the Type Scope is
	// keyed by the name the declaration wrote, so a lookup that went looking for
	// the identity would find nothing — and answering nothing is not a
	// Diagnostic anywhere, it is a Choice that silently stops deriving its
	// equality or resolving its Cases.
	// NOTE: `= expression` at the end of a Parameter. The scoping rule is one
	// ordering — a default is enriched before its own Parameter is declared —
	// and every case here is that ordering seen from a different side.
	describe("Default Parameter Values", () => {
		it("should accept a default that fits its Parameter", () => {
			expect(
				diagnosticsFor(`implementation {
					function f(_ count: Integer = 1) -> Integer {
						<- count
					}
				}`),
			).toEqual([])
		})

		it("should report a default that does not fit its Parameter", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function f(_ count: Integer = "one") -> Integer {
					<- count
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("default-type-mismatch")
			expect(diagnostics[0].message).toBe(
				"This default does not fit Parameter 'count'",
			)
		})

		// NOTE: The default is enriched BEFORE its own Parameter is declared,
		// which is what makes a self-reference impossible; the Parameter's name
		// is BARRED there, which is what keeps it impossible when something
		// outside the Declaration spells the same name.
		it("should refuse a default that reads its own Parameter", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function f(_ count: Integer = count) -> Integer {
					<- count
				}
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"default-references-own-parameter",
			])
		})

		it("should refuse a default that reads its own Parameter over an outer Constant of that name", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant count = 5

				function f(_ count: Integer = count) -> Integer {
					<- count
				}
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"default-references-own-parameter",
			])
		})

		// NOTE: The whole reason the barred names are a barrier and not a
		// fallback for names that resolved to nothing: this one RESOLVES, to the
		// Constant above, and the emitted `(a = y, y)` reads the Parameter out of
		// its own temporal dead zone rather than the Constant.
		it("should refuse a default that reads a later Parameter shadowing an outer Constant", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant y = 7

				function g(_ a: Integer = y, with y: Integer) -> Integer {
					<- a::add(y)
				}
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"default-references-later-parameter",
			])
		})

		// NOTE: A Pattern's bindings are Constants at the head of the BODY, and
		// every default is worked out before the body's first Statement runs —
		// so a default reading one would emit a read of a `const` that does not
		// exist yet.
		it("should refuse a default that reads a Pattern binding", () => {
			let diagnostics = diagnosticsFor(`implementation {
				type Point = { x: Integer, y: Integer }

				function shift(_ { x, y }: Point, by amount: Integer = x) -> Integer {
					<- y::add(amount)
				}
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"default-references-pattern-binding",
			])
		})

		// NOTE: A Function literal written inside a default declares Parameters
		// of its own, and they shadow the barrier exactly as they shadow
		// everything else — the barred names belong to the list the default is
		// written in, not to every list below it.
		it("should let a Function literal inside a default bind the barred name itself", () => {
			expect(
				diagnosticsFor(`implementation {
					function apply(_ transform: (_ n: Integer) -> Integer, to value: Integer) -> Integer {
						<- transform(value)
					}

					function f(_ a: Integer = apply((_ b: Integer) -> Integer {
						<- b
					}, to 1), with b: Integer) -> Integer {
						<- a::add(b)
					}
				}`),
			).toEqual([])
		})

		it("should accept a default that reads a Parameter to its left", () => {
			expect(
				diagnosticsFor(`implementation {
					function f(_ a: Integer, _ b: Integer = a) -> Integer {
						<- a::add(b)
					}
				}`),
			).toEqual([])
		})

		it("should report a default that reads a Parameter to its right", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function f(_ a: Integer = b, to b: Integer) -> Integer {
					<- a::add(b)
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe(
				"default-references-later-parameter",
			)
			expect(diagnostics[0].labels).toHaveLength(2)
		})

		it("should accept a default that reads @", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Slices for List<Integer> {
						upTo(_ end: Integer = @::length()) -> Integer {
							<- end
						}
					}
				}`),
			).toEqual([])
		})

		// NOTE: Nothing enforces this beyond the Scope a static Method's body
		// already is — `enrichMethodFunctionDefinition` sets the `@` barrier
		// before it walks the Parameter list, so a default reading `@` there
		// is refused by the rule that was already there.
		it("should refuse @ in a static Method's default", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Slices for List<Integer> {
					static build(_ end: Integer = @::length()) -> Integer {
						<- end
					}
				}
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
				"at-in-static-method",
			)
		})

		// NOTE: The rule is about LABELS, not about position: a default may sit
		// anywhere so long as nothing after it answers to the same label.
		it("should refuse an unlabelled default followed by an unlabelled Parameter", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function f(_ a: Integer = 1, _ b: String) -> String {
					<- b
				}
			}`)

			expect(
				diagnostics.filter(
					(diagnostic) =>
						diagnostic.code ===
						"indistinguishable-default-parameter",
				),
			).toHaveLength(1)
		})

		it("should refuse a default followed by the same label", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function f(to a: Integer = 1, to b: String) -> String {
					<- b
				}
			}`)

			expect(
				diagnostics.filter(
					(diagnostic) =>
						diagnostic.code ===
						"indistinguishable-default-parameter",
				),
			).toHaveLength(1)
		})

		it("should accept a default followed by a differently labelled Parameter", () => {
			expect(
				diagnosticsFor(`implementation {
					function f(_ a: Integer, _ b: Integer = 2, to x: Integer) -> Integer {
						<- x
					}
				}`),
			).toEqual([])
		})

		it("should accept a Method's default followed by a labelled Parameter", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Slices for List<Integer> {
						cut(_ start: Integer = 0, to end: Integer) -> Integer {
							<- end
						}
					}
				}`),
			).toEqual([])
		})

		// NOTE: The call side. Pairing reads labels and `hasDefault` and never a
		// Type, so a call's shape is settled before any Argument is typed —
		// which is what every Overload candidate, the deferred-Argument order
		// and Completion all depend on.
		describe("calls that leave an Argument out", () => {
			it("should type a call that omits a trailing default", () => {
				expect(
					printType(
						lastConstantValue(`implementation {
							function f(_ count: Integer = 1) -> Integer {
								<- count
							}

							constant value = f()
						}`).type,
					),
				).toBe("Integer")
			})

			it("should record which Parameters a call left out", () => {
				let value = lastConstantFunctionInvocation(`implementation {
					function f(_ count: Integer = 1) -> Integer {
						<- count
					}

					constant value = f()
				}`)

				expect(value.omittedParameterIndices).toEqual([0])
			})

			it("should record nothing for a call that writes every Argument", () => {
				let value = lastConstantFunctionInvocation(`implementation {
					function f(_ count: Integer = 1) -> Integer {
						<- count
					}

					constant value = f(3)
				}`)

				expect(value.omittedParameterIndices).toEqual([])
			})

			// NOTE: The case the trailing-run rule would have forbidden. `to 3`
			// carries a label `from` does not, so the walk skips `from` and
			// pairs `to` — decided from labels alone.
			it("should skip an interior default the next label steps over", () => {
				let value = lastConstantFunctionInvocation(`implementation {
					function cut(from start: Integer = 0, to end: Integer) -> Integer {
						<- end::subtract(start)
					}

					constant value = cut(to 3)
				}`)

				expect(value.omittedParameterIndices).toEqual([0])
				expect(printType(value.type)).toBe("Integer")
			})

			it("should omit a Method's default and index over the receiver", () => {
				let value = lastConstantMethodInvocation(`implementation {
					namespace Slices for List<Integer> {
						upTo(_ end: Integer = @::length()) -> Integer {
							<- end
						}
					}

					constant value = [1, 2, 3]::upTo()
				}`)

				// NOTE: Parameter 0 is the receiver `@` lowers to, so the one
				// the source wrote is 1.
				expect(value.omittedParameterIndices).toEqual([1])
			})

			// NOTE: An omitted Argument binds NOTHING — there is no Argument to
			// read a Type off. A Type Parameter another Argument binds is bound
			// all the same.
			it("should bind a Type Parameter from the Argument that was written", () => {
				expect(
					printType(
						lastConstantValue(`implementation {
							function pick<infer T>(_ x: T, _ y: T = x) -> T {
								<- y
							}

							constant value = pick(1)
						}`).type,
					),
				).toBe("Integer")
			})

			it("should report a Type Parameter only an omitted Parameter could bind", () => {
				let diagnostics = diagnosticsFor(`implementation {
					function empty<infer T>(_ items: List<T> = []) -> List<T> {
						<- items
					}

					constant value = empty()
				}`)

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toContain("uninferable-type-parameter")
			})
		})

		// NOTE: `hasDefault` is the whole of what a TYPE says about a default
		// — the expression itself stays on the Declaration's Node, because a
		// Type is compared, cached and serialized.
		it("should carry hasDefault on a Function's Parameter Type", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				function f(_ a: Integer, _ b: Integer = 1) -> Integer {
					<- a
				}
			}`)

			expect(diagnostics).toEqual([])

			let statement = program.implementation.nodes[0]

			if (statement.nodeType !== "FunctionStatement") {
				throw new Error("Expected a FunctionStatement")
			}

			let type = statement.name.type

			if (type.type !== "Function") {
				throw new Error("Expected a Function Type")
			}

			expect(type.parameterTypes[0].hasDefault).toBeUndefined()
			expect(type.parameterTypes[1].hasDefault).toBe(true)
		})

		it("should carry hasDefault on a Namespace Method's Parameter Type", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				namespace Slices for List<Integer> {
					upTo(_ end: Integer = 1) -> Integer {
						<- end
					}
				}
			}`)

			expect(diagnostics).toEqual([])

			let statement = program.implementation.nodes[0]

			if (statement.nodeType !== "NamespaceDefinitionStatement") {
				throw new Error("Expected a NamespaceDefinitionStatement")
			}

			let member = statement.type.methods["upTo"]

			if (member?.type !== "SimpleMethod") {
				throw new Error("Expected a SimpleMethod")
			}

			// NOTE: Parameter 0 is the receiver every non-static signature is
			// prefixed with — `end` is the one the source wrote.
			expect(member.parameterTypes[0].hasDefault).toBeUndefined()
			expect(member.parameterTypes[1].hasDefault).toBe(true)
		})

		// NOTE: `defaultMembers` is the second half of what a Type says about
		// a default, and it says it about a Record Parameter alone: which
		// members a call may leave out of an Argument it still has to write.
		it("should carry defaultMembers for a partial Record default", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				type Options = { host: String, retries: Integer }

				function connect(using options: Options = { retries = 3 }) -> String {
					<- options.host
				}
			}`)

			expect(diagnostics).toEqual([])

			let statement = program.implementation.nodes[1]

			if (statement.nodeType !== "FunctionStatement") {
				throw new Error("Expected a FunctionStatement")
			}

			let type = statement.name.type

			if (type.type !== "Function") {
				throw new Error("Expected a Function Type")
			}

			expect(type.parameterTypes[0].defaultMembers).toEqual(["retries"])
			// NOTE: The Argument is still required — a partial default fills in
			// members, never the whole value.
			expect(type.parameterTypes[0].hasDefault).toBeUndefined()
		})

		it("should carry both keys for a complete Record default", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				type Options = { host: String, retries: Integer }

				function connect(using options: Options = { host = "h", retries = 3 }) -> String {
					<- options.host
				}
			}`)

			expect(diagnostics).toEqual([])

			let statement = program.implementation.nodes[1]

			if (statement.nodeType !== "FunctionStatement") {
				throw new Error("Expected a FunctionStatement")
			}

			let type = statement.name.type

			if (type.type !== "Function") {
				throw new Error("Expected a Function Type")
			}

			expect(type.parameterTypes[0].defaultMembers).toEqual([
				"host",
				"retries",
			])
			expect(type.parameterTypes[0].hasDefault).toBe(true)
		})

		// NOTE: What a default that is not written as a literal supplies can not
		// be read off its text, so it is held to the Parameter's Type as it
		// always was — complete, and every member omittable.
		it("should carry every member for a default that is not a literal", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				type Options = { host: String, retries: Integer }

				constant fallback: Options = { host = "h", retries = 3 }

				function connect(using options: Options = fallback) -> String {
					<- options.host
				}
			}`)

			expect(diagnostics).toEqual([])

			let statement = program.implementation.nodes[2]

			if (statement.nodeType !== "FunctionStatement") {
				throw new Error("Expected a FunctionStatement")
			}

			let type = statement.name.type

			if (type.type !== "Function") {
				throw new Error("Expected a Function Type")
			}

			expect(type.parameterTypes[0].defaultMembers).toEqual([
				"host",
				"retries",
			])
			expect(type.parameterTypes[0].hasDefault).toBe(true)
		})

		it("should carry defaultMembers on a Namespace Method's Parameter", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				type Options = { host: String, retries: Integer }

				namespace Links for String {
					open(using options: Options = { retries = 3 }) -> String {
						<- options.host
					}
				}
			}`)

			expect(diagnostics).toEqual([])

			let statement = program.implementation.nodes[1]

			if (statement.nodeType !== "NamespaceDefinitionStatement") {
				throw new Error("Expected a NamespaceDefinitionStatement")
			}

			let member = statement.type.methods["open"]

			if (member?.type !== "SimpleMethod") {
				throw new Error("Expected a SimpleMethod")
			}

			expect(member.parameterTypes[0].defaultMembers).toBeUndefined()
			expect(member.parameterTypes[1].defaultMembers).toEqual(["retries"])
		})

		it("should carry no defaultMembers for a scalar default", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				function f(_ a: Integer = 1) -> Integer {
					<- a
				}
			}`)

			expect(diagnostics).toEqual([])

			let statement = program.implementation.nodes[0]

			if (statement.nodeType !== "FunctionStatement") {
				throw new Error("Expected a FunctionStatement")
			}

			let type = statement.name.type

			if (type.type !== "Function") {
				throw new Error("Expected a Function Type")
			}

			expect(type.parameterTypes[0].defaultMembers).toBeUndefined()
		})

		// NOTE: A Function taken as a VALUE drops its defaults, and both keys go
		// with them — nothing a default was going to fill in is filled in any
		// more, neither a whole Argument nor one member of one.
		it("should drop defaultMembers where the Function is taken as a value", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				type Options = { host: String, retries: Integer }

				function connect(using options: Options = { retries = 3 }) -> String {
					<- options.host
				}

				constant taken = connect
			}`)

			expect(diagnostics).toEqual([])

			let statement = program.implementation.nodes[2]

			if (statement.nodeType !== "ConstantDeclarationStatement") {
				throw new Error("Expected a ConstantDeclarationStatement")
			}

			let type = statement.type

			if (type.type !== "Function") {
				throw new Error("Expected a Function Type")
			}

			expect(type.parameterTypes[0].defaultMembers).toBeUndefined()
			expect(type.parameterTypes[0].hasDefault).toBeUndefined()
		})

		// NOTE: A partial default is admitted only where its members really are
		// the Parameter's, and only where they are written out — the two things
		// `recordDefaultMembers` reads.
		it("should refuse a Record default naming a member the Type has not", () => {
			let { diagnostics } = enrichSource(`implementation {
				type Options = { host: String, retries: Integer }

				function connect(using options: Options = { retires = 3 }) -> String {
					<- options.host
				}
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
				"default-type-mismatch",
			)
		})

		it("should refuse a partial default that is not a Record literal", () => {
			let { diagnostics } = enrichSource(`implementation {
				type Options = { host: String, retries: Integer }

				constant some = { retries = 3 }

				function connect(using options: Options = some) -> String {
					<- options.host
				}
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
				"default-type-mismatch",
			)
		})

		// NOTE: The typed tree carries the enriched Expression, because the
		// Simplifier lowers it and the Language Server's typed walkers have to
		// reach a call written inside one.
		it("should carry the enriched default on the typed Parameter", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				function f(_ count: Integer = 1) -> Integer {
					<- count
				}
			}`)

			expect(diagnostics).toEqual([])

			let statement = program.implementation.nodes[0]

			if (statement.nodeType !== "FunctionStatement") {
				throw new Error("Expected a FunctionStatement")
			}

			let parameter = statement.value.parameters[0]

			expect(parameter.defaultValue?.nodeType).toBe("IntegerValue")
			expect(printType(parameter.defaultValue!.type)).toBe("Integer")
		})
	})

	describe("Module Identity", () => {
		function diagnosticsForModule(
			source: string,
		): Array<common.Diagnostic> {
			return enrich(parse(source), {
				modulePath: "/modules/Choices.es",
			}).diagnostics
		}

		it("should resolve a Choice's Cases named, bare and matched", () => {
			expect(
				diagnosticsForModule(`implementation {
					choice Colour {
						Red,
						Green { shade: Integer },
					}

					constant named: Colour = Colour#Red
					constant bare: Colour = #Green({ shade = 1 })

					Terminal.inspect(match named -> String {
						case #Red { <- "red" }
						case Colour#Green { <- @.shade::toString() }
					})
				}`),
			).toEqual([])
		})

		it("should derive a Choice's equality from a Module's own Choice", () => {
			expect(
				diagnosticsForModule(`implementation {
					choice Colour {
						Red,
						Green,
					}

					constant red: Colour = #Red
					constant same = red::is(#Green)

					Terminal.inspect(same::toString())
				}`),
			).toEqual([])
		})

		it("should derive a generic Choice's equality through its Generic Alias", () => {
			expect(
				diagnosticsForModule(`implementation {
					choice Box<Value> {
						Empty,
						Full { value: Value },
					}

					constant full: Box<Integer> = Box<Integer>#Full({ value = 1 })
					constant same = full::is(Box<Integer>#Empty)

					Terminal.inspect(same::toString())
				}`),
			).toEqual([])
		})

		it("should reach a Module's Choice through a Type Alias of it", () => {
			expect(
				diagnosticsForModule(`implementation {
					choice Colour {
						Red,
						Green,
					}

					type Shade = Colour

					constant red: Shade = Shade#Red

					Terminal.inspect(match red -> String {
						case #Red { <- "red" }
						case #Green { <- "green" }
					})
				}`),
			).toEqual([])
		})

		it("should dispatch a Namespace declared for a Module's Choice", () => {
			expect(
				diagnosticsForModule(`implementation {
					choice Colour {
						Red,
						Green,
					}

					namespace Named for Colour {
						name() -> String {
							<- match @ -> String {
								case #Red { <- "red" }
								case #Green { <- "green" }
							}
						}
					}

					constant red: Colour = #Red

					Terminal.inspect(red::name())
				}`),
			).toEqual([])
		})

		it("should identify a Choice by its Module while naming it as written", () => {
			let { program, diagnostics } = enrich(
				parse(`implementation {
					choice Colour {
						Red,
					}
				}`),
				{ modulePath: "/modules/Colour.es" },
			)

			expect(diagnostics).toEqual([])

			let declaration = program.implementation.nodes[0]

			if (declaration.nodeType !== "ChoiceDeclarationStatement") {
				throw new Error("The Program declares no Choice.")
			}

			expect(declaration.cases[0].type.choice).toBe(
				"/modules/Colour.es#Colour",
			)
			expect(printType(declaration.type)).toBe("Colour")
		})
	})

	// NOTE: What a `where` clause on a Type Alias declares — the Type it
	// resolves to, the canonical conjuncts it is compared by, and every shape it
	// is refused for. Assignability between two of them is pinned in
	// `typeMatching.spec.ts`; this is about the Declaration.
	describe("Checked refinements", () => {
		function refinementOf(source: string): common.RefinementType {
			let { program, diagnostics } = enrichSource(source)

			expect(diagnostics).toEqual([])

			let aliases = program.implementation.nodes.filter(
				(node) => node.nodeType === "TypeAliasStatement",
			)
			let type = aliases[aliases.length - 1].type

			expect(type.type).toBe("Refinement")

			if (type.type !== "Refinement") {
				throw new Error("The last Type Alias is not a refinement.")
			}

			return type
		}

		function aliasOf(source: string): common.typed.TypeAliasStatementNode {
			let { program } = enrichSource(source)
			let aliases = program.implementation.nodes.filter(
				(node) => node.nodeType === "TypeAliasStatement",
			)

			return aliases[aliases.length - 1]
		}

		// NOTE: A GENERIC refined Alias resolves to a Generic Alias wrapping the
		// refinement — the wrapper is what applies the Type Arguments, the
		// refinement is what carries the evidence — so its refinement is one
		// level in.
		function genericRefinementOf(source: string): common.RefinementType {
			let { program, diagnostics } = enrichSource(source)

			expect(diagnostics).toEqual([])

			let aliases = program.implementation.nodes.filter(
				(node) => node.nodeType === "TypeAliasStatement",
			)
			let type = aliases[aliases.length - 1].type

			expect(type.type).toBe("GenericAlias")

			if (
				type.type !== "GenericAlias" ||
				type.aliasedType.type !== "Refinement"
			) {
				throw new Error(
					"The last Type Alias is not a generic refinement.",
				)
			}

			return type.aliasedType
		}

		it("should resolve a predicate to a refinement of its base", () => {
			let refinement = refinementOf(
				"implementation { type NonZero = Integer where @::isNot(0) }",
			)

			expect(refinement.name).toBe("NonZero")
			expect(refinement.base).toEqual({ type: "Integer" })
			// NOTE: `Integer`, though `isNot` is a Protocol's PROVIDED Method —
			// the one body every conformer shares stands on the ladder under
			// the Namespace whose conformance put it in reach, which for an
			// Integer receiver is Integer's own.
			expect(refinement.conjuncts).toEqual([
				{
					namespaceName: "Integer",
					methodName: "is",
					negated: true,
					args: ["0"],
					spelling: { methodName: "isNot", args: ["0"] },
				},
			])
		})

		it("should refine a String and an applied List", () => {
			expect(
				refinementOf(
					"implementation { type NonEmptyText = String where @::hasCharacters() }",
				).base,
			).toEqual({ type: "String" })

			expect(
				refinementOf(
					"implementation { type NonEmptyStrings = List<String> where @::hasItems() }",
				).base,
			).toEqual({ type: "List", itemType: { type: "String" } })
		})

		// NOTE: The fourth base. `Rational` declares its own `is` and its own
		// four comparisons, and a bound written beside one of them is a written
		// Rational — so the conjunct keeps a fraction where an Integer's keeps
		// digits, and the Namespace it names is Rational's own.
		it("should refine a Rational, keeping the fraction the bound was written as", () => {
			let refinement = refinementOf(
				"implementation { type NonZeroRatio = Rational where @::isNot(0/1) }",
			)

			expect(refinement.base).toEqual({ type: "Rational" })
			expect(refinement.conjuncts).toEqual([
				{
					namespaceName: "Rational",
					methodName: "is",
					negated: true,
					args: ["0/1"],
					spelling: { methodName: "isNot", args: ["0/1"] },
				},
			])
		})

		// NOTE: A conjunct is a KEY, and `0/2` and `0/1` are one question about
		// one number — so what the key holds is the number, in the lowest terms
		// the runtime keeps it in, rather than the two runs of digits that were
		// typed. Without this the two Aliases below would be different Types
		// that admit exactly the same values.
		it("should key a written Rational bound by its value", () => {
			expect(
				refinementOf(
					"implementation { type NonZeroRatio = Rational where @::isNot(0/2) }",
				).conjuncts,
			).toEqual(
				refinementOf(
					"implementation { type NonZeroRatio = Rational where @::isNot(0/1) }",
				).conjuncts,
			)

			expect(
				refinementOf(
					"implementation { type Half = Rational where @::isGreaterThan(2/4) }",
				).conjuncts,
			).toEqual([
				{
					namespaceName: "Rational",
					methodName: "isGreaterThan",
					negated: false,
					args: ["1/2"],
					spelling: { methodName: "isGreaterThan", args: ["1/2"] },
				},
			])
		})

		// NOTE: And an Integer bound written on a Rational is the same number
		// and so the same key. The two spellings used to be two questions —
		// `Rational::isNot` answers a fraction while a bare `0` finds no
		// same-kind entry and falls to the covering `Number` — so
		// `NonZeroRational` was reachable through one of them and not the other,
		// and `@::isNot(0)`, the spelling the Compiler's own Help offers, was
		// the one that missed. The RECEIVER decides it now.
		it("should read an Integer bound on a Rational as the Rational it is", () => {
			expect(
				refinementOf(
					"implementation { type NonZeroRatio = Rational where @::isNot(0) }",
				).conjuncts,
			).toEqual([
				{
					namespaceName: "Rational",
					methodName: "is",
					negated: true,
					args: ["0/1"],
					spelling: { methodName: "isNot", args: ["0"] },
				},
			])

			// NOTE: The `spelling` is what was WRITTEN and stays apart — it is
			// the half a Diagnostic reads back — so the two are compared by
			// everything the key is taken from.
			let leavesOf = (source: string) =>
				refinementOf(source).conjuncts?.map(
					({ spelling: _spelling, ...leaf }) => leaf,
				)

			expect(
				leavesOf(
					"implementation { type Negative = Rational where @::isLessThan(0) }",
				),
			).toEqual(
				leavesOf(
					"implementation { type Negative = Rational where @::isLessThan(0/1) }",
				),
			)
		})

		// NOTE: A Program's own Namespace over a Rational is left exactly as
		// written. What `Frac::isHalf` asks is the Program's question, and
		// renaming it to Rational's own would say the standard library answers
		// something it never declared.
		it("should leave a Program's own Namespace over a Rational alone", () => {
			expect(
				refinementOf(
					`implementation {
						namespace Frac for Rational {
							isBig(_ bound: Integer) -> Boolean {
								<- @::numerator()::isGreaterThan(bound)
							}
						}

						type Big = Rational where @::<Frac>isBig(2)
					}`,
				).conjuncts,
			).toEqual([
				{
					namespaceName: "Frac",
					methodName: "isBig",
					negated: false,
					args: ["2"],
					spelling: { methodName: "isBig", args: ["2"] },
				},
			])
		})

		// NOTE: The conjunct set of a generic refinement is the point of the whole
		// design: `hasItems` asks nothing about the items, so the key holds no Type
		// Argument at all and `Filled<String>` differs from `Filled<Integer>`
		// by its BASE — which `matchTypes` already compares.
		//
		// NOTE: A Program's OWN Alias throughout this file, under a name the
		// standard library does not use — `NonEmptyList` is a builtin now, and
		// declaring one over again would only be a `duplicate-type`. What is under
		// test is the mechanism, which is the same one the builtin is declared by.
		it("should refine a generic applied List, keying the conjunct without the Argument", () => {
			let refinement = genericRefinementOf(
				"implementation { type Filled<Item> = List<Item> where @::hasItems() }",
			)

			expect(refinement.name).toBe("Filled")
			expect(refinement.base).toEqual({
				type: "List",
				itemType: { type: "GenericUse", name: "Item" },
			})
			expect(refinement.conjuncts).toEqual([
				{
					namespaceName: "List",
					methodName: "isEmpty",
					negated: true,
					args: [],
					spelling: { methodName: "hasItems", args: [] },
				},
			])
		})

		// NOTE: A use site applies its Arguments through the wrapper, which
		// substitutes them into the base and stamps the applied spelling. The
		// conjuncts come along BY REFERENCE — the same array the Declaration
		// resolved, because a predicate that says nothing about the items has
		// nothing to substitute.
		it("should apply a generic refinement's Arguments into its base", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				type Filled<Item> = List<Item> where @::hasItems()

				function lengthOf(_ items: Filled<String>) -> Integer {
					<- items::length()
				}
			}`)

			expect(diagnostics).toEqual([])

			let alias = program.implementation.nodes[0]
			let declared = program.implementation.nodes[1]

			if (
				alias.nodeType !== "TypeAliasStatement" ||
				alias.type.type !== "GenericAlias" ||
				alias.type.aliasedType.type !== "Refinement" ||
				declared.nodeType !== "FunctionStatement" ||
				declared.type.type !== "Function"
			) {
				throw new Error("The Program is not the shape under test.")
			}

			let applied = declared.type.parameterTypes[0].type

			expect(applied.type).toBe("Refinement")

			if (applied.type !== "Refinement") {
				throw new Error("The Parameter is not a refinement.")
			}

			expect(applied.base).toEqual({
				type: "List",
				itemType: { type: "String" },
			})
			expect(applied.typeArguments).toEqual([{ type: "String" }])
			expect(applied.conjuncts).toBe(alias.type.aliasedType.conjuncts)
			expect(printType(applied)).toBe("Filled<String>")
		})

		// NOTE: `isBetween` is written once, as `Orderable`'s provided Method,
		// and it stands on the ladder under the Namespace whose conformance put
		// it in reach — `Integer` for an Integer receiver, which is also what
		// answers `isOdd` beside it. The conjunct records what answered, because
		// that is what makes two conjuncts the same question.
		//
		// The LABEL is on the spelling and nowhere else. It decides nothing
		// about the key, and the text a Diagnostic prints has to carry it: a
		// `match` guard is written the way that text reads.
		it("should key a conjunct by the Namespace that answered it", () => {
			expect(
				refinementOf(
					"implementation { type Digit = Integer where @::isBetween(0, and 9) }",
				).conjuncts,
			).toEqual([
				{
					namespaceName: "Integer",
					methodName: "isBetween",
					negated: false,
					args: ["0", "9"],
					spelling: {
						methodName: "isBetween",
						args: ["0", { label: "and", value: "9" }],
					},
				},
			])
		})

		it("should flatten a conjunction into a canonical conjunct set", () => {
			let straight = refinementOf(
				"implementation { type SmallOdd = Integer where @::isOdd()::and(@::isLessThan(10)) }",
			)
			let mirrored = refinementOf(
				"implementation { type SmallOdd = Integer where @::isLessThan(10)::and(@::isOdd()) }",
			)

			expect(straight.conjuncts).toHaveLength(2)
			expect(straight.conjuncts).toEqual(mirrored.conjuncts)
		})

		it("should carry the enriched predicate on the typed Node", () => {
			let alias = aliasOf(
				"implementation { type NonZero = Integer where @::isNot(0) }",
			)

			expect(alias.predicate?.nodeType).toBe("MethodInvocation")
			expect(alias.predicate?.type).toEqual({ type: "Boolean" })
		})

		// NOTE: A generic Alias too, which takes reading `@` off the base INSIDE
		// the wrapper: read off the wrapper it was a Type taking Arguments, and the
		// Language Server got an Error where the Compiler had a Boolean.
		it("should carry the enriched predicate of a generic Alias too", () => {
			let alias = aliasOf(
				"implementation { type Filled<Item> = List<Item> where @::hasItems() }",
			)

			expect(alias.predicate?.nodeType).toBe("MethodInvocation")
			expect(alias.predicate?.type).toEqual({ type: "Boolean" })
		})

		it("should leave an unrefined Alias without a predicate", () => {
			expect(
				aliasOf("implementation { type Small = Integer }").predicate,
			).toBeNull()
		})

		// NOTE: Poison recovery — a refused clause leaves the Alias meaning its
		// base, so everything naming it stays about itself. What is asserted here
		// is the underlined text of each refusal, which is the span an Editor
		// puts the squiggle under.
		describe("refusals", () => {
			function refusal(source: string): {
				code: string
				underlined: string
			} {
				let diagnostics = diagnosticsFor(source)

				expect(diagnostics).toHaveLength(1)

				return {
					code: diagnostics[0].code,
					underlined: underlinedText(source, diagnostics[0]),
				}
			}

			// NOTE: A generic Alias is refined like any other, and an
			// item-dependent predicate needs no rule of its own — `Item` is
			// opaque while the clause is read, so `@::contains(0)` is refused
			// for the Argument it passes. Which is what keeps the conjuncts
			// item-agnostic without anything checking that they are.
			it("should refuse an item-dependent predicate as the Argument mistake it is", () => {
				expect(
					refusal(
						"implementation { type Containing<Item> = List<Item> where @::contains(0) }",
					),
				).toEqual({
					code: "no-matching-overload",
					underlined: "@::contains(0)",
				})
			})

			it("should refuse a base outside Integer, Rational, String and an applied List", () => {
				expect(
					refusal(
						"implementation { type Yes = Boolean where @::is(true) }",
					),
				).toEqual({
					code: "invalid-refinement-predicate",
					underlined: "Boolean",
				})

				expect(
					refusal(
						"implementation { type Weird = Integer | String where @::isNot(0) }",
					),
				).toEqual({
					code: "invalid-refinement-predicate",
					underlined: "Integer | String",
				})

				expect(
					refusal(
						"implementation { type Several = List where @::hasItems() }",
					),
				).toEqual({
					code: "invalid-refinement-predicate",
					underlined: "List",
				})
			})

			it("should refuse a receiver that is not '@'", () => {
				expect(
					refusal(
						`implementation { type Named = Integer where "essence"::hasCharacters() }`,
					),
				).toEqual({
					code: "invalid-refinement-predicate",
					underlined: `"essence"`,
				})
			})

			it("should refuse a chained receiver", () => {
				expect(
					refusal(
						"implementation { type Trimmed = String where @::trim()::hasCharacters() }",
					),
				).toEqual({
					code: "invalid-refinement-predicate",
					underlined: "@::trim()",
				})
			})

			it("should refuse an Argument that is not a literal", () => {
				expect(
					refusal(
						"implementation { constant limit = 3\ntype Bounded = Integer where @::isLessThan(limit) }",
					),
				).toEqual({
					code: "invalid-refinement-predicate",
					underlined: "limit",
				})
			})

			it("should refuse a predicate that is not a Boolean", () => {
				expect(
					refusal(
						"implementation { type Sized = Integer where @::absolute() }",
					),
				).toEqual({
					code: "predicate-not-boolean",
					underlined: "@::absolute()",
				})

				expect(
					refusal("implementation { type Bare = Integer where @ }"),
				).toEqual({
					code: "predicate-not-boolean",
					underlined: "@",
				})
			})

			// NOTE: A poisoned base says nothing about the clause, so the clause
			// says nothing back — one Diagnostic about the name that is missing,
			// and no second one about a Type nobody wrote.
			it("should stay silent about a base that is already an Error", () => {
				expect(
					diagnosticsFor(
						"implementation { type Refined = Nope where @::isNot(0) }",
					).map((diagnostic) => diagnostic.code),
				).toEqual(["unknown-type"])

				expect(
					diagnosticsFor(
						"implementation { type Refined = Refined where @::isNot(0) }",
					).map((diagnostic) => diagnostic.code),
				).toEqual(["recursive-type-declaration"])
			})

			// NOTE: And a predicate that could not be typed is a Diagnostic about
			// the Method it named, never a second one about the clause holding it.
			it("should stay silent about a predicate that did not type", () => {
				expect(
					diagnosticsFor(
						"implementation { type Refined = Integer where @::nope(0) }",
					).map((diagnostic) => diagnostic.code),
				).toEqual(["unknown-method"])
			})

			it("should leave a refused Alias meaning its base", () => {
				let { program } = enrichSource(
					"implementation { type Sized = Integer where @::absolute() }",
				)

				expect(program.implementation.nodes[0].nodeType).toBe(
					"TypeAliasStatement",
				)

				let alias = program.implementation
					.nodes[0] as common.typed.TypeAliasStatementNode

				expect(alias.type).toEqual({ type: "Integer" })
			})

			// NOTE: A Matcher narrows by TYPE, and a refinement's predicate is
			// not a runtime question — the emitted check could only ask about
			// the base, and the arm would run for values the predicate refuses,
			// typed as evidence nothing proved.
			it("should refuse a refinement in Matcher position", () => {
				expect(
					refusal(`implementation {
						constant v: Integer | String = 0

						constant sorted = match v -> String {
							case NonZeroInteger { <- "nonzero" }
							case _ { <- "other" }
						}
					}`),
				).toEqual({
					code: "refinement-as-matcher",
					underlined: "NonZeroInteger",
				})
			})

			// NOTE: The refinement need not stand at the Matcher's top level —
			// `List<NonZeroInteger>` spells one inside a Type Argument, the
			// emitted check could still only ask about `List<Integer>`, and
			// the arm would bind items the predicate refuses.
			it("should refuse a refinement nested inside a Matcher's Type Argument", () => {
				expect(
					refusal(`implementation {
						constant v: List<Integer> | String = [0]

						constant sorted = match v -> String {
							case List<NonZeroInteger> { <- "nonzero" }
							case _ { <- "other" }
						}
					}`),
				).toEqual({
					code: "refinement-as-matcher",
					underlined: "List<NonZeroInteger>",
				})
			})

			// NOTE: An Alias hiding a refinement in a member is just as much a
			// Matcher that can not be tested for — and beside a wildcard there
			// is no second arm for the Validator's erased-conflict analysis to
			// notice, so the refusal has to happen here.
			it("should refuse an Alias hiding a refinement in a member", () => {
				expect(
					refusal(`implementation {
						type Weird = { n: NonZeroInteger }
						type Plain = { n: Integer, p: String }

						constant v: Weird | Plain = Plain ~> { n = 0, p = "x" }

						constant told = match v -> String {
							case Weird { <- "weird" }
							case _ { <- "other" }
						}
					}`),
				).toEqual({
					code: "refinement-as-matcher",
					underlined: "Weird",
				})
			})

			it("should refuse a refinement in a payload Pattern's annotation", () => {
				expect(
					refusal(`implementation {
						choice Box {
							Full { value: Integer | String },
							Empty,
						}

						constant box: Box = #Full({ value = 0 })

						constant label = match box -> String {
							case #Full({ value: NonZeroInteger }) { <- "nonzero" }
							case _ { <- "other" }
						}
					}`),
				).toEqual({
					code: "refinement-as-matcher",
					underlined: "NonZeroInteger",
				})
			})

			it("should refuse a refinement in a Record Pattern's annotation", () => {
				expect(
					refusal(`implementation {
						type Holder = { n: Integer | String }
						type Other = { tag: String }

						constant v: Holder | Other = { n = 0 }

						constant told = match v -> String {
							case { n: NonZeroInteger } { <- "nonzero" }
							case _ { <- "other" }
						}
					}`),
				).toEqual({
					code: "refinement-as-matcher",
					underlined: "NonZeroInteger",
				})
			})
		})

		// NOTE: A refined receiver keeps every Method its base answers — the
		// bucketing that makes it so is pinned in `resolvers.spec.ts`, and this is
		// the Declaration reaching it — and it flows into its base for free, which
		// is what makes a body written against the base compile unchanged.
		it("should answer a base's Methods on a refined value", () => {
			expect(
				diagnosticsFor(`implementation {
					type NonZero = Integer where @::isNot(0)

					function doubled(_ n: NonZero) -> Integer {
						<- n::multiply(with 2)
					}

					function forgotten(_ n: NonZero) -> Integer {
						<- n
					}
				}`),
			).toEqual([])
		})

		// NOTE: The refusal is reported ONCE. A refined Alias is resolved by
		// hoisting and its predicate is enriched a second time for the typed Node,
		// so there are two readings of one clause and only one of them may speak.
		it("should report a refusal exactly once", () => {
			expect(
				diagnosticsFor(
					"implementation { type Yes = Boolean where @::is(true) }",
				),
			).toHaveLength(1)
		})

		// NOTE: A refined Alias and the Namespace answering its predicate may
		// name each other — the Alias asks `isProper`, and a signature next to
		// `isProper` takes a `Proper` — which no single hoisting round can
		// resolve in one breath. The Alias hoists with its predicate unread and
		// the conjuncts are written into the shared object once the Namespace
		// arrives; these pin that the pair resolves, in either order, and that
		// what the signatures bound really is the refinement rather than a
		// poisoned base.
		describe("self-answering Namespaces", () => {
			function selfAnswering(body: string, aliasFirst: boolean): string {
				let alias = "type Proper = String where @::isProper()"
				let namespace = `namespace Naming for String {
					isProper() -> Boolean {
						<- @::hasCharacters()
					}

					greet(_ name: Proper) -> String {
						<- "Hello, "::append(name)
					}
				}`

				return `implementation {
					${aliasFirst ? alias : namespace}

					${aliasFirst ? namespace : alias}

					${body}
				}`
			}

			it("should let a Namespace answer the predicate its own signatures name", () => {
				expect(
					diagnosticsFor(
						selfAnswering(
							`constant raw = "Ada"

							if raw::isProper() {
								constant greeting = raw::greet(raw)
							}`,
							true,
						),
					),
				).toEqual([])
			})

			it("should resolve the pair written in either order", () => {
				expect(diagnosticsFor(selfAnswering("", false))).toEqual([])
			})

			// NOTE: The proof that the signature holds the REFINEMENT — a
			// clause that failed would poison the Alias to String, and this
			// call would then pass without a word.
			it("should still demand the evidence the signature names", () => {
				let diagnostics = diagnosticsFor(
					selfAnswering(
						`constant raw = "Ada"

						constant greeting = raw::greet(raw)`,
						true,
					),
				)

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["no-matching-overload"])
			})

			// NOTE: The same pair one turn harder. A GENERIC refined Alias can not
			// be bound by reference the way `Proper` is — applying Type Arguments
			// substitutes them into the base, which COPIES the refinement — so the
			// answering Namespace hoists holding copies whose predicate is still
			// unread, and the fill finishes them along with the Alias.
			//
			// The predicate asks `isFilled` rather than `hasItems` because the
			// builtin `namespace List` answers `hasItems`, which would take the
			// clause off the Program's hands and leave nothing circular to test.
			function genericallySelfAnswering(entries: string): string {
				return `implementation {
					type Filled<Item> = List<Item> where @::isFilled()

					namespace Listing<infer Item> for List<Item> {
						${entries}
					}
				}`
			}

			// NOTE: The Types the two applications in the Namespace resolved to,
			// beside the refinement the Alias itself declares — read off the typed
			// Nodes rather than through a Scope, because what a signature ENDED UP
			// holding is the whole question.
			function appliedInAnsweringNamespace(source: string): {
				declared: common.Type
				concrete: common.Type
				generic: common.Type
				diagnostics: Array<common.Diagnostic>
			} {
				let { program, diagnostics } = enrichSource(source)
				let [alias, namespace] = program.implementation.nodes

				if (
					alias?.nodeType !== "TypeAliasStatement" ||
					alias.type.type !== "GenericAlias" ||
					namespace?.nodeType !== "NamespaceDefinitionStatement"
				) {
					throw new Error("The Program is not the shape under test.")
				}

				let concrete = namespace.type.methods["firstOf"]
				let generic = namespace.type.methods["sizeOf"]

				if (
					concrete?.type !== "SimpleMethod" ||
					generic?.type !== "SimpleMethod"
				) {
					throw new Error(
						"The Namespace is not the shape under test.",
					)
				}

				return {
					declared: alias.type.aliasedType,
					concrete: concrete.parameterTypes[1]!.type,
					generic: generic.parameterTypes[1]!.type,
					diagnostics,
				}
			}

			const APPLYING_ENTRIES = `firstOf(_ numbers: Filled<Integer>) -> Integer {
					<- 0
				}

				sizeOf(_ items: Filled<Item>) -> Integer {
					<- items::length()
				}`

			it("should let the answering Namespace apply the Alias it answers for", () => {
				let { declared, concrete, generic, diagnostics } =
					appliedInAnsweringNamespace(
						genericallySelfAnswering(`isFilled() -> Boolean {
							<- @::hasItems()
						}

						${APPLYING_ENTRIES}`),
					)

				expect(diagnostics).toEqual([])

				if (
					declared.type !== "Refinement" ||
					concrete.type !== "Refinement" ||
					generic.type !== "Refinement"
				) {
					throw new Error("The signatures did not hold refinements.")
				}

				expect(declared.conjuncts).toEqual([
					{
						namespaceName: "List",
						methodName: "isEmpty",
						negated: true,
						args: [],
						spelling: { methodName: "isFilled", args: [] },
					},
				])

				// NOTE: The mechanism in two lines — each copy holds the very ARRAY
				// the fill wrote into the Alias, which no copy taken a round too
				// early and forgotten about could be holding.
				expect(concrete.conjuncts).toBe(declared.conjuncts)
				expect(generic.conjuncts).toBe(declared.conjuncts)

				expect(concrete.base).toEqual({
					type: "List",
					itemType: { type: "Integer" },
				})
				expect(generic.base).toEqual({
					type: "List",
					itemType: { type: "GenericUse", name: "Item" },
				})
			})

			// NOTE: The other end of the same road. A predicate nothing answers is
			// poisoned to its base in place, and so is every copy taken of it while
			// it was pending — each to ITS OWN base, so a signature that applied
			// `Filled<Integer>` goes on saying `List<Integer>` rather than borrowing
			// the Alias' `List<Item>`. One Diagnostic names the clause; the copies
			// have nothing of their own to report.
			it("should poison every copy of a predicate nothing answers", () => {
				let { declared, concrete, generic, diagnostics } =
					appliedInAnsweringNamespace(
						genericallySelfAnswering(APPLYING_ENTRIES),
					)

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["unknown-method"])

				expect(declared).toEqual({
					type: "List",
					itemType: { type: "GenericUse", name: "Item" },
				})
				expect(concrete).toEqual({
					type: "List",
					itemType: { type: "Integer" },
				})
				expect(generic).toEqual({
					type: "List",
					itemType: { type: "GenericUse", name: "Item" },
				})
			})
		})
	})

	// NOTE: The Types every use of a name is enriched to, in the order a walk
	// over the Program finds them — which is how a test asks what a branch
	// narrowed a binding to without reaching through the Statements around it
	// by hand. Reflective on purpose: what the narrowed use happens to sit
	// inside is not what any assertion below is about.
	//
	// Declared at this level rather than inside one describe, because a `define`
	// arm narrows through the very same machinery and a test of one asks exactly
	// this question of it: what Type did this name have where it was read.
	function readTypesOf(source: string, name: string): Array<string> {
		let { program, diagnostics } = enrichSource(source)

		expect(diagnostics).toEqual([])

		let types: Array<string> = []
		let seen = new Set<object>()

		let walk = (value: unknown): void => {
			if (
				value === null ||
				typeof value !== "object" ||
				seen.has(value)
			) {
				return
			}

			seen.add(value)

			if (Array.isArray(value)) {
				for (let item of value) {
					walk(item)
				}

				return
			}

			let record = value as Record<string, unknown>

			if (record.nodeType === "Identifier" && record.content === name) {
				types.push(printType(record.type as common.Type))
			}

			for (let child of Object.values(record)) {
				walk(child)
			}
		}

		walk(program)

		return types
	}

	// NOTE: Every source that asks this puts the use it is about LAST, so that
	// is the narrowed one.
	function narrowedTypeOf(source: string, name: string): string {
		let types = readTypesOf(source, name)

		if (types.length === 0) {
			throw new Error(`Nothing named '${name}' is read anywhere.`)
		}

		return types[types.length - 1]
	}

	// NOTE: What makes a doorway writable — an `if` whose condition asks a
	// declared refinement's question narrows the binding it asked it of. Nothing
	// here reaches the typed tree: a narrowing is a shadow declaration in an
	// Enricher Scope, and what it is worth is the resolution it changes.
	describe("Refinement flow narrowing", () => {
		it("should narrow a Constant the condition proved the predicate of", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						constant d = 3

						if d::isNot(0) {
							Terminal.inspect(d)
						}
					}`,
					"d",
				),
			).toBe("NonZeroInteger")
		})

		// NOTE: A Rational narrows on the same rail, with the bound written as
		// the fraction `Rational::isNot` takes.
		it("should narrow a Rational the condition proved the predicate of", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						constant r = 1/2::add(1/3)

						if r::isNot(0/1) {
							Terminal.inspect(r)
						}
					}`,
					"r",
				),
			).toBe("NonZeroRational")
		})

		// NOTE: And with the bound written as a bare Integer, which is the same
		// number and so the same question. It used to be a different one: a
		// bare `0` finds no same-kind entry and falls to the covering `Number`'s
		// rung, so this branch narrowed to nothing at all while the fraction
		// beside it reached `NonZeroRational`.
		it("should narrow a Rational proved by an Integer bound", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						constant r = 1/2::add(1/3)

						if r::isNot(0) {
							Terminal.inspect(r)
						}
					}`,
					"r",
				),
			).toBe("NonZeroRational")
		})

		// NOTE: And the ELSE of the question turned round, which is the leaf
		// read in the other polarity: `@::is(0/1)` failing IS `@::isNot(0/1)`
		// holding, so the branch that did not find a zero holds a
		// `NonZeroRational`. Nothing declares the contrary Type, so the `if`
		// side stays the Rational it was — a complement narrows to a refinement
		// somebody wrote down or to nothing at all.
		it("should narrow a Rational in the else of the opposite question", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						constant r = 1/2::add(1/3)

						if r::is(0/1) {
							Terminal.inspect(0)
						} else {
							Terminal.inspect(r)
						}
					}`,
					"r",
				),
			).toBe("NonZeroRational")
		})

		// NOTE: A Rational bound is read by the same ordering law an Integer
		// bound is: a value proven above zero has been proven not to BE zero, so
		// a condition nobody wrote an Alias for still reaches the Alias its
		// answer proves. The `reciprocal` inside is what the narrowing is worth
		// — the entry answering a bare Rational is the one a proven receiver
		// reaches, and the annotation refuses the Optional the base answers.
		it("should reach a Rational refinement an ordering proves", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						constant r = 1/2::add(1/3)

						if r::isGreaterThan(0/1) {
							constant flipped: Rational = r::reciprocal()

							Terminal.inspect(flipped)
							Terminal.inspect(r)
						}
					}`,
					"r",
				),
			).toBe("NonZeroRational")
		})

		// NOTE: The narrowing is worth exactly what it lets a Program write, which
		// is the call a bare Integer is refused by — asserted end to end in
		// `codeGeneration.spec.ts`, where the Validator that refuses it runs.
		it("should let a narrowed Constant reach a refined Parameter", () => {
			expect(
				diagnosticsFor(`implementation {
					function doubled(_ n: NonZeroInteger) -> Integer {
						<- n::multiply(with 2)
					}

					constant d = 3

					if d::isNot(0) {
						Terminal.inspect(doubled(d))
					}
				}`),
			).toEqual([])
		})

		// NOTE: A Variable proven something about can be written to inside the very
		// branch the narrowing would hold over, so the evidence would be about a
		// value that is gone.
		it("should not narrow a Variable", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						variable d = 3

						if d::isNot(0) {
							Terminal.inspect(d)
						}
					}`,
					"d",
				),
			).toBe("Integer")
		})

		// NOTE: One question spelled two ways is one question. `PositiveInteger`
		// is declared `@::isPositive()`, whose body is `@::isGreaterThan(0)`, so
		// the condition below asks the very leaf the Alias is declared by and
		// the branch has proven it. Which spelling was written decides nothing.
		it("should narrow on a differently spelled predicate", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						constant d = 3

						if d::isGreaterThan(0) {
							Terminal.inspect(d)
						}
					}`,
					"d",
				),
			).toBe("PositiveInteger")
		})

		// NOTE: And the one proving the MOST wins, counted through what a leaf
		// implies. `@::isNot(0)` proves one question and reaches the one Alias
		// declared by it; `PositiveInteger` would have to be proven above zero.
		it("should narrow on the leaf the refinement is declared by", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						constant d = 3

						if d::isNot(0) {
							Terminal.inspect(d)
						}
					}`,
					"d",
				),
			).toBe("NonZeroInteger")
		})

		it("should not narrow a Constant the condition says nothing about", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						constant d = 3
						constant e = 4

						if e::isNot(0) {
							Terminal.inspect(d)
						}
					}`,
					"d",
				),
			).toBe("Integer")
		})

		// NOTE: Set INCLUSION — a condition proving two things establishes a
		// refinement asking for one of them.
		it("should establish a refinement a conjunction includes", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						constant d = 3

						if d::isNot(0)::and(d::isLessThan(10)) {
							Terminal.inspect(d)
						}
					}`,
					"d",
				),
			).toBe("NonZeroInteger")
		})

		// NOTE: And where several qualify, the one proving the MOST wins — it is
		// the one that forgets the least.
		it("should prefer the refinement proving the most", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						type SmallNonZero = Integer where @::isNot(0)::and(@::isLessThan(10))

						constant d = 3

						if d::isNot(0)::and(d::isLessThan(10)) {
							Terminal.inspect(d)
						}
					}`,
					"d",
				),
			).toBe("SmallNonZero")
		})

		// NOTE: And where several prove exactly as much as each other, the first
		// candidate the walk reaches stands — nearest Scope first, and inside the
		// one top-level table the builtins are declared ahead of a Program's own
		// Aliases. Which of them wins is a spelling and nothing more (two
		// refinements proving the same conjuncts over the same base are one Type to
		// everything that reads conjuncts), but it is settled rather than
		// incidental, and a Hover answering `Nonzero` here would be a change of
		// behaviour nobody meant to make.
		it("should establish the builtin where a Program's Alias proves the same", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						type Nonzero = Integer where @::isNot(0)

						constant d = 3

						if d::isNot(0) {
							Terminal.inspect(d)
						}
					}`,
					"d",
				),
			).toBe("NonZeroInteger")
		})

		// NOTE: A conjunction proves things about each binding it names, and each
		// of them narrows on its own.
		it("should narrow both bindings a conjunction names", () => {
			let source = `implementation {
				constant d = 3
				constant s = "essence"

				if d::isNot(0)::and(s::hasCharacters()) {
					Terminal.inspect(s)
					Terminal.inspect(d)
				}
			}`

			expect(narrowedTypeOf(source, "d")).toBe("NonZeroInteger")
			expect(narrowedTypeOf(source, "s")).toBe("NonEmptyString")
		})

		// NOTE: An `else` proves the leaf its condition proved, asked the other
		// way round. A leaf is stored RESOLVED and carries its polarity as a
		// flag, so the opposite of one is that flag flipped and no pair of
		// Methods has to be declared anywhere to be each other's contraries.
		describe("the else branch", () => {
			it("should narrow through isNot where the condition asked is", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							constant d = 3

							if d::is(0) {
								Terminal.inspect(0)
							} else {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("NonZeroInteger")
			})

			it("should narrow through is where the condition asked isNot", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							type Zero = Integer where @::is(0)

							constant d = 3

							if d::isNot(0) {
								Terminal.inspect(0)
							} else {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("Zero")
			})

			it("should narrow a String through hasCharacters", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							constant s = "essence"

							if s::isEmpty() {
								Terminal.inspect(0)
							} else {
								Terminal.inspect(s)
							}
						}`,
						"s",
					),
				).toBe("NonEmptyString")
			})

			it("should narrow a List through hasItems", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							type NonEmptyStrings = List<String> where @::hasItems()

							constant items = ["a", "b"]

							if items::isEmpty() {
								Terminal.inspect(0)
							} else {
								Terminal.inspect(items)
							}
						}`,
						"items",
					),
				).toBe("NonEmptyStrings")
			})

			// NOTE: A conjunction answering `false` says that ONE of its questions
			// failed and nothing about which.
			it("should not narrow through a conjunction", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							constant d = 3

							if d::is(0)::and(d::isLessThan(10)) {
								Terminal.inspect(0)
							} else {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("Integer")
			})

			// NOTE: Including one whose OTHER half proves nothing readable. The true
			// branch may read a conjunction leaf by leaf and ignore the rest, because
			// each leaf it reads really is proven; the false branch may not, and a
			// count of the conjuncts that came back could not tell the two apart.
			it("should not narrow through a conjunction it read half of", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							constant d = 3
							constant flag = true

							if d::is(0)::and(flag) {
								Terminal.inspect(0)
							} else {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("Integer")
			})

			// NOTE: No Method is declared to be another's opposite any more.
			// `isGreaterThanOrEqualTo` IS `isLessThan` negated — the standard
			// library writes it that way — so the leaf the condition proves and
			// the leaf its `else` proves are one leaf in two polarities, and the
			// `else` proves exactly what `Small` is declared by.
			it("should narrow through a Method written as another's negation", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							type Small = Integer where @::isLessThan(10)

							constant d = 3

							if d::isGreaterThanOrEqualTo(10) {
								Terminal.inspect(0)
							} else {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("Small")
			})

			// NOTE: An `else if` needs nothing of its own — the nested If lives in
			// the `falseBody` Array and is enriched in the Scope the complement was
			// declared in, so every branch below it inherits the narrowing.
			it("should carry the narrowing into an else-if chain", () => {
				let source = `implementation {
					constant d = 3

					if d::is(0) {
						Terminal.inspect(0)
					} else if d::isLessThan(0) {
						Terminal.inspect(d)
					} else {
						Terminal.inspect(d)
					}
				}`

				// NOTE: The nested condition's own receiver, then both of its
				// branches — the outer condition's receiver is the Integer before
				// any of it, and is not among these three.
				//
				// NOTE: The last of the three is the one both `else`s reached,
				// and between them they have proven the value is neither zero
				// nor below it — which is what `PositiveInteger` says, and more
				// than the `NonZeroInteger` one `else` alone proves.
				expect(readTypesOf(source, "d").slice(-3)).toEqual([
					"NonZeroInteger",
					"NonZeroInteger",
					"PositiveInteger",
				])
			})

			// NOTE: `isZero` is written `<- @::is(0)`, so its `else` proves the
			// leaf `NonZeroInteger` is declared by. No Method names any other as
			// its opposite anywhere; the body is what says it.
			it("should narrow through a Method written as one call on '@'", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							constant d = 3

							if d::isZero() {
								Terminal.inspect(0)
							} else {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("NonZeroInteger")
			})

			// NOTE: And `isNegative` is `<- @::isLessThan(0)`, whose contrary is
			// the leaf `NonNegativeInteger` is declared by — written there as
			// `@::isGreaterThanOrEqualTo(0)`, which is that same leaf negated.
			// Three spellings, one question.
			it("should narrow an else to a Type spelled three names away", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							constant d = 3

							if d::isNegative() {
								Terminal.inspect(0)
							} else {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("NonNegativeInteger")
			})
		})

		// NOTE: A Program's own Method of the shape is read exactly as the
		// standard library's is — one call on `@`, Arguments written out — and
		// what it forwards to is the leaf both branches are decided by.
		describe("a Program's own predicate alias", () => {
			// NOTE: The bound is 5 rather than 0, which the standard library
			// declares `PositiveInteger` by — two refinements proving one leaf
			// are one Type, and the tie above would hand the branch the builtin
			// name.
			const STOCK = `namespace Stock for Integer {
					isInStock() -> Boolean {
						<- @::isGreaterThan(5)
					}

					isOutOfStock() -> Boolean {
						<- @::isGreaterThan(5)::negate()
					}
				}

				type Stocked = Integer where @::isInStock()

				type Unstocked = Integer where @::isOutOfStock()`

			it("should narrow the true branch of the alias", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							${STOCK}

							constant d = 3

							if d::isInStock() {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("Stocked")
			})

			// NOTE: The condition asks the leaf the alias forwards to, and the
			// branch reaches the refinement written on the alias. Which of the
			// two names was written decides nothing.
			it("should narrow through the leaf the alias forwards to", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							${STOCK}

							constant d = 3

							if d::isGreaterThan(5) {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("Stocked")
			})

			it("should narrow the else branch of the alias", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							${STOCK}

							constant d = 3

							if d::isInStock() {
								Terminal.inspect(0)
							} else {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("Unstocked")
			})

			// NOTE: `negate` is a name until the Enricher says whose it is, and
			// a Program may write one of its own over a Boolean. Only
			// `Boolean::negate` is the answer the polarity flag stands for, so
			// the peel is taken after the call resolves — `Same::negate` here
			// answers the value it was handed, and reading it as a negation
			// would prove `d` the opposite of what the branch tested.
			it("should read no alias off a negate that is not Boolean's", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							namespace Same for Boolean {
								negate() -> Boolean {
									<- @
								}
							}

							namespace Stock for Integer {
								isBig(_ n: Integer) -> Boolean {
									<- @::isGreaterThan(n)::<Same>negate()
								}
							}

							type NotBig = Integer where @::isLessThanOrEqualTo(9)

							constant d = 12

							if d::isBig(9) {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("Integer")
			})
		})

		// NOTE: A Method that TAKES Arguments is read the same way, with the
		// Arguments the body forwarded standing in for whatever a caller writes
		// — `isLessThanOrEqualTo(_ other)` is `@::isGreaterThan(other)` negated,
		// so a call passing 9 asks the leaf `@::isGreaterThan(9)`.
		describe("an alias that forwards its Arguments", () => {
			it("should narrow the else of a bound the standard library forwards", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							type Big = Integer where @::isGreaterThan(9)

							constant d = 12

							if d::isLessThanOrEqualTo(9) {
								Terminal.inspect(0)
							} else {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("Big")
			})

			// NOTE: The standard library's own `doesNot` Methods are of this
			// shape, and String and List are two of the four bases a `where`
			// clause may be written on. So the `else` of `contains` proves a
			// refinement written on the contrary, over the very bound the
			// condition asked about.
			it("should narrow the else of a String the standard library forwards", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							type Clean = String where @::doesNotContain("x")

							constant s = "abc"

							if s::contains("x") {
								Terminal.inspect(0)
							} else {
								Terminal.inspect(s)
							}
						}`,
						"s",
					),
				).toBe("Clean")
			})

			it("should narrow the else of a List the standard library forwards", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							type Clean = List<String> where @::doesNotContain("x")

							constant l = ["a", "b"]

							if l::contains("x") {
								Terminal.inspect(0)
							} else {
								Terminal.inspect(l)
							}
						}`,
						"l",
					),
				).toBe("Clean")
			})

			// NOTE: The bound is the CALL's, not the body's — two calls of one
			// alias with different Arguments are two questions.
			it("should not narrow where the bounds differ", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							type Big = Integer where @::isGreaterThan(9)

							constant d = 12

							if d::isLessThanOrEqualTo(4) {
								Terminal.inspect(0)
							} else {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("Integer")
			})

			// NOTE: A Program's own reads exactly alike. `Healthy` and
			// `Integer where @::isGreaterThanOrEqualTo(5)` are one Type, so the
			// `else` of the sibling question reaches it.
			const STOCK = `namespace Stock for Integer {
					isAtLeast(_ n: Integer) -> Boolean {
						<- @::isLessThan(n)::negate()
					}

					isLow() -> Boolean {
						<- @::isLessThan(5)
					}
				}

				type Healthy = Integer where @::isAtLeast(5)`

			it("should narrow the else of a Program's own forwarded alias", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							${STOCK}

							constant units = 12

							if units::isLow() {
								Terminal.inspect(0)
							} else {
								Terminal.inspect(units)
							}
						}`,
						"units",
					),
				).toBe("Healthy")
			})

			it("should make the alias and the leaf one Type in both directions", () => {
				expect(
					diagnosticsFor(`implementation {
						${STOCK}

						type Spelled = Integer where @::isGreaterThanOrEqualTo(5)

						function needsHealthy(_ n: Healthy) -> Integer {
							<- n
						}

						function needsSpelled(_ n: Spelled) -> Integer {
							<- n
						}

						constant healthy: Healthy = 5
						constant spelled: Spelled = 7

						Terminal.inspect(needsSpelled(healthy))
						Terminal.inspect(needsHealthy(spelled))
					}`),
				).toEqual([])
			})

			// NOTE: A body writing the ordering BACKWARDS is read as its
			// converse — `@ ≤ other` is what `other ≥ @` says, which is how
			// `Integer::isLessThanOrEqualTo` answers a Rational bound. Read as
			// written it would be a question of its own, and the `else` below
			// would reach nothing.
			it("should narrow the else of a flipped call", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							type Big = Integer where @::isGreaterThan(1/2)

							constant d = 12

							if d::isLessThanOrEqualTo(1/2) {
								Terminal.inspect(0)
							} else {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("Big")
			})

			// NOTE: A slot is a POSITION, and a Parameter a caller may leave
			// out makes the two sides count positions differently: `n` is
			// declared second and written first, so the leaf would take its
			// bound from `slack` and the branch would prove a bound nobody
			// asked. Refused outright rather than read, so the question stays
			// the Method's own.
			it("should read no alias off a Method with a defaulted Parameter", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							namespace Stock for Integer {
								isOver(_ pad: Integer = 0, than n: Integer, orSo slack: Integer) -> Boolean {
									<- @::isGreaterThan(n)
								}
							}

							type Huge = Integer where @::isGreaterThan(100)

							constant d = 12

							if d::isOver(than 9, orSo 100) {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("Integer")
			})
		})

		// NOTE: An alias naming an alias is the leaf both of them mean, and
		// WHICH of the two was written first decides nothing — the readings are
		// taken together and collapsed against each other.
		describe("a chain of aliases", () => {
			it("should resolve a target written below", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							namespace Downward for Integer {
								big(_ n: Integer) -> Boolean {
									<- @::huge(n)
								}

								huge(_ n: Integer) -> Boolean {
									<- @::isGreaterThan(n)
								}
							}

							type Over = Integer where @::isGreaterThan(9)

							constant d = 12

							if d::<Downward>big(9) {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("Over")
			})

			it("should resolve a target written above", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							namespace Upward for Integer {
								vast(_ n: Integer) -> Boolean {
									<- @::isGreaterThan(n)
								}

								wide(_ n: Integer) -> Boolean {
									<- @::vast(n)
								}
							}

							type Over = Integer where @::isGreaterThan(9)

							constant d = 12

							if d::<Upward>wide(9) {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("Over")
			})

			// NOTE: Three Namespaces, one chain, and every order of writing
			// them down. A Namespace hoisting before what it names records the
			// NAME, and one that hoists after records what the name had said by
			// then, so a reading is finished where the leaf is read rather than
			// where the body was. The middle Namespace is written first here,
			// which is the order that leaves it recording a name.
			const ASKS = {
				A: `namespace Asker for Integer {
						asks(_ n: Integer) -> Boolean {
							<- @::isGreaterThan(n)
						}
					}`,
				B: `namespace Relay for Integer {
						relays(_ n: Integer) -> Boolean {
							<- @::asks(n)
						}
					}`,
				C: `namespace Chain for Integer {
						chains(_ n: Integer) -> Boolean {
							<- @::relays(n)
						}
					}`,
			}

			function chainedTypeOf(order: Array<"A" | "B" | "C">): string {
				return narrowedTypeOf(
					`implementation {
						${order.map((name) => ASKS[name]).join("\n\n")}

						type Over = Integer where @::isGreaterThan(9)

						constant d = 12

						if d::chains(9) {
							Terminal.inspect(d)
						}
					}`,
					"d",
				)
			}

			// NOTE: A refinement is read at the top of a round, and the reading
			// of what it names may be a round or two behind — `Relay` waits on
			// a Type written below it. The conjuncts are written ONCE, so a
			// leaf put down before the reading landed would stay the name it
			// was while the `if` beside it went on to the leaf. Held back to a
			// later round instead.
			it("should hold a refinement back until its leaf is read", () => {
				const LATE = `namespace Chain for Integer {
						chains(_ n: Integer) -> Boolean {
							<- @::relays(n)
						}
					}

					type Over = Integer where @::chains(9)

					namespace Relay for Integer {
						relays(_ n: Integer) -> Boolean {
							<- @::isGreaterThan(n)
						}

						tag() -> Tag {
							<- "x"
						}
					}

					type Tag = String`

				expect(
					narrowedTypeOf(
						`implementation {
							${LATE}

							constant d = 12

							if d::isGreaterThan(9) {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("Over")
			})

			it("should resolve a chain across Namespaces in every order", () => {
				expect([
					chainedTypeOf(["A", "B", "C"]),
					chainedTypeOf(["A", "C", "B"]),
					chainedTypeOf(["B", "A", "C"]),
					chainedTypeOf(["B", "C", "A"]),
					chainedTypeOf(["C", "A", "B"]),
					chainedTypeOf(["C", "B", "A"]),
				]).toEqual(["Over", "Over", "Over", "Over", "Over", "Over"])
			})

			// NOTE: A chain is no alias at all, however short. `@::absolute()`
			// is an intermediate value whose evidence is nobody's to read here,
			// so the `if` proves nothing about `d` and the refinement written
			// on the comparison is out of reach. This is the rule that keeps
			// the standard library's `isEmpty` a question of its own.
			it("should leave a chained body a question of its own", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							namespace Rank for Integer {
								isBigger(than n: Integer) -> Boolean {
									<- @::absolute()::isGreaterThan(n)
								}
							}

							type Above = Integer where @::isGreaterThan(3)

							constant d = 12

							if d::isBigger(than 3) {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("Integer")
			})

			// NOTE: Two Methods written as each other's contrary say nothing
			// about anything: believing either would make the other its own
			// contrary. Both are left asking their own question, so the `else`
			// of one proves nothing about the other.
			it("should leave a ring of aliases primitive", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							namespace Ring for Integer {
								yin(_ n: Integer) -> Boolean {
									<- @::yang(n)::negate()
								}

								yang(_ n: Integer) -> Boolean {
									<- @::yin(n)::negate()
								}
							}

							type Yinned = Integer where @::yin(0)

							constant d = 12

							if d::yang(0) {
								Terminal.inspect(0)
							} else {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("Integer")
			})
		})

		// NOTE: A Protocol's PROVIDED body is read as it hoists, with no
		// Namespace on the leaf — a provided Method belongs to whichever
		// conformance reaches it — and the witness fills its own in. The
		// standard library's `isNot` and the two `…OrEqualTo` are all of this
		// shape, and a Program's own Protocol is read exactly alike.
		describe("a Protocol's provided predicate", () => {
			it("should narrow through a Protocol a Program declares", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							protocol Ranked {
								isAbove(_ n: Integer) -> Boolean

								isAtMost(_ n: Integer) -> Boolean {
									<- @::isAbove(n)::negate()
								}
							}

							namespace Rank for Integer is Ranked {
								isAbove(_ n: Integer) -> Boolean {
									<- @::isGreaterThan(n)
								}
							}

							type Above = Integer where @::isGreaterThan(3)

							constant d = 12

							if d::isAtMost(3) {
								Terminal.inspect(0)
							} else {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("Above")
			})

			// NOTE: And a body of the CONFORMER's own that names a provided
			// Method reaches the requirement through two readings, neither of
			// which the other could see: the provided body names `Self::isAbove`
			// and this one names the provided body. Both are recorded by the
			// time the leaf is read, so the leaf is followed the whole way.
			it("should follow a conformer's body through a provided one", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							protocol Ranked {
								isAbove(_ n: Integer) -> Boolean

								isAtMost(_ n: Integer) -> Boolean {
									<- @::isAbove(n)::negate()
								}
							}

							namespace Rank for Integer is Ranked {
								isAbove(_ n: Integer) -> Boolean {
									<- @::isGreaterThan(n)
								}

								isWayOff(_ n: Integer) -> Boolean {
									<- @::isAtMost(n)::negate()
								}
							}

							type Above = Integer where @::isGreaterThan(3)

							constant d = 12

							if d::isWayOff(3) {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("Above")
			})

			// NOTE: A leaf naming an OVERLOADED Method stops there. Which
			// entry of an Overload a leaf means is the Arguments' business,
			// and a leaf carries scalars rather than the typed, labelled
			// Arguments an Overload is chosen by. So the requirement is as far
			// as the leaf goes: the comparison the conformer wrote is out of
			// reach, while a refinement written on the provided Method itself
			// is not.
			it("should stop at an Overload the witness answers with", () => {
				const RANKED = `protocol Ranked {
						isAbove(_ n: Integer) -> Boolean

						isAtMost(_ n: Integer) -> Boolean {
							<- @::isAbove(n)::negate()
						}
					}

					namespace Rank for Integer is Ranked {
						overload isAbove {
							(_ n: Integer) -> Boolean {
								<- @::isGreaterThan(n)
							}

							(_ n: Rational) -> Boolean {
								<- @::isGreaterThan(n)
							}
						}
					}`

				function narrowedThrough(
					refinement: string,
					proven = false,
				): string {
					return narrowedTypeOf(
						`implementation {
							${RANKED}

							type Above = Integer where ${refinement}

							constant d = 12

							if d::isAtMost(3) {
								Terminal.inspect(${proven ? "d" : "0"})
							} else {
								Terminal.inspect(${proven ? "0" : "d"})
							}
						}`,
						"d",
					)
				}

				expect(narrowedThrough("@::isGreaterThan(3)")).toBe("Integer")
				expect(narrowedThrough("@::isAtMost(3)", true)).toBe("Above")
			})

			// NOTE: And `Comparable`'s own provided bodies reach a witness the
			// same way. A String writes none of the four itself, so every one
			// of them is the Protocol's body over `String::compare` — and
			// `isLessThanOrEqualTo` is `isGreaterThan` negated through it.
			it("should narrow through a provided body the standard library writes", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							type Long = String where @::isGreaterThan("mm")

							constant w = "zebra"

							if w::isLessThanOrEqualTo("mm") {
								Terminal.inspect(0)
							} else {
								Terminal.inspect(w)
							}
						}`,
						"w",
					),
				).toBe("Long")
			})
		})

		// NOTE: The ordering's law is the BASE's promise, so it is read off the
		// base's own Namespace and off the covering `Number`, and off nothing
		// else. A Program may spell `is`, `isLessThan` or `isNot` in a Namespace
		// of its own and mean whatever its body means by them — reading below,
		// above and equal off those words would rule out comparisons nobody made.
		describe("a foreign Namespace spelling the comparisons", () => {
			// NOTE: `Tag::is` and `Tag::isLessThan` each read a CHAIN, so each
			// is a question of its own about the LENGTH, and neither excludes
			// the other: a three-letter word answers both. Read as the
			// trichotomy, the true branch would have proven the contrary of
			// `Tag::isLessThan(3)` and walked into 'NotLess', whose own
			// predicate the value answers 'false'.
			it("should not exclude a sibling comparison it never contradicts", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							namespace Tag for String {
								is(_ length: Integer) -> Boolean {
									<- @::length()::is(length)
								}

								isLessThan(_ length: Integer) -> Boolean {
									<- @::length()::isGreaterThan(0)
								}

								notLess() -> Boolean {
									<- @::<Tag>isLessThan(3)::negate()
								}
							}

							type NotLess = String where @::notLess()

							constant word = "zzz"

							if word::<Tag>is(3) {
								Terminal.inspect(word)
							}
						}`,
						"word",
					),
				).toBe("String")
			})

			// NOTE: And `isNot` is not turned into `is` negated here either. The
			// BODY decides, and both of these bodies say "above the bound" — so
			// each is `Integer::isGreaterThan(other)` and neither is the other's
			// contrary. The `else` below has proven the value is NOT above zero,
			// which no refinement in scope is declared by.
			it("should read a foreign contrary as the question its body asks", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							namespace Weird for Integer {
								is(_ other: Integer) -> Boolean {
									<- @::isGreaterThan(other)
								}

								isNot(_ other: Integer) -> Boolean {
									<- @::isGreaterThan(other)
								}
							}

							type Above = Integer where @::<Weird>isNot(0)

							constant d = 3

							if d::<Weird>is(0) {
								Terminal.inspect(0)
							} else {
								Terminal.inspect(d)
							}
						}`,
						"d",
					),
				).toBe("Integer")
			})

			// NOTE: Which is the same rule the other way round. `Weird::isNot`
			// asks whether the value is above the bound, so a refinement written
			// on it is the one written on that comparison — `PositiveInteger`,
			// which the standard library declares. Two refinements proving one
			// leaf are one Type, and a value proven either way reaches both.
			it("should make a foreign alias one Type with the leaf it asks", () => {
				expect(
					diagnosticsFor(`implementation {
						namespace Weird for Integer {
							isNot(_ other: Integer) -> Boolean {
								<- @::isGreaterThan(other)
							}
						}

						type Above = Integer where @::<Weird>isNot(0)

						function needsAbove(_ n: Above) -> Integer {
							<- n
						}

						function needsPositive(_ n: PositiveInteger) -> Integer {
							<- n
						}

						constant d = 3

						if d::isPositive() {
							Terminal.inspect(needsAbove(d))
						}

						if d::<Weird>isNot(0) {
							Terminal.inspect(needsPositive(d))
						}
					}`),
				).toEqual([])
			})
		})

		// NOTE: The shadow lives in a WRAPPER Scope of its own, so a body that
		// re-declares the very name the condition narrowed is told nothing — the
		// declaration it would collide with is one nobody wrote.
		it("should leave a body free to re-declare the narrowed name", () => {
			let source = `implementation {
				constant d = 3

				if d::isNot(0) {
					constant d = 1

					Terminal.inspect(d)
				}
			}`

			expect(diagnosticsFor(source)).toEqual([])
			expect(narrowedTypeOf(source, "d")).toBe("Integer")
		})

		// NOTE: A shadow that forgets something the binding's Type already carries
		// is no narrowing at all.
		it("should not forget evidence the binding's Type already carries", () => {
			let source = `implementation {
				type Odd = Integer where @::isOdd()

				function keeps(_ n: NonZeroInteger) -> Integer {
					if n::isOdd() {
						<- n::multiply(with 2)
					}

					<- 0
				}
			}`

			expect(readTypesOf(source, "n").slice(-1)).toEqual([
				"NonZeroInteger",
			])
		})

		// NOTE: And evidence a Type already carries counts towards what the branch
		// proves, which is what lets a condition ADD to it.
		it("should add the condition's evidence to what the Type carries", () => {
			let source = `implementation {
				type SmallNonZero = Integer where @::isNot(0)::and(@::isLessThan(10))

				function adds(_ n: NonZeroInteger) -> Integer {
					if n::isLessThan(10) {
						<- n::multiply(with 2)
					}

					<- 0
				}
			}`

			expect(readTypesOf(source, "n").slice(-1)).toEqual(["SmallNonZero"])
		})

		// NOTE: A Guard proves things about `@` exactly as a condition proves them
		// about a Constant, and it runs before any Statement of the Handler — the
		// Matcher's own check is ANDed in front of it — so what it proves holds
		// throughout the body.
		it("should narrow '@' by a Match Handler's Guard", () => {
			let value = lastConstantValue(`implementation {
				constant value: Integer | String = 3

				constant narrowed = match value -> Integer {
					case Integer where @::isNot(0) {
						<- @
					}

					case _ {
						<- 0
					}
				}
			}`)

			if (value.nodeType !== "Match") {
				throw new Error("Last Constant is not a Match.")
			}

			// NOTE: Navigated rather than searched, because a Handler holds TWO
			// `@`s — its Guard's and its body's — and only the body's is the one
			// the Guard narrowed.
			let returned = value.handlers[0].body[0]

			if (returned.nodeType !== "ReturnStatement") {
				throw new Error("The first Handler does not return.")
			}

			expect(printType(returned.expression.type)).toBe("NonZeroInteger")
		})

		it("should leave '@' alone where a Guard proves nothing declared", () => {
			// NOTE: `isGreaterThan(7)` rather than `isGreaterThan(0)`, which the
			// standard library declares `PositiveInteger` by. The bound is the
			// whole of what makes this Guard prove nothing anybody named.
			let value = lastConstantValue(`implementation {
				constant value: Integer | String = 3

				constant narrowed = match value -> Integer {
					case Integer where @::isGreaterThan(7) {
						<- @
					}

					case _ {
						<- 0
					}
				}
			}`)

			if (value.nodeType !== "Match") {
				throw new Error("Last Constant is not a Match.")
			}

			let returned = value.handlers[0].body[0]

			if (returned.nodeType !== "ReturnStatement") {
				throw new Error("The first Handler does not return.")
			}

			expect(printType(returned.expression.type)).toBe("Integer")
		})

		// NOTE: A Guard proves things about the value a Handler NAMED exactly as it
		// proves them about `@` — `case #Value(item) where item::hasCharacters()` is
		// one question about one value, and which of the two ways to spell that value
		// it was asked of is no part of what it proved.
		describe("a Match Handler's payload binding", () => {
			const SHOUT = "type Shout = String where @::hasCharacters()"

			// NOTE: What the Handler's body reads under a name — navigated rather than
			// searched, because a Handler holds the name three times over: the Guard's
			// reading of it, the Constant the binding desugars to, and the body's own
			// use, which is the only one a Guard narrowed. The body's LAST Statement
			// is the use every source below is about.
			function bodyReadingOf(source: string): string {
				let value = lastConstantValue(source)

				if (value.nodeType !== "Match") {
					throw new Error("Last Constant is not a Match.")
				}

				let body = value.handlers[0].body
				let returned = body[body.length - 1]

				if (returned.nodeType !== "ReturnStatement") {
					throw new Error("The first Handler does not return.")
				}

				return printType(returned.expression.type)
			}

			// NOTE: The standard library's own `NonEmptyString` proves the very
			// thing `Shout` does, and it is reached first, being declared first
			// in the one top-level table — so it is the Type the Guard
			// establishes. `Shout` is what the sources below ask nothing of:
			// each is about a name or a binding form the evidence does not
			// reach, and a Program-declared candidate beside the builtin is
			// what keeps them about that rather than about which Alias won.
			it("should narrow the binding its Guard proved the predicate of", () => {
				expect(
					bodyReadingOf(`implementation {
						${SHOUT}

						constant value: Optional<String> = #Value("a")

						constant narrowed = match value -> String {
							case #Value(item) where item::hasCharacters() {
								<- item
							}

							case _ {
								<- ""
							}
						}
					}`),
				).toBe("NonEmptyString")
			})

			it("should leave the binding alone where a Guard proves nothing declared", () => {
				expect(
					bodyReadingOf(`implementation {
						${SHOUT}

						constant value: Optional<String> = #Value("a")

						constant narrowed = match value -> String {
							case #Value(item) where item::is("a") {
								<- item
							}

							case _ {
								<- ""
							}
						}
					}`),
				).toBe("String")
			})

			// NOTE: Evidence is about the name it was spelled with and about no
			// other. A Guard proving the very predicate the binding would need,
			// of a different value, proves nothing about the binding.
			it("should not narrow the binding by a Guard about another name", () => {
				expect(
					bodyReadingOf(`implementation {
						${SHOUT}

						constant other = "elsewhere"
						constant value: Optional<String> = #Value("a")

						constant narrowed = match value -> String {
							case #Value(item) where other::hasCharacters() {
								<- item
							}

							case _ {
								<- ""
							}
						}
					}`),
				).toBe("String")
			})

			// NOTE: And a Variable is no narrowing receiver under a Guard either — it
			// can be written to inside the very body the evidence would hold over,
			// which is the rule a condition narrows Constants alone by.
			it("should not narrow a Variable a Guard proved the predicate of", () => {
				expect(
					bodyReadingOf(`implementation {
						${SHOUT}

						variable other = "elsewhere"
						constant value: Optional<String> = #Value("a")

						constant narrowed = match value -> String {
							case #Value(item) where other::hasCharacters() {
								<- other
							}

							case _ {
								<- ""
							}
						}
					}`),
				).toBe("String")
			})

			// NOTE: The Constant the binding desugars to is a Statement of the body,
			// so a body declaring that name AGAIN declares it twice — which the
			// narrowing must not quietly turn into a legal shadow, or the emitted
			// Program would hold two Constants of one name in one block.
			it("should still refuse a body that re-declares the narrowed binding", () => {
				expect(
					diagnosticsFor(`implementation {
						${SHOUT}

						constant value: Optional<String> = #Value("a")

						constant narrowed = match value -> String {
							case #Value(item) where item::hasCharacters() {
								constant item = "again"

								<- item
							}

							case _ {
								<- ""
							}
						}
					}`).map((diagnostic) => diagnostic.code),
				).toEqual(["duplicate-variable"])
			})
		})

		// NOTE: An Error matches everything in both directions, so a poisoned
		// binding would qualify for whichever refinement is declared first and walk
		// out of the branch better typed than it went in.
		it("should not narrow a binding whose Type is poisoned", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				type NonEmptyStrings = List<String> where @::hasItems()

				constant items = [nope]

				if items::hasItems() {
					Terminal.inspect(items)
				}
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"unknown-name",
				"uninferable-type-parameter",
			])

			let branch = program.implementation.nodes.find(
				(node) => node.nodeType === "IfStatement",
			)

			if (branch?.nodeType !== "IfStatement") {
				throw new Error("The Program has no IfStatement.")
			}

			let printed = branch.body[0]

			if (printed.nodeType !== "FunctionInvocation") {
				throw new Error("The branch does not print.")
			}

			expect(printType(printed.arguments[0].value.type)).toBe(
				"List<Error>",
			)
		})

		// NOTE: A refinement over a base the binding is not of establishes nothing,
		// however the predicate is spelled. Asked of an Integer receiver rather
		// than of a List or a String one, because the standard library's own
		// `NonEmptyList` and `NonEmptyString` are refinements over every List and
		// every String and would be established here on their own account — which
		// is the doorway working, not this rule failing. `isEven` is a predicate
		// no refinement in scope asks, so nothing but the base can answer.
		it("should not narrow across bases", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						type NonEmptyStrings = List<String> where @::hasItems()

						constant count = 4

						if count::isEven() {
							Terminal.inspect(count)
						}
					}`,
					"count",
				),
			).toBe("Integer")
		})

		// NOTE: A GENERIC refined Alias stands for nothing until something decides
		// its Type Arguments, and a branch has exactly one thing to decide them
		// FROM: the receiver the question was asked of. So the candidate is worked
		// out per binding — the declared base unified against the receiver's Type —
		// and everything below it is the rule every other refinement is established
		// by, asked of the refinement that unification built.
		describe("a generic refinement", () => {
			// NOTE: The standard library's own `NonEmptyList` is the generic refinement
			// every `hasItems` branch establishes now, so these ask nothing of a
			// Program-declared Alias — a second one proving the same thing is a
			// candidate beside it, and the builtin is reached first, being declared
			// first in the one top-level table. A Program's OWN generic refined
			// Alias is what `Filled` below is for: the value a branch establishes
			// flows into a Parameter written with it, because two refinements are
			// one Type when they prove the same thing of the same base.
			const FILLED = "type Filled<Item> = List<Item> where @::hasItems()"

			it("should narrow a List to the Alias applied to its items", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							constant items = ["a", "b"]

							if items::hasItems() {
								Terminal.inspect(items)
							}
						}`,
						"items",
					),
				).toBe("NonEmptyList<String>")
			})

			// NOTE: The Arguments are worked out from the receiver whatever they are
			// — a List of Lists decides `ItemType` as the inner List, and the
			// spelling says so.
			it("should narrow a List of Lists to the Alias applied to them", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							constant items = [["a"], ["b"]]

							if items::hasItems() {
								Terminal.inspect(items)
							}
						}`,
						"items",
					),
				).toBe("NonEmptyList<List<String>>")
			})

			// NOTE: The narrowing is worth what it lets a Program write, and what it
			// lets a Program write is a call nothing spelled the Type of: the
			// Parameter says `Filled<String>` and the branch worked that out from
			// a `List<String>`. Asserted end to end in `codeGeneration.spec.ts`,
			// where the Validator that refuses it outside the branch runs.
			it("should let a narrowed List reach a refined Parameter", () => {
				expect(
					diagnosticsFor(`implementation {
						${FILLED}

						function firstOf(_ items: Filled<String>) -> String {
							<- items::item(at 0)::value(defaultingTo "")
						}

						constant items = ["a", "b"]

						if items::hasItems() {
							Terminal.inspect(firstOf(items))
						}
					}`),
				).toEqual([])
			})

			// NOTE: `hasItems` IS `isEmpty` negated — the standard library writes
			// it that way and the body is read — so the `else` of an `isEmpty`
			// establishes the instantiated refinement for the same reason the
			// true branch of a `hasItems` does. One shared helper asks both.
			it("should narrow the else branch of isEmpty", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							constant items = ["a", "b"]

							if items::isEmpty() {
								Terminal.inspect(0)
							} else {
								Terminal.inspect(items)
							}
						}`,
						"items",
					),
				).toBe("NonEmptyList<String>")
			})

			// NOTE: And a Match Handler's Guard, through the same helper again.
			it("should narrow '@' by a Match Handler's Guard", () => {
				let value = lastConstantValue(`implementation {
					constant value: List<String> | String = ["a"]

					constant narrowed = match value -> Integer {
						case List<String> where @::hasItems() {
							<- @::length()
						}

						case _ {
							<- 0
						}
					}
				}`)

				if (value.nodeType !== "Match") {
					throw new Error("Last Constant is not a Match.")
				}

				let returned = value.handlers[0].body[0]

				if (
					returned.nodeType !== "ReturnStatement" ||
					returned.expression.nodeType !== "MethodInvocation"
				) {
					throw new Error("The first Handler does not return a call.")
				}

				expect(printType(returned.expression.base.type)).toBe(
					"NonEmptyList<String>",
				)
			})

			// NOTE: And the value a Handler NAMED, which is what the narrowing is
			// worth having for: `firstItem` on the binding answers the item itself
			// rather than an Optional, so the Guard reached the total Method through a
			// Type nobody in the Program wrote.
			it("should narrow a payload binding by a Match Handler's Guard", () => {
				let value = lastConstantValue(`implementation {
					constant value: Optional<List<String>> = #Value(["a"])

					constant narrowed = match value -> String {
						case #Value(items) where items::hasItems() {
							<- items::firstItem()
						}

						case _ {
							<- ""
						}
					}
				}`)

				if (value.nodeType !== "Match") {
					throw new Error("Last Constant is not a Match.")
				}

				let body = value.handlers[0].body
				let returned = body[body.length - 1]

				if (
					returned.nodeType !== "ReturnStatement" ||
					returned.expression.nodeType !== "MethodInvocation"
				) {
					throw new Error("The first Handler does not return a call.")
				}

				expect(printType(returned.expression.base.type)).toBe(
					"NonEmptyList<String>",
				)
				expect(printType(returned.expression.type)).toBe("String")
			})

			it("should not narrow a Variable", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							variable items = ["a", "b"]

							if items::hasItems() {
								Terminal.inspect(items)
							}
						}`,
						"items",
					),
				).toBe("List<String>")
			})

			// NOTE: A unification that leaves a Parameter undecided is no candidate:
			// `B` appears nowhere in the base, so no receiver could ever decide it,
			// and a refinement whose base nobody decided would put a Type nobody
			// wrote into the branch. The predicate is `isEmpty` so that the ONLY
			// candidate in the branch is the one under test — the builtin `NonEmptyList`
			// asks the opposite question and establishes nothing here.
			it("should not narrow where the receiver decides only some Parameters", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							type Pairish<A, B> = List<A> where @::isEmpty()

							constant items = ["a", "b"]

							if items::isEmpty() {
								Terminal.inspect(items)
							}
						}`,
						"items",
					),
				).toBe("List<String>")
			})

			// NOTE: A receiver whose items are the enclosing Function's own Type
			// Parameter decides `Item` as that Parameter, which is a decision like
			// any other — the branch inside a generic Function narrows exactly as one
			// outside it does. It reads terse because every Argument is a Parameter,
			// the way an unapplied Case header does.
			it("should narrow a List whose items are a Type Parameter", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							function probe<Item>(_ items: List<Item>) -> Integer {
								if items::hasItems() {
									Terminal.inspect(items)
								}

								<- 0
							}
						}`,
						"items",
					),
				).toBe("NonEmptyList")
			})

			// NOTE: The instantiation is remembered per receiver, and a NAME is
			// the one thing a Program may spell twice — so the two `Even`s here
			// print alike and prove different things. Remembered by their
			// spelling, the second receiver was handed the first one's
			// `NonEmptyList<Even>`, whose items answer another question
			// altogether, and the branch then narrowed to nothing at all.
			it("should tell two shadowing refinements of one name apart", () => {
				let source = `implementation {
					type Even = Integer where @::isEven()

					function outer(_ items: List<Even>) -> Integer {
						if items::hasItems() {
							<- items::firstItem()
						}

						<- 0
					}

					function inner() -> Integer {
						type Even = Integer where @::isPositive()

						constant items: List<Even> = [2, 4]

						if items::hasItems() {
							<- items::firstItem()
						}

						<- 0
					}
				}`

				expect(diagnosticsFor(source)).toEqual([])
				expect(readTypesOf(source, "items").slice(-1)).toEqual([
					"NonEmptyList<Even>",
				])
			})
		})

		// NOTE: The one thing about a narrowing that DOES reach the typed tree
		// — the two claims a Conditional carries about what its condition
		// established, which nothing below the Enricher could work out for
		// itself: a narrowing is read off the typed condition and checked
		// refinements are erased before the Simplifier hands anything on.
		// `instrument-coverage` marks each half of the branch with the claim
		// about that half, and `--mutate` reads both before it will swap two
		// bodies.
		describe("The claims a Conditional carries", () => {
			// NOTE: Two claims and not the same one twice, in both directions.
			// `isEmpty` establishes nothing about a String where it holds and
			// proves `NonEmptyString` where it does not, while
			// `isGreaterThan(0)` proves `PositiveInteger` for the branch it
			// opens and leaves the `else` nothing. Neither implies the other,
			// which is why a reader that may not swap two bodies has to ask
			// both.
			it("should record what the condition proved for each branch", () => {
				let { program, diagnostics } = enrichSource(`implementation {
					function pieces(_ text: String, on separator: String) -> NonEmptyList<String> {
						if separator::isEmpty() {
							<- [text]
						} else {
							<- text::split(on separator)
						}
					}

					function shrunk(_ n: Integer) -> Integer {
						if n::isGreaterThan(0) {
							<- n::subtract(1)
						} else {
							<- 0
						}
					}
				}`)

				expect(diagnostics).toEqual([])

				let branches = program.implementation.nodes.flatMap((node) =>
					node.nodeType === "FunctionStatement"
						? node.value.body.filter(
								(statement) =>
									statement.nodeType === "IfElseStatement",
							)
						: [],
				)

				expect(
					branches.map(
						(branch) => `${branch.narrows} ${branch.narrowsFalse}`,
					),
				).toEqual(["false true", "true false"])
			})
		})
	})

	// NOTE: A `define` reads its arms in the Scope it stands in, and every arm
	// carries a doorway of its own: the complements of the Conditions above it,
	// which is what reaching it proves, and its own Condition on top. The same
	// machinery an `if` narrows through, so what is asked here is what a `define`
	// does with it and not whether the machinery works.
	//
	// The answer Type is the other half — the arrow, the position around the
	// `define`, or the arms, in that order.
	describe("Define Expressions", () => {
		// NOTE: A `define` standing where nothing hands a Type down, so the arms
		// are what decide it. Written out per test because what the arms answer
		// with is the point of most of them.
		function defineTypeOf(source: string): string {
			return printType(lastConstantValue(source).type)
		}

		describe("Flow narrowing", () => {
			// NOTE: `divide` is what the narrowing is worth: the entry taking a
			// NonZeroInteger answers the quotient itself, where the one taking a
			// plain Integer answers an Optional it might be empty of. So the arm
			// Types say which of the two the receiver reached.
			it("should narrow an arm from the complement of the arm above it", () => {
				let source = `implementation {
					constant d = 3

					constant quotient = define {
						as 0/1 if d::is(0)
						as 1::divide(by d) if d::isOdd()
						as 0/1 otherwise
					}
				}`

				// NOTE: Four uses, in the order a walk meets them: the
				// Declaration's own name, the first arm's Condition — which
				// stands above every complement and so narrows nothing — and
				// then the second arm's value and its Condition, both of them
				// read past the first arm's `false`.
				expect(diagnosticsFor(source)).toEqual([])
				expect(readTypesOf(source, "d")).toEqual([
					"Integer",
					"Integer",
					"NonZeroInteger",
					"NonZeroInteger",
				])
			})

			// NOTE: The value of the second arm is read in the Scope its own
			// Condition opens, which stands on the complement above it — so the
			// two doorways compose rather than replacing one another.
			it("should narrow an arm by its own Condition as well", () => {
				expect(
					defineTypeOf(`implementation {
						constant d = 3

						constant quotient = define {
							as 0/1 if d::isZero()
							as 1::divide(by d) otherwise
						}
					}`),
				).toBe("Rational")
			})

			// NOTE: The `otherwise` arm is reached by a value every Condition
			// declined, so it holds every complement — and no positive evidence,
			// having asked nothing of its own.
			it("should let the otherwise arm see every complement", () => {
				let source = `implementation {
					constant d = 3

					constant quotient = define {
						as 0/1 if d::is(0)
						as 1/1 if d::isGreaterThan(100)
						as 1::divide(by d) otherwise
					}
				}`

				expect(diagnosticsFor(source)).toEqual([])
				expect(narrowedTypeOf(source, "d")).toBe("NonZeroInteger")
			})

			// NOTE: A conjunction answering `false` says that ONE of its questions
			// failed and nothing about which, so it leaves the arms below it
			// nothing at all. Its own arm still narrows by both halves — this is a
			// limitation of the complement, not of the evidence.
			it("should leave no complement behind a conjunction", () => {
				let source = `implementation {
					constant d = 3

					constant quotient = define {
						as 0/1 if d::is(0)::and(d::isOdd())
						as 1::divide(by d) otherwise
					}
				}`

				expect(diagnosticsFor(source)).toEqual([])
				expect(narrowedTypeOf(source, "d")).toBe("Integer")
			})

			// NOTE: Recorded per arm, because each arm asks a question of its own
			// — and only the Enricher can say so, checked refinements being erased
			// before anything downstream sees a Program.
			it("should record which arms narrow", () => {
				let { program, diagnostics } = enrichSource(`implementation {
					constant d = 3

					constant quotient = define {
						as 0/1 if d::isGreaterThan(100)
						as 1/1 if d::isNot(0)
						as 0/1 otherwise
					}
				}`)

				expect(diagnostics).toEqual([])

				let value = program.implementation.nodes
					.filter(
						(node) =>
							node.nodeType === "ConstantDeclarationStatement",
					)
					.at(-1)!.value

				expect(value.nodeType).toBe("Define")

				if (value.nodeType === "Define") {
					expect(value.arms.map((arm) => arm.narrows)).toEqual([
						false,
						true,
					])
				}
			})

			// NOTE: The SECOND claim, and the reason it is a second one:
			// `isEmpty` establishes nothing about a String where it holds and
			// proves `NonEmptyString` where it does not, while `isGreaterThan(0)`
			// proves `PositiveInteger` for its own arm and leaves the arm below
			// it nothing. Neither flag implies the other in either direction,
			// which is why a reader that may not move an arm has to ask both.
			it("should record which arms narrow the arms BELOW them", () => {
				let { program, diagnostics } = enrichSource(`implementation {
					function pieces(_ text: String, on separator: String) -> List<String> {
						<- define {
							as [text] if separator::isEmpty()
							as text::split(on separator) otherwise
						}
					}

					function shrunk(_ n: Integer) -> Integer {
						<- define {
							as n::subtract(1) if n::isGreaterThan(0)
							as 0 otherwise
						}
					}
				}`)

				expect(diagnostics).toEqual([])

				let defines = program.implementation.nodes.flatMap((node) => {
					if (node.nodeType !== "FunctionStatement") {
						return []
					}

					let answer = node.value.body.at(-1)

					return answer?.nodeType === "ReturnStatement" &&
						answer.expression.nodeType === "Define"
						? [answer.expression]
						: []
				})

				expect(
					defines.map((define) =>
						define.arms.map(
							(arm) => `${arm.narrows} ${arm.narrowsBelow}`,
						),
					),
				).toEqual([["false true"], ["true false"]])
			})
		})

		// NOTE: A bare `#Empty` decides no Type of its own — a Choice's Type
		// Parameters are applied and never inferred — so a `define` whose arms
		// answer with one compiles exactly where the position around it hands a
		// Type down, and nowhere else. That is what every source here asks.
		describe("The answer Type from context", () => {
			const ARMS = `define {
					as #Empty if flag
					as #Value(1) otherwise
				}`

			it("should take it from an annotated Constant", () => {
				expect(
					diagnosticsFor(`implementation {
						constant flag = true
						constant found: Optional<Integer> = ${ARMS}
					}`),
				).toEqual([])
			})

			it("should take it from an annotated Variable", () => {
				expect(
					diagnosticsFor(`implementation {
						constant flag = true
						variable found: Optional<Integer> = ${ARMS}
					}`),
				).toEqual([])
			})

			it("should take it from an Assignment's target", () => {
				expect(
					diagnosticsFor(`implementation {
						constant flag = true
						variable found: Optional<Integer> = #Value(0)

						found = ${ARMS}
					}`),
				).toEqual([])
			})

			it("should take it from the declared return Type", () => {
				expect(
					diagnosticsFor(`implementation {
						constant flag = true

						function pick () -> Optional<Integer> {
							<- ${ARMS}
						}
					}`),
				).toEqual([])
			})

			// NOTE: A Match Handler's `<-` reaches the same rail through the
			// Match's own declared return Type.
			it("should take it from a Match's declared return Type", () => {
				expect(
					diagnosticsFor(`implementation {
						constant flag = true
						constant n: Integer | String = 1

						constant found = match n -> Optional<Integer> {
							case Integer { <- ${ARMS} }
							case String  { <- #Empty }
						}
					}`),
				).toEqual([])
			})

			it("should take it from a Record member", () => {
				expect(
					diagnosticsFor(`implementation {
						constant flag = true
						constant row: { found: Optional<Integer> } = {
							found = ${ARMS},
						}
					}`),
				).toEqual([])
			})

			it("should take it from a List item", () => {
				expect(
					diagnosticsFor(`implementation {
						constant flag = true
						constant found: List<Optional<Integer>> = [${ARMS}]
					}`),
				).toEqual([])
			})

			it("should take it from a Dictionary value", () => {
				expect(
					diagnosticsFor(`implementation {
						constant flag = true
						constant found: Dictionary<String, Optional<Integer>> = [
							"a" = ${ARMS},
						]
					}`),
				).toEqual([])
			})

			it("should take it from a Parameter's default", () => {
				expect(
					diagnosticsFor(`implementation {
						constant flag = true

						function pick (
							_ found: Optional<Integer> = ${ARMS},
						) -> Integer {
							<- 1
						}
					}`),
				).toEqual([])
			})

			// NOTE: The rows of a table test are read against what the row
			// Parameter declared, which is the same hand-down every position
			// above makes — asked with the tests section enriched, since that is
			// the only mode that reads one at all.
			it("should take it from a table test's row Parameter", () => {
				expect(
					enrich(
						parse(`implementation {
							constant flag = true
						}

						tests {
							test "row" across [
								${ARMS},
							] (row: Optional<Integer>) {
								expect row::hasValue()
							}
						}`),
						{ tests: true },
					).diagnostics,
				).toEqual([])
			})

			// NOTE: An Argument is the one position that hands nothing down — a
			// call picks its Overload BY the Arguments, so no Parameter Type is
			// decided before they are read. The arrow is what a `define` standing
			// in one has instead, and the Diagnostic is what says so.
			it("should not reach an Argument, and say what to write instead", () => {
				let diagnostics = diagnosticsFor(`implementation {
					constant flag = true

					function count (_ found: Optional<Integer>) -> Integer {
						<- 1
					}

					constant total = count(${ARMS})
				}`)

				// NOTE: All three, and in that order. The Case's own two
				// Diagnostics name the Type Parameters left over and the two
				// Choices declaring `#Value` — `Optional` and `Result` — and
				// each offers to annotate the Declaration, which is a help
				// there IS no Declaration for here. The `define`'s own is what
				// supplies the one that works.
				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual([
					"undecided-type-arguments",
					"ambiguous-case",
					"define-without-answer-type",
				])
				expect(diagnostics[2].severity).toBe("error")
				expect(diagnostics[2].labels[0]?.message).toBe(
					"this 'define' has no answer Type",
				)
				expect(diagnostics[2].labels[1]?.message).toBe(
					"this arm has none of its own to lend it",
				)
				expect(diagnostics[2].helps).toEqual([
					"Write the answer Type on the 'define' itself: 'define -> Type { … }' — it is pushed into every arm.",
					"Or annotate the Declaration it stands in, where it stands in one. An Argument position hands nothing down: a call picks its Overload BY the Arguments, so no Parameter Type is decided before they are read.",
				])
			})

			// NOTE: The Argument position is a CAVEAT on the second help and not
			// an account of where the `define` stands — nothing here can tell an
			// Argument from a Declaration with no annotation, since both hand the
			// same nothing down. Stated as a Note it read as a remark about the
			// Declaration below, which no Argument list is anywhere near, and it
			// withheld the help that annotating that Declaration is the fix.
			it("should offer the Declaration the arrow is an alternative to", () => {
				let diagnostics = diagnosticsFor(`implementation {
					constant flag = true

					constant fetched = ${ARMS}
				}`)

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual([
					"undecided-type-arguments",
					"ambiguous-case",
					"define-without-answer-type",
				])
				expect(diagnostics[2].notes).toHaveLength(1)
				expect(
					diagnostics[2].notes.some((note) =>
						note.includes("An Argument position"),
					),
				).toBe(false)
				expect(
					diagnostics[2].helps.some((help) =>
						help.includes("annotate the Declaration"),
					),
				).toBe(true)
			})

			it("should reach an Argument through the arrow", () => {
				expect(
					diagnosticsFor(`implementation {
						constant flag = true

						function count (_ found: Optional<Integer>) -> Integer {
							<- 1
						}

						constant total = count(define -> Optional<Integer> {
							as #Empty if flag
							as #Value(1) otherwise
						})
					}`),
				).toEqual([])
			})
		})

		describe("The answer Type from the arrow and the arms", () => {
			// NOTE: The arrow is a claim about the `define` itself and the
			// position around it is a claim about what may stand there, so the
			// arrow is the narrower of the two and wins.
			it("should let the arrow beat the position", () => {
				expect(
					defineTypeOf(`implementation {
						constant flag = true

						constant scored: Integer | String = define -> Integer {
							as 1 if flag
							as 2 otherwise
						}
					}`),
				).toBe("Integer")
			})

			// NOTE: The position OFFERS where the arrow claims, and an
			// anonymous Union offers each of its members — so what a `define`
			// answers with is the offers its arms took. Both are taken here,
			// which is the annotation over again.
			it("should take the position's Type where there is no arrow", () => {
				expect(
					defineTypeOf(`implementation {
						constant flag = true

						constant scored: Integer | String = define {
							as 1 if flag
							as "none" otherwise
						}
					}`),
				).toBe("Integer | String")
			})

			// NOTE: A ladder of Integers under `Integer | String` answers
			// Integer, and nothing is lost by that: the position said either may
			// stand there, and an Integer is one of them. Adopting the whole
			// offer instead is what refused a `define` in a one-member Case
			// payload, whose position offers two SPELLINGS of one payload.
			it("should answer with only the offers its arms took", () => {
				expect(
					defineTypeOf(`implementation {
						constant flag = true

						constant scored: Integer | String = define {
							as 1 if flag
							as 2 otherwise
						}
					}`),
				).toBe("Integer")
			})

			// NOTE: An arm that took none of the offers disagrees with the
			// POSITION, and every arm is held to the Type the `define` answers
			// with — so the whole offer stands, and the Validator reports the
			// disagreement against what the position actually said rather than
			// against the offers the other arms happened to take.
			it("should keep the whole offer where an arm took none of it", () => {
				expect(
					defineTypeOf(`implementation {
						constant flag = true

						constant scored: Integer | String = define {
							as 1 if flag
							as true otherwise
						}
					}`),
				).toBe("Integer | String")
			})

			// NOTE: The `otherwise` arm's own Type is among them, being one of
			// the answers.
			it("should union the arms where neither says anything", () => {
				expect(
					defineTypeOf(`implementation {
						constant flag = true

						constant scored = define {
							as 1 if flag
							as "none" otherwise
						}
					}`),
				).toBe("Integer | String")
			})
		})

		// NOTE: A one-member Case's payload slot offers two spellings of one
		// payload at once — the Record the Case carries and the member's own
		// Type — and the value settles which of them it is. A `define` that
		// answered with BOTH settled nothing: it fitted neither spelling, and
		// every single-member Case in the language refused one.
		describe("The answer Type inside a Case payload", () => {
			// NOTE: The Type the payload reached the Case with. A one-member
			// shorthand is wrapped into the Record the Case carries, so this is
			// that Record either way — and `lastConstantValue` asks for a clean
			// Program on the way past.
			function payloadTypeOf(source: string): string {
				let value = lastConstantValue(source)

				if (value.nodeType !== "CaseValue" || value.value === null) {
					throw new Error(
						"Last Constant is no Case carrying a payload.",
					)
				}

				return printType(value.value.type)
			}

			it("should answer with the member's Type in a one-member Case", () => {
				expect(
					payloadTypeOf(`implementation {
						constant n = 4

						constant maybe: Optional<Integer> = #Value(define {
							as 1 if n::isEven()
							as 2 otherwise
						})
					}`),
				).toBe("{ item: Integer }")
			})

			it("should answer with the Record a multi-member Case carries", () => {
				expect(
					payloadTypeOf(`implementation {
						choice Span {
							Range { from: Integer, to: Integer },
							Whole,
						}

						constant flag = true

						constant span: Span = #Range(define {
							as { from = 1, to = 2 } if flag
							as { from = 3, to = 4 } otherwise
						})
					}`),
				).toBe("{ from: Integer, to: Integer }")
			})

			// NOTE: The Record spelling written out, which the shorthand is only
			// a shorter way of saying — the `define` stands in the member's own
			// position there and never sees the two spellings at all.
			it("should read the long form as it always did", () => {
				expect(
					payloadTypeOf(`implementation {
						constant flag = true

						constant maybe: Optional<Integer> = #Value({
							item = define {
								as 1 if flag
								as 2 otherwise
							}
						})
					}`),
				).toBe("{ item: Integer }")
			})

			it("should take an arrow inside a payload", () => {
				expect(
					payloadTypeOf(`implementation {
						constant flag = true

						constant maybe: Optional<Integer> = #Value(define -> Integer {
							as 1 if flag
							as 2 otherwise
						})
					}`),
				).toBe("{ item: Integer }")
			})

			// NOTE: The other direction — a `define` whose arms are bare Cases
			// answers with the Choice the position named, because a bare Case
			// decides no Type Arguments of its own and the offer is what it is
			// read against. Pushing the position's Type into the arms is what
			// this needs, and it is untouched by what the `define` then answers
			// with.
			it("should let a bare Case arm resolve from the position", () => {
				expect(
					defineTypeOf(`implementation {
						constant flag = true

						constant maybe: Optional<Integer> = define {
							as #Value(1) if flag
							as #Empty otherwise
						}
					}`),
				).toBe("Optional<Integer>")
			})
		})
	})

	// NOTE: The doorway nobody has to write — a Match on a bare Integer or String
	// takes the VALUE apart, and its Cases are evidence in both directions:
	// reaching the Case for the rest proves the value is none of the values named
	// above it, and a Case that NAMES a value proves that. The Matcher itself is
	// untouched throughout, which is what leaves the Rewriter the Match it always
	// had.
	describe("Refinement match narrowing", () => {
		function handlersOf(
			source: string,
		): common.typed.MatchNode["handlers"] {
			let value = lastConstantValue(source)

			if (value.nodeType !== "Match") {
				throw new Error("Last Constant is not a Match.")
			}

			return value.handlers
		}

		// NOTE: The Type `@` has where the Handler ANSWERS, read off the value it
		// returns rather than searched for — a Handler can hold more than one `@`,
		// and a Guard's is not the body's.
		function selfTypesOf(source: string): Array<string> {
			return handlersOf(source).map((handler) => {
				let returned = handler.body[0]

				if (returned.nodeType !== "ReturnStatement") {
					throw new Error("A Handler does not return.")
				}

				return printType(returned.expression.type)
			})
		}

		let zero = "type Zero = Integer where @::is(0)"

		it("should narrow '@' to the values the Cases above did not name", () => {
			expect(
				selfTypesOf(`implementation {
					constant n = 3

					constant answer = match n -> Integer {
						case 0 { <- 0 }

						case _ { <- @ }
					}
				}`),
			).toEqual(["Integer", "NonZeroInteger"])
		})

		it("should narrow '@' to the value its own Case named", () => {
			expect(
				selfTypesOf(`implementation {
					${zero}

					constant n = 3

					constant answer = match n -> Integer {
						case 0 { <- @ }

						case _ { <- 0 }
					}
				}`),
			).toEqual(["Zero", "Integer"])
		})

		// NOTE: Every Case above contributes, so a refinement asking about two values
		// is established by the two Cases that named them — and set INCLUSION means a
		// refinement asking about one of them is established too.
		it("should read every value the Cases above named", () => {
			expect(
				selfTypesOf(`implementation {
					type NotZeroOrOne = Integer where @::isNot(0)::and(@::isNot(1))

					constant n = 3

					constant answer = match n -> Integer {
						case 0 { <- 0 }

						case 1 { <- 1 }

						case _ { <- @ }
					}
				}`).at(-1),
			).toBe("NotZeroOrOne")
		})

		it("should narrow a String Case by the String it named", () => {
			expect(
				selfTypesOf(`implementation {
					type NotBlank = String where @::isNot("")

					constant text = "essence"

					constant answer = match text -> String {
						case "" { <- "" }

						case _ { <- @ }
					}
				}`),
			).toEqual(["String", "NotBlank"])
		})

		// NOTE: The evidence is read off the Matchers alone, so it holds whatever the
		// Validator makes of the Match's shape — a Guarded value Case is refused
		// there, and it hands nothing down here either. Asked of a Union, where such
		// a Case is legal and the Handlers below it really do see the value it named.
		it("should not read a value a Guarded Case named", () => {
			expect(
				selfTypesOf(`implementation {
					constant flag = true
					constant value: Integer | String = 3

					constant answer = match value -> Integer {
						case 0 where flag { <- 0 }

						case Integer { <- @ }

						case String { <- 0 }
					}
				}`).at(1),
			).toBe("Integer")
		})

		// NOTE: A Guard runs AFTER the Matcher matched, not instead of it, so what the
		// Handler's own Case named still holds inside its body.
		it("should keep the value its own Guarded Case named", () => {
			expect(
				selfTypesOf(`implementation {
					${zero}

					constant flag = true
					constant value: Integer | String = 3

					constant answer = match value -> Integer {
						case 0 where flag { <- @ }

						case Integer { <- 0 }

						case String { <- 0 }
					}
				}`).at(0),
			).toBe("Zero")
		})

		// NOTE: Nothing about the Match itself changes — the Matcher is the Type the
		// runtime check is emitted from, and evidence is not a runtime question. This
		// is the invariant that leaves the Rewriter needing no change at all.
		it("should leave every Matcher as it was", () => {
			expect(
				handlersOf(`implementation {
					${zero}

					constant n = 3

					constant answer = match n -> Integer {
						case 0 { <- @ }

						case _ { <- @ }
					}
				}`).map((handler) => printType(handler.matcher)),
			).toEqual(["Integer", "Integer"])
		})

		// NOTE: Two questions about the same value are not the same question. A String
		// that is not the empty one HAS content, and the Compiler has no way to know
		// that — the same rule an `if` narrows by.
		it("should not narrow on a differently spelled predicate", () => {
			expect(
				selfTypesOf(`implementation {
					type NonEmptyText = String where @::hasCharacters()

					constant text = "essence"

					constant answer = match text -> String {
						case "" { <- "" }

						case _ { <- @ }
					}
				}`).at(-1),
			).toBe("String")
		})

		// NOTE: A Boolean is no refinable base, and a Case naming one of its two
		// values proves nothing anything could be declared by.
		it("should read no evidence out of a Boolean Case", () => {
			expect(
				selfTypesOf(`implementation {
					constant value: Boolean | Integer = true

					constant answer = match value -> Integer {
						case true { <- 0 }

						case Integer { <- @ }

						case Boolean { <- 1 }
					}
				}`).at(1),
			).toBe("Integer")
		})
	})

	// NOTE: A value written DOWN needs no branch in front of it — its predicate is
	// decided while compiling. What the Enricher does with that is choose an
	// Overload by it, which is what these assert; the Statements a Program writes
	// one into are the Validator's, and `validator.spec.ts` asserts those.
	describe("Refinement literal admission", () => {
		// NOTE: Two entries under one name, told apart by exactly the evidence the
		// first one demands — so which one answered says whether the Argument was
		// admitted, with no Diagnostic and no narrowing anywhere in the source.
		function scaled(argument: string): string {
			return `implementation {
				type NonZero = Integer where @::isNot(0)

				namespace Scaling for Integer {
					overload scaled {
						(by other: NonZero) -> String {
							<- "refined"
						}

						(by other: Integer) -> String {
							<- "base"
						}
					}
				}

				constant scaledValue = 3::scaled(by ${argument})
			}`
		}

		it("should admit a written value the predicate holds of", () => {
			expect(
				lastConstantMethodInvocation(scaled("2")).overloadedMethodIndex,
			).toBe(0)
		})

		it("should not admit a written value the predicate refuses", () => {
			expect(
				lastConstantMethodInvocation(scaled("0")).overloadedMethodIndex,
			).toBe(1)
		})

		// NOTE: The evaluator reads a value that is WRITTEN. A name is a value the
		// Program computes, however plainly it was computed a line above — deciding
		// that would need an interpreter, which is what the allowlist exists not to
		// be.
		it("should not admit a value the Program computes", () => {
			expect(
				lastConstantMethodInvocation(`implementation {
					type NonZero = Integer where @::isNot(0)

					namespace Scaling for Integer {
						overload scaled {
							(by other: NonZero) -> String {
								<- "refined"
							}

							(by other: Integer) -> String {
								<- "base"
							}
						}
					}

					constant two = 2

					constant scaledValue = 3::scaled(by two)
				}`).overloadedMethodIndex,
			).toBe(1)
		})

		// NOTE: The same two answers for a written Rational, which is as visibly
		// not zero as a written Integer is. What the entry is told apart by is
		// the value rather than the spelling: `2/4` is the number `1/2` is.
		describe("a written Rational", () => {
			function scaledRatio(argument: string): string {
				return `implementation {
					type NonZeroRatio = Rational where @::isNot(0/1)

					namespace Scaling for Integer {
						overload scaled {
							(by other: NonZeroRatio) -> String {
								<- "refined"
							}

							(by other: Rational) -> String {
								<- "base"
							}
						}
					}

					constant scaledValue = 3::scaled(by ${argument})
				}`
			}

			it("should admit a written Rational the predicate holds of", () => {
				expect(
					lastConstantMethodInvocation(scaledRatio("2/4"))
						.overloadedMethodIndex,
				).toBe(0)
			})

			it("should not admit a written Rational the predicate refuses", () => {
				expect(
					lastConstantMethodInvocation(scaledRatio("0/2"))
						.overloadedMethodIndex,
				).toBe(1)
			})

			// NOTE: An Integer bound standing where a Rational is compared is
			// the same question about the same number — `Rational::isLessThan`
			// declares an entry for each kind, and `1/2::isLessThan(1)` asks
			// what `1/2::isLessThan(1/1)` asks.
			function belowOne(argument: string): string {
				return `implementation {
					type BelowOne = Rational where @::isLessThan(1)

					namespace Scaling for Integer {
						overload scaled {
							(by other: BelowOne) -> String {
								<- "refined"
							}

							(by other: Rational) -> String {
								<- "base"
							}
						}
					}

					constant scaledValue = 3::scaled(by ${argument})
				}`
			}

			it("should read an Integer bound as the Rational it widens to", () => {
				expect(
					lastConstantMethodInvocation(belowOne("1/2"))
						.overloadedMethodIndex,
				).toBe(0)
				expect(
					lastConstantMethodInvocation(belowOne("3/2"))
						.overloadedMethodIndex,
				).toBe(1)
			})
		})

		// NOTE: The whole reason admission answers a POSITION rather than writing
		// the refinement onto the Node: the first entry here admits the Argument it
		// is asked about and loses anyway, on the Argument after it. Nothing it
		// admitted may reach the entry that wins — and nothing does, because there
		// was never anywhere to leave it.
		it("should leave nothing behind on a Node a losing candidate admitted", () => {
			let invocation = lastConstantMethodInvocation(`implementation {
				type NonZero = Integer where @::isNot(0)

				namespace Scaling for Integer {
					overload scaled {
						(by other: NonZero, and extra: String) -> String {
							<- "refined"
						}

						(by other: Integer, and extra: Integer) -> String {
							<- "base"
						}
					}
				}

				constant scaledValue = 3::scaled(by 2, and 5)
			}`)

			expect(invocation.overloadedMethodIndex).toBe(1)
			expect(
				invocation.arguments.map((argument) =>
					printType(argument.type),
				),
			).toEqual(["Integer", "Integer"])
			expect(
				invocation.arguments.map((argument) =>
					printType(argument.value.type),
				),
			).toEqual(["Integer", "Integer"])
		})

		// NOTE: The RECEIVER of a Namespace over a refinement is a refinement in
		// every entry, and it is not evidence any of them asked for — it can not
		// tell two entries apart. Counting it put them all in one partition, which
		// left the order they were written in, which is the one order an APPENDED
		// refined entry can never win from.
		it("should probe an appended refined entry first under a refined receiver", () => {
			let invocation = lastConstantMethodInvocation(`implementation {
				type NonZero = Integer where @::isNot(0)
				type NotNegative = Integer where @::isGreaterThanOrEqualTo(0)

				namespace Powers for NonZero {
					overload power {
						(to exponent: Integer) -> String {
							<- "base"
						}

						(to exponent: NotNegative) -> Integer {
							<- 0
						}
					}
				}

				constant proven: NonZero = 3
				constant raised = proven::power(to 2)
			}`)

			expect(invocation.overloadedMethodIndex).toBe(1)
			expect(printType(invocation.type)).toBe("Integer")
		})

		// NOTE: The one position where the refinement standing there is not yet a
		// Type: a Parameter written `NonEmptyList<Item>` whose `Item` the CALL has to
		// work out. Asked as it stands, its base is `List<Item>` and no written List
		// is of that Type at all — so what the value is asked about is the refinement
		// the value itself DECIDES, the declared base unified against the written
		// List's own Type. The Parameter is then bound through the base, exactly as an
		// unrefined `List<Item>` would bind it.
		describe("a Type Argument the call infers", () => {
			// NOTE: The evidence is all that tells the two entries apart — the second
			// one pins the items rather than inferring them, so the List that decides
			// nothing still has an entry to fall to and the answer says which.
			function counted(argument: string): string {
				return `implementation {
					namespace Counting for {} {
						overload static counted {
							<infer Item>(_ items: NonEmptyList<Item>) -> String {
								<- "refined"
							}

							(_ items: List<String>) -> String {
								<- "base"
							}
						}
					}

					constant countedValue = Counting.counted(${argument})
				}`
			}

			it("should admit a written List into the instantiation it decides", () => {
				expect(
					lastConstantFunctionInvocation(counted(`["a"]`))
						.overloadedMethodIndex,
				).toBe(0)
			})

			// NOTE: An empty List decides nothing — `List<Item>` accepts a
			// `List<Unknown>` without saying what `Item` is, and a refinement over a
			// base nobody decided would hand the call a Type nobody wrote. So the
			// unrefined entry answers, as it does for a List the predicate simply
			// fails.
			it("should not admit a written List that decides no Type Argument", () => {
				expect(
					lastConstantFunctionInvocation(counted("[]"))
						.overloadedMethodIndex,
				).toBe(1)
			})

			// NOTE: A Type Parameter binds the BASE and never the refinement — the v1
			// rule, asked of the one Parameter a refinement is what decided. The
			// return Type IS the binding here, and `firstItem` is total for it: the
			// whole point of the Parameter having been admitted.
			it("should bind the Type Parameter to the base's items", () => {
				expect(
					printType(
						lastConstantValue(`implementation {
							function firstOf<infer Item>(_ items: NonEmptyList<Item>) -> Item {
								<- items::firstItem()
							}

							constant first = firstOf(["a"])
						}`).type,
					),
				).toBe("String")
			})
		})
	})

	// NOTE: A RECEIVER is the one position that asks a value nothing. A
	// Parameter, a declared Constant, a return position and an Argument matched
	// against a refined entry each hand a written value a question; dispatch
	// reads whatever the receiver's Type came to and looks a Namespace up in it.
	// So the receiver asks ITSELF, of every refinement in scope at once, and
	// carries the conjunction of everything admitted.
	describe("A written receiver", () => {
		function receiverTypeOf(body: string): string {
			return printType(
				lastConstantMethodInvocation(`implementation {
					${body}
				}`).base.type,
			)
		}

		function answerOf(body: string): string {
			return printType(
				lastConstantValue(`implementation {
					${body}
				}`).type,
			)
		}

		// NOTE: `3` proves both builtin predicates over an Integer, and
		// `PositiveInteger` is the Alias whose conjuncts are exactly the two —
		// so the conjunction has a name to print and prints under it.
		it("should carry every refinement the value is admitted into", () => {
			expect(receiverTypeOf("constant text = 3::toString()")).toBe(
				"PositiveInteger",
			)
		})

		it("should carry only the refinements the value proves", () => {
			expect(receiverTypeOf("constant text = 0::toString()")).toBe(
				"NonNegativeInteger",
			)
			expect(receiverTypeOf("constant text = -4::toString()")).toBe(
				"NonZeroInteger",
			)
		})

		// NOTE: Where no declared Alias proves the whole conjunction, the Type
		// prints as the Declaration a reader would have to write for it — the
		// conjuncts in the order they are compared, joined the way a chain is.
		// It names the proof; like every other predicate spelling, it is not
		// offered as something to paste.
		it("should spell a conjunction no declared name covers", () => {
			expect(
				receiverTypeOf(`type Even = Integer where @::isEven()
					type Big = Integer where @::isGreaterThan(10)

					constant text = 12::toString()`),
			).toBe(
				"Integer where @::isNot(0)::and(@::isEven())::and(@::isPositive())::and(@::isGreaterThan(10))::and(@::isGreaterThanOrEqualTo(0))",
			)
		})

		// NOTE: A written Rational answers for itself the way a written Integer
		// does, and prints under the Alias whose conjuncts are exactly what it
		// proved. A zero proves nothing, so it stays the Rational it is written
		// as.
		it("should carry a written Rational's proof", () => {
			expect(receiverTypeOf("constant text = 1/2::toString()")).toBe(
				"NonZeroRational",
			)

			expect(receiverTypeOf("constant text = 0/1::toString()")).toBe(
				"Rational",
			)
		})

		it("should carry a generic refinement applied to the items", () => {
			expect(receiverTypeOf('constant text = ["a"]::isEmpty()')).toBe(
				"NonEmptyList<String>",
			)
		})

		// NOTE: A written String proves `NonEmptyString`, and the Namespace over
		// that proof declares no `trim` — trimming is one of the three Methods
		// that CAN empty a String. So the call falls to `String`'s own, which
		// is what a refinement adding Methods and taking none away means.
		it("should reach the base Namespace where nothing targets the proof", () => {
			expect(receiverTypeOf('constant text = "abc"::trim()')).toBe(
				"NonEmptyString",
			)
			expect(answerOf('constant text = "abc"::trim()')).toBe("String")
		})

		// NOTE: And where the proof IS targeted, every answer it tightens says
		// so: the count is above zero, the characters are a List with
		// something in it, and either end is a character rather than an
		// Optional.
		it("should spend the proof a written String carries", () => {
			expect(answerOf('constant count = "abc"::length()')).toBe(
				"PositiveInteger",
			)
			expect(answerOf('constant characters = "abc"::characters()')).toBe(
				"NonEmptyList<Character>",
			)
			expect(answerOf('constant first = "abc"::firstCharacter()')).toBe(
				"Character",
			)
			expect(answerOf('constant last = "abc"::lastCharacter()')).toBe(
				"Character",
			)
			expect(answerOf('constant loud = "abc"::uppercase()')).toBe(
				"NonEmptyString",
			)
			expect(answerOf('constant twice = "abc"::repeat(times 2)')).toBe(
				"NonEmptyString",
			)
			expect(
				answerOf(`constant text = "abc"::append("d")
					constant first = text::firstCharacter()`),
			).toBe("Optional<Character>")
		})

		// NOTE: A written List is counted by its BRACKETS, and an empty pair
		// counts nothing — so the one predicate it could have proven is false
		// of it and the receiver stays the List it is written as. A Boolean
		// beside it, whose Type no refinement may even be written over.
		it("should prove nothing about a written value the predicates refuse", () => {
			expect(receiverTypeOf("constant grown = []::append(1)")).toBe(
				"List<Unknown>",
			)
			expect(receiverTypeOf("constant text = true::toString()")).toBe(
				"Boolean",
			)
		})

		// NOTE: The other side of the same rule. A value the Program COMPUTES is
		// a value nothing has decided anything about, however plainly it was
		// computed a line above — which is what keeps every unproven entry
		// reachable. A DIFFERENCE, because it is the arithmetic no refinement
		// of Integer closes over: a sum and a product of two written Integers
		// each answer a `PositiveInteger` and carry that proof on.
		it("should prove nothing about a computed receiver", () => {
			expect(
				answerOf(`constant two = 3::subtract(1)
					constant root = two::squareRoot()`),
			).toBe("Optional<Integer | Algebraic>")
		})

		it("should spend the proof on the Namespace that takes it", () => {
			expect(answerOf("constant root = 4::squareRoot()")).toBe(
				"PositiveInteger | Algebraic",
			)
			expect(answerOf("constant first = [1, 2]::firstItem()")).toBe(
				"Integer",
			)
			expect(answerOf("constant mean = [1, 2]::average()")).toBe(
				"Rational",
			)
			expect(
				answerOf(
					"constant scaled = 2::multiply(with Number.GoldenRatio)",
				),
			).toBe("Algebraic")
		})

		// NOTE: What the proof may never do is make an answer WIDER. A power at
		// a non-negative exponent and a sum are whole numbers whatever the
		// receiver proves, and each answers the tightest Integer the operands
		// prove between them. A receiver proving only that it is not negative
		// reaches no `raise` of its own, so a negative exponent there is still
		// the entry that can come back empty.
		it("should never widen an answer the base already gave", () => {
			expect(answerOf("constant power = 2::raise(to 10)")).toBe(
				"PositiveInteger",
			)
			expect(answerOf("constant sum = 1::add(2)")).toBe("PositiveInteger")
			expect(answerOf("constant power = 0::raise(to -1)")).toBe(
				"Optional<Integer | Rational>",
			)
		})

		// NOTE: And where the proof tightens the answer it says so — a product
		// of two proven Integers is proven itself, which is what `namespace
		// NonZeroInteger` was written to carry. Two written factors prove both
		// halves of the sign as well, and `namespace PositiveInteger` is
		// narrower than either of the two it holds the proofs of, so it is the
		// one the call reaches.
		it("should answer with the refinement a refined entry declares", () => {
			expect(answerOf("constant product = 2::multiply(with 3)")).toBe(
				"PositiveInteger",
			)
			expect(
				answerOf(`constant count: NonZeroInteger = 3
					constant product = count::multiply(with 4)`),
			).toBe("NonZeroInteger")
		})

		// NOTE: The proofs the library MINTS. A count is never negative, a count
		// of something proven non-empty is above zero, a distance from zero is
		// never negative and a denominator in lowest terms is always positive
		// — and each of those answers says so, so that the next call can spend
		// it: `2::raise(to items::length())` reaches the entry taking a
		// `NonNegativeInteger` exponent and answers a whole number rather than
		// the Union, and `absolute()::squareRoot()` answers the root itself
		// rather than an Optional.
		it("should mint the count and sign proofs a native answer carries", () => {
			expect(
				answerOf(`constant items: List<Integer> = [1, 2, 3]
					constant count = items::length()`),
			).toBe("NonNegativeInteger")
			expect(
				answerOf('constant count = "abc"::append("d")::length()'),
			).toBe("NonNegativeInteger")
			expect(
				answerOf(`constant entries = Dictionary.of([{ key = "a", value = 1 }])
					constant count = entries::length()`),
			).toBe("NonNegativeInteger")
			expect(
				answerOf(`constant items: List<Integer> = [1, 2, 3]
					constant count = items::count(of 2)`),
			).toBe("NonNegativeInteger")
			expect(
				answerOf(`constant items: List<Integer> = [1, 2, 3]
					constant count = items::count(where (item) { <- item::isEven() })`),
			).toBe("NonNegativeInteger")
			expect(
				answerOf(`constant items: NonEmptyList<Integer> = [1, 2, 3]
					constant count = items::length()`),
			).toBe("PositiveInteger")
			expect(
				answerOf(`constant entries: NonEmptyDictionary<String, Integer> = ["a" = 1]
					constant count = entries::length()`),
			).toBe("PositiveInteger")
			expect(
				answerOf(`constant computed = 1::subtract(2)
					constant distance = computed::absolute()`),
			).toBe("NonNegativeInteger")
			expect(
				answerOf(`constant computed = 1/4::add(1/4)
					constant denominator = computed::denominator()`),
			).toBe("PositiveInteger")
		})

		it("should let the next call spend a minted proof", () => {
			expect(
				answerOf(`constant items: NonEmptyList<Integer> = [1, 2, 3]
					constant power = 2::raise(to items::length())`),
			).toBe("PositiveInteger")
			expect(
				answerOf(`constant computed = 1::subtract(2)
					constant root = computed::absolute()::squareRoot()`),
			).toBe("Integer | Algebraic")
			expect(
				answerOf(`constant computed = 1/4::add(1/4)
					constant scaled = 10::raise(to computed::denominator())`),
			).toBe("PositiveInteger")
			expect(
				answerOf(`constant items: List<Integer> = [1, 2, 3]
					constant width = items::length()::add(1)`),
			).toBe("PositiveInteger")
		})

		// NOTE: A Program's own Alias is a candidate beside the builtins, and a
		// Namespace over it is reached by a written receiver exactly as the
		// standard library's are.
		it("should reach a Program's own refined Namespace", () => {
			expect(
				answerOf(`type Even = Integer where @::isEven()

					namespace EvenInteger for Even {
						halved() -> String {
							<- "half"
						}
					}

					constant half = 4::halved()`),
			).toBe("String")
		})
	})

	// NOTE: The other half of what a proof buys. A refinement ADDS Methods and
	// takes none away, so `namespace NonEmptyList` can answer `firstItem()` bare
	// and still not hide `List::firstItem(defaultingTo:)` — the call compiles,
	// and the fallback beside it is text that can never run. Only a Diagnostic
	// can say so.
	//
	// The rule is written about the LABEL and about nothing else: an Invocation
	// carrying an Argument labelled `defaultingTo` is resolved a second time with
	// that Argument struck out, and the Warning is reported when the second
	// resolution answers a Type that is not an Optional. No Method name and no
	// Namespace name is named anywhere in it, which is what makes a Program's own
	// Namespace following the same convention read the same way.
	describe("Dead 'defaultingTo' fallbacks", () => {
		function programWith(body: string): string {
			return `implementation {
				constant proven: NonEmptyList<Integer> = [3, 1, 2]
				constant plain: List<Integer> = []

				${body}
			}`
		}

		function codesFor(source: string): Array<string> {
			return diagnosticsFor(source).map((diagnostic) => diagnostic.code)
		}

		it("should warn where a proven receiver answers bare", () => {
			expect(
				codesFor(
					programWith(
						"constant first = proven::firstItem(defaultingTo 0)",
					),
				),
			).toEqual(["fallback-never-used"])
		})

		it("should warn where a proven Argument answers bare", () => {
			expect(
				codesFor(
					programWith(
						"constant highest = Number.highest(proven, defaultingTo 0)",
					),
				),
			).toEqual(["fallback-never-used"])
		})

		// NOTE: A written RECEIVER is proof of the same kind, and the probe that
		// erases the caller's proof erases it too — the receiver is widened past
		// its refinement and no written value is admitted to one, so the
		// question asked is what a caller holding nothing would have reached.
		// Without that, `[1, 2]::firstItem(defaultingTo 0)` would look like an
		// entry swap rather than the dead fallback it is.
		it("should warn where a written receiver answers bare", () => {
			expect(
				codesFor(
					programWith(
						"constant first = [1, 2]::firstItem(defaultingTo 0)",
					),
				),
			).toEqual(["fallback-never-used"])
		})

		// NOTE: A written `2` is proof enough for `divide`'s NonZeroInteger
		// entry, so the quotient exists and the fallback is as dead as the
		// receiver-side ones — the evidence is on the ARGUMENT here, which is
		// the same rule from the other side.
		it("should warn where a written Argument proves the answer exists", () => {
			expect(
				codesFor(
					programWith(
						"constant half = 10::divide(by 2, defaultingTo 0/1)",
					),
				),
			).toEqual(["fallback-never-used"])
		})

		// NOTE: The Warning has to name the Type the call already answers, or a
		// reader is told to delete an Argument without being told what is left.
		it("should name the Type the call answers without the fallback", () => {
			let source = programWith(
				"constant first = proven::firstItem(defaultingTo 0)",
			)
			let diagnostic = diagnosticsFor(source)[0]

			expect(diagnostic.severity).toBe("warning")
			expect(diagnostic.tags).toEqual(["unnecessary"])
			expect(diagnostic.labels[0]).toMatchObject({
				kind: "primary",
				message: "this fallback can never be read",
			})
			expect(diagnostic.notes).toEqual([
				"Without it the call answers an Integer, which is never empty.",
			])
			expect(diagnostic.helps).toEqual([
				"Drop the 'defaultingTo' Argument; the call already answers an Integer.",
			])
		})

		// NOTE: The label is part of the span, because the label is part of what
		// the Help asks the reader to drop.
		it("should underline the label together with its value", () => {
			let source = programWith(
				"constant first = proven::firstItem(defaultingTo 0)",
			)

			expect(underlinedText(source, diagnosticsFor(source)[0])).toBe(
				"defaultingTo 0",
			)
		})

		// NOTE: The one entry the whole rule is built around — and the reason it
		// re-probes rather than reading a Parameter list. `Optional::value`
		// declares no bare `value()` at all, so the second resolution finds no
		// winner and there is nothing to say.
		it("should stay silent on 'Optional::value(defaultingTo:)'", () => {
			expect(
				codesFor(
					programWith(
						"constant first = plain::firstItem()::value(defaultingTo 0)",
					),
				),
			).toEqual([])
		})

		// NOTE: A proven receiver is not on its own enough. `firstItem(where:)`
		// can find nothing in a List that holds items, so the bare call still
		// answers an Optional and the fallback is live.
		it("should stay silent where the bare call still answers an Optional", () => {
			expect(
				codesFor(
					programWith(
						"constant first = proven::firstItem(where (item) { <- item::isGreaterThan(2) }, defaultingTo 0)",
					),
				),
			).toEqual([])
		})

		it("should stay silent on an unproven receiver", () => {
			expect(
				codesFor(
					programWith(
						"constant first = plain::firstItem(defaultingTo 0)",
					),
				),
			).toEqual([])
		})

		// NOTE: Nothing in the rule is about the standard library. A Namespace a
		// Program declares over a refinement of its own, with the same two
		// entries beside each other, is read exactly the same way.
		it("should read a Program's own Namespaces by the same convention", () => {
			expect(
				codesFor(`implementation {
					type Filled<Item> = List<Item> where @::hasItems()

					namespace Boxes for List<Integer> {
						overload head {
							() -> Optional<Integer> {
								<- @::firstItem()
							}

							(defaultingTo fallback: Integer) -> Integer {
								<- @::firstItem(defaultingTo fallback)
							}
						}
					}

					namespace FilledBoxes for Filled<Integer> {
						head() -> Integer {
							<- @::firstItem()
						}
					}

					constant filled: Filled<Integer> = [3, 1, 2]
					constant head = filled::head(defaultingTo 0)
				}`),
			).toEqual(["fallback-never-used"])
		})

		// NOTE: The same Namespace with no bare entry to fall to. The fallback is
		// the only way to call it, which is `Optional::value`'s shape written by
		// a Program.
		it("should stay silent where the Method declares no bare entry", () => {
			expect(
				codesFor(`implementation {
					namespace Boxes for List<Integer> {
						head(defaultingTo fallback: Integer) -> Integer {
							<- @::firstItem(defaultingTo fallback)
						}
					}

					constant plain: List<Integer> = []
					constant head = plain::head(defaultingTo 0)
				}`),
			).toEqual([])
		})

		// NOTE: A `defaultingTo` Parameter carrying a default value is filled in
		// by the callee where no Argument is written, so striking the Argument
		// reaches the very entry the call already selected. Nothing was proven —
		// it is one entry asked twice — and the Argument that WAS written is read
		// at run time, so the Help would change what the Program answers.
		it("should stay silent where the Parameter was defaulted, not dropped", () => {
			expect(
				codesFor(`implementation {
					namespace Wallets for { cents: Integer } {
						spend(_ amount: Integer, defaultingTo fallback: Integer = 0) -> Integer {
							if amount::isGreaterThan(@.cents) {
								<- fallback
							} else {
								<- amount
							}
						}
					}

					constant wallet = { cents = 10 }
					constant spent = wallet::spend(50, defaultingTo 7)
				}`),
			).toEqual([])
		})

		// NOTE: The same on the other rail, since both go through the one probe.
		it("should stay silent where a Function's Parameter was defaulted", () => {
			expect(
				codesFor(`implementation {
					function pick(_ amount: Integer, defaultingTo fallback: Integer = 0) -> Integer {
						if amount::isGreaterThan(10) {
							<- fallback
						} else {
							<- amount
						}
					}

					constant spent = pick(50, defaultingTo 7)
				}`),
			).toEqual([])
		})

		// NOTE: Striking the Argument can let an ENTIRELY different entry win, and
		// an entry that answers bare for reasons of its own proves nothing. A
		// plain List reaches this one holding no proof at all, the written call
		// really does read its fallback — no item is greater than 100 — and the
		// Help would silently swap which entry runs.
		it("should stay silent where the bare entry needed no proof", () => {
			expect(
				codesFor(`implementation {
					namespace Picks for List<Integer> {
						overload pick {
							(where check: (_: Integer) -> Boolean) -> Integer {
								<- 0
							}

							(where check: (_: Integer) -> Boolean, defaultingTo fallback: Integer) -> Integer {
								<- @::firstItem(where check, defaultingTo fallback)
							}
						}
					}

					constant plain: List<Integer> = [1, 2, 3]
					constant picked = plain::pick(where (item) { <- item::isGreaterThan(100) }, defaultingTo 9)
				}`),
			).toEqual([])
		})

		// NOTE: A call that resolved to nothing has no entry to have written the
		// fallback for, so it is told nothing about it — the Validator is
		// already reporting the Argument it could not place, and "drop the
		// fallback" on top of that reads as a second, unrelated fault.
		it("should stay silent where the written call resolved to nothing", () => {
			expect(
				codesFor(`implementation {
					function twice(_ value: Integer) -> Integer {
						<- value::multiply(with 2)
					}

					constant doubled = twice(3, defaultingTo 0)
				}`),
			).toEqual([])
		})

		// NOTE: A re-probe enriches the Arguments it keeps, and one of those may
		// write a `defaultingTo` of its own — so the re-probe is not re-entered.
		// The inner call still reports for itself, from the enrichment the
		// Program commits, and the outer one stays silent because a plain List
		// can still be empty.
		it("should report a nested call once, from its own enrichment", () => {
			expect(
				codesFor(
					programWith(
						"constant first = plain::firstItem(defaultingTo proven::firstItem(defaultingTo 0))",
					),
				),
			).toEqual(["fallback-never-used"])
		})

		// NOTE: The Warning is a Warning: the call is well typed, nothing is
		// refused, and what the Program does is unchanged. A reader who leaves it
		// alone gets the same answer — which `lastConstantValue` can not be asked
		// for, since it requires a Program that enriches silently and this one is
		// the whole point.
		it("should leave the call resolving to the entry it was written for", () => {
			let { program } = enrichSource(
				programWith(
					"constant first = proven::firstItem(defaultingTo 0)",
				),
			)
			let constants = program.implementation.nodes.filter(
				(node) => node.nodeType === "ConstantDeclarationStatement",
			)

			expect(printType(constants[constants.length - 1].value.type)).toBe(
				"Integer",
			)
		})
	})

	// NOTE: The Dictionary Type as a Program can reach it — the annotation, the
	// arity, assignability between two of them, and a user Namespace written for
	// one. Nothing here constructs a Dictionary: slice 1 builds one only through
	// `Dictionary.of`, which the standard library does not declare yet, so every
	// Dictionary a test can get hold of arrives as a Parameter.
	describe("Dictionary Types", () => {
		function parameterTypeOf(source: string, methodName: string): string {
			let { program, diagnostics } = enrichSource(source)

			expect(diagnostics).toEqual([])

			for (let node of program.implementation.nodes) {
				if (node.nodeType !== "NamespaceDefinitionStatement") {
					continue
				}

				let method = node.type.methods[methodName]

				expect(method?.type).toBe("SimpleMethod")

				// NOTE: Parameter 0 is the injected receiver, so the one the
				// Declaration wrote is the second.
				return printType(
					(method as common.SimpleMethodType).parameterTypes[1]!
						.type as common.Type,
				)
			}

			throw new Error("No Namespace in the Program")
		}

		// NOTE: Every plan a derived `Equatable` left on the tree. The Invocation
		// carries it, not the Conformance beside it — `collectConformances` above
		// looks for the other shape — so this is its own walk.
		function derivedDescriptorsIn(
			value: unknown,
		): Array<common.DerivedEquatableDescriptor> {
			let found: Array<common.DerivedEquatableDescriptor> = []
			let seen = new WeakSet<object>()

			let visit = (node: unknown) => {
				if (Array.isArray(node)) {
					for (let element of node) {
						visit(element)
					}

					return
				}

				if (
					node === null ||
					typeof node !== "object" ||
					seen.has(node)
				) {
					return
				}

				seen.add(node)

				let record = node as Record<string, unknown>

				if (record.derivedDescriptor !== undefined) {
					found.push(
						record.derivedDescriptor as common.DerivedEquatableDescriptor,
					)
				}

				for (let key of Object.keys(record)) {
					visit(record[key])
				}
			}

			visit(value)

			return found
		}

		it("should resolve and print an applied Dictionary annotation", () => {
			expect(
				parameterTypeOf(
					`implementation {
						namespace Ages for Integer {
							count(_ entries: Dictionary<String, Integer>) -> Integer {
								<- 0
							}
						}
					}`,
					"count",
				),
			).toBe("Dictionary<String, Integer>")
		})

		it("should resolve a nested Dictionary through both slots", () => {
			expect(
				parameterTypeOf(
					`implementation {
						namespace Ages for Integer {
							count(_ entries: Dictionary<String, List<Dictionary<Integer, Boolean>>>) -> Integer {
								<- 0
							}
						}
					}`,
					"count",
				),
			).toBe("Dictionary<String, List<Dictionary<Integer, Boolean>>>")
		})

		it("should resolve a bare Dictionary annotation", () => {
			expect(
				parameterTypeOf(
					`implementation {
						namespace Ages for Integer {
							count(_ entries: Dictionary) -> Integer {
								<- 0
							}
						}
					}`,
					"count",
				),
			).toBe("Dictionary")
		})

		// NOTE: Two Type Arguments exactly, reported the way `List` reports one
		// — the same code, the same shape, and a Type built out of whatever WAS
		// written so the Declaration underneath does not cascade.
		it("should report too few Type Arguments", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Ages for Integer {
					count(_ entries: Dictionary<String>) -> Integer {
						<- 0
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("wrong-type-argument-count")
			expect(diagnostics[0].message).toBe(
				"Dictionary takes exactly 2 Type Arguments",
			)
		})

		it("should report too many Type Arguments", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Ages for Integer {
					count(_ entries: Dictionary<String, Integer, Boolean>) -> Integer {
						<- 0
					}
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("wrong-type-argument-count")
			expect(diagnostics[0].message).toBe(
				"Dictionary takes exactly 2 Type Arguments",
			)
		})

		// NOTE: The Namespace index buckets both Dictionary spellings under one
		// key, exactly as it buckets the two List ones — so a Namespace written
		// `for Dictionary<Key, Value>` is a candidate for a
		// `Dictionary<String, Integer>` receiver and its Type Parameters bind
		// off that receiver, slot by slot.
		it("should find a Namespace written for a Dictionary", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Boxes<infer Key, infer Value> for Dictionary<Key, Value> {
						sample(_ key: Key, to value: Value) -> Boolean {
							<- true
						}
					}

					function check(_ entries: Dictionary<String, Integer>) -> Boolean {
						<- entries::sample("alex", to 39)
					}
				}`),
			).toEqual([])
		})

		it("should bind each slot of the receiver to its own Type Parameter", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Boxes<infer Key, infer Value> for Dictionary<Key, Value> {
					sample(_ key: Key, to value: Value) -> Boolean {
						<- true
					}
				}

				function check(_ entries: Dictionary<String, Integer>) -> Boolean {
					<- entries::sample(39, to "alex")
				}
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("no-matching-overload")
		})

		it("should answer a Method with the receiver's own slot Types", () => {
			expect(
				printType(
					lastConstantValue(`implementation {
						namespace Boxes<infer Key, infer Value> for Dictionary<Key, Value> {
							anyKey() -> Optional<Key> {
								<- #Empty
							}
						}

						function check(_ entries: Dictionary<String, Integer>) -> Optional<String> {
							<- entries::anyKey()
						}

						constant checker = check
					}`).type,
				),
			).toBe("(_ Dictionary<String, Integer>) -> Optional<String>")
		})

		// NOTE: A Dictionary in a generic Choice's payload — the descriptor its
		// derived `Equatable` follows at run time. The two slots are described
		// APART: `String` names no Type Parameter and compares structurally,
		// while `Value` routes through the witness at its declaration-order
		// index. Reading the slots together would have compared the whole
		// Dictionary structurally, which for a box reading through a shared
		// store is not equality at all.
		it("describes each slot of a Dictionary in a generic Choice's payload", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				choice Holder<Value> {
					Held { entries: Dictionary<String, Value> },
					Blank,
				}

				function same(_ a: Holder<Integer>, _ b: Holder<Integer>) -> Boolean {
					<- a::is(b)
				}
			}`)

			expect(diagnostics).toEqual([])

			let descriptors = derivedDescriptorsIn(program)

			expect(descriptors).toHaveLength(1)
			expect(descriptors[0]).toEqual({
				"Holder#Held": {
					entries: {
						k: "dictionary",
						key: { k: "eq" },
						value: { k: "w", i: 0 },
					},
				},
				"Holder#Blank": {},
			})
		})

		// NOTE: A Namespace targeting a Dictionary must not answer for a List,
		// which is what buckets keyed by kind are for — the two spellings share
		// one bucket with each other and with nothing else.
		it("should not offer a Dictionary Namespace to a List receiver", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Boxes<infer Key, infer Value> for Dictionary<Key, Value> {
					sample(_ key: Key, to value: Value) -> Boolean {
						<- true
					}
				}

				constant answered = [1, 2]::sample(1, to 2)
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unknown-method")
		})
	})
})
