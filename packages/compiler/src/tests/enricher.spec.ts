import { describe, expect, it } from "bun:test"

import type { common, parser } from "@essence-lang/interfaces"

import { builtinNamespaces, builtinProtocols } from "../enricher/builtins"
import { nestingLevelProbes } from "../enricher/enrichers"
import { enrich } from "../enricher/index"
import {
	derivedEquatableNamespace,
	derivedPrintableNamespace,
} from "../enricher/resolvers"
import { computeConformanceMethodMap } from "../helpers/conformance"
import { parse } from "../parser/index"
import { printType } from "../printType"
import { forEachParserChild, type ParserNode } from "../visitor/parser"
import {
	analysedDiagnosticsFor,
	codesOfSource,
	compiles,
	helpsOfCode,
} from "./followedHelps"

function enrichSource(source: string): {
	program: common.typed.Program
	diagnostics: Array<common.Diagnostic>
} {
	return enrich(parse(source))
}

function diagnosticsFor(source: string): Array<common.Diagnostic> {
	return enrichSource(source).diagnostics
}

// The single-line text a Diagnostic's Position covers, which its Quick Fix
// replaces, so a test can check where a span starts without counting columns.
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

// The characters one Position covers, so a test can say where a synthesized
// Node stands.
function spanOf(source: string, position: common.Position): string {
	return source
		.split("\n")
		[position.start.line - 1].slice(
			position.start.column - 1,
			position.end.column - 1,
		)
}

// The typed Expression the Program's last Constant was declared from, to ask
// what a call resolved to. The Program must enrich cleanly, so no test
// asserts on a failed resolution.
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

// The Type an applied `Optional<ItemType>` enriches to: the Union of its two
// Cases, each carrying the bound Type Arguments. Its display alias is the
// applied spelling.
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

// The live Namespace of that name, as every Program's top level Scope holds
// it, so a test asks what a Program can reach. Throws for a missing Namespace,
// so the failure names it.
function builtinNamespace(name: string): common.NamespaceType {
	let namespace = builtinNamespaces().find(
		(candidate) => candidate.name === name,
	)

	if (namespace === undefined) {
		throw new Error(`There is no builtin Namespace named '${name}'`)
	}

	return namespace
}

// Every Case construction in a typed subtree, in build order, to ask what
// unwritten Type Arguments were decided as. A `GenericUse` left in
// `typeArguments` is a Type Parameter nothing decided.
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

// Every resolved Conformance in the typed Program, to assert which Namespace
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

		// The Help and the `data` a Quick Fix writes must name the same thing.
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

		// The bare name, so the Quick Fix replaces exactly what the Diagnostic
		// underlines. The `#` belongs to the Help's rendering.
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

		// The bare form is the preferred spelling, reported from a site of its
		// own, which must carry the near miss too.
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

		// A Case Matcher whose Case was reported, or whose value is an Error,
		// still binds its names, as holes. The body's reads of them are no
		// second mistake.
		it("should bind a Case Matcher's names where its Case is not resolved", () => {
			expect(
				diagnosticsFor(`implementation {
					constant chosen: Optional<Integer> = #Value(1)
					constant broken = zz

					constant first = match chosen -> Integer {
						case #Valu(value) { <- value }
						case _ { <- 0 }
					}
					constant second = match chosen -> Integer {
						case #Valu({ value }) { <- value }
						case _ { <- 0 }
					}
					constant third = match broken -> Integer {
						case #Value(value) { <- value }
						case _ { <- 0 }
					}
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["unknown-name", "unknown-case", "unknown-case"])
		})

		// A subject that only holds the Choice a Case Matcher names is one
		// mistake about the Match. The first such Case Matcher reports it,
		// whatever its arm, with its binding or without.
		it("should report a held Case at the first Case Matcher naming one", () => {
			expect(
				diagnosticsFor(`implementation {
					choice Inner { A { value: Integer }, B }
					choice Outer { Wrap { inner: Inner }, None }

					constant outer: Outer = #Wrap(#A(5))

					constant first = match outer -> Integer {
						case #None     { <- 0 }
						case #A(value) { <- value }
						case #B        { <- 2 }
						case _         { <- 1 }
					}
					constant second = match outer -> Integer {
						case #None { <- 0 }
						case #B    { <- 2 }
						case _     { <- 1 }
					}
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["unknown-case", "unknown-case"])
		})

		// A prefixed Case the value can not be is reported, though the value
		// holds an Error elsewhere, since that Error may carry no report.
		it("should report a prefixed Case a value holding an Error can not be", () => {
			expect(
				diagnosticsFor(`implementation {
					constant mismatched: Result<Result<Integer, String>, Integer> =
						#Value(#Value(1))
					constant flat = mismatched::flatten()

					constant read = match flat -> Integer {
						case Optional#Value(value) { <- value }
						case _ { <- 0 }
					}
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["unknown-case"])
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

		// A Partial is judged by assignability, not identity, so one arm's
		// value fits a Union-typed member, as at the Declaration.
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

		// The Enricher rewrites `{ config with server.port = 1 }` as
		// `{ config with server = { config.server with port = 1 } }`. See "Path
		// keys" in packages/compiler/src/enricher/DEVELOPMENT.md.
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

			// Only the Scope says whether the last step names a binding. The
			// value is spelled from one where it is there, and nothing else is
			// reported where it is not.
			describe("written with no value", () => {
				let written = (keys: string, port = "") => `implementation {
						${config}
						${port}
						constant moved = { config with ${keys} }
					}`

				it("should write the binding the last step names", () => {
					let source = written(
						'server.port, name = "a"',
						"constant port = 8080",
					)

					expect(codesOfSource(source)).toEqual([
						"shorthand-on-path-key",
					])
					expect(
						helpsOfCode(source, "shorthand-on-path-key"),
					).toEqual(["Write 'server.port = port'."])
					expect(
						compiles(
							written(
								'server.port = port, name = "a"',
								"constant port = 8080",
							),
						),
					).toBe(true)
				})

				it("should report once, and ask for the value, where nothing is bound", () => {
					let source = written('server.port, name = "a"')

					expect(codesOfSource(source)).toEqual([
						"shorthand-on-path-key",
					])
					expect(
						helpsOfCode(source, "shorthand-on-path-key"),
					).toEqual([
						"Write the value it sets in place of '…': 'server.port = …'.",
					])
					expect(
						compiles(written('server.port = 8080, name = "a"')),
					).toBe(true)
				})

				it("should report a bare path in a descend and beside a bare name", () => {
					expect(
						codesOfSource(written("server.{ tls.enabled }")),
					).toEqual(["shorthand-on-path-key"])
					expect(
						codesOfSource(
							written("server.port, name", 'constant name = "b"'),
						),
					).toEqual([
						"shorthand-on-path-key",
						"shorthand-in-combination",
					])
				})

				// The offered Record holds every bare key, so following one report
				// drops no other key. It is offered only where every name is bound.
				it("should write each bare name's binding, and merge them only where all are bound", () => {
					let base = `constant base = { port = 80, host = "localhost" }
						constant port = 8080`
					let update = (keys: string, host = 'constant host = "h"') =>
						`implementation {
						${base}
						${host}
						constant server = { base with ${keys} }
					}`
					let merged =
						"Or merge a whole Record: '{ base with { port, host } }'."

					expect(
						analysedDiagnosticsFor(update("port, host")).flatMap(
							(diagnostic) => diagnostic.helps,
						),
					).toEqual([
						"Write 'port = port'.",
						merged,
						"Write 'host = host'.",
						merged,
					])
					expect(compiles(update("{ port, host }"))).toBe(true)
					expect(compiles(update("port = port, host = host"))).toBe(
						true,
					)
				})

				// The merged Record keeps the keys written beside the bare name,
				// each value as written, so following it drops none.
				it("should merge the written keys along with the bare name", () => {
					let update = (keys: string) => `implementation {
						constant base = { port = 80, name = "a" }
						constant port = 8080
						constant server = { base with ${keys} }
					}`

					expect(
						helpsOfCode(
							update('port, name = "x"'),
							"shorthand-in-combination",
						),
					).toEqual([
						"Write 'port = port'.",
						"Or merge a whole Record: '{ base with { port, name = … } }', with each value as it is written.",
					])
					expect(compiles(update('{ port, name = "x" }'))).toBe(true)
				})

				it("should report an unbound bare name once, and ask for its value", () => {
					let source = `implementation {
						constant base = { port = 80, host = "localhost" }
						constant port = 8080
						constant server = { base with port, host }
					}`

					expect(codesOfSource(source)).toEqual([
						"shorthand-in-combination",
						"shorthand-in-combination",
					])
					expect(
						analysedDiagnosticsFor(source).flatMap(
							(diagnostic) => diagnostic.helps,
						),
					).toEqual([
						"Write 'port = port'.",
						"Write the value it sets in place of '…': 'host = …'.",
					])
					expect(
						compiles(
							source.replace(
								"{ base with port, host }",
								'{ base with port = port, host = "example.com" }',
							),
						),
					).toBe(true)
				})

				// A plain Literal updates nothing, so the key reaches into
				// nothing, with or without a value, and its own Help says so.
				it("should report a plain Record Literal's as a key outside an update", () => {
					let source = `implementation {
						constant blank = { server.port }
					}`

					expect(codesOfSource(source)).toEqual([
						"path-key-outside-combination",
					])
					expect(
						compiles(`implementation {
						constant blank = { server = { port = 1 } }
					}`),
					).toBe(true)
				})

				// The report is made where the key list is read, so a walk that
				// stops before the leaf loses it to nothing.
				it("should report a bare path key wherever the walk stops", () => {
					for (let [keys, other] of [
						['srever.port, name = "a"', "unknown-member"],
						[
							'server.port.deep, name = "a"',
							"path-step-not-a-record",
						],
					]) {
						expect(
							codesOfSource(
								written(keys as string),
							) as Array<string>,
						).toEqual(["shorthand-on-path-key", other])
					}

					for (let [declarations, other] of [
						["constant base = 5", "uncombinable-types"],
						["", "unknown-name"],
					]) {
						expect(
							codesOfSource(`implementation {
						${declarations}
						constant moved = { base with server.port, name = 5 }
					}`).sort() as Array<string>,
						).toEqual(
							[other as string, "shorthand-on-path-key"].sort(),
						)
					}
				})
			})

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

			// Two keys through `server` each read `config.server`, in a Lookup of
			// its own, so a pass rewriting one never rewrites the other.
			it("should build each Lookup of a shared step from Nodes of its own", () => {
				let value = lastConstantValue(`implementation {
					${config}
					constant both = {
						config with
							server.tls.enabled = true,
							server.port = 1,
					}
				}`)
				let lookups: Array<common.typed.LookupNode> = []

				function collect(entry: unknown) {
					if (entry === null || typeof entry !== "object") {
						return
					}

					let fields = entry as Record<string, unknown>

					if (fields.nodeType === "Lookup") {
						lookups.push(entry as common.typed.LookupNode)
					}

					for (let key of Object.keys(fields)) {
						if (key !== "type") {
							collect(fields[key])
						}
					}
				}

				collect(value)

				let members = lookups.map((lookup) => lookup.member)

				expect(lookups.length).toBeGreaterThan(1)
				expect(new Set(members).size).toBe(members.length)
			})

			// Every level keeps the Alias it was reached under, since an update
			// writes only members the original declares.
			it("should answer the Type of the value updated", () => {
				let value = lastConstantValue(`implementation {
					${config}
					constant moved = { config with server.port = 8080 }
				}`)

				expect(value.type).toEqual({
					type: "Record",
					name: "Config",
					members: {
						name: { type: "String" },
						server: {
							type: "Record",
							name: "Server",
							members: {
								host: { type: "String" },
								port: { type: "Integer" },
								tls: {
									type: "Record",
									name: "Tls",
									members: { enabled: { type: "Boolean" } },
								},
							},
						},
					},
				})
			})

			// INVARIANT: a synthesized Lookup's member Identifier stands at the
			// step that spelled it, which renames, Hovers and semantic tokens rely
			// on.
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

			// A refused path's value is still read, so a mistake inside it is
			// a report of its own.
			it("should report a mistake inside a refused path key's value", () => {
				expect(
					diagnosticsFor(`implementation {
						${config}

						function load() -> Config {
							<- config
						}

						constant loaded = { load() with server.port = 1::add("q") }
						constant renamed = { config with name.length = 1::add("q") }
						constant missing = { config with nope.port = 1::add("q") }
						constant grouped = { config with nope.{ port = 1::add("q") } }
						constant loose: Config = { server.port = 1::add("q") }
					}`).map((diagnostic) => diagnostic.code),
				).toEqual([
					"path-on-computed-value",
					"no-matching-overload",
					"path-step-not-a-record",
					"no-matching-overload",
					"unknown-member",
					"no-matching-overload",
					"unknown-member",
					"no-matching-overload",
					"path-key-outside-combination",
					"no-matching-overload",
				])
			})

			// The value reads the member its path names where the Type in hand
			// declares it. Past a step that does not resolve, it stands in a
			// refused place, so a bare Case there is no second mistake.
			it("should read a refused path key's value where its path stands", () => {
				expect(
					diagnosticsFor(`implementation {
						choice Light { Red, Green }
						choice Paint { Red, Blue }
						type Lamp = { light: Light }
						type Room = { lamp: Lamp }

						function load() -> Room {
							<- { lamp = { light = #Green } }
						}

						constant loaded = { load() with lamp.light = #Red }
						constant missing = { load() with lmp.light = #Red }
						constant loose: Room = { lamp.light = #Red }
					}`).map((diagnostic) => diagnostic.code),
				).toEqual([
					"path-on-computed-value",
					"path-on-computed-value",
					"path-key-outside-combination",
				])
			})

			// `@` is a place, and the one a Method's nested update is
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

			// A braced descend reaches one step in exactly as a dotted key
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
				expect(diagnostics[0].helps).toEqual([
					"Write the whole member: 'server = { … }'.",
					"Or update a value that already has it: '{ original with server.port = … }'.",
				])
			})

			it("should compile either way its Helps are followed", () => {
				expect(
					compiles(`implementation {
					constant blank = { server = { port = 8080 } }
				}`),
				).toBe(true)
				expect(
					compiles(`implementation {
					constant original = { server = { port = 80 } }
					constant blank = { original with server.port = 8080 }
				}`),
				).toBe(true)
			})

			// A Record annotation is no value under the Literal, which writes
			// its members from nothing.
			it("should refuse a path key under a Record annotation", () => {
				let diagnostics = diagnosticsFor(`implementation {
					${config}
					constant blank: Config = { name = "api", server.port = 1 }
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("path-key-outside-combination")
			})

			// The member the path meant holds a hole, so the Literal is not
			// measured as lacking it, nor is a read through it refused.
			it("should report a refused path key once in the whole analysis", () => {
				expect(
					codesOfSource(`implementation {
					${config}
					constant blank: Config = { name = "api", server.port = 1 }
					constant grouped: Config = { name = "api", server.{ port = 1 } }
					constant loose = { name = "api", server.port = 1 }
					constant read = loose.server.port
				}`),
				).toEqual([
					"path-key-outside-combination",
					"path-key-outside-combination",
					"path-key-outside-combination",
				])
			})
		})

		// An Argument for a defaulted Record Parameter, or a payload for a
		// defaulting Case, merges into the default as `{ default with argument }`.
		// So it carries path keys as a `with` does.
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

			it("should report a path key with no value once, as an Argument or a payload", () => {
				expect(
					codesOfSource(`implementation {
						${options}

						constant a = connect(using { server.port })
					}`),
				).toEqual(["shorthand-on-path-key"])
				expect(
					codesOfSource(`implementation {
						choice Fetch {
							Get { limits: { calls: Integer } } = { limits = { calls = 1 } },
						}

						constant value: Fetch = #Get({ limits.calls })
					}`),
				).toEqual(["shorthand-on-path-key"])
			})

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

			// A plain key and a path key stand side by side, as after a `with`.
			it("should admit a path key beside a plain one", () => {
				expect(
					diagnosticsFor(`implementation {
						${options}

						constant a = connect(using { retries = 9, server.port = 1 })
					}`),
				).toEqual([])
			})

			// The Node keeps the partial Type it wrote, since later stages see
			// only the members really written.
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

			// A written member a path key reaches is evidence for a refinement
			// only where the predicate holds of it, at a selected call too.
			it("should admit a path key's written member only where the predicate holds", () => {
				let source = (port: string) => `implementation {
					type Server = { port: PositiveInteger, host: String }

					namespace Tool for Integer {
						configure(using settings: { server: Server } = { server = { port = 80, host = "a" } }) -> Integer {
							<- settings.server.port
						}
					}

					constant a = 1::configure(using { server.port = ${port} })
				}`

				expect(diagnosticsFor(source("8080"))).toEqual([])
				expect(
					diagnosticsFor(source("0")).map(
						(diagnostic) => diagnostic.code,
					),
				).toEqual(["no-matching-overload"])
			})

			// Only the merged Literal merges, so a path key inside a member's own
			// Literal reaches into nothing.
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

		// A written member is evidence for a refinement only where the
		// predicate holds of it. A computed one needs a check.
		it("should report an update writing what a refined member refuses", () => {
			expect(
				diagnosticsFor(`implementation {
					type Counted = { count: NonZeroInteger, label: String }

					constant counted: Counted = { count = 1, label = "a" }
					constant three = 3
					constant zero = { counted with count = 0 }
					constant computed = { counted with count = three }
				}`).map((diagnostic) => [
					diagnostic.code,
					diagnostic.labels[0]?.message,
				]),
			).toEqual([
				[
					"partial-type-mismatch",
					"this is an Integer, and Counted declares a NonZeroInteger",
				],
				[
					"partial-type-mismatch",
					"this is an Integer, and Counted declares a NonZeroInteger",
				],
			])
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

		// A member named after an `Object.prototype` member must not find the
		// JavaScript builtin.
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

		// The standard library declares `toString` over a Record, so a Lookup
		// of it meets the separator rule. Any other prototype member reports
		// `unknown-member`.
		it("should report a Lookup of a member only Object.prototype has", () => {
			expect(
				diagnosticsFor(`implementation {
					constant a = { name = "x" }
					constant b = a.toString
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["method-called-with-dot"])

			expect(
				diagnosticsFor(`implementation {
					constant a = { name = "x" }
					constant b = a.hasOwnProperty
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["unknown-member"])
		})

		// A bare member name is read as well as written, so the report says it
		// is a shorthand.
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

		// A Function conforms to nothing, whatever it returns.
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

		// The receiver is computed. A written one proves its own sign,
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
			// The Optional's payload decides its conformance. The List is bound
			// to a `List` Type, or `firstItem` would answer the Function bare.
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
			// The span is the call alone, which the Quick Fix deletes.
			expect(underlinedText(source, diagnostics[0])).toBe("::toString()")
			expect(diagnostics[0].tags).toEqual(["unnecessary"])
		})

		// A Warning does not stop a compile, so the Program is also asked to
		// report nothing once the Help is followed.
		it("should report nothing once the call is dropped", () => {
			let source = `implementation {
				constant count = 3
				constant message = "count: {count::toString()}"
			}`

			expect(diagnosticsFor(source)[0]?.helps).toEqual([
				"Drop the '::toString()' and interpolate the value itself.",
			])

			let followed = source.replace("{count::toString()}", "{count}")

			expect(compiles(followed)).toBe(true)
			expect(diagnosticsFor(followed)).toEqual([])
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
			// `Rational.toString(as:)` picks a form the hole would not, so the
			// call is needed.
			expect(
				diagnosticsFor(`implementation {
					constant message = "half: {1/2::toString(as NumberFormat#Decimal)}"
				}`),
			).toEqual([])
		})

		it("should accept a 'toString' on a receiver that is not Printable itself", () => {
			// A structural Union conforms to nothing, so only the explicit call,
			// resolved per member, works.
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

		// Only a `constant` Declaration can be rewritten with `variable`. Any
		// other name takes the new value under a name of its own.
		let freshNameHelp =
			"Declare the new value under a name of its own, with 'constant' or 'variable'."

		function reassignmentOf(source: string): common.Diagnostic {
			let found = diagnosticsFor(source).find(
				(diagnostic) => diagnostic.code === "constant-reassignment",
			)

			if (found === undefined) {
				throw new Error("No 'constant-reassignment' reported.")
			}

			return found
		}

		it("should ask a new value for a Namespace's name to take a name of its own", () => {
			let program = (statement: string): string => `implementation {
				namespace Clock {
					static now() -> Integer {
						<- 1
					}
				}

				${statement}
			}`
			let diagnostic = reassignmentOf(program("Clock = 5"))

			expect(diagnostic.helps).toEqual([freshNameHelp])
			expect(diagnostic.notes).toEqual([
				"'Clock' is a Namespace, which holds Methods and statics and is no value of its own.",
			])
			expect(compiles(program("constant clockValue = 5"))).toBe(true)
		})

		// No Scope binds a Type's name as a value, so the assignment is
		// refused for what the name is, never as a name nothing declares.
		it.each([
			[
				"a Choice",
				"Colour",
				"choice Colour {\n\t\t\t\t\tRed,\n\t\t\t\t}",
			],
			["a Type", "Size", "type Size = Integer"],
			[
				"a Protocol",
				"Shown",
				"protocol Shown {\n\t\t\t\t\tshow() -> String\n\t\t\t\t}",
			],
		])(
			"should ask a new value for %s's name to take a name of its own",
			(kind, name, declaration) => {
				let program = (statement: string): string => `implementation {
				${declaration}

				${statement}
			}`

				expect(codesOfSource(program(`${name} = 5`))).toEqual([
					"constant-reassignment",
				])

				let diagnostic = reassignmentOf(program(`${name} = 5`))

				expect(diagnostic.helps).toEqual([freshNameHelp])
				expect(diagnostic.notes).toEqual([
					`'${name}' is ${kind}, which is no value of its own.`,
				])
				expect(compiles(program("constant fresh = 5"))).toBe(true)
			},
		)

		it("should ask a new value for a Function's name to take a name of its own", () => {
			let program = (statement: string): string => `implementation {
				function greet() -> String {
					<- "hi"
				}

				${statement}
			}`
			let diagnostic = reassignmentOf(program("greet = 5"))

			expect(diagnostic.helps).toEqual([freshNameHelp])
			expect(diagnostic.notes).toEqual([
				"Only a name declared with 'variable' can be given a new value.",
			])
			expect(compiles(program("constant greeting = 5"))).toBe(true)
		})

		it("should ask a new value for a Parameter's name to take a name of its own", () => {
			let program = (statement: string): string => `implementation {
				function greet(_ name: String) -> String {
					${statement}
					<- name
				}
			}`
			let diagnostic = reassignmentOf(program(`name = "other"`))

			expect(diagnostic.helps).toEqual([freshNameHelp])
			expect(diagnostic.labels.map((label) => label.message)).toEqual([
				"assigned to here",
				"declared here",
			])
			expect(compiles(program(`constant other = "other"`))).toBe(true)
		})

		it("should offer 'variable' for a name a Pattern Constant binds", () => {
			let program = (keyword: string): string => `implementation {
				${keyword} { a } = { a = 1 }
				a = 2
			}`

			expect(reassignmentOf(program("constant")).helps).toEqual([
				"Declare it with 'variable' instead of 'constant' if it needs to change.",
			])
			expect(compiles(program("variable"))).toBe(true)
		})

		// A Namespace or a Function can be no Variable, so the assignment is
		// the one mistake and its value is judged against nothing. A written
		// Constant may become a Variable, which leaves a value of the wrong
		// Type a mistake of its own.
		it("should judge no value against a name that can be no Variable", () => {
			let codes = (declaration: string) =>
				codesOfSource(`implementation {
				${declaration}

				Clock = 5
			}`)

			expect(
				codes(
					"namespace Clock {\n\t\t\t\t\tstatic now() -> Integer {\n\t\t\t\t\t\t<- 1\n\t\t\t\t\t}\n\t\t\t\t}",
				),
			).toEqual(["constant-reassignment"])
			expect(
				codes(
					'function Clock() -> String {\n\t\t\t\t\t<- "hi"\n\t\t\t\t}',
				),
			).toEqual(["constant-reassignment"])
			expect(codes('constant Clock = "twelve"')).toEqual([
				"constant-reassignment",
				"assignment-type-mismatch",
			])
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

		// A Constant never hoists, so the value can not be read while hoisting.
		// The annotation stands in for it.
		it("should hoist a Namespace whose annotated static Property reads a Constant", () => {
			expect(
				diagnosticsFor(`implementation {
					constant size = 4

					function doubledSize() -> Integer {
						<- size::doubled()::add(Sized.base)
					}

					namespace Sized for Integer {
						static base: Integer = size

						doubled() -> Integer { <- @::multiply(with 2) }
					}

					Terminal.inspect(doubledSize())
				}`),
			).toEqual([])
		})

		it("should type such a Property by its value below its Namespace", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				constant size = 4

				function early() -> Integer | String {
					<- Sized.base
				}

				namespace Sized {
					static base: Integer | String = size
				}

				constant late = Sized.base
			}`)

			expect(diagnostics).toEqual([])

			let late = program.implementation.nodes.at(-1)

			expect(late?.nodeType).toBe("ConstantDeclarationStatement")
			expect(
				late?.nodeType === "ConstantDeclarationStatement"
					? printType(late.type)
					: null,
			).toBe("Integer")
		})

		// `B.z` read `A.x` while hoisting, as the annotation's Union.
		it("should type a Property that read such a Property by its value too", () => {
			expect(
				diagnosticsFor(`implementation {
					constant base = 4

					namespace A for Integer {
						static x: Integer | String = base
					}

					namespace B for Integer {
						static z = A.x
					}

					Terminal.inspect(B.z::add(1))
				}`),
			).toEqual([])
		})

		// The Method a call above the Namespace answers with no longer depends
		// on whether a static Property of the Namespace reads a Constant.
		it("should answer a refinement's Method from a Namespace whose static Property reads a Constant", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				type NonZero = Integer where @::isNot(0)

				constant base = 10

				namespace Wide for Integer {
					label() -> String { <- "wide" }
				}

				function describe(_ n: NonZero) -> String {
					<- n::label()
				}

				namespace Narrow for NonZero {
					static scale: Integer = base

					label() -> String { <- "narrow" }
				}
			}`)

			expect(diagnostics).toEqual([])

			let describe = program.implementation.nodes.find(
				(node) => node.nodeType === "FunctionStatement",
			)
			let answer =
				describe?.nodeType === "FunctionStatement"
					? describe.value.body[0]
					: undefined

			expect(
				answer?.nodeType === "ReturnStatement" &&
					answer.expression.nodeType === "MethodInvocation"
					? answer.expression.namespace.name
					: null,
			).toBe("Narrow")
		})

		// Without an annotation the Property has no Type while hoisting, but
		// nothing above the Namespace reads it here.
		it("should hoist a Namespace whose unannotated static Property reads a Constant", () => {
			expect(
				diagnosticsFor(`implementation {
					function useIt() -> Integer {
						<- Sizes.doubled()::add(3::tripled())
					}

					constant size = 4

					namespace Sizes for Integer {
						static base = size

						static doubled() -> Integer {
							<- Sizes.base::multiply(with 2)
						}

						tripled() -> Integer {
							<- @::multiply(with 3)
						}
					}

					Terminal.inspect(useIt())
				}`),
			).toEqual([])
		})

		it("should answer a refinement's Method from such a Namespace without an annotation", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				type NonZero = Integer where @::isNot(0)

				constant base = 10

				namespace Wide for Integer {
					label() -> String { <- "wide" }
				}

				function describe(_ n: NonZero) -> String {
					<- n::label()
				}

				namespace Narrow for NonZero {
					static scale = base

					label() -> String { <- "narrow" }
				}
			}`)

			expect(diagnostics).toEqual([])

			let describe = program.implementation.nodes.find(
				(node) => node.nodeType === "FunctionStatement",
			)
			let answer =
				describe?.nodeType === "FunctionStatement"
					? describe.value.body[0]
					: undefined

			expect(
				answer?.nodeType === "ReturnStatement" &&
					answer.expression.nodeType === "MethodInvocation"
					? answer.expression.namespace.name
					: null,
			).toBe("Narrow")
		})

		// `size` is declared by the time `useIt` reads `Sizes.base`, so the
		// value is typed there.
		it("should type an unannotated static Property where it is read once its value resolves", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				constant size = 4

				function useIt() -> Integer {
					<- Sizes.base
				}

				namespace Sizes {
					static base = size
				}

				constant late = Sizes.base
			}`)

			expect(diagnostics).toEqual([])

			let late = program.implementation.nodes.at(-1)

			expect(
				late?.nodeType === "ConstantDeclarationStatement"
					? printType(late.type)
					: null,
			).toBe("Integer")
		})

		// Whether the read is refused depends on what runs before the
		// Namespace, which only the validator knows.
		it("should answer a read it can not type with an Error and no report", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				function useIt() -> Integer {
					<- Sizes.base
				}

				constant size = 4

				namespace Sizes {
					static base = size
				}
			}`)

			expect(diagnostics).toEqual([])

			let useIt = program.implementation.nodes[0]
			let answer =
				useIt?.nodeType === "FunctionStatement"
					? useIt.value.body[0]
					: undefined

			expect(
				answer?.nodeType === "ReturnStatement"
					? answer.expression.type.type
					: null,
			).toBe("Error")
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

		// The undeclared Type is the one mistake. The Function hoists holding
		// it, so a call written above it reads a hole rather than no name.
		it("should hoist a Function whose Parameter Type is declared nowhere", () => {
			expect(
				diagnosticsFor(`implementation {
					function early() -> String {
						<- describe(1)
					}

					constant now = describe(2)

					function describe(_ value: Colr) -> String {
						<- "x"
					}

					constant later = describe(3)
				}`).map((diagnostic) => [diagnostic.code, diagnostic.message]),
			).toEqual([["unknown-type", "Type 'Colr' is not declared"]])
		})

		// `Pair` never hoists, so the Function naming it is read in order,
		// once `Pair` is declared, rather than refused for naming it.
		it("should leave a Function naming a Type still waiting to its place", () => {
			expect(
				diagnosticsFor(`implementation {
					type Pair = Integer | Colr

					function describe(_ value: Pair) -> String {
						<- "x"
					}

					constant later = describe(3)
				}`).map((diagnostic) => diagnostic.message),
			).toEqual(["Type 'Colr' is not declared"])
		})

		// `Pair` and then `Tools` hoist holding their own holes first, and `f`
		// hoists holding its hole after them.
		it("should hoist such a Function beside other refused declarations", () => {
			expect(
				diagnosticsFor(`implementation {
					constant early = f(1)

					function f(_ x: Colr) -> Integer {
						<- 1
					}

					type Pair = { a: Colr }

					namespace Tools for Integer {
						paint(_ c: Colr) -> Integer {
							<- 1
						}
					}
				}`).map((diagnostic) => [
					diagnostic.code,
					diagnostic.position?.start.line,
				]),
			).toEqual([
				["unknown-type", 8],
				["unknown-type", 11],
				["unknown-type", 4],
			])
		})

		// `Pair` holds its undeclared member for good, so it hoists holding
		// the hole and the Function above it reads a Type rather than no name.
		it("should hoist a Type whose declaration names a Type declared nowhere", () => {
			expect(
				diagnosticsFor(`implementation {
					function describe(_ value: Pair) -> String {
						<- "x"
					}

					constant now = describe(1)

					type Pair = Integer | Colr
				}`).map((diagnostic) => [diagnostic.code, diagnostic.message]),
			).toEqual([["unknown-type", "Type 'Colr' is not declared"]])
		})

		// `Outer` hoists holding the hole `Pair` holds, which frees the
		// Namespace for it to hoist too, so `describe` reaches its Method.
		it("should hoist a Namespace for a refused Type after that Type", () => {
			expect(
				diagnosticsFor(`implementation {
					function describe(_ value: Outer) -> String {
						<- value::label()
					}

					function named(_ value: Outer) -> String {
						<- Labels.label(value)
					}

					namespace Labels for Outer {
						label() -> String {
							<- "l"
						}
					}

					type Outer = { inner: Pair, n: Integer }

					type Pair = Integer | Colr
				}`).map((diagnostic) => [
					diagnostic.code,
					diagnostic.position?.start.line,
				]),
			).toEqual([["unknown-type", 18]])
		})

		it("should hoist a Protocol whose Method names a Type declared nowhere", () => {
			expect(
				diagnosticsFor(`implementation {
					function describe<infer T is Shows>(_ value: T) -> String {
						<- value::shown()
					}

					namespace Numbers for Integer is Shows {
						show() -> Colr {
							<- 1
						}
					}

					protocol Shows {
						show() -> Colr

						shown() -> String {
							<- "s"
						}
					}
				}`).map((diagnostic) => [
					diagnostic.code,
					diagnostic.position?.start.line,
				]),
			).toEqual([
				["unknown-type", 13],
				["unknown-type", 7],
			])
		})

		// `Pair` hoists first, which frees `Outer` and the bound naming
		// `Shows` to hoist after it.
		it("should hoist a declaration naming a refused Type after that Type", () => {
			expect(
				diagnosticsFor(`implementation {
					function describe(_ value: Outer) -> String {
						<- "x"
					}

					constant kept: Outer = { inner = 1 }

					namespace Labels for Outer {
						label() -> String {
							<- "l"
						}
					}

					type Outer = { inner: Pair }

					type Pair = Integer | Colr

					type Boxed<T is Shows> = { value: T }

					protocol Shows {
						show() -> Colr
					}
				}`).map((diagnostic) => [
					diagnostic.code,
					diagnostic.position?.start.line,
				]),
			).toEqual([
				["unknown-type", 16],
				["unknown-type", 21],
			])
		})

		it("should hoist a Protocol extending one declared after it", () => {
			expect(
				diagnosticsFor(`implementation {
					protocol Fancy is Named {
						describe() -> String {
							<- "*{@::name()}*"
						}
					}

					protocol Named {
						name() -> String
					}

					type Person = { who: String }

					namespace People for Person is Fancy {
						name() -> String {
							<- @.who
						}
					}

					constant person: Person = { who = "Ada" }
					constant described = person::describe()
				}`),
			).toEqual([])
		})

		// `Proper` hoists with its predicate still unread, so the first
		// round's reading of `greet("Ada")` has to wait for the fill.
		it("should retry a declaration that reads a predicate not filled yet", () => {
			expect(
				diagnosticsFor(`implementation {
					type Proper = String where @::isProper()

					namespace Naming for String {
						isProper() -> Boolean {
							<- @::hasCharacters()
						}
					}

					function greet(_ name: Proper) -> String {
						<- name
					}

					namespace Greeter {
						static hello = greet("Ada")
					}
				}`),
			).toEqual([])
		})

		// Only the first read throws, so the throw is one only hoisting
		// meets and the in-order enrichment reads the Function whole.
		it("should report a throw during hoisting where it happened", () => {
			let program = parse(`implementation {
				function answer() -> Integer {
					<- 42
				}
			}`)
			let node = program.implementation
				.nodes[0] as parser.FunctionStatementNode
			let value = node.value
			let reads = 0

			Object.defineProperty(node, "value", {
				get: () => {
					reads += 1

					if (reads === 1) {
						throw new Error("the resolver broke")
					}

					return value
				},
			})

			expect(
				enrich(program).diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.message,
					diagnostic.position?.start.line,
				]),
			).toEqual([
				[
					"internal-error",
					"Internal Compiler Error: the resolver broke",
					2,
				],
			])
		})

		// Reading `Fits` checks the `5` against `Small`, whose predicate
		// is still unread when `Fits` is reached.
		it("should read a predicate that checks a value against a refinement still pending", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				type Small = Integer where @::isLessThan(10)

				namespace Fitting for Integer {
					fits(_ limit: Small) -> Boolean {
						<- @::isLessThan(limit)
					}
				}

				type Fits = Integer where @::fits(5)
			}`)
			let fits = program.implementation.nodes.findLast(
				(node) => node.nodeType === "TypeAliasStatement",
			)

			expect(diagnostics).toEqual([])
			expect(fits?.type).toEqual({
				type: "Refinement",
				name: "Fits",
				base: { type: "Integer" },
				conjuncts: [
					{
						namespaceName: "Integer",
						methodName: "isLessThan",
						negated: false,
						args: ["5"],
						spelling: { methodName: "fits", args: ["5"] },
					},
				],
			})
		})

		// `Greeter` waits on `Fits` and `Fits` on `Small`, so both have to
		// be filled in the round `Greeter` is retried in. Left to the in-order
		// enrichment instead, `Greeter` is not declared where `greeting` reads it.
		it("should hoist a declaration waiting on a predicate that waits on another", () => {
			expect(
				diagnosticsFor(`implementation {
					function greeting() -> Integer {
						<- Greeter.hello
					}

					type Small = Integer where @::isLessThan(10)

					namespace Fitting for Integer {
						fits(_ limit: Small) -> Boolean {
							<- @::isLessThan(limit)
						}
					}

					type Fits = Integer where @::fits(5)

					function checked(_ value: Fits) -> Integer {
						<- value
					}

					namespace Greeter {
						static hello = checked(3)
					}
				}`),
			).toEqual([])
		})

		// `fitsFive`'s body can be read only once `Small` is filled, so another
		// round must read it again for `Five`.
		it("should hoist a declaration waiting on a predicate read through a Method body that waits on another", () => {
			expect(
				diagnosticsFor(`implementation {
					function greeting() -> Integer {
						<- Greeter.hello
					}

					type Small = Integer where @::isLessThan(10)

					namespace Fitting for Integer {
						fits(_ limit: Small) -> Boolean {
							<- @::isLessThan(limit)
						}

						fitsFive() -> Boolean {
							<- @::fits(5)
						}
					}

					type Five = Integer where @::fitsFive()

					function checked(_ value: Five) -> Integer {
						<- value
					}

					namespace Greeter {
						static hello = checked(3)
					}
				}`),
			).toEqual([])
		})

		it("should read a Method body that checks a value against a refinement still pending", () => {
			expect(
				diagnosticsFor(`implementation {
					type Small = Integer where @::isLessThan(10)

					namespace Fitting for Integer {
						fits(_ limit: Small) -> Boolean {
							<- @::isLessThan(limit)
						}

						fitsFive() -> Boolean {
							<- @::fits(5)
						}
					}
				}`),
			).toEqual([])
		})

		it("should read a provided Method body that checks a value against a refinement still pending", () => {
			expect(
				diagnosticsFor(`implementation {
					type Small = Integer where @::isLessThan(10)

					protocol Sized {
						fits(_ limit: Small) -> Boolean

						fitsFive() -> Boolean {
							<- @::fits(5)
						}
					}
				}`),
			).toEqual([])
		})

		// `Middle` only waits on the cycle, so it is read once the cycle
		// is reported and reports nothing itself.
		it("should report predicates that wait on each other", () => {
			expect(
				diagnosticsFor(`implementation {
					type Low = Integer where @::isBelow(5)
					type High = Integer where @::isAbove(5)

					namespace Bounds for Integer {
						isBelow(_ limit: High) -> Boolean {
							<- @::isLessThan(limit)
						}

						isAbove(_ limit: Low) -> Boolean {
							<- @::isGreaterThan(limit)
						}
					}

					type Middle = Integer where @::isBelow(7)
				}`).map((diagnostic) => [
					diagnostic.code,
					diagnostic.message,
					diagnostic.position?.start.line,
				]),
			).toEqual([
				[
					"recursive-type-declaration",
					"The predicate of 'Low' depends on itself through 'High'",
					2,
				],
				[
					"recursive-type-declaration",
					"The predicate of 'High' depends on itself through 'Low'",
					3,
				],
			])
		})

		it("should report a predicate that waits on itself", () => {
			expect(
				diagnosticsFor(`implementation {
					type Fitting = Integer where @::fitsUnder(5)

					namespace Fits for Integer {
						fitsUnder(_ limit: Fitting) -> Boolean {
							<- @::isLessThan(limit)
						}
					}
				}`).map((diagnostic) => [
					diagnostic.code,
					diagnostic.message,
					diagnostic.labels.map((label) => label.message),
				]),
			).toEqual([
				[
					"recursive-type-declaration",
					"The predicate of 'Fitting' depends on itself",
					["reading this checks a value against 'Fitting'"],
				],
			])
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

		// A written List reaches `NonEmptyList::firstItem`, which answers the
		// item bare. The receiver decides `ItemType` either way.
		it("should infer List item Types through Method Invocations", () => {
			expect(
				typeOfFirstConstant(`implementation {
					constant first = [1, 2]::firstItem()
				}`),
			).toEqual({ type: "Integer" })
		})

		it("should infer map's result Type from the callback's return", () => {
			// `Result` occurs only in the callback's return and `map`'s. The
			// callback is contextually typed, so `n` needs no annotation. Printed,
			// since `NonEmptyList::map` carries the receiver's proof.
			expect(
				printType(
					typeOfFirstConstant(`implementation {
						constant texts = [1, 2]::map((n) { <- n::toString() })
					}`),
				),
			).toBe("NonEmptyList<String>")
		})

		it("should infer reduce's result Type from the starting value", () => {
			// `Result` binds from `startingWith` before the callback is
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
			// `isGreaterThan` only resolves if `n` typed as Integer, so
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
			// `firstAgain` returns `firstItem`'s `Optional<Item>` answer. The
			// receiver alone binds `Item` to String.
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
			// The shape of `List.firstItem(where:)`. `reduce`'s own Generic is
			// also `ItemType`, so the receiver binds `ItemType := ItemType`.
			// `isOpenBindable` treats that as opaque, so inference terminates.
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
			// The caller's opaque `State` and `loop`'s bindable `State` share a
			// spelling, and the threaded Record mentions it. The callee's Generics
			// are freshened for the match, so `State := { carried: State }` does
			// not substitute into itself.
			expect(
				diagnosticsFor(`implementation {
					function myCount<infer State>(
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

		// `Step`'s first Parameter and `myCount`'s are both `State`. The Case
		// construction freshens its Choice's Generics, so `#Done` binds `Result`
		// rather than `Step`'s `State`.
		it("freshens a Choice's own Generics against a same-named caller Generic", () => {
			let { program, diagnostics } = enrichSource(`implementation {
				function myCount<infer State>(
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

		// A Function literal Argument may omit annotations and take them from
		// its Parameter, label included, so `(item)` and `(_ item)` mean the
		// same here.
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

			it("pairs a typed `_` with the expected Parameter", () => {
				expect(
					typeOfFirstConstant(`implementation {
						constant kept = [1, 2, 3]::removeEvery(
							where (_: Integer) { <- true },
						)
					}`),
				).toEqual({ type: "List", itemType: { type: "Integer" } })
			})

			it("pairs a label written before `_` with the expected label", () => {
				expect(
					typeOfFirstConstant(`implementation {
						function twice(_ rule: (on: Integer) -> Integer) -> Integer {
							<- rule(on rule(on 1))
						}

						constant twiced = twice((on _: Integer) { <- 2 })
					}`),
				).toEqual({ type: "Integer" })
			})

			it("refuses a label before `_` the expected signature lacks", () => {
				expect(
					diagnosticsFor(`implementation {
						constant zeros = [1, 2]::map((on _: Integer) { <- 0 })
					}`).map((diagnostic) => diagnostic.code),
				).toEqual(["no-matching-overload"])
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
				// `isBetween` is `Orderable`'s and a String is only
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

				// One Diagnostic: the return Type fails only because the
				// Parameter does.
				expect(
					diagnostics.map((diagnostic) => diagnostic.message),
				).toEqual(["The Type of Parameter 'x' could not be inferred"])
			})

			it("reports an omitted return Type outside Argument position", () => {
				// Only an Argument, whose Type is written elsewhere, may omit
				// its return Type, even where the body could answer it.
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
				// The case `map` needs. The receiver binds `Item`, and only the
				// literal's body binds `Target`, which then types the invocation.
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
				// The return Type is the Union of every return, not the first.
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

			// Every declaring Namespace is probed, and each types the
			// unannotated literal differently. Only the winner's reading reaches
			// the body. See "Probe recordings" in
			// packages/compiler/src/enricher/DEVELOPMENT.md.
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
				// With no winner, the last probe's Types stand in, so the
				// literal adds no uninferable report to the real Diagnostic.
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

			// A callee with no Type Parameters still matches its Arguments, so
			// an unannotated literal reads its Parameter Types there, as with a
			// Method.
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
				// The Parameter is written out, so only the omitted
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
				// `isBetween` only resolves for a Type on a line, so a
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
				// Every Argument reads its own Parameter, not just the first.
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

			// A literal after a mismatching Argument still gets its context, so
			// only the mismatch is reported.
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

			// Only the body binds `Result`, and `#Stopped("done")` leaves `State`
			// open. So the position is read again once the call has committed,
			// and the body is enriched against that.
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

				// `Integer` comes from the committed Overload's bindings and
				// `String` from the payload.
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

			// `loop`'s general entry declares `step` as
			// `(_: State) -> Step<State, Result>`, the shape Programs meet.
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

			// `<-` returns from its own literal, so each `#Done` carries its own
			// `loop`'s Result.
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

			// `List.firstItem(where:)` spelled out. The annotated seed binds the
			// fold's `Result`, so the `#Done(…)` and the `#Value(item)` in it are
			// decided by `Step<Optional<Item>, Optional<Item>>`. They print terse,
			// as `caseHeader` leaves out the unbound `Item`.
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

			// A Diagnostic inside a callback body uses the committed Overload's
			// Types, not a losing Overload's `Boolean`.
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

		// An Error Type matches everything, so the call must not then report the
		// Type Parameter it meets as uninferable.
		it("should not report uninferable Type Parameters for an Error Argument", () => {
			// Two generic Namespaces with one target tie, so the Argument is an
			// Error. The receiver is a bound name, since a written List would
			// reach `NonEmptyList` and break the tie.
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

		// The Error meets `List<ItemType>` as a whole, and still binds the Type
		// Parameter inside it.
		it("should report nothing past an Error a receiver's Type holds", () => {
			expect(
				diagnosticsFor(`implementation {
					constant column = zz
					constant grid = [column]

					Terminal.inspect(grid::transpose())
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["unknown-name"])
		})

		// An Error binds a Type Parameter only where no other Argument does, in
		// either order, so the call answers what the other Argument decided.
		it("should let another Argument bind a Type Parameter an Error met", () => {
			expect(
				diagnosticsFor(`implementation {
					function pair<infer T>(_ first: T, _ second: T) -> T {
						<- first
					}

					Terminal.print(pair(zz, 1)::add("x"))
					Terminal.print(pair(1, zz)::add("x"))
				}`).map((diagnostic) => diagnostic.code),
			).toEqual([
				"unknown-name",
				"no-matching-overload",
				"unknown-name",
				"no-matching-overload",
			])
		})

		// The callback waits for the `1`, which binds `T` past the Error. Its
		// body is read with `x` an Integer, so its own mistake is reported.
		it("should type a callback by what a later Argument binds past an Error", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function apply<infer T>(_ f: T, _ cb: (_: T) -> T, _ v: T) -> T {
					<- cb(v)
				}

				function over<infer T>(_ f: List<T>, _ cb: (_: T) -> T, _ v: T) -> T {
					<- cb(v)
				}

				Terminal.print(apply(zz, (x) { <- x::add("s") }, 1))
				Terminal.print(over(zz, (x) { <- x::add("s") }, 1))
				Terminal.print(apply(zz, (x) { <- x::add(1) }, 1))
			}`)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.position?.start.line,
				]),
			).toEqual([
				["unknown-name", 10],
				["no-matching-overload", 10],
				["unknown-name", 11],
				["no-matching-overload", 11],
				["unknown-name", 12],
			])
			expect(diagnostics[1].labels[0]?.message).toBe("this is a String")
		})

		// A Type Parameter an Error meets binds it. A Function literal's
		// Parameter typed from it, and an answer read later, are then holes
		// that report nothing more.
		it("should report nothing past an Error a Type Parameter binds", () => {
			expect(
				diagnosticsFor(`implementation {
					constant column = zz
					constant listed = [column, column]
					constant mapped = listed::map((c) { <- c::add(1) })
					constant counted = [1]::map((x) { <- zz })

					Terminal.print(mapped::length()::add(counted::length()))
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["unknown-name", "unknown-name"])
		})

		// A literal whose body answers a hole has the hole as its return Type.
		// One passed to a call that resolved to nothing takes no Types. Neither
		// is a second mistake.
		it("should report nothing for a Function literal past an earlier Error", () => {
			expect(
				diagnosticsFor(`implementation {
					constant column = zz
					constant read = [1]::map((x) { <- column })
					constant later = Async.deferred(() { <- column })
					constant missed = Async.deferredLater(() { <- 1 })

					Terminal.print(read::length())
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["unknown-name", "unknown-member"])
		})

		// A Parameter whose Type is an Error takes a literal as a refused call
		// does. The body is still read, so a mistake there is its own.
		it("should report nothing for a literal at a Parameter whose Type is an Error", () => {
			expect(
				diagnosticsFor(`implementation {
					function run(_ step: Colr) -> Integer {
						<- 1
					}

					constant ran = run((x) { <- x })
					constant read = run((x) { <- zz })
				}`).map((diagnostic) => [
					diagnostic.code,
					diagnostic.position?.start.line,
				]),
			).toEqual([
				["unknown-type", 2],
				["unknown-name", 7],
			])
		})

		// A literal with no Parameters is reported at its empty Parameter list.
		it("should place an unreadable return Type on a literal with no Parameters", () => {
			let source = `implementation {
				constant later = Async.deferred(() { 1 })
			}`
			let [unreadable] = diagnosticsFor(source)

			expect(unreadable?.code).toBe("uninferable-return-type")
			expect(underlinedText(source, unreadable!)).toBe("()")
		})

		// A literal outside Argument position reports on every reading, and its
		// Help reads its body, which holds the next literal. So the Help is read
		// once. Body reads are counted, since a timing ceiling would flake.
		it("should not read a nested literal's body again for each reading around it", () => {
			let shapes = [
				[
					"function one(_ c: { f: (_ a: Integer) -> Integer }) -> Integer { <- c.f(1) }",
					(inner: string) =>
						`one({ f = (p: Integer) { <- ${inner} } })`,
				],
				[
					"function two(_ c: Integer) -> Integer { <- c }",
					(inner: string) => `two((p: Integer) { <- ${inner} })`,
				],
				[
					`choice Box { Full { f: (_ a: Integer) -> Integer }, Blank }
					function five(_ b: Box) -> Integer { <- 1 }`,
					(inner: string) =>
						`five(#Full({ f = (p: Integer) { <- ${inner} } }))`,
				],
			] as const

			for (let [callee, wrap] of shapes) {
				let program = parse(`implementation {
					${callee}

					constant x = ${Array.from({ length: 12 }).reduce<string>(wrap, "1")}
				}`)
				let reads: Array<number> = []
				let count = (node: ParserNode): void => {
					forEachParserChild(node, count)

					if (
						node.nodeType !== "FunctionDefinition" ||
						node.returnType !== null
					) {
						return
					}

					let { body } = node
					let index = reads.push(0) - 1

					Object.defineProperty(node, "body", {
						get: () => {
							reads[index] += 1

							return body
						},
					})
				}

				count(program)

				expect(
					enrich(program).diagnostics.map(
						(diagnostic) => diagnostic.code,
					),
				).toEqual(
					Array.from({ length: 12 }, () => "missing-return-type"),
				)
				expect(reads).toHaveLength(12)
				expect(Math.max(...reads)).toBeLessThanOrEqual(2 * 12)
			}
		})

		// The probes of a call and its commit share one reading of a payload,
		// so each literal's body is read once, however deep the nesting.
		it("should read a construction's payload once for its call", () => {
			let program = parse(`implementation {
				choice Box<T> { Full { value: T }, Blank }
				function five(_ b: Box<{ f: (_ a: Integer) -> Integer }>) -> Integer { <- 1 }

				constant x = ${Array.from({ length: 12 }).reduce<string>(
					(inner) =>
						`five(#Full({ value = { f = (_ p: Integer) -> Integer { <- ${inner} } } }))`,
					"1",
				)}
			}`)
			let reads: Array<number> = []
			let count = (node: ParserNode): void => {
				forEachParserChild(node, count)

				if (node.nodeType !== "FunctionDefinition") {
					return
				}

				let internal = node.parameters[0]?.internalName

				// Only the literals; `five` names its Parameter `b`.
				if (
					internal?.nodeType !== "Identifier" ||
					internal.content !== "p"
				) {
					return
				}

				let { body } = node
				let index = reads.push(0) - 1

				Object.defineProperty(node, "body", {
					get: () => {
						reads[index] += 1

						return body
					},
				})
			}

			count(program)

			expect(enrich(program).diagnostics).toEqual([])
			expect(reads).toEqual(Array.from({ length: 12 }, () => 1))
		})

		// The Help spells what the body answers in the reading around it. Under
		// the entry selected, `a` is a String. Inside the call refused for its
		// labels, `a` has no Type, so a schematic stands there.
		it("should spell a nested literal's Help from the reading around it", () => {
			let source = `implementation {
				namespace Gen for Integer {
					overload gen {
						<infer T>(step f: (_ a: Integer) -> T, by n: String) -> T {
							<- f(@)
						}
						<infer T>(step f: (_ a: String) -> T, by n: Integer) -> T {
							<- f("s")
						}
					}
				}

				Terminal.inspect(1::gen(step (a) {
					constant g = (p: Integer) { <- a }
					<- 1
				}, by 2))
				Terminal.inspect(1::gen(by 2, step (a) {
					constant g = (p: Integer) { <- a }
					<- 1
				}))
			}`

			expect(
				diagnosticsFor(source)
					.filter(
						(diagnostic) =>
							diagnostic.code === "missing-return-type",
					)
					.map((diagnostic) => diagnostic.helps),
			).toEqual([
				[
					"Write the return Type after the Parameter list — '-> String', which is what this body answers with.",
				],
				[
					"Write the return Type after the Parameter list — '-> <Type>', naming what this body's '<-' answers with.",
				],
			])
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
				// The applied spelling stays as the Union's display alias, which
				// assignability ignores.
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

		// A Namespace whose target is an applied Alias, reached through a
		// declared `Tagged<Integer>`. The second member is a plain String, since
		// the Alias is there to be applied, not to mean "missing".
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

		// The braces of `"use { and } carefully"` open a hole, so `and` reads as
		// a name. The report says how to print braces.
		it("should answer a name that is a whole String hole", () => {
			let diagnostics = diagnosticsFor(`implementation {
				Terminal.print("use { and } carefully")
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unknown-name")
			expect(diagnostics[0].helps[0]).toBe(
				"Write '\\{' and '\\}' where the braces stand for themselves.",
			)
			expect(diagnostics[0].notes[0]).toBe(
				"A '{' inside a String opens a hole, which holds an Expression — so 'and' is read as a name rather than printed.",
			)
		})

		// A hole holding a misspelled name gets only the near miss.
		it("should leave a misspelled name in a hole to the near miss", () => {
			let diagnostics = diagnosticsFor(`implementation {
				constant name = "Ada"
				Terminal.print("Hello, {naem}")
			}`)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].helps).toEqual([
				"Did you mean 'name'?",
				"Write '\\{' and '\\}' where the braces stand for themselves.",
			])
		})

		it("should reserve Self as a Generic name", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function identity <infer Self>(_ value: Self) -> Self {
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
			expect(diagnostics[0].helps).toEqual(["Choose another name."])
		})

		// No declaration may take the name `Self`. A Choice, a Protocol or a
		// Namespace is named where a Type is, and inside a Protocol `Self` means
		// the conforming Type.
		it("should reserve Self for every declaration form", () => {
			for (let declaration of [
				"choice Self { Red, Green }",
				"protocol Self { size() -> Integer }",
				"namespace Self for Integer { twice() -> Integer { <- @ } }",
			]) {
				let diagnostics = diagnosticsFor(
					`implementation {\n\t${declaration}\n}`,
				)

				expect(
					diagnostics.map((diagnostic) => diagnostic.message),
				).toEqual(["'Self' is a reserved Type name"])
				expect(diagnostics[0].helps).toEqual(["Choose another name."])
			}
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

			// List's conformance is conditional on its items, so `Value` is
			// solved by List's conformance carrying Integer's, collected beside it.
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
			// `List<Integer> | String` and `List<ItemType>` each cover the
			// binding, and neither is narrower, so the call is ambiguous. A
			// written `for List<Integer>` would win outright.
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
					compare<Item is Comparable>(to other: List<Item>) -> Ordering {
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

		// `next()` answers `Self` at the Union the Namespace covers, but not at
		// the Integer the call binds. A Namespace of its own answers there.
		it("should say where a written Method fits its requirement only at the covered Union", () => {
			let program = (declared: string): string => `implementation {
				protocol Cycled {
					next() -> Self
				}

				namespace Cyc for Integer | String is Cycled {
					next() -> Integer | String {
						<- 1
					}
				}
${declared}
				function step<infer T is Cycled>(_ a: T) -> T {
					<- a::next()
				}

				Terminal.inspect(step(5))
			}`
			let [refusal] = diagnosticsFor(program(""))

			expect(refusal.code).toBe("nonconforming-namespace")
			expect(refusal.notes).toEqual([
				"'next' in 'Cyc' answers an Integer | String at Integer, where 'Cycled' answers an Integer.",
			])
			expect(refusal.helps).toEqual([
				"Declare a Namespace for Integer that conforms to 'Cycled'.",
			])
			expect(
				compiles(
					program(`
				namespace IntegerCycle for Integer is Cycled {
					next() -> Integer {
						<- 2
					}
				}
`),
				),
			).toBe(true)
		})

		// Annotated at `Colour`, the value still meets a Namespace that covers
		// `Integer` too, whose `next()` answers no `Self` of `Colour`. Both edits
		// are needed.
		it("should ask a bare Case under a covering target for the annotation and a Namespace", () => {
			let program = (
				declared: string,
				value: string,
			): string => `implementation {
				choice Colour { Red, Green }

				protocol Cycled {
					next() -> Self
				}

				namespace Cyc for Colour | Integer is Cycled {
					next() -> Colour | Integer {
						<- 1
					}
				}
${declared}
				function step<infer T is Cycled>(_ a: T) -> T {
					<- a::next()
				}

				constant red = Colour#Red
				${value}
			}`
			let [refusal] = diagnosticsFor(
				program("", "Terminal.inspect(step(red))"),
			)

			expect(refusal.code).toBe("nonconforming-namespace")
			expect(refusal.helps).toEqual([
				"Annotate the value at 'Colour', since a bare Case binds the Case, not the Choice, and declare a Namespace for Colour that conforms to 'Cycled'.",
			])
			expect(
				compiles(
					program(
						`
				namespace ColourCycle for Colour is Cycled {
					next() -> Colour {
						<- #Green
					}
				}
`,
						"constant colour: Colour = red\n\t\t\t\tTerminal.inspect(step(colour))",
					),
				),
			).toBe(true)
		})

		// A fulfilling Method declares the requirement's Parameters. It may give
		// one a default, but a Parameter it adds is refused, defaulted or not.
		it("should accept a default the requirement lacks but no added Parameter", () => {
			let conforming = (parameters: string): Array<common.Diagnostic> =>
				diagnosticsFor(`implementation {
					protocol Greeter {
						greet(times count: Integer) -> String
					}

					namespace Hello for Integer is Greeter {
						greet(${parameters}) -> String {
							<- "hi"
						}
					}
				}`)

			expect(conforming("times count: Integer = 1")).toEqual([])
			expect(
				conforming(
					"times count: Integer, loudly loud: Boolean = false",
				).map((diagnostic) => diagnostic.code),
			).toEqual(["nonconforming-namespace"])
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

		it("should say at a bounded call which requirement the Namespace does not write", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Described {
					describe() -> String
				}

				namespace IntegerDescribed for Integer is Described {}

				function show<infer Item is Described>(_ item: Item) -> String {
					<- item::describe()
				}

				constant shown: String = show(3)
			}`)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.notes,
				]),
			).toEqual([
				["nonconforming-namespace", []],
				[
					"nonconforming-namespace",
					[
						"'IntegerDescribed' does not write 'describe', which 'Described' requires.",
					],
				],
			])
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
					compare<Item is Comparable>(to other: List<Item>) -> Ordering {
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

		// The name as the condition wrote it, so the Quick Fix declares the
		// Parameter the condition reads.
		it("should carry that Generic's name as data", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Wrapper<infer Item> for { value: Item, other: Other }
					is Comparable where Other is Comparable
				{
					compare(to other: { value: Item }) -> Ordering {
						<- Ordering#Equal
					}
				}
			}`)

			expect(
				diagnostics.find(
					(diagnostic) => diagnostic.code === "unknown-where-generic",
				)?.data,
			).toEqual({
				kind: "undeclared-parameter",
				name: "Other",
			})
		})

		// The target Type already reads `Other`, so declaring it is the whole
		// edit.
		it("should compile once the Generic is declared", () => {
			let source = (generics: string) => `implementation {
				namespace Pairs<${generics}> for { first: Item, second: Other } is Printable where Other is Printable {
					toString() -> String {
						<- "{@.second}"
					}
				}
			}`

			expect(
				diagnosticsFor(source("infer Item")).map(
					(diagnostic) => diagnostic.helps,
				),
			).toContainEqual([
				"Declare it in the Namespace's Generic list: '<infer Other>'.",
			])
			expect(compiles(source("infer Item, infer Other"))).toBe(true)
		})

		// A target Type that never reads `Other` could not witness the condition
		// on a declared `Other` either, so dropping the condition is the edit.
		it("should drop a condition on a Generic the target never reads", () => {
			let source = (conformance: string) => `implementation {
				namespace Pairs<infer Item> for List<Item> is ${conformance} {
					toString() -> String {
						<- "pairs"
					}
				}
			}`
			let diagnostics = diagnosticsFor(
				source("Printable where Other is Printable"),
			)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.helps,
					diagnostic.data,
				]),
			).toEqual([
				["unknown-where-generic", ["Drop this condition."], undefined],
			])
			expect(compiles(source("Printable"))).toBe(true)
		})

		// A near miss of a Type Parameter the target reads is likelier a slip
		// than a condition to drop, which would leave `toString` unprovable.
		it("should offer the Type Parameter a misspelt condition is closest to", () => {
			let source = (generic: string) => `implementation {
				type Box<Item> = { item: Item }

				namespace Boxes<infer Item> for Box<Item> is Printable where ${generic} is Printable {
					toString() -> String {
						<- @.item::toString()
					}
				}
			}`
			let refused = diagnosticsFor(source("Itme")).find(
				(diagnostic) => diagnostic.code === "unknown-where-generic",
			)

			expect(refused?.helps).toEqual(["Did you mean 'Item'?"])
			expect(refused?.data).toEqual({
				kind: "suggestion",
				suggestion: "Item",
			})
			expect(compiles(source("Item"))).toBe(true)
		})

		it("should reject a where condition on a Generic the target Type never mentions", () => {
			// A phantom Generic's condition can never be witnessed at a use site,
			// so it is refused at the Namespace.
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

		// A condition naming an undeclared Protocol is refused at the Namespace
		// and not carried to a use site.
		it("should stay quiet at a use site above a condition it refused", () => {
			let diagnostics = diagnosticsFor(`implementation {
				protocol Sized {
					size() -> Integer
				}

				function measure <infer Item is Sized>(_ item: Item) -> Integer {
					<- item::size()
				}

				constant measured: Integer = measure([1, 2])

				namespace ListSized<infer ItemType> for List<ItemType>
					is Sized where ItemType is Undeclared
				{
					size() -> Integer {
						<- 2
					}
				}
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"unknown-protocol",
			])
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
			// The message names the `List<{ x: Integer }>` the bound was written
			// on, and the Note names the Record that can not answer, without
			// repeating the message.
			expect(failure!.message).toContain(
				"List<{ x: Integer }> does not conform",
			)
			expect(failure!.notes.length).toBeGreaterThanOrEqual(1)
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
			// A Record conforms only to Equatable and Printable, so its List has
			// no ordering to sort by.
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
		// A Namespace Generic reaches a Method only when its resolved signature
		// mentions it, or no call site could bind it.
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

		it("should bound the Namespace's own Generic for one Method", () => {
			let method = methodTypeFor(
				`implementation {
					namespace Tags<infer Item> for Integer {
						ranked<Item is Comparable>(_ items: List<Item>) -> List<Item> {
							<- items
						}
					}
				}`,
				"Tags",
				"ranked",
			)

			// One entry, the Namespace's, carrying the Method's bound. `infer`
			// stays true, since the Namespace says where the Type comes from.
			expect(genericsOf(method)).toEqual([
				{
					name: "Item",
					infer: true,
					defaultType: null,
					constraint: "Comparable",
				},
			])
		})

		it("should refuse a re-declaration that only restates 'infer'", () => {
			let { diagnostics } = enrichSource(
				`implementation {
					namespace Tags<infer Item> for Integer {
						ranked<infer Item is Comparable>(_ items: List<Item>) -> List<Item> {
							<- items
						}
					}
				}`,
			)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.helps?.[0],
				]),
			).toEqual([
				[
					"restated-inferred-parameter",
					"Write '<Item is Comparable>' on 'ranked'.",
				],
			])
		})

		it("should compile once the bound is written without 'infer'", () => {
			expect(
				compiles(`implementation {
					namespace Restating<infer Item> for { value: Item } {
						shown<Item is Printable>() -> String {
							<- "{@.value}"
						}
					}

					Terminal.print({ value = 1 }::shown())
				}`),
			).toBe(true)
		})

		it("should refuse a re-declaration carrying no bound at all", () => {
			let { diagnostics } = enrichSource(
				`implementation {
					namespace Tags<infer Item> for Integer {
						ranked<Item>(_ items: List<Item>) -> List<Item> {
							<- items
						}
					}
				}`,
			)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.helps?.[0],
				]),
			).toEqual([
				[
					"shadowed-type-parameter",
					"Drop 'Item' from 'ranked's Type Parameters.",
				],
			])
		})

		// Every head that writes a `<…>` reports a repeated Type Parameter in
		// the same words, two bounds on one Parameter included.
		it("should refuse a Type Parameter declared twice in every head", () => {
			let heads = [
				"function twice<infer T is Comparable, infer T is Printable>(_ v: T) -> T {\n\t\t\t\t\t\t<- v\n\t\t\t\t\t}",
				"namespace Twice<infer T, infer T> for List<T> {}",
				"choice Twice<A, A> {\n\t\t\t\t\t\tOne { a: A },\n\t\t\t\t\t}",
				"type Twice<A, A> = List<A>",
			]

			for (let head of heads) {
				let { diagnostics } = enrichSource(
					`implementation {\n\t\t\t\t\t${head}\n\t\t\t\t}`,
				)

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["duplicate-type-parameter"])
			}
		})

		// A Method's list is split into its own Parameters and bounds on the
		// Namespace's, so the repetition is caught while the list is written.
		// Two Overloads may each name `Item`.
		it("should refuse two bounds on one Namespace Parameter", () => {
			let { diagnostics } = enrichSource(
				`implementation {
					namespace Boxes<infer Item> for { items: List<Item> } {
						described<Item is Comparable, Item is Printable>() -> String {
							<- "{@.items::sort()::length()}"
						}
					}
				}`,
			)

			// The last bound survives, so the body's sort reports wanting
			// `Comparable`, naming the Protocol the Help points to.
			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.message,
				]),
			).toEqual([
				[
					"duplicate-type-parameter",
					"Type Parameter 'Item' is declared twice",
				],
				[
					"unsatisfied-bound",
					"Type Parameter 'Item' does not conform to 'Comparable'",
				],
			])
			expect(diagnostics[0]!.notes?.[0]).toBe(
				"'Item' is bounded by 'Comparable' already, and a Type Parameter carries ONE bound — a second would replace it rather than stand beside it.",
			)
			expect(diagnostics[0]!.helps).toEqual([
				"Keep the one the body needs: write '<Item is Comparable>' or '<Item is Printable>', not both.",
			])
		})

		it("should leave two Overloads naming one Parameter alone", () => {
			let { diagnostics } = enrichSource(
				`implementation {
					namespace Boxes<infer Item> for { items: List<Item> } {
						overload described {
							<Item is Comparable>() -> Integer {
								<- @.items::sort()::length()
							}

							<Item is Printable>(_ prefix: String) -> String {
								<- "{prefix}{@.items}"
							}
						}
					}
				}`,
			)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([])
		})

		// `<infer Item>` is no shadow but the Namespace's own word written
		// twice, so the edit is its removal.
		it("should refuse a restated 'infer' that carries no bound", () => {
			let { diagnostics } = enrichSource(
				`implementation {
					namespace Tags<infer Item> for Integer {
						ranked<infer Item>(_ items: List<Item>) -> List<Item> {
							<- items
						}
					}
				}`,
			)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.helps?.[0],
					diagnostic.data?.kind,
				]),
			).toEqual([
				[
					"restated-inferred-parameter",
					"Drop 'Item' from 'ranked's Type Parameters.",
					"shadowed-type-parameter",
				],
			])
		})

		it("should compile once the restated entry is dropped", () => {
			expect(
				compiles(`implementation {
					namespace Restating<infer Item> for { value: Item } {
						held() -> Item {
							<- @.value
						}
					}

					Terminal.print({ value = 1 }::held())
				}`),
			).toBe(true)
		})

		// One Help, since `unsatisfied-bound` names the Protocol once the entry
		// is gone.
		it("should offer one Help for a shadowing re-declaration", () => {
			let { diagnostics } = enrichSource(
				`implementation {
					namespace Tags<infer Item> for Integer {
						ranked<Item>(_ items: List<Item>) -> List<Item> {
							<- items
						}
					}
				}`,
			)

			expect(diagnostics.map((diagnostic) => diagnostic.helps)).toEqual([
				["Drop 'Item' from 'ranked's Type Parameters."],
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
			// One case per Type shape the walk sees through, since a missed shape
			// would prune a used Generic.
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
			// `compare` uses `Item`, so it survives pruning and keeps the bound
			// woven in by the conditional conformance.
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

			// The typed Node agrees, so `simplifyFunctionDefinition` emits one
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

			// A Method that does not fulfil the conformance carries
			// neither the Generic nor its hidden Parameter.
			let describe = namespaceNode.methods.describe

			expect(
				(describe as common.typed.StaticMethod).method.value.generics,
			).toEqual([])
		})

		it("should retain a bound Generic on a fulfilling Method that never mentions it", () => {
			// `$type.boundConformance` curries a witness onto every fulfilling
			// Method, so such a Method keeps the bound Namespace Generic even when
			// its signature does not name it.
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
			// The witness is curried per Method, so every Overload keeps the
			// Generic, and no Overload emits a Parameter its Type lacks.
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

			// Each Overload carries the same leading bounded `Item`, so one
			// hidden conformance Parameter each.
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
			// With `Item` kept, a static call that binds nothing is a compile
			// error.
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

		// The nested `Sized` shadows the name, and is a Protocol of its
		// own, so `IntegerCounted` conforms to nothing `measure` asks for.
		it("should refuse a bound only a nested Protocol of its name meets", () => {
			expect(
				diagnosticsFor(`implementation {
					protocol Sized {
						size() -> Integer
					}

					function measure <infer Item is Sized>(_ item: Item) -> Integer {
						<- item::size()
					}

					function inner() -> Integer {
						protocol Sized {
							count() -> Integer
						}

						namespace IntegerCounted for Integer is Sized {
							count() -> Integer {
								<- 100
							}
						}

						<- measure(3)
					}
				}`).map((diagnostic) => [diagnostic.code, diagnostic.message]),
			).toEqual([
				["unsatisfied-bound", "Integer does not conform to 'Sized'"],
			])
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

		// A refused Invocation types its literal from the last probe, so the
		// callback's Parameter has the callee's Type Parameter, which the reader
		// can not see. Nothing is reported against it.
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

		// Without `infer` the Parameter is opaque, so the target matches no
		// receiver and the Namespace is never found. It is refused at the
		// declaration.
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

		// A call writes no Type Arguments, so only `infer` or a default decides a
		// Function's Type Parameter. The calls are checked as the Help would
		// have them, and add nothing.
		it("should reject Function Type Parameters written without 'infer'", () => {
			let diagnostics = diagnosticsFor(`implementation {
				function plain<Item>(_ item: Item) -> Item {
					<- item
				}

				namespace Boxes<infer Item> for List<Item> {
					paired<Other>(_ other: Other) -> List<Item> {
						<- @
					}
				}

				Terminal.inspect(plain(5))
				Terminal.inspect([1]::paired("a"))
			}`)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.helps,
				]),
			).toEqual([
				["uninferred-type-parameter", ["Write 'infer Item'."]],
				["uninferred-type-parameter", ["Write 'infer Other'."]],
			])
			expect(
				compiles(`implementation {
				function plain<infer Item>(_ item: Item) -> Item {
					<- item
				}

				namespace Boxes<infer Item> for List<Item> {
					paired<infer Other>(_ other: Other) -> List<Item> {
						<- @
					}
				}

				Terminal.inspect(plain(5))
				Terminal.inspect([1]::paired("a"))
			}`),
			).toBe(true)
		})

		// A default decides the Parameter, and a Method's entry naming the
		// Namespace's own Parameter is a bound.
		it("should accept a defaulted Function Type Parameter and a Method bound", () => {
			expect(
				diagnosticsFor(`implementation {
					function fallback<Value = String>(_ value: Value) -> Value {
						<- value
					}

					namespace Lists<infer Item> for List<Item> {
						holds<Item is Equatable>(_ item: Item) -> Boolean {
							<- @::contains(item)
						}
					}

					Terminal.inspect(fallback("a"))
					Terminal.inspect([1]::holds(1))
				}`),
			).toEqual([])
		})

		// Only a Method's own `<…>` may name the Namespace's Parameter. A
		// Function inside the body declares one of its own by that name.
		it("should reject a Function in a Method body that reuses the Namespace's name", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Lists<infer Item> for List<Item> {
						described() -> String {
							function helper<Item>(_ x: Item) -> Item {
								<- x
							}

							<- "{helper(1)}"
						}
					}

					Terminal.print([1]::described())
				}`).map((diagnostic) => diagnostic.code),
			).toEqual(["uninferred-type-parameter"])
		})

		// Bounds decide which Overload is selected, so the order of entries does
		// not matter. Each pair swaps the same two entries, and the one that
		// accepts a Boolean wins either way.
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

			// A Namespace of static Methods is never reached through a receiver,
			// so its target is `{}`, which nothing else here targets.
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

			// A literal with more Parameters than one entry's Function does not
			// fit that entry, which says nothing about the literal while another
			// entry fits it.
			describe("told apart by a callback's Parameter count", () => {
				let runner = (call: string) => `implementation {
					namespace Runner for Integer {
						overload run {
							(step advance: (_ a: Integer) -> Integer) -> Integer {
								<- advance(@)
							}
							(step advance: (_ a: Integer, _ b: Integer) -> Integer) -> Integer {
								<- advance(@, 10)
							}
						}
					}

					constant ran = ${call}
				}`

				it("should select the entry whose callback takes as many Parameters", () => {
					let two = runner("1::run(step (a, b) { <- a::add(b) })")
					let one = runner("1::run(step (a) { <- a::add(100) })")

					expect(diagnosticsFor(two)).toEqual([])
					expect(
						lastConstantMethodInvocation(two).overloadedMethodIndex,
					).toBe(1)
					expect(diagnosticsFor(one)).toEqual([])
					expect(
						lastConstantMethodInvocation(one).overloadedMethodIndex,
					).toBe(0)
				})

				// An entry whose Parameter is no Function, or a Type Parameter,
				// does not fit the literal either, and says nothing about it.
				it("should select a later entry where an earlier takes no Function", () => {
					let source = `implementation {
						namespace Gen for Integer {
							overload keep {
								<infer T>(step value: T) -> Integer {
									<- 0
								}
								(step advance: (_ a: Integer, _ b: Integer) -> Integer) -> Integer {
									<- advance(@, 10)
								}
							}
							overload maybe {
								(step advance: Optional<(_ a: Integer) -> Integer>) -> Integer {
									<- 0
								}
								(step advance: (_ a: Integer, _ b: Integer) -> Integer) -> Integer {
									<- advance(@, 10)
								}
							}
							overload count {
								(step advance: Integer) -> Integer {
									<- advance
								}
								(step advance: (_ a: Integer, _ b: Integer) -> Integer) -> Integer {
									<- advance(@, 10)
								}
							}
						}

						Terminal.inspect(1::keep(step (a, b) { <- a::add(b) }))
						Terminal.inspect(1::maybe(step (a, b) { <- a::add(b) }))
						Terminal.inspect(1::count(step (a, b) { <- a::add(b) }))
					}`

					expect(diagnosticsFor(source)).toEqual([])
				})

				// Only the Parameter no entry gives a Type is reported, with the
				// closest entry's count.
				it("should report a callback no entry fits beside the call", () => {
					let diagnostics = diagnosticsFor(
						runner("1::run(step (a, b, c) { <- a })"),
					)

					expect(
						diagnostics.map((diagnostic) => [
							diagnostic.code,
							diagnostic.message,
						]),
					).toEqual([
						[
							"uninferable-parameter-type",
							"The Type of Parameter 'c' could not be inferred",
						],
						[
							"no-matching-overload",
							"No overload of 'run' accepts these Arguments",
						],
					])
					expect(diagnostics[0].notes).toEqual([
						"The expected Function Type takes 2 Parameters, so there is nothing for Parameter 3 to infer from.",
					])
				})
			})

			// An Argument holding an Error may be what chose the entry, so the
			// call answers the hole, and its use reports nothing more.
			it("should answer the hole where an Argument holding an Error chose the entry", () => {
				expect(
					codesOfSource(`implementation {
						namespace Pick for Integer {
							overload static pick {
								(_ v: Integer) -> Integer {
									<- 1
								}
								(_ v: String) -> String {
									<- "s"
								}
							}
						}

						function held(_ value: Colr | Integer) -> String {
							<- Pick.pick(value)
						}

						constant named: String = Pick.pick(undeclared)
					}`),
				).toEqual(["unknown-type", "unknown-name"])
			})

			// One entry taking the call's labels, or a lone signature, is no
			// choice, so what it answers is still measured.
			it("should measure what the one entry taking the labels answers", () => {
				expect(
					codesOfSource(`implementation {
						namespace Pick for Integer {
							overload twice {
								(with v: Integer) -> Integer {
									<- 1
								}
								(by v: String) -> String {
									<- "s"
								}
							}
						}

						function one(_ v: Integer) -> Integer {
							<- v
						}

						constant labelled: String = 1::twice(with undeclared)
						constant lone: String = one(missing)
					}`),
				).toEqual([
					"assignment-type-mismatch",
					"unknown-name",
					"assignment-type-mismatch",
					"unknown-name",
				])
			})

			// A callback's body with mistakes of its own under one entry does
			// not fit that entry while a later entry reads it cleanly.
			describe("told apart by a callback's body", () => {
				let runner = (call: string) => `implementation {
					namespace Runner for Integer {
						overload run {
							(step advance: (_ a: Integer, _ b: Integer) -> Integer) -> Integer {
								<- advance(@, 10)
							}
							(step advance: (_ a: String, _ b: String) -> Integer) -> Integer {
								<- advance("a", "b")
							}
						}
					}

					constant ran = ${call}
				}`

				it("should select the entry whose Types the callback's body reads", () => {
					let strings = runner(
						"1::run(step (a, b) { <- a::length() })",
					)
					let both = runner("1::run(step (a, b) { <- 1 })")

					expect(diagnosticsFor(strings)).toEqual([])
					expect(
						lastConstantMethodInvocation(strings)
							.overloadedMethodIndex,
					).toBe(1)
					expect(diagnosticsFor(both)).toEqual([])
					expect(
						lastConstantMethodInvocation(both)
							.overloadedMethodIndex,
					).toBe(0)
				})

				// Where no entry reads it, the first is selected, and its own
				// reading reports the body's mistake.
				it("should report a callback's body no entry reads under the first", () => {
					expect(
						diagnosticsFor(
							runner("1::run(step (a, b) { <- a::nope() })"),
						).map((diagnostic) => [
							diagnostic.code,
							diagnostic.notes,
						]),
					).toEqual([
						[
							"unknown-method",
							[
								"Searched Namespaces 'Integer', 'Scalar', 'Number', 'Runner'.",
							],
						],
					])
				})

				// Each level reads its literal once per Parameter Types and once
				// for real. The readings of a literal inside another are shared
				// where the bindings it reads hold the same Types, so the reads
				// grow by level. Counted, not timed.
				it("should read nested callbacks a number of times that grows by level", () => {
					// Each level also reads the Parameter of the literal around it.
					let chained = (depth: number, level = 1): string =>
						level > depth
							? "1"
							: `items::sum(on (i${level}) { <- i${level}.count::add(${chained(depth, level + 1)})${level > 1 ? `::add(i${level - 1}.count)` : ""} })`
					let shapes = [
						{
							header: "type Item = { price: Rational, count: Integer }\n constant items: List<Item> = []",
							wrap: (inner: string) =>
								`items::sum(on (item) { <- ${inner}::add(item.count) })`,
							leaf: "item.count",
							extra: chained(4),
							literals: 8,
							perLevel: 3,
						},
						{
							header: `${Array.from({ length: 10 }, (_, index) => `type T${index} = { tag${index}: Integer }`).join("\n")}
							namespace Tens for Integer {
								overload static pick {
									${Array.from({ length: 10 }, (_, index) => `(on key: (_ v: T${index}) -> Integer) -> Integer { <- ${index} }`).join("\n")}
								}
							}`,
							wrap: (inner: string) =>
								`Tens.pick(on (v) { <- v.tag9::add(${inner}) })`,
							leaf: "1",
							extra: "1",
							literals: 4,
							perLevel: 11,
						},
					]

					for (let {
						header,
						wrap,
						leaf,
						extra,
						literals,
						perLevel,
					} of shapes) {
						let program = parse(`implementation {
							${header}

							constant x = ${Array.from({ length: 4 }).reduce<string>(wrap, leaf)}
							constant y = ${extra}
						}`)
						let reads: Array<number> = []
						let count = (node: ParserNode): void => {
							forEachParserChild(node, count)

							if (
								node.nodeType !== "FunctionDefinition" ||
								node.returnType !== null
							) {
								return
							}

							let { body } = node
							let index = reads.push(0) - 1

							Object.defineProperty(node, "body", {
								get: () => {
									reads[index] += 1

									return body
								},
							})
						}

						count(program)

						expect(enrich(program).diagnostics).toEqual([])
						expect(reads).toHaveLength(literals)
						expect(Math.max(...reads)).toBeLessThanOrEqual(
							perLevel * 4,
						)
					}
				})
			})

			// A literal without `-> Type` is measured by what its body answers,
			// so the entry whose declared answer takes it is selected.
			describe("told apart by a callback's answer", () => {
				let items = `type Item = { price: Rational, count: Integer }

					constant items: List<Item> = [{ price = 1/2, count = 2 }]`
				let picks = `namespace Picks for Integer {
						overload static pick {
							(on key: (_ v: Integer) -> Integer | String) -> String {
								<- "text"
							}
							(on key: (_ v: Integer) -> Integer | Boolean) -> String {
								<- "flag"
							}
						}
					}`
				// The widest entry is written first.
				let threePicks = `namespace Picks for Integer {
						overload static pick {
							(on key: (_ v: Integer) -> Integer | String | Boolean) -> String {
								<- "any"
							}
							(on key: (_ v: Integer) -> Integer | String) -> String {
								<- "text"
							}
							(on key: (_ v: Integer) -> Integer | Boolean) -> String {
								<- "flag"
							}
						}
					}`

				it("should select the entry whose declared answer takes the body's", () => {
					let source = `implementation {
						${items}

						constant byPrice = items::sum(on (item) { <- item.price })
						constant byCount = items::sum(on (item) { <- item.count })
					}`
					let program = enrich(parse(source))

					expect(program.diagnostics).toEqual([])
					expect(
						program.program.implementation.nodes.flatMap((node) =>
							node.nodeType === "ConstantDeclarationStatement"
								? [printType(node.value.type)]
								: [],
						),
					).toEqual([
						"List<{ price: Rational, count: Integer }>",
						"Rational",
						"Integer",
					])
				})

				// The entry whose answer every other one takes is selected, so
				// the order the entries are written in decides nothing.
				it("should select the narrowest answer whichever entry comes first", () => {
					let measured = (
						first: string,
						second: string,
					) => `implementation {
						namespace Measures for Integer {
							overload measure {
								(by key: (_ v: Integer) -> ${first}) -> String {
									<- "${first}"
								}
								(by key: (_ v: Integer) -> ${second}) -> String {
									<- "${second}"
								}
							}
						}

						constant measured = 1::measure(by (v) { <- v })
					}`

					for (let [source, index] of [
						[measured("Scalar", "Integer"), 1],
						[measured("Integer", "Scalar"), 0],
					] as const) {
						expect(diagnosticsFor(source)).toEqual([])
						expect(
							lastConstantMethodInvocation(source)
								.overloadedMethodIndex,
						).toBe(index)
					}
				})

				// A named Function, a Function-typed Constant and a literal,
				// annotated or not, all count by their answer Type.
				it("should measure every Function-typed Argument by its answer", () => {
					let measured = (argument: string) => `implementation {
						namespace Measures for Integer {
							overload measure {
								(by key: (_ v: Integer) -> Scalar) -> String {
									<- "scalar"
								}
								(by key: (_ v: Integer) -> Integer) -> String {
									<- "integer"
								}
							}
						}

						function named(_ v: Integer) -> Integer {
							<- v
						}

						constant kept: (_ v: Integer) -> Integer = named

						constant measured = 1::measure(by ${argument})
					}`

					for (let argument of [
						"(_ v: Integer) -> Integer { <- v }",
						"(v) -> Integer { <- v }",
						"(v) { <- v }",
						"named",
						"kept",
					]) {
						let source = measured(argument)

						expect(diagnosticsFor(source)).toEqual([])
						expect(
							lastConstantMethodInvocation(source)
								.overloadedMethodIndex,
						).toBe(1)
					}
				})

				// A named Function's refusal writes a literal calling it, and
				// either compiles.
				it("should write a literal calling a named Function the answers refuse", () => {
					let call = (argument: string) => `implementation {
						${picks}

						function named(_ v: Integer) -> Integer {
							<- v
						}

						constant picked = Picks.pick(on ${argument})
					}`

					expect(
						helpsOfCode(call("named"), "ambiguous-overload-answer"),
					).toEqual([
						"Write a Function literal in its place — '(p1) -> Integer | String { <- named(p1) }', for the entry that answers it.",
						"Or write a Function literal in its place — '(p1) -> Integer | Boolean { <- named(p1) }', for the entry that answers it.",
					])

					for (let [answer, entry] of [
						["Integer | String", 0],
						["Integer | Boolean", 1],
					] as const) {
						let followed = call(
							`(p1) -> ${answer} { <- named(p1) }`,
						)

						expect(compiles(followed)).toBe(true)
						expect(
							lastConstantFunctionInvocation(followed)
								.overloadedMethodIndex,
						).toBe(entry)
					}
				})

				// The literal's Parameters are named apart from the name it
				// calls, so none shadows it.
				it("should name a written literal's Parameters apart from the Function it calls", () => {
					let call = (argument: string) => `implementation {
						${picks}

						function named(_ v: Integer) -> Integer {
							<- v
						}

						constant p1: (_ v: Integer) -> Integer = named

						constant picked = Picks.pick(on ${argument})
					}`
					let helps = helpsOfCode(
						call("p1"),
						"ambiguous-overload-answer",
					)

					expect(helps).toEqual([
						"Write a Function literal in its place — '(p2) -> Integer | String { <- p1(p2) }', for the entry that answers it.",
						"Or write a Function literal in its place — '(p2) -> Integer | Boolean { <- p1(p2) }', for the entry that answers it.",
					])

					for (let [help, entry] of helps.map(
						(text, index) => [text, index] as const,
					)) {
						let followed = call(help.split("'")[1]!)

						expect(compiles(followed)).toBe(true)
						expect(
							lastConstantFunctionInvocation(followed)
								.overloadedMethodIndex,
						).toBe(entry)
					}
				})

				// The answers of three entries take an Integer, and none takes
				// both others'. Each Help writes one of them, and compiles.
				it("should refuse an answer no one entry takes most narrowly", () => {
					let call = (literal: string) => `implementation {
						${threePicks}

						constant picked = Picks.pick(on ${literal})
					}`
					let source = call("(v) { <- v }")
					let helps = helpsOfCode(source, "ambiguous-overload-answer")

					expect(codesOfSource(source)).toEqual([
						"ambiguous-overload-answer",
					])
					expect(helps).toHaveLength(3)

					// A written answer is the literal's own, so the narrowest
					// entry taking it is selected, though a wider one comes
					// first.
					for (let [answer, entry] of [
						["Integer | String | Boolean", 0],
						["Integer | String", 1],
						["Integer | Boolean", 2],
					] as const) {
						let followed = call(`(v) -> ${answer} { <- v }`)

						expect(
							helps.some((help) =>
								help.includes(`'-> ${answer}'`),
							),
						).toBe(true)
						expect(compiles(followed)).toBe(true)
						expect(
							lastConstantFunctionInvocation(followed)
								.overloadedMethodIndex,
						).toBe(entry)
					}
				})

				// Every entry fits, with the same answer, so only the first is
				// read. Each literal reads the Parameter of the one around it.
				// Counted, not timed.
				it("should read a nesting of entries that all fit a number of times that grows by level", () => {
					let chained = (depth: number, level = 1): string =>
						level > depth
							? "1"
							: `Three.pick(on (v${level}) { <- v${level}.z::add(${chained(depth, level + 1)})${level > 1 ? `::add(v${level - 1}.z)` : ""} })`
					let program = parse(`implementation {
						type A = { a: Integer, z: Integer }
						type B = { b: Integer, z: Integer }
						type C = { c: Integer, z: Integer }

						namespace Three for Integer {
							overload static pick {
								(on key: (_ v: A) -> Integer) -> Integer { <- 1 }
								(on key: (_ v: B) -> Integer) -> Integer { <- 2 }
								(on key: (_ v: C) -> Integer) -> Integer { <- 3 }
							}
						}

						constant x = ${chained(6)}
					}`)
					let reads: Array<number> = []
					let count = (node: ParserNode): void => {
						forEachParserChild(node, count)

						if (
							node.nodeType !== "FunctionDefinition" ||
							node.returnType !== null
						) {
							return
						}

						let { body } = node
						let index = reads.push(0) - 1

						Object.defineProperty(node, "body", {
							get: () => {
								reads[index] += 1

								return body
							},
						})
					}

					count(program)

					expect(enrich(program).diagnostics).toEqual([])
					expect(reads).toHaveLength(6)
					expect(Math.max(...reads)).toBeLessThanOrEqual(3 * 6)
				})

				// A value call probes every Namespace declaring the Method, and
				// only the one it commits reports its refusal, once per spelling.
				it("should refuse an answer only from the Namespace the call commits", () => {
					let namespaces = (
						wide: string,
						narrow: string,
					) => `implementation {
						namespace Wide for Integer | String {
							overload pick {
								${wide}
							}
						}

						namespace Narrow for Integer {
							overload pick {
								${narrow}
							}
						}

						constant valued = 1::pick(on (v) { <- v })
						constant named = Narrow.pick(1, on (v) { <- v })
					}`
					let entries = (answers: Array<string>) =>
						answers
							.map(
								(answer) =>
									`(on key: (_ v: Integer) -> ${answer}) -> String { <- "${answer}" }`,
							)
							.join("\n")
					let ambiguous = entries([
						"Integer | String",
						"Integer | Boolean",
					])

					expect(
						codesOfSource(
							namespaces(
								ambiguous,
								entries(["Integer", "Scalar"]),
							),
						),
					).toEqual([])
					expect(
						codesOfSource(
							namespaces(entries(["Integer"]), ambiguous),
						),
					).toEqual([
						"ambiguous-overload-answer",
						"ambiguous-overload-answer",
					])
					expect(
						codesOfSource(namespaces(ambiguous, ambiguous)),
					).toEqual([
						"ambiguous-overload-answer",
						"ambiguous-overload-answer",
					])
				})

				// The refused call answers the hole, so nothing done with its
				// answer is reported again.
				it("should answer the hole where it refuses an answer", () => {
					expect(
						codesOfSource(`implementation {
							${picks.replace('-> Integer | Boolean) -> String {\n\t\t\t\t\t\t\t\t<- "flag"', "-> Integer | Boolean) -> Integer {\n\t\t\t\t\t\t\t\t<- 2")}

							constant n: Integer = Picks.pick(on (v) { <- v })
							constant m = Picks.pick(on (v) { <- v })::add(1)
							constant s: String = Picks.pick(on (v) { <- v })
						}`),
					).toEqual([
						"ambiguous-overload-answer",
						"ambiguous-overload-answer",
						"ambiguous-overload-answer",
					])
				})

				// Both entries take an Integer, and neither takes the other's
				// answer. Each Help writes one of them, and compiles.
				it("should refuse an answer two entries take, with a Help for each", () => {
					let call = (literal: string) => `implementation {
						${picks}

						Terminal.print(Picks.pick(on ${literal}))
					}`
					let source = call("(v) { <- v }")

					expect(codesOfSource(source)).toEqual([
						"ambiguous-overload-answer",
					])
					expect(
						helpsOfCode(source, "ambiguous-overload-answer"),
					).toEqual([
						"Write the return Type after the Parameter list — '-> Integer | String', for the entry that answers it.",
						"Or write the return Type after the Parameter list — '-> Integer | Boolean', for the entry that answers it.",
					])
					expect(
						compiles(call("(v) -> Integer | String { <- v }")),
					).toBe(true)
					expect(
						compiles(call("(v) -> Integer | Boolean { <- v }")),
					).toBe(true)
				})

				// Each candidate reads the body silently, and the real pass
				// reports its mistake once.
				it("should report a mistake in the body once", () => {
					expect(
						codesOfSource(`implementation {
							${items}

							constant misspelt = items::sum(on (item) { <- item.prise })
							constant missing = items::sum(on (item) { <- zz })
						}`),
					).toEqual(["unknown-member", "unknown-name"])
				})

				// The inner call is read inside each reading of the outer body,
				// and answers a Rational in every one of them.
				it("should read a literal's answer through a literal inside it", () => {
					let source = `implementation {
						type Part = { price: Rational, count: Integer }
						type Item = { parts: List<Part> }

						constant items: List<Item> = []
						constant total = items::sum(on (item) { <- item.parts::sum(on (part) { <- part.price }) })
					}`
					let program = enrich(parse(source))
					let total = program.program.implementation.nodes.at(-1)

					expect(program.diagnostics).toEqual([])
					expect(
						total?.nodeType === "ConstantDeclarationStatement"
							? printType(total.value.type)
							: null,
					).toBe("Rational")
				})
			})

			// The call carries the conformances solved during selection, not a
			// second solve.
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

			// No candidate's bounds hold, so the call keeps the first matching
			// candidate's Diagnostic about which bound failed.
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
				// The kept Diagnostic whole, since its Note and Help say how to
				// satisfy the bound.
				expect(diagnostics[0].notes).toEqual([
					"No Namespace in scope makes Boolean conform to 'Showable'.",
				])
				expect(diagnostics[0].helps).toEqual([
					"Declare a Namespace 'for Boolean is Showable'.",
				])
			})

			// A candidate whose bound could not be decided is reported, since
			// that ambiguity is why the call fails.
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
					"More than one Namespace makes Vector conform to 'Showable'",
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
				// Every candidate in written order, so a call matching none is
				// told what it could have passed, as with `::`.
				expect(diagnostics[0].notes).toEqual([
					"'Renderer.render' takes 1 Argument: Parameter 1 is Value.",
					"'Renderer.render' takes 2 Arguments: Parameter 1 is Boolean, Parameter 2 is Boolean.",
				])
				expect(diagnostics[0].helps).toEqual([])
			})

			// A single entry `overload` block is common, and the report means
			// nothing without a Note spelling that entry out.
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

			// The caller wrote no Namespace Generic, so the Note reads the
			// signature off the Namespace specialized to the receiver.
			it("should spell a Namespace Generic as the receiver decided it", () => {
				let diagnostics = diagnosticsFor(`implementation {
					constant list = [1, 2]::prepend("nope")
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("no-matching-overload")
				expect(diagnostics[0].notes).toEqual([
					"'List::prepend' takes 1 Argument: Parameter 1 is Integer.",
					"'List::prepend' takes 1 Argument: Parameter 'contentsOf' is List<Integer> — this call writes no label where Parameter 'contentsOf' is expected.",
					"'NonEmptyList::prepend' takes 1 Argument: Parameter 'contentsOf' is List<Integer> — this call writes no label where Parameter 'contentsOf' is expected.",
				])
			})

			// An `overload function`'s entries differ by their Argument labels,
			// so the Notes name them.
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
					"And 4 more Overloads of this name, not listed.",
				])
			})

			// The literal is read against an `Integer` Parameter of a losing
			// candidate on the way to the winner. A losing candidate reports
			// nothing.
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

			// A Namespace that loses on specificity still probes its Overloads,
			// and reports nothing either.
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

			// Against `Holder<Item>` a Case construction types as Error and
			// leaves `Item` unbound. The candidate that decides the construction
			// wins in either order.
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
		// Every builtin conformance must be fulfilled, checked by the helper
		// that conformance checking and codegen use. It reads the live accessors,
		// so it tests what a compilation sees.
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

						// A conditional conformance holds only under its `where`
						// conditions, supplied as assumptions as the Enricher does.
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

						// A Choice's derives fulfil `Equatable` and `Printable`,
						// so the derived Namespace is checked. The Scope resolves
						// the Choice's name to the target Type.
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
			// The comparator needs no Protocol bound, and the annotation holds
			// because `compare` resolves on a String.
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

		// The unit Record `{}` reaches Equatable through the builtin Record
		// Namespace like any other Record.
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

		// `Comparable` provides the ordering over `Self`, the covering `Number`
		// included, so a cross-kind comparison is answered on `Number`'s rung.
		// A written receiver's `squareRoot` answers `Integer | Algebraic` bare.
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
			// The annotation holds only if `1::add(Number.Pi)` resolves to the
			// Transcendental entry. The match adds an Integer to an Algebraic, and
			// `toString` keeps the answer a String.
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

		// Integer and Rational order each other but not the irrationals, whose
		// ordering is undecidable in general. `Number.compare` makes that claim
		// once, and `Comparable` builds the family on it.
		it("keeps cross-kind comparison off the member Namespaces", () => {
			// The Argument Types `Integer::isLessThan` accepts, with no Algebraic
			// or Transcendental among them.
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
			// `Number` writes none either. It is `Orderable`, and the provided
			// `isLessThan` reads its cross-kind `compare`.
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

		// `Number` covers the whole numeric Union and writes `toString`, as each
		// member does, so the covering Namespace must win over a dispatch.
		it("should keep a Namespace covering the whole Union ahead of dispatch", () => {
			let invocation = lastConstantMethodInvocation(`implementation {
				constant value: Number = 5
				constant text = value::toString()
			}`)

			expect(invocation.namespace.name).toBe("Number")
			expect(invocation.dispatch).toBeNull()
			expect(invocation.type).toEqual({ type: "String" })
		})

		// A dispatch needs unrelated Namespaces each declaring `toString` for
		// one member, as `Rational | String` has.
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

		// The `Item` member is a Type Parameter, so only its bound can answer
		// `toString` in the dispatch.
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

		// An `Optional` is `Printable` only when its payload is, and the
		// payload is an undecided Type Parameter, so the bound makes the call
		// legal.
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

		// Record matching is open at runtime, so the more specific Record's
		// branch is tried first. Applying a Generic Alias yields such a Union,
		// skipping subsumption.
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

		// The same Union with its incomparable member moved, which must not
		// change the order.
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

		// `Integer::is` has a Rational entry beside its Integer one, so Integer's
		// rung answers. A kind neither rung names falls to the covering
		// Namespace.
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
			// A Namespace naming the item Type is more specific than the
			// standard library's `List<ItemType>`. The receiver is a bound name,
			// since a written List would make the call ambiguous.
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

		// A written receiver carries its proof into dispatch, so it meets the
		// same ambiguity a `NonEmptyList<Integer>` Constant would.
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
			expect(
				compiles(`implementation {
				namespace IntegerTally for List<Integer> {
					firstItem() -> Integer {
						<- 0
					}
				}

				constant first = [1, 2, 3]::<NonEmptyList>firstItem()
			}`),
			).toBe(true)
		})

		// The Help leads with one specifier, and the `data` carries every
		// candidate for the Quick Fix to offer, the Help's first.
		it("should carry every candidate specifier as data", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace IntegerTally for List<Integer> {
					firstItem() -> Integer {
						<- 0
					}
				}

				constant first = [1, 2, 3]::firstItem()
			}`)

			expect(diagnostics[0].data).toEqual({
				kind: "namespace-candidates",
				names: ["NonEmptyList", "IntegerTally"],
			})
		})

		// A specifier at the call picks the candidate for every member of a
		// Union receiver, so the `data` is the same.
		// A specifier on the call holds for every member, and String answers
		// through neither Namespace, so none is offered.
		it("should carry no candidate specifier the other Union members do not answer through", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace FirstTag for Integer {
					tag() -> String {
						<- "first"
					}
				}

				namespace SecondTag for Integer {
					tag() -> String {
						<- "second"
					}
				}

				constant value: Integer | String = 1
				constant tagged = value::tag()
			}`)

			expect(diagnostics[0].code).toBe("ambiguous-namespace")
			expect(diagnostics[0].data).toEqual({
				kind: "namespace-candidates",
				names: [],
			})
			expect(diagnostics[0].helps).toEqual([
				"Match on the value, and call '@::<FirstTag>tag(…)' in the arm for Integer.",
			])
		})

		it("should prefer a nested generic target over a flat one", () => {
			// `List<List<ItemType>>` covers only nested Lists, so it is narrower.
			// Both spell their Generic `ItemType`, which the comparison renames
			// apart.
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

		// Every List target covers a `List<Unknown>` both ways, so ordering
		// would pick on an undecided Type. The refusal comes before the order is
		// asked.
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

			// The annotation is spelled from the receiver's own Type, so an
			// empty Dictionary is told of a Dictionary.
			it("should spell the annotation from the receiver's Type", () => {
				let tags = (receiver: string) => `implementation {
				namespace Counts for Dictionary<String, Integer> {
					tag() -> String {
						<- "counts"
					}
				}

				namespace Words for Dictionary<String, String> {
					tag() -> String {
						<- "words"
					}
				}

				${receiver}
			}`

				expect(
					diagnosticsFor(tags("constant tagged = [=]::tag()"))[0]
						?.helps,
				).toEqual([
					"Annotate what the receiver comes from with 'Dictionary<String, Integer>', for instance, so its Type is decided before the call.",
				])
				expect(
					compiles(
						tags(
							"constant entries: Dictionary<String, Integer> = [=]\n\t\t\t\tconstant tagged = entries::tag()",
						),
					),
				).toBe(true)
			})

			it("should compile once the receiver is annotated", () => {
				expect(
					compiles(`implementation {
				${overlappingNamespaces}

				constant items: List<Integer> = []
				constant tagged = items::tag()
			}`),
				).toBe(true)
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
				// The annotated Type is made up, so the Help says it is an
				// example.
				expect(diagnostic.helps).toEqual([
					"Annotate what the receiver comes from with 'List<Integer>', for instance, so its Type is decided before the call.",
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
				// With one Namespace to go to, the Unknown decides nothing.
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
				// Per-member dispatch refuses on the same terms. The callback's
				// returns build a Union with a `List<Unknown>` member, refused before
				// the Integer member is asked for `tag`.
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
			// The name alone is underlined, rather than the whole block
			// or the whole Comment.
			expect(diagnostics[0].position).toEqual({
				start: { line: 3, column: 15 },
				end: { line: 3, column: 22 },
			})
		})

		// Warnings do not stop a compile, so each followed Help is also asked
		// to leave nothing to report.
		it("should report nothing once the line names the Parameter", () => {
			let greet = (tag: string) => `implementation {
				§§ Greets.
				§§ @param ${tag} — who to greet
				function greet(subject: String) -> String { <- subject }
			}`

			expect(compiles(greet("subject"))).toBe(true)
			expect(diagnosticsFor(greet("subject"))).toEqual([])
		})

		it("should report nothing once an unlabelled Parameter's line is '_'", () => {
			let double = (tag: string) => `implementation {
				§§ Doubles a number.
				§§
				§§ @param ${tag} — the number to double
				function double(_ number: Integer) -> Integer {
					<- number::multiply(with 2)
				}
			}`

			expect(diagnosticsFor(double("number"))[0]?.helps).toEqual([
				"Write '@param _' — Parameter 1 carries no label.",
			])
			expect(compiles(double("_"))).toBe(true)
			expect(diagnosticsFor(double("_"))).toEqual([])
		})

		it("should match a '@param' to the Parameter at its position", () => {
			// Both lines name real Parameters, but the first names the second,
			// as when a line is left out.
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
			// A positional Parameter is documented as '_', and a
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
			// One line per Parameter, so the Parameter no line reached
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
			expect(diagnostics[0].notes).toHaveLength(1)
		})

		it("should report nothing once the missing line is written", () => {
			let followed = `implementation {
				§§ Joins.
				§§ @param left — the text to put first
				§§ @param right — the text to put after
				function join(left: String, right: String) -> String {
					<- left::append(right)
				}
			}`

			expect(compiles(followed)).toBe(true)
			expect(diagnosticsFor(followed)).toEqual([])
		})

		// A misnamed line and an undocumented Parameter are one missing line
		// seen from both ends, so the report says which to put right first.
		it("should say which line to put right first", () => {
			let diagnostics = diagnosticsFor(`implementation {
				§§ Scales a number.
				§§
				§§ @returns — the scaled number
				§§ @param by — the factor
				function scale(_ number: Integer, by factor: Integer) -> Integer {
					<- number::multiply(with factor)
				}
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"misnamed-documentation-parameter",
				"undocumented-parameter",
			])
			expect(diagnostics[1].notes[1]).toBe(
				"'by' is already written on line 1 of the run, where it documents Parameter 1 — put that line right first, and the run reads in Parameter order.",
			)
			expect(diagnostics.map((diagnostic) => diagnostic.helps)).toEqual([
				["Write '@param _' — Parameter 1 carries no label."],
				["Write '@param by — …' as line 2 of the run."],
			])

			let followed = `implementation {
				§§ Scales a number.
				§§
				§§ @returns — the scaled number
				§§ @param _ — the number to scale
				§§ @param by — the factor
				function scale(_ number: Integer, by factor: Integer) -> Integer {
					<- number::multiply(with factor)
				}
			}`

			expect(compiles(followed)).toBe(true)
			expect(diagnosticsFor(followed)).toEqual([])
		})

		// The Help and the Quick Fix `data` name the same thing. `after` is the
		// tag the missing line goes under.
		it("should carry the tag a missing '@param' is written under", () => {
			let diagnostics = diagnosticsFor(`implementation {
				§§ Joins.
				§§ @param left — the text to put first
				function join(left: String, right: String) -> String {
					<- left::append(right)
				}
			}`)

			expect(diagnostics[0].data).toEqual({
				kind: "documentation-line",
				parameter: "right",
				after: {
					start: { line: 3, column: 15 },
					end: { line: 3, column: 19 },
				},
			})
		})

		// Lines document Parameters by position, so a run two short gets a line
		// for the first missing Parameter only.
		it("should carry no line for a Parameter the run cannot reach yet", () => {
			let diagnostics = diagnosticsFor(`implementation {
				§§ Joins.
				§§ @param left — the text to put first
				function join(left: String, middle: String, right: String) -> String {
					<- left::append(middle)::append(right)
				}
			}`)

			expect(
				diagnostics.map((diagnostic) => diagnostic.data?.kind),
			).toEqual(["documentation-line", undefined])
		})

		// What the signature writes for the Parameter, its label or `_`, since
		// the fix rewrites the tag.
		it("should carry the written name of a misnamed Parameter", () => {
			let diagnostics = diagnosticsFor(`implementation {
				§§ Greets.
				§§ @param subject — who to greet
				function greet(_ subject: String) -> String { <- subject }
			}`)

			expect(diagnostics[0].code).toBe("misnamed-documentation-parameter")
			expect(diagnostics[0].data).toEqual({
				kind: "suggestion",
				suggestion: "_",
			})
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
			expect(diagnostics[0].data).toEqual({
				kind: "suggestion",
				suggestion: "height",
			})
		})

		// A tag past the last Parameter names nothing, so the only answer is to
		// drop the line.
		it("should carry no suggestion for a tag past the last Parameter", () => {
			let diagnostics = diagnosticsFor(`implementation {
				§§ Greets.
				§§ @param subject — who to greet
				§§ @param loudly — and how
				function greet(subject: String) -> String { <- subject }
			}`)

			expect(diagnostics[0].code).toBe("unknown-documentation-parameter")
			expect(diagnostics[0].data).toBeUndefined()
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
			// The block sits above the `constant`, and the Parameters it
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
			// A Warning about a `§§` block must not keep its Function from being
			// hoisted, or earlier calls would report `unknown-name`.
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
			// `alias` is function-valued, but its resolved Type keeps no internal
			// names, so its `@param` can not be checked.
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
			// An anonymous literal declares nothing, so the `§§` block on its line
			// belongs to the enclosing Declaration, not the literal. A Parameter's
			// default shares its signature's line.
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

			// An Argument's callback is the same shape without a default
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
			// The block is still checked, against the Method whose Parameter
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
			// The literal is handed the Declaration's block rather than reading
			// its line, so both layouts give Signature Help the description.
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
			// The standard library's Positions are stripped as it loads, so it
			// has no `§§` line to check.
			expect(
				diagnosticsFor(`implementation {
					constant length = "abc"::length()
				}`),
			).toEqual([])
		})
	})

	// A static Method takes no receiver, so its call passes only the written
	// Arguments and its definition has no `_self` Parameter.
	describe("Static Methods", () => {
		// No Namespace is a value, so `print` asks no conformance of one after.
		it("should reject a standard library Namespace used as a value", () => {
			let diagnostics = diagnosticsFor(`implementation {
				Terminal.inspect(String)
				Terminal.print(Integer)
			}`)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.message,
				]),
			).toEqual([
				[
					"namespace-as-value",
					"Namespace 'String' can not be used as a value",
				],
				[
					"namespace-as-value",
					"Namespace 'Integer' can not be used as a value",
				],
			])
		})

		// A Program's own Namespace is no value either, so `clock` is never
		// declared at a Namespace's Type and reports nothing further.
		it("should reject a declared Namespace used as a value", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Clock for Integer {
					static noon = 43_200
				}

				constant clock = Clock

				Terminal.inspect(clock.noon)
			}`)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.message,
				]),
			).toEqual([
				[
					"namespace-as-value",
					"Namespace 'Clock' can not be used as a value",
				],
			])
		})

		// A member read off a Namespace is a value of the member, whoever
		// declared the Namespace.
		it("should accept a member read off a declared Namespace and off a builtin", () => {
			expect(
				diagnosticsFor(`implementation {
					namespace Clock for Integer {
						static noon = 43_200

						static now() -> Integer {
							<- 7
						}

						shouted() -> String {
							<- "LOUD"
						}
					}

					constant now = Clock.now

					Terminal.inspect(Clock.noon)
					Terminal.inspect(Clock.now())
					Terminal.inspect(now())
					Terminal.inspect(5::<Clock>shouted())
					Terminal.inspect(String.isEmpty(""))
				}`),
			).toEqual([])
		})

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
			expect(diagnostics[0].helps).toEqual([
				"Write 'Maker.make(…)' without the value — the signature takes no receiver.",
			])
		})

		// The arity decides whether the value goes among the Arguments, and
		// each reading the Help spells compiles.
		it("should compile the call each arity's Help writes", () => {
			let maker = (signature: string, call: string) => `implementation {
				namespace Maker for Integer {
					static ${signature} -> Integer {
						<- 1
					}
				}

				constant made = ${call}
			}`

			for (let [signature, written, help, followed] of [
				[
					"origin()",
					"5::origin()",
					"Write 'Maker.origin(…)' without the value — the signature takes no receiver.",
					"Maker.origin()",
				],
				[
					"moved(_ base: Integer, by amount: Integer)",
					"5::moved(by 2)",
					"Write 'Maker.moved(…)', passing the value as its first Argument.",
					"Maker.moved(5, by 2)",
				],
			]) {
				expect(
					diagnosticsFor(maker(signature, written))[0]?.helps,
				).toEqual([help])
				expect(compiles(maker(signature, followed))).toBe(true)
			}
		})

		// A static is reached only through its Namespace, which the Help names
		// and the Quick Fix writes.
		it("should carry the owning Namespace as data", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Maker for Integer {
					static make(_ base: Integer) -> Integer {
						<- base
					}
				}

				constant made = 5::make(7)
			}`)

			// `make` takes exactly the Argument the call wrote, so the Help says
			// to drop the value.
			expect(diagnostics[0].helps).toEqual([
				"Write 'Maker.make(…)' without the value — the signature takes no receiver.",
			])
			expect(diagnostics[0].data).toEqual({
				kind: "static-owner",
				namespace: "Maker",
				acceptsValue: false,
				acceptsWithoutValue: true,
			})
		})

		// One Argument written and two Parameters to fill, so the receiver
		// belongs among the Arguments.
		it("should name the shape a longer signature accepts", () => {
			let diagnostics = diagnosticsFor(`implementation {
				namespace Spans for Integer {
					static distance(_ from: Integer, to end: Integer) -> Integer {
						<- end::subtract(from)
					}
				}

				constant span = 5::distance(to 7)
			}`)

			expect(diagnostics[0].helps).toEqual([
				"Write 'Spans.distance(…)', passing the value as its first Argument.",
			])
			expect(diagnostics[0].data).toEqual({
				kind: "static-owner",
				namespace: "Spans",
				acceptsValue: true,
				acceptsWithoutValue: false,
			})
		})

		// A predicate calls nothing but a Method of `@`, so rewriting the call
		// to `Sizes.isSmall()` would be refused again. The declaration is the
		// edit, and a standard library static has none to offer.
		it("should offer only the declaration's edit inside a predicate", () => {
			let refined = (keyword: string) => `implementation {
				namespace Sizes for Integer {
					${keyword}isSmall() -> Boolean {
						<- true
					}
				}

				type Small = Integer where @::isSmall()
			}`
			let [refusal] = diagnosticsFor(refined("static "))

			expect(refusal.code).toBe("static-method-on-value")
			expect(refusal.helps).toEqual([
				"Declare 'isSmall' in 'Sizes' without 'static' — a predicate asks a Method of '@', and a static Method has no receiver.",
			])
			expect(refusal.data).toBeUndefined()
			expect(compiles(refined(""))).toBe(true)

			let [builtin] = diagnosticsFor(`implementation {
				type Parsed = Integer where @::parse("5")
			}`)

			expect(builtin.code).toBe("static-method-on-value")
			expect(builtin.helps).toEqual([])
		})

		// Without 'static', a first Parameter that took the value is still an
		// Argument. The Help says to read '@' in its place.
		it("should name the Parameter '@' replaces inside a predicate", () => {
			let refined = (declaration: string) => `implementation {
				namespace Sizes for Integer {
					${declaration} -> Boolean {
						<- number::isLessThan(limit)
					}
				}

				type Small = Integer where @::isSmall(below 10)
			}`
			let [refusal] = diagnosticsFor(
				refined(
					"static isSmall(_ number: Integer, below limit: Integer)",
				),
			)

			expect(refusal.code).toBe("static-method-on-value")
			expect(refusal.helps).toEqual([
				"Declare 'isSmall' in 'Sizes' without 'static', reading '@' in place of its first Parameter — a predicate asks a Method of '@', and a static Method has no receiver.",
			])
			expect(
				compiles(
					refined("isSmall(below limit: Integer)").replace(
						"number::isLessThan",
						"@::isLessThan",
					),
				),
			).toBe(true)
			expect(
				compiles(
					refined("isSmall(_ number: Integer, below limit: Integer)"),
				),
			).toBe(false)
		})

		// A builtin static called on a value is refused, or the Simplifier
		// would prepend the receiver as an Argument.
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

		// An instance Method beside it binds `@`, so the Scope refuses `@` in a
		// static rather than leaving it undeclared.
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
			// Dropping 'static' changes how every call is written, so the Help
			// says so.
			expect(diagnostics[0].helps).toEqual([
				"Take the value as a Parameter, or drop 'static' to make this an instance Method — then every call writes its receiver, 'value::name(…)' rather than 'Namespace.name(…)'.",
			])
		})

		// Each half of the Help, followed with the calls it says to rewrite.
		it("should compile either way the Help names", () => {
			let maker = (method: string, call: string) => `implementation {
				namespace Maker for Integer {
					${method} {
						<- base::add(1)
					}
				}

				constant made = ${call}
			}`

			expect(
				compiles(
					maker(
						"static make(_ base: Integer) -> Integer",
						"Maker.make(7)",
					),
				),
			).toBe(true)
			expect(
				compiles(
					maker("make() -> Integer", "7::make()").replace(
						"base::add(1)",
						"@::add(1)",
					),
				),
			).toBe(true)
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

		// A Match Handler binds its own `@`, the matched value, so it works
		// inside a static Method.
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

	// A default is enriched before its own Parameter is declared. See
	// "Parameter defaults" in packages/compiler/src/enricher/DEVELOPMENT.md.
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

		// The Parameter's own name is barred in its default, even where an
		// outer name is spelled the same.
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

		// `y` resolves to the outer Constant, but the emitted `(a = y, y)` would
		// read the later Parameter before it exists.
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

		// A Pattern's bindings are Constants at the head of the body, which
		// runs after every default.
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

		// A Function literal inside a default may declare a barred name as its
		// own Parameter.
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

		// `enrichMethodFunctionDefinition` bars `@` before it walks the
		// Parameter list, so a static's default can not read `@` either.
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

		// A default may sit anywhere unless a later Parameter answers to the
		// same label.
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

		// Pairing reads labels and `hasDefault`, never a Type, so a call's shape
		// is settled before any Argument is typed.
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

			// `to 3` carries a label `from` does not, so the walk skips `from` and
			// pairs `to`.
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

				// Parameter 0 is the receiver `@` lowers to, so the one
				// the source wrote is 1.
				expect(value.omittedParameterIndices).toEqual([1])
			})

			// An omitted Argument binds nothing, but another Argument still binds
			// the Type Parameter.
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

			// A call can not spell Type Arguments, and the binding's annotation
			// does not reach the call, so the Help names another edit.
			it("should offer an edit that is not the annotation already written", () => {
				let diagnostics = diagnosticsFor(`implementation {
					function blank<infer Item>() -> List<Item> {
						<- []
					}

					constant items: List<Integer> = blank()
				}`)

				expect(diagnostics.map(({ code }) => code)).toEqual([
					"uninferable-type-parameter",
				])
				expect(diagnostics[0]!.helps).toEqual([
					"Give the Type Parameter a place among the Parameters, so that an Argument binds it.",
					"Or write the value itself, with the Type it answers written out — 'constant value: List<…> = []', with the Type you mean in place of each '…'.",
				])
			})
		})

		// A Type carries only `hasDefault`, since Types are compared, cached
		// and serialized. The expression stays on the Declaration's Node.
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

			// Parameter 0 is the receiver every non-static signature starts with.
			expect(member.parameterTypes[0].hasDefault).toBeUndefined()
			expect(member.parameterTypes[1].hasDefault).toBe(true)
		})

		// `defaultMembers` says which members a call may leave out of a Record
		// Argument it still has to write.
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
			// A partial default fills in members, so the Argument is required.
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

		// A default that is not a literal can not be read off its text, so it
		// is complete and every member is omittable.
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

		// A Function taken as a value drops its defaults, both keys included.
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

		// `recordDefaultMembers` admits a partial default only where its
		// members are the Parameter's and written out.
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

		// The typed tree carries the enriched default, which the Simplifier
		// lowers and the Language Server walks.
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

	// A Module's Choices are identified by its canonical path, but the Type
	// Scope is keyed by the written name. Every lookup by name must still find
	// the Choice.
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

	// A `where` clause's Type, its canonical conjuncts and its refusals.
	// `typeMatching.spec.ts` pins assignability between refinements.
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

		// A generic refined Alias is a Generic Alias wrapping the refinement, so
		// its refinement is one level in.
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
			// `isNot` is a provided Method, keyed under the Namespace whose
			// conformance put it in reach, Integer's own.
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

		// A Rational bound keeps a fraction where an Integer's keeps digits,
		// under Rational's own Namespace.
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

		// A conjunct is a key, so it holds the number in lowest terms. `0/2` and
		// `0/1` make one Type.
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

		// An Integer bound on a Rational is the same number and the same key,
		// since the receiver decides it.
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

			// `spelling` keeps what was written, for Diagnostics, so the keys are
			// compared without it.
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

		// A Program's own Namespace over a Rational is left exactly as
		// written. What `Frac::isBig` asks is the Program's question, and
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

		// `hasItems` asks nothing about the items, so the key holds no Type
		// Argument, and `matchTypes` tells `Filled<String>` from `Filled<Integer>`
		// by base. `Filled` is used since `NonEmptyList` is a builtin.
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

		// The wrapper substitutes a use site's Arguments into the base. The
		// conjuncts come along by reference, with nothing to substitute.
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

		// The provided `isBetween` is keyed under `Integer` for an Integer
		// receiver, as `isOdd` is. The label is kept on the spelling alone, for
		// the text a Diagnostic prints.
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

		// A generic Alias reads `@` off the base inside its wrapper.
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

		// A refused clause leaves the Alias meaning its base. Each test asserts
		// the text the refusal underlines.
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

			// `Item` is opaque while the clause is read, so `@::contains(0)` is
			// refused for its Argument, keeping conjuncts item-agnostic.
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

			// A poisoned base gets one Diagnostic, about the missing name, and
			// none about the clause.
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

			// And a predicate that could not be typed is a Diagnostic about
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

			// A Namespace over a refused Alias answers for its base, through a
			// receiver typed either way.
			it("should let a Namespace over a refused Alias answer for its base", () => {
				let codes = [
					`implementation {
						constant limit = 10

						type Small = Integer where @::isLessThan(limit)

						namespace SmallOps for Small {
							negated() -> Integer {
								<- @::negate()
							}
						}

						constant n: Integer = 3
						constant x = n::negated()
					}`,
					`implementation {
						constant limit = 10

						type Holding = List<Integer> where @::contains(limit)

						namespace HoldingOps for Holding {
							size() -> Integer {
								<- @::length()
							}
						}

						function sizeOf(_ items: Holding) -> Integer {
							<- items::size()
						}
					}`,
				].map((source) =>
					diagnosticsFor(source).map((diagnostic) => diagnostic.code),
				)

				expect(codes).toEqual([
					["invalid-refinement-predicate"],
					["invalid-refinement-predicate"],
				])
			})

			// The emitted check could ask only about the base, so a refinement
			// Matcher would admit values its predicate refuses.
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

			// A refinement inside a Type Argument, as in `List<NonZeroInteger>`,
			// is refused for the same reason.
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

			// An Alias hiding a refinement in a member can not be tested either,
			// and beside a wildcard only this refusal catches it.
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

			// The refusal offers the erased shape, which the emitted check can
			// ask about. `eraseRefinements` drops a rebuilt Record's display
			// spelling.
			it("should offer the erased shape rather than the Alias it stopped being", () => {
				let diagnostics = diagnosticsFor(`implementation {
					type Bag = { count: NonZeroInteger }
					type Other = { label: String }

					constant thing: Bag | Other = { label = "x" }

					constant told = match thing -> String {
						case Bag { <- "bag" }
						case Other { <- "other" }
					}
				}`)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].helps).toEqual([
					"Match on '{ count: Integer }' and prove the predicate inside the arm, the way every 'Bag' is proven: an 'if' condition, a Case naming a written value, or a written value.",
				])
				expect(diagnostics[0].notes).toEqual([
					"A refinement's predicate erases before the Program runs, so the emitted check could only ask about '{ count: Integer }' — and the arm would run for values the predicate refuses.",
				])
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

		// A refined receiver keeps every Method of its base and flows into it.
		// `resolvers.spec.ts` pins the bucketing.
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

		// A refined Alias's predicate is read in hoisting and again for the
		// typed Node, so only one reading reports.
		it("should report a refusal exactly once", () => {
			expect(
				diagnosticsFor(
					"implementation { type Yes = Boolean where @::is(true) }",
				),
			).toHaveLength(1)
		})

		// The Alias asks `isProper`, and a signature beside `isProper` takes a
		// `Proper`. The Alias hoists with its predicate unread, and the conjuncts
		// are filled in when the Namespace arrives, in either order.
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

			// A failed clause would poison the Alias to String and let this call
			// pass, so the refusal proves the refinement.
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

			// Applying a generic refined Alias copies the refinement, so the
			// Namespace holds unread copies that the fill finishes too. `isFilled`,
			// since the builtin `List` answers `hasItems`.
			function genericallySelfAnswering(entries: string): string {
				return `implementation {
					type Filled<Item> = List<Item> where @::isFilled()

					namespace Listing<infer Item> for List<Item> {
						${entries}
					}
				}`
			}

			// The Types the Namespace's two applications resolved to, beside the
			// Alias's own refinement, read off the typed Nodes.
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

				// Each copy holds the very array the fill wrote into the Alias.
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

			// A predicate nothing answers is poisoned to its base, and each
			// pending copy to its own base, so `Filled<Integer>` stays
			// `List<Integer>`. Only the clause is reported.
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

	// The Types every use of a name is enriched to, in walk order. A test asks
	// what a branch or a `define` arm narrowed a binding to.
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

	// Every source puts the use it asks about last.
	function narrowedTypeOf(source: string, name: string): string {
		let types = readTypesOf(source, name)

		if (types.length === 0) {
			throw new Error(`Nothing named '${name}' is read anywhere.`)
		}

		return types[types.length - 1]
	}

	// An `if` whose condition asks a refinement's question narrows the binding
	// it asked. A narrowing is a shadow declaration in an Enricher Scope. See
	// "Narrowing" in packages/compiler/src/enricher/DEVELOPMENT.md.
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

		// A Rational narrows the same way. The receiver is a difference, which no
		// refinement of Rational closes over, so it is unproven before the `if`.
		it("should narrow a Rational the condition proved the predicate of", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						constant r = 5/6::subtract(1/3)

						if r::isNot(0/1) {
							Terminal.inspect(r)
						}
					}`,
					"r",
				),
			).toBe("NonZeroRational")
		})

		// A bare Integer bound is the same number, so the same question.
		it("should narrow a Rational proved by an Integer bound", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						constant r = 5/6::subtract(1/3)

						if r::isNot(0) {
							Terminal.inspect(r)
						}
					}`,
					"r",
				),
			).toBe("NonZeroRational")
		})

		// `@::is(0/1)` failing is `@::isNot(0/1)` holding, so the `else` holds a
		// `NonZeroRational`. No Type declares the `if` side, so it stays a
		// Rational.
		it("should narrow a Rational in the else of the opposite question", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						constant r = 5/6::subtract(1/3)

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

		// `isGreaterThan(0/1)` is what `PositiveRational` is written on, and a
		// value above zero is not zero, which `reciprocal` spends. The
		// annotation refuses the base's Optional.
		it("should reach a Rational refinement an ordering proves", () => {
			expect(
				narrowedTypeOf(
					`implementation {
						constant r = 5/6::subtract(1/3)

						if r::isGreaterThan(0/1) {
							constant flipped: Rational = r::reciprocal()

							Terminal.inspect(flipped)
							Terminal.inspect(r)
						}
					}`,
					"r",
				),
			).toBe("PositiveRational")
		})

		// The narrowed Constant reaches the call a bare Integer is refused.
		// `codeGeneration.spec.ts` asserts it end to end.
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

		// A Variable can be written inside the branch, so evidence about it
		// could outlive its value.
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

		// `PositiveInteger` is `@::isPositive()`, whose body is
		// `@::isGreaterThan(0)`, so either spelling proves the same leaf.
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

		// `@::isNot(0)` reaches the Alias declared by it, not `PositiveInteger`,
		// which needs a value above zero.
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

		// A condition proving two things establishes a refinement asking one.
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

		// Where several qualify, the one proving the most wins.
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

		// Among equal candidates the first the walk reaches stands: nearest
		// Scope first, and builtins before a Program's Aliases. Only the spelling
		// differs, but it is settled.
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

		// A conjunction proves things about each binding it names, and each
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

		// An `else` proves its condition's leaf with the polarity flag flipped,
		// so no Methods need to be declared contraries.
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

			// A conjunction answering `false` says that ONE of its questions
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

			// The true branch may read a conjunction leaf by leaf, since each leaf
			// is proven. The false branch may not, if any half is unreadable.
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

			// The standard library writes `isGreaterThanOrEqualTo` as `isLessThan`
			// negated, so the `else` proves the leaf `Small` is declared by.
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

			// The nested If is enriched in the Scope that holds the complement,
			// so its branches inherit the narrowing.
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

				// The nested condition's receiver, then its branches. Both `else`s
				// together prove the value is above zero, which is
				// `PositiveInteger`.
				expect(readTypesOf(source, "d").slice(-3)).toEqual([
					"NonZeroInteger",
					"NonZeroInteger",
					"PositiveInteger",
				])
			})

			// `isZero` is written `<- @::is(0)`, so its `else` proves the
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

			// `isNegative` is `@::isLessThan(0)`, whose contrary declares
			// `NonNegativeInteger`. Three spellings, one question.
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

		// A Program's own one-call predicate is read as the standard library's,
		// by the leaf it forwards to.
		describe("a Program's own predicate alias", () => {
			// The bound is 5, since with 0 the builtin `PositiveInteger` would win
			// the tie.
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

			// The condition asks the leaf the alias forwards to, and the
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

			// Only `Boolean::negate` flips the polarity, so the negation is read
			// after the call resolves. `Same::negate` here answers its value
			// unchanged.
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

		// A forwarding Method is read with the caller's Arguments in place.
		// `isLessThanOrEqualTo(9)` asks `@::isGreaterThan(9)`, negated.
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

			// The `doesNot…` Methods forward too, so the `else` of `contains`
			// proves a refinement written on the contrary, with the same bound.
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

			// The bound is the call's, so different Arguments are different
			// questions.
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

			// A Program's own reads exactly alike. `Healthy` and
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

			// A body writing the ordering backwards, as
			// `Integer::isLessThanOrEqualTo` does for a Rational bound, is read
			// as its converse.
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

			// A defaulted Parameter makes the caller and the body count
			// positions differently, so such a Method is read as no alias.
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

		// An alias naming an alias reads as the leaf both mean, in either order.
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

			// One chain written in every order. A Namespace hoisting before what
			// it names records the name, so a reading is finished where the leaf
			// is read.
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

			// `Relay` waits on a later Type, so the reading lags. The conjuncts are
			// written once, so the refinement waits a round for its leaf.
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

			// A chain is no alias. `@::absolute()` is an intermediate value, so
			// the `if` proves nothing about `d`.
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

			// Two Methods written as each other's contrary say nothing
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

		// A provided body is read as it hoists, with no Namespace on the leaf,
		// which the witness fills in. A Program's own Protocol is read alike.
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

			// The conformer's body names the provided body, which names
			// `Self::isAbove`. Both readings are recorded before the leaf is read.
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

			// A leaf carries scalars, not the typed Arguments that choose an
			// Overload, so it stops at an overloaded requirement. A refinement on
			// the provided Method is still reached.
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

			// A String's comparisons are `Comparable`'s bodies over
			// `String::compare`, and `isLessThanOrEqualTo` is `isGreaterThan`
			// negated.
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

		// The ordering law is read only off the base's Namespace and `Number`.
		// A Program's own `is` or `isLessThan` means what its body says.
		describe("a foreign Namespace spelling the comparisons", () => {
			// `Tag::is` and `Tag::isLessThan` ask about the length, and a
			// three-letter word answers both, so neither excludes the other.
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

			// Here `isNot` is not `is` negated: both bodies ask "above the
			// bound". The `else` proves "not above zero", which no refinement
			// declares.
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

			// `Weird::isNot` asks "above the bound", so a refinement on it is one
			// Type with `PositiveInteger`, reached by a value proven either way.
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

		// The narrowing lives in a wrapper Scope, so the body may re-declare the
		// narrowed name.
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

		// A shadow that forgets something the binding's Type already carries
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

		// A Type's own evidence counts towards what the branch proves, so a
		// condition adds to it.
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

		// A Guard narrows `@` as a condition narrows a Constant, and it runs
		// before the Handler's body. See "Match Handlers and Guards" in
		// packages/compiler/src/enricher/DEVELOPMENT.md.
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

			// Navigated, since only the body's `@`, not the Guard's, is narrowed.
			let returned = value.handlers[0].body[0]

			if (returned.nodeType !== "ReturnStatement") {
				throw new Error("The first Handler does not return.")
			}

			expect(printType(returned.expression.type)).toBe("NonZeroInteger")
		})

		it("should leave '@' alone where a Guard proves nothing declared", () => {
			// `isGreaterThan(7)` rather than `isGreaterThan(0)`, which the
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

		// A Guard narrows a payload binding as it narrows `@`, since
		// `case #Value(item) where item::hasCharacters()` asks about one value.
		describe("a Match Handler's payload binding", () => {
			const SHOUT = "type Shout = String where @::hasCharacters()"

			// The Type the body's last Statement reads a name at. Navigated, since
			// the Guard, the desugared Constant and the body each hold the name.
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

			// The builtin `NonEmptyString` proves what `Shout` does and is
			// declared first, so the Guard establishes it. `Shout` keeps the other
			// sources about reach rather than about which Alias won.
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

			// Evidence is about the name it was spelled with and about no
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

			// A Variable can be written in the body, so a Guard does not narrow
			// it either.
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

			// The binding's desugared Constant is in the body, so declaring the
			// name again is still a duplicate, not a shadow.
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

		// An Error matches every refinement, so a poisoned binding is not
		// narrowed.
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

		// A refinement over another base establishes nothing. An Integer
		// receiver keeps the builtin List and String refinements out, and no
		// refinement in scope asks `isEven`.
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

		// A generic refined Alias's Type Arguments are decided per binding, by
		// unifying its base with the receiver's Type. The result is then
		// established like any refinement.
		describe("a generic refinement", () => {
			// Every `hasItems` branch establishes the builtin `NonEmptyList`,
			// declared first. `Filled` proves the same of the same base, so the
			// established value flows into a `Filled` Parameter.
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

			// A List of Lists decides `ItemType` as the inner List.
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

			// The branch works out `Filled<String>` from a `List<String>`.
			// `codeGeneration.spec.ts` asserts it end to end.
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

			// `hasItems` is written as `isEmpty` negated, so the `else` of
			// `isEmpty` establishes what the true branch of `hasItems` does.
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

			// And a Match Handler's Guard, through the same helper again.
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

			// `firstItem` on the narrowed binding answers the item bare, through
			// a Type the Program never wrote.
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

			// `B` appears nowhere in the base, so no receiver decides it and the
			// Alias is no candidate. `isEmpty` keeps the builtin `NonEmptyList` out.
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

			// Items of the enclosing Function's Type Parameter decide `Item` as
			// that Parameter. It prints terse, as every Argument is a Parameter.
			it("should narrow a List whose items are a Type Parameter", () => {
				expect(
					narrowedTypeOf(
						`implementation {
							function probe<infer Item>(_ items: List<Item>) -> Integer {
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

			// The two `Even`s print alike but prove different things, so the
			// instantiation is remembered per receiver, not by spelling.
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

		// A Conditional carries two claims about what its condition proved,
		// since refinements are erased before later stages. `instrument-coverage`
		// and `--mutate` read them.
		describe("The claims a Conditional carries", () => {
			// `isEmpty` proves `NonEmptyString` only for the `else`, and
			// `isGreaterThan(0)` proves `PositiveInteger` only for its own branch,
			// so both claims are kept.
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

	// Each arm is narrowed by the complements of earlier Conditions and its
	// own. The answer Type comes from the arrow, the position, or the arms. See
	// "define arms" in packages/compiler/src/enricher/DEVELOPMENT.md.
	describe("Define Expressions", () => {
		// The Type of a `define` where only the arms decide it.
		function defineTypeOf(source: string): string {
			return printType(lastConstantValue(source).type)
		}

		describe("Flow narrowing", () => {
			// The `divide` entry taking a `NonZeroInteger` answers bare, the other
			// an Optional, so the arm Types show which was reached.
			it("should narrow an arm from the complement of the arm above it", () => {
				let source = `implementation {
					constant d = 3

					constant quotient = define {
						as 0/1 if d::is(0)
						as 1::divide(by d) if d::isOdd()
						as 0/1 otherwise
					}
				}`

				// In walk order: the Declaration's name, the first Condition,
				// which nothing narrows, then the second arm's value and
				// Condition, read past the first arm's `false`.
				expect(diagnosticsFor(source)).toEqual([])
				expect(readTypesOf(source, "d")).toEqual([
					"Integer",
					"Integer",
					"NonZeroInteger",
					"NonZeroInteger",
				])
			})

			// The second arm's own Condition stacks on the earlier complement.
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

			// The `otherwise` arm holds every complement and nothing else.
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

			// A conjunction's `false` does not say which half failed, so later
			// arms get nothing. Its own arm still narrows by both halves.
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

			// Recorded per arm, since refinements are erased before later
			// stages.
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

			// `isEmpty` proves `NonEmptyString` only for later arms, and
			// `isGreaterThan(0)` proves `PositiveInteger` only for its own, so both
			// flags are kept.
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

		// A bare `#Empty` decides no Type, since a Choice's Type Parameters are
		// never inferred. These `define`s compile only where the position hands a
		// Type down.
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

			// A Match Handler's `<-` reaches the same rail through the
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

			// A table test's rows read the row Parameter's Type, so the tests
			// section is enriched here.
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

			it("should compile with the arrow or the annotation its Help names", () => {
				let typed = ARMS.replace(
					"define {",
					"define -> Optional<Integer> {",
				)

				for (let source of [
					`constant fetched = ${typed}`,
					`constant fetched: Optional<Integer> = ${ARMS}`,
				]) {
					expect(
						compiles(`implementation {
					constant flag = true

					${source}
				}`),
					).toBe(true)
				}
			})

			// A call picks its Overload by the Arguments, so an Argument hands
			// nothing down. The Diagnostic suggests the arrow.
			it("should not reach an Argument, and say what to write instead", () => {
				let diagnostics = diagnosticsFor(`implementation {
					constant flag = true

					function count (_ found: Optional<Integer>) -> Integer {
						<- 1
					}

					constant total = count(${ARMS})
				}`)

				// The Case's two Diagnostics, then the `define`'s, which offers
				// the arrow that works here.
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

			// An Argument and an unannotated Declaration hand down the same
			// nothing, so the Help offers the annotation and names the Argument
			// case as a caveat.
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
			// The arrow is a claim about the `define` itself, narrower than the
			// position's.
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

			// A position offers each member of a Union, and the `define` answers
			// with the offers its arms took, here both.
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

			// A ladder of Integers under `Integer | String` answers Integer, one
			// of the offers.
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

			// An arm taking none of the offers keeps the whole offer, so the
			// Validator reports against what the position said.
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

			// The `otherwise` arm's own Type is among them, being one of
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

		// A one-member Case's payload slot offers the Record and the member's
		// Type, and the `define` must settle on one spelling.
		describe("The answer Type inside a Case payload", () => {
			// The Type the payload reached the Case with, the carried Record
			// either way, since a one-member shorthand is wrapped into it.
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

			// Written out in full, the `define` stands in the member's own
			// position and sees one spelling.
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

			// Bare Case arms decide no Type Arguments, so they resolve against the
			// position's Choice.
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

	// In a Match on an Integer or String value, a Case naming a value proves it.
	// The Case for the rest proves the value is none of the named ones.
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

		// The Type of `@` in each Handler's returned value, since a Guard's `@`
		// is not the body's.
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

		// Every earlier Case contributes, so two named values establish a
		// refinement asking about both, or about either.
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

		// A Guarded value Case hands nothing down, since its value may still
		// reach later Cases. Asked of a Union, where such a Case is legal.
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

		// A Guard runs after the Matcher, so the Case's own value still holds in
		// its body.
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

		// INVARIANT: the Matchers stay as written, since the runtime check is
		// emitted from them.
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

		// A String that is not empty has content, but the Compiler can not know
		// that, as with an `if`.
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

		// A Boolean is no refinable base, and a Case naming one of its two
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

	// A written value's predicate is decided while compiling, and the Enricher
	// chooses Overloads by it. `validator.spec.ts` asserts the Statements.
	describe("Refinement literal admission", () => {
		// Two entries told apart by the evidence the first demands, so the one
		// that answers says whether the Argument was admitted.
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

		// A name is a computed value, and deciding it would need an interpreter.
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

		// The same two answers for a written Rational, which is as visibly
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

			// `1/2::isLessThan(1)` asks what `1/2::isLessThan(1/1)` asks.
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

		// Admission answers a position rather than writing onto the Node, so
		// what a losing entry admitted can not reach the winner.
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

		// A refined receiver is in every entry, so it is not counted as
		// evidence, and an appended refined entry is still probed first.
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

		// A `NonEmptyList<Item>` Parameter whose `Item` the call infers is not
		// yet a Type. The value is asked about the refinement its own Type
		// decides, and binds `Item` as an unrefined `List<Item>` would.
		describe("a Type Argument the call infers", () => {
			// Only the evidence tells the two entries apart. The second pins the
			// items, so an undecided List still has an entry to fall to.
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

			// An empty List decides no `Item`, so the unrefined entry answers, as
			// for a List the predicate fails.
			it("should not admit a written List that decides no Type Argument", () => {
				expect(
					lastConstantFunctionInvocation(counted("[]"))
						.overloadedMethodIndex,
				).toBe(1)
			})

			// A Type Parameter binds the base, never the refinement. The return
			// Type is the binding, and `firstItem` is total for the admitted value.
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

		// A literal written inside a Record literal answers as a written
		// Argument does, so the refined entry takes it.
		it("should admit a written member into the refined entry", () => {
			let entryFor = (call: string) =>
				lastConstantMethodInvocation(`implementation {
					namespace Taker for Integer {
						overload take {
							(_ n: { count: PositiveInteger }) -> String { <- "positive" }
							(_ n: { count: Integer }) -> String { <- "integer" }
						}

						overload listed {
							(_ b: { rows: NonEmptyList<Integer> }) -> String { <- "filled" }
							(_ b: { rows: List<Integer> }) -> String { <- "rows" }
						}
					}

					constant answer = 1::${call}
				}`).overloadedMethodIndex

			expect(entryFor("take({ count = 3 })")).toBe(0)
			expect(entryFor("take({ count = -3 })")).toBe(1)
			expect(entryFor("listed({ rows = [1] })")).toBe(0)
			expect(entryFor("listed({ rows = [] })")).toBe(1)
		})

		// A written payload answers for the instantiation it stands in, so the
		// refined entry takes it too.
		it("should admit a written payload into the refined entry", () => {
			let entryFor = (payload: string) =>
				lastConstantMethodInvocation(`implementation {
					choice Box<Value> { Full { value: Value }, Empty }

					namespace Taker for Integer {
						overload boxed {
							(_ b: Box<PositiveInteger>) -> String { <- "positive" }
							(_ b: Box<Integer>) -> String { <- "integer" }
						}
					}

					constant answer = 1::boxed(${payload})
				}`).overloadedMethodIndex

			expect(entryFor("#Full(3)")).toBe(0)
			expect(entryFor("#Full(-3)")).toBe(1)
		})
	})

	// No position asks a receiver a question, so a written receiver asks every
	// refinement in scope itself and carries the conjunction admitted. See
	// "Written receivers" in packages/compiler/src/enricher/DEVELOPMENT.md.
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

		// `3` proves both builtin Integer predicates, whose conjunction is
		// `PositiveInteger`.
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

		// With no declared Alias for the whole conjunction, the Type prints as
		// its conjuncts chained in comparison order.
		it("should spell a conjunction no declared name covers", () => {
			expect(
				receiverTypeOf(`type Even = Integer where @::isEven()
					type Big = Integer where @::isGreaterThan(10)

					constant text = 12::toString()`),
			).toBe(
				"Integer where @::isNot(0)::and(@::isEven())::and(@::isPositive())::and(@::isGreaterThan(10))::and(@::isGreaterThanOrEqualTo(0))",
			)
		})

		// The hover shows the conjunction, but no reader declared it, so a
		// report names the Type the reader wrote.
		it("should describe a conjunction no declared name covers as the written Type", () => {
			let [refusal] = diagnosticsFor(`implementation {
				Terminal.print("a"::frobnicate())
			}`)

			expect(refusal.code).toBe("unknown-method")
			expect(refusal.labels.map((label) => label.message)).toEqual([
				"no Method of this name",
				"this is a String",
			])
		})

		// A written Rational answers for itself the way a written Integer
		// does, and prints under the Alias whose conjuncts are exactly what it
		// proved. A zero is not above zero and is not below it either, so it
		// proves the weaker of the two sign Aliases.
		it("should carry a written Rational's proof", () => {
			expect(receiverTypeOf("constant text = 1/2::toString()")).toBe(
				"PositiveRational",
			)

			expect(receiverTypeOf("constant text = 0/1::toString()")).toBe(
				"NonNegativeRational",
			)
		})

		it("should carry a generic refinement applied to the items", () => {
			expect(receiverTypeOf('constant text = ["a"]::isEmpty()')).toBe(
				"NonEmptyList<String>",
			)
		})

		// `NonEmptyString` declares no `trim`, which can empty a String, so the
		// call falls to `String`'s own.
		it("should reach the base Namespace where nothing targets the proof", () => {
			expect(receiverTypeOf('constant text = "abc"::trim()')).toBe(
				"NonEmptyString",
			)
			expect(answerOf('constant text = "abc"::trim()')).toBe("String")
		})

		// Where the proof is targeted, the answers tighten: a count above zero,
		// characters in a proven List, and bare ends.
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

		// An empty written List proves nothing, and no refinement may be
		// written over a Boolean.
		it("should prove nothing about a written value the predicates refuse", () => {
			expect(receiverTypeOf("constant grown = []::append(1)")).toBe(
				"List<Unknown>",
			)
			expect(receiverTypeOf("constant text = true::toString()")).toBe(
				"Boolean",
			)
		})

		// A computed receiver proves nothing. A difference is used, since no
		// Integer refinement closes over it, while sums and products of written
		// Integers carry proofs.
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

		// A proof never widens an answer. A power at a non-negative exponent and
		// a sum answer the tightest Integer their operands prove.
		it("should never widen an answer the base already gave", () => {
			expect(answerOf("constant power = 2::raise(to 10)")).toBe(
				"PositiveInteger",
			)
			expect(answerOf("constant sum = 1::add(2)")).toBe("PositiveInteger")
			expect(answerOf("constant power = 0::raise(to -1)")).toBe(
				"Optional<Integer | Rational>",
			)
		})

		// A product of proven Integers is proven. Two written factors reach
		// `PositiveInteger`, the narrowest Namespace holding both proofs.
		it("should answer with the refinement a refined entry declares", () => {
			expect(answerOf("constant product = 2::multiply(with 3)")).toBe(
				"PositiveInteger",
			)
			expect(
				answerOf(`constant count: NonZeroInteger = 3
					constant product = count::multiply(with 4)`),
			).toBe("NonZeroInteger")
		})

		// Counts, distances from zero and lowest-terms denominators carry sign
		// proofs, so `2::raise(to items::length())` answers a whole number and
		// `absolute()::squareRoot()` a bare root.
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

		// A written receiver reaches a Program's own refined Namespace as it
		// reaches the standard library's.
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

	// A refinement adds Methods and hides none, so a `defaultingTo` fallback
	// can be dead. A call is resolved again without that Argument, and a
	// non-Optional answer is a Warning. See "Dead fallbacks" in
	// packages/compiler/src/enricher/DEVELOPMENT.md.
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

		// The probe widens a written receiver past its refinement, so
		// `[1, 2]::firstItem(defaultingTo 0)` is a dead fallback, not an entry
		// swap.
		it("should warn where a written receiver answers bare", () => {
			expect(
				codesFor(
					programWith(
						"constant first = [1, 2]::firstItem(defaultingTo 0)",
					),
				),
			).toEqual(["fallback-never-used"])
		})

		// A written `2` proves `divide`'s `NonZeroInteger` entry, so the
		// fallback is dead, with the evidence on the Argument.
		it("should warn where a written Argument proves the answer exists", () => {
			expect(
				codesFor(
					programWith(
						"constant half = 10::divide(by 2, defaultingTo 0/1)",
					),
				),
			).toEqual(["fallback-never-used"])
		})

		// The Warning names the Type the call answers without the fallback.
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

		// The label is part of the span, because the label is part of what
		// the Help asks the reader to drop.
		it("should underline the label together with its value", () => {
			let source = programWith(
				"constant first = proven::firstItem(defaultingTo 0)",
			)

			expect(underlinedText(source, diagnosticsFor(source)[0])).toBe(
				"defaultingTo 0",
			)
		})

		// `Optional::value` declares no bare `value()`, so the second resolution
		// finds no winner. This is why the rule re-probes.
		it("should stay silent on 'Optional::value(defaultingTo:)'", () => {
			expect(
				codesFor(
					programWith(
						"constant first = plain::firstItem()::value(defaultingTo 0)",
					),
				),
			).toEqual([])
		})

		// A proven receiver is not on its own enough. `firstItem(where:)`
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

		// Nothing in the rule is about the standard library. A Namespace a
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

		// The same Namespace with no bare entry to fall to. The fallback is
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

		// A defaulted `defaultingTo` Parameter means the re-probe reaches the
		// same entry, whose written Argument is read at run time.
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

		// The same on the other rail, since both go through the one probe.
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

		// A different entry answering bare for reasons of its own proves
		// nothing. This call does read its fallback.
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

		// A call that resolved to nothing gets no Warning, since the Validator
		// already reports its Argument.
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

		// A re-probe is not re-entered for a kept Argument's own `defaultingTo`.
		// The inner call reports once, and the outer stays silent.
		it("should report a nested call once, from its own enrichment", () => {
			expect(
				codesFor(
					programWith(
						"constant first = plain::firstItem(defaultingTo proven::firstItem(defaultingTo 0))",
					),
				),
			).toEqual(["fallback-never-used"])
		})

		// The call keeps its entry. `lastConstantValue` is not used, since it
		// requires a silent Program.
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

	// `Optional::is` has an entry for the carrier and one for its payload. A
	// written `#Empty` against `Optional<Optional<Integer>>` fits both, and the
	// first entry wins, so a Warning says which question was asked. A Program's
	// own carrier is read the same way.
	describe("Two-level carrier comparisons", () => {
		function programWith(body: string): string {
			return `implementation {
				constant nested: Optional<Optional<Integer>> = #Value(#Empty)
				constant plain: Optional<Integer> = #Value(1)
				constant inner: Optional<Integer> = #Empty
				constant outer: Optional<Optional<Integer>> = #Empty
				constant failed: Result<Result<Integer, String>, String> = #Value(#Failure("inner"))

				${body}
			}`
		}

		function codesFor(source: string): Array<string> {
			return diagnosticsFor(source).map((diagnostic) => diagnostic.code)
		}

		// The selected Overload slot, read from a Program that may warn.
		function selectedEntryOf(source: string): number | null {
			let { program } = enrichSource(source)
			let constants = program.implementation.nodes.filter(
				(node) => node.nodeType === "ConstantDeclarationStatement",
			)
			let value = constants[constants.length - 1].value

			if (value.nodeType !== "MethodInvocation") {
				throw new Error("Last Constant is not a MethodInvocation.")
			}

			return value.overloadedMethodIndex
		}

		it("should warn where the Argument fits both levels of an Optional", () => {
			expect(
				codesFor(programWith("constant answer = nested::is(#Empty)")),
			).toEqual(["ambiguous-nesting-level"])
		})

		it("should warn on the negative reading of the same call", () => {
			expect(
				codesFor(
					programWith("constant answer = nested::isNot(#Empty)"),
				),
			).toEqual(["ambiguous-nesting-level"])
		})

		// A `Result` of `Result`s fails with one Type at both levels, so
		// `#Failure(reason)` fits both, as `#Empty` does for Optionals.
		it("should warn where a Result of Results is compared to a failure", () => {
			expect(
				codesFor(
					programWith(
						'constant answer = failed::is(#Failure("inner"))',
					),
				),
			).toEqual(["ambiguous-nesting-level"])
		})

		// The Warning names both levels and how to spell each.
		it("should name both levels and both spellings", () => {
			let source = programWith("constant answer = nested::is(#Empty)")
			let diagnostic = diagnosticsFor(source)[0]

			expect(diagnostic.severity).toBe("warning")
			expect(diagnostic.labels[0]).toMatchObject({
				kind: "primary",
				message: "read as an Optional<Optional<Integer>> here",
			})
			expect(diagnostic.labels[1]).toMatchObject({
				kind: "secondary",
				message: "this takes an Optional<Integer> as well",
			})
			expect(diagnostic.helps).toEqual([
				"Write '#Value(…)' around the Argument to ask whether the receiver holds it.",
				"Name it in a Constant annotated 'Optional<Optional<Integer>>' to go on asking about the receiver.",
			])
			expect(diagnostic.data).toEqual({
				kind: "holding-case",
				caseNames: ["Value"],
			})

			// Either reading, once written, is the one call there is.
			for (let followed of [
				"constant answer = nested::is(#Value(#Empty))",
				"constant answer = nested::is(outer)",
			]) {
				expect(compiles(programWith(followed))).toBe(true)
				expect(diagnosticsFor(programWith(followed))).toEqual([])
			}
		})

		// The Argument alone, which both Helps rewrite. The Method name carries
		// the secondary Label.
		it("should underline the Argument", () => {
			let source = programWith("constant answer = nested::is(#Empty)")

			expect(underlinedText(source, diagnosticsFor(source)[0])).toBe(
				"#Empty",
			)
		})

		// The Warning is a Warning: nothing is refused, and the call goes
		// on reaching the entry it reached. The whole-carrier entry is Overload
		// slot 0 of `Optional::is`.
		it("should leave the call on the entry it selected", () => {
			expect(
				selectedEntryOf(
					programWith("constant answer = nested::is(#Empty)"),
				),
			).toBe(0)
		})

		// An Argument annotated at the item's level reaches the bare-item
		// entry, slot 1, unambiguously.
		it("should stay silent where an annotated Constant asks about the item", () => {
			let source = programWith("constant answer = nested::is(inner)")

			expect(codesFor(source)).toEqual([])
			expect(selectedEntryOf(source)).toBe(1)
		})

		// An Argument annotated at the carrier's level fits only the
		// whole-carrier entry.
		it("should stay silent where an annotated Constant asks about the receiver", () => {
			expect(
				codesFor(programWith("constant answer = nested::is(outer)")),
			).toEqual([])
		})

		// The first Help's spelling: wrapping the Argument in the holding Case
		// decides the level.
		it("should stay silent on the wrapped spelling it recommends", () => {
			expect(
				codesFor(
					programWith("constant answer = nested::is(#Value(#Empty))"),
				),
			).toEqual([])
		})

		// `matchTypes` compares a Case's members, not its Type Arguments, so
		// `Optional<Optional<Integer>>#Empty` decides nothing. The second Help
		// asks for a Constant.
		it("should go on warning where the Case names its Choice", () => {
			expect(
				codesFor(
					programWith(
						"constant answer = nested::is(Optional<Optional<Integer>>#Empty)",
					),
				),
			).toEqual(["ambiguous-nesting-level"])
		})

		it("should stay silent on a plain Optional", () => {
			expect(
				codesFor(programWith("constant answer = plain::is(#Empty)")),
			).toEqual([])
		})

		it("should stay silent on a plain Optional compared to a bare item", () => {
			expect(
				codesFor(programWith("constant answer = plain::is(1)")),
			).toEqual([])
		})

		// An Integer holds nothing, so there is no second level and no
		// Warning.
		it("should stay silent where the receiver holds nothing", () => {
			expect(codesFor(programWith("constant answer = 3::is(4)"))).toEqual(
				[],
			)
		})

		// `or` and `value(defaultingTo:)` are single entries whose Parameter
		// Types pick the level, so the Method name decides. The same fact keeps
		// an `orElse` out of `Optional.es`.
		it("should stay silent where the Method's own name picks the level", () => {
			expect(
				codesFor(`implementation {
					constant nested: Optional<Optional<Integer>> = #Value(#Empty)

					constant fallen = nested::or(#Empty)
					constant item = nested::value(defaultingTo #Empty)
				}`),
			).toEqual([])
		})

		// A Program's own carrier and Overload are read the same way, down to
		// the Case the Help wraps in.
		it("should read a Program's own carrier by the same shape", () => {
			let source = `implementation {
				choice Box<ItemType> {
					Full { item: ItemType },
					Blank,
				}

				namespace Boxes<infer ItemType> for Box<ItemType> {
					overload holds {
						(_ other: Box<ItemType>) -> Boolean {
							<- true
						}

						(_ other: ItemType) -> Boolean {
							<- false
						}
					}
				}

				constant nested: Box<Box<Integer>> = #Full(#Blank)

				constant answer = nested::holds(#Blank)
			}`
			let diagnostics = diagnosticsFor(source)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"ambiguous-nesting-level",
			])
			expect(diagnostics[0].data).toEqual({
				kind: "holding-case",
				caseNames: ["Full"],
			})
		})

		// `#Labelled` and `#Full` both fit the payload entry and ask different
		// questions, so the Warning names every qualifying Case rather than
		// choosing one.
		it("should name every Case of a carrier whose payload fits", () => {
			let source = `implementation {
				choice Twin<ItemType> {
					First { item: ItemType },
					Second { item: ItemType },
					Blank,
				}

				namespace Twins<infer ItemType> for Twin<ItemType> {
					overload holds {
						(_ other: Twin<ItemType>) -> Boolean {
							<- true
						}

						(_ other: ItemType) -> Boolean {
							<- false
						}
					}
				}

				constant nested: Twin<Twin<Integer>> = #First(#Blank)

				constant answer = nested::holds(#Blank)
			}`
			let diagnostics = diagnosticsFor(source)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"ambiguous-nesting-level",
			])
			expect(diagnostics[0].data).toEqual({
				kind: "holding-case",
				caseNames: ["First", "Second"],
			})
			expect(diagnostics[0].helps).toEqual([
				"Write '#First(…)' around the Argument to ask whether the receiver holds it.",
				"Write '#Second(…)' around the Argument to ask whether the receiver holds it.",
				"Name it in a Constant annotated 'Twin<Twin<Integer>>' to go on asking about the receiver.",
			])
		})

		// `#Labelled` holds a String, so it is the first Case with a payload but
		// not the one that fits.
		it("should name the Case whose payload fits rather than the first", () => {
			let source = `implementation {
				choice Box<ItemType> {
					Labelled { label: String },
					Full { item: ItemType },
					Blank,
				}

				namespace Boxes<infer ItemType> for Box<ItemType> {
					overload holds {
						(_ other: Box<ItemType>) -> Boolean {
							<- true
						}

						(_ other: ItemType) -> Boolean {
							<- false
						}
					}
				}

				constant nested: Box<Box<Integer>> = #Full(#Blank)

				constant answer = nested::holds(#Blank)
			}`
			let diagnostics = diagnosticsFor(source)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"ambiguous-nesting-level",
			])
			expect(diagnostics[0].data).toEqual({
				kind: "holding-case",
				caseNames: ["Full"],
			})
		})

		// The check runs on every `Optional::is`, and a probe is a full match,
		// so a value that is no Case's payload must need no probe. Probes are
		// counted, since a timing ceiling this tight would flake.
		function probesFor(source: string): number {
			nestingLevelProbes.count = 0
			enrichSource(source)

			return nestingLevelProbes.count
		}

		it("should probe no Overload for a call that can not warn", () => {
			expect(
				probesFor(programWith("constant a = plain::is(#Empty)")),
			).toBe(0)
			expect(probesFor(programWith("constant a = plain::isNot(2)"))).toBe(
				0,
			)
			expect(probesFor(programWith("constant a = 3::is(4)"))).toBe(0)
			expect(
				probesFor(programWith("constant a = nested::is(#Empty)")),
			).toBeGreaterThan(0)
		})

		// The same Namespace with nothing nested under it. Both entries are
		// there, and a `#Blank` fits the carrier one alone, so there are not two
		// readings to report.
		it("should stay silent on a Program's own carrier holding no carrier", () => {
			expect(
				codesFor(`implementation {
					choice Box<ItemType> {
						Full { item: ItemType },
						Blank,
					}

					namespace Boxes<infer ItemType> for Box<ItemType> {
						overload holds {
							(_ other: Box<ItemType>) -> Boolean {
								<- true
							}

							(_ other: ItemType) -> Boolean {
								<- false
							}
						}
					}

					constant plain: Box<Integer> = #Blank

					constant answer = plain::holds(#Blank)
				}`),
			).toEqual([])
		})
	})

	// The Dictionary Type: its annotation, arity, assignability and user
	// Namespaces. Each Dictionary arrives as a Parameter, so only the Type is
	// asked.
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

				// Parameter 0 is the injected receiver, so the one the
				// Declaration wrote is the second.
				return printType(
					(method as common.SimpleMethodType).parameterTypes[1]!
						.type as common.Type,
				)
			}

			throw new Error("No Namespace in the Program")
		}

		// Every plan a derived `Equatable` left on an Invocation, which
		// `collectConformances` does not walk.
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

		// Two Type Arguments exactly, reported as `List` reports one, with a Type
		// built from what was written so nothing cascades.
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

		// Both Dictionary spellings share one index bucket, so a Namespace for
		// `Dictionary<Key, Value>` binds its Type Parameters off the receiver.
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

		// The two slots of a payload Dictionary are described apart: `String`
		// compares structurally and `Value` through its witness. Read together,
		// the box over a shared store would be compared structurally.
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

		// The Dictionary bucket holds only the two Dictionary spellings, so it
		// never answers a List.
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
