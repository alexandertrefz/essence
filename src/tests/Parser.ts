import { lex } from '../Lexer'
import { parse } from '../Parser'

describe('Parser', () => {
	describe('Expressions', () => {
		it('should parse identifiers', () => {
			let input = `identifier`
			let output = [{
				nodeType: 'Identifier',
				content: 'identifier',
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse "true" literals', () => {
			let input = `true`
			let output = [{
				nodeType: 'Value',
				type: 'Bool',
				value: true,
				members: {},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse "false" literals', () => {
			let input = `false`
			let output = [{
				nodeType: 'Value',
				type: 'Bool',
				value: false,
				members: {},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse empty string literals', () => {
			let input = `''`
			let output = [{
				nodeType: 'Value',
				type: 'String',
				value: '',
				members: {},
				position: {
					line: 1,
					column: 2,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse filled string literals', () => {
			let input = `'string'`
			let output = [{
				nodeType: 'Value',
				type: 'String',
				value: 'string',
				members: {},
				position: {
					line: 1,
					column: 2,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse simple number literals', () => {
			let input = `123`
			let output = [{
				nodeType: 'Value',
				type: 'Number',
				value: '123',
				members: {},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse simple number literals with underscores', () => {
			let input = `1_000`
			let output = [{
				nodeType: 'Value',
				type: 'Number',
				value: '1000',
				members: {},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse float number literals', () => {
			let input = `1.5`
			let output = [{
				nodeType: 'Value',
				type: 'Number',
				value: '1.5',
				members: {},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse float number literals with underscores', () => {
			let input = `1_000.5`
			let output = [{
				nodeType: 'Value',
				type: 'Number',
				value: '1000.5',
				members: {},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse empty function literals', () => {
			let input = `() -> Type {}`
			let output = [{
				nodeType: 'Value',
				type: 'Function',
				value: {
					nodeType: 'FunctionDefinition',
					parameters: [],
					returnType: {
						nodeType: 'TypeDeclaration',
						name: 'Type',
						position: {
							line: 1,
							column: 6,
						},
					},
					body: {
						nodeType: 'Block',
						nodes: [],
						position: {
							line: 1,
							column: 12,
						},
					},
					position: {
						line: 1,
						column: 1,
					},
				},
				members: {},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse empty function literals with some linebreaks', () => {
			let input = `() -> Type {
			}`
			let output = [{
				nodeType: 'Value',
				type: 'Function',
				value: {
					nodeType: 'FunctionDefinition',
					parameters: [],
					returnType: {
						nodeType: 'TypeDeclaration',
						name: 'Type',
						position: {
							line: 1,
							column: 6,
						},
					},
					body: {
						nodeType: 'Block',
						nodes: [],
						position: {
							line: 1,
							column: 12,
						},
					},
					position: {
						line: 1,
						column: 1,
					},
				},
				members: {},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse empty function literals with one parameter', () => {
			let input = `(parameter Type) -> Type {}`
			let output = [{
				nodeType: 'Value',
				type: 'Function',
				value: {
					nodeType: 'FunctionDefinition',
					parameters: [{
						nodeType: 'Parameter',
						name: 'parameter',
						type: {
							nodeType: 'TypeDeclaration',
							name: 'Type',
							position: {
								line: 1,
								column: 12,
							},
						},
						position: {
							line: 1,
							column: 2,
						},
					}],
					returnType: {
						nodeType: 'TypeDeclaration',
						name: 'Type',
						position: {
							line: 1,
							column: 21,
						},
					},
					body: {
						nodeType: 'Block',
						nodes: [],
						position: {
							line: 1,
							column: 27,
						},
					},
					position: {
						line: 1,
						column: 1,
					},
				},
				members: {},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse empty function literals with two parameters', () => {
			let input = `(parameter Type, parameter2 Type) -> Type {}`
			let output = [{
				nodeType: 'Value',
				type: 'Function',
				value: {
					nodeType: 'FunctionDefinition',
					parameters: [{
						nodeType: 'Parameter',
						name: 'parameter',
						type: {
							nodeType: 'TypeDeclaration',
							name: 'Type',
							position: {
								line: 1,
								column: 12,
							},
						},
						position: {
							line: 1,
							column: 2,
						},
					}, {
						nodeType: 'Parameter',
						name: 'parameter2',
						type: {
							nodeType: 'TypeDeclaration',
							name: 'Type',
							position: {
								line: 1,
								column: 30,
							},
						},
						position: {
							line: 1,
							column: 18,
						},
					}],
					returnType: {
						nodeType: 'TypeDeclaration',
						name: 'Type',
						position: {
							line: 1,
							column: 39,
						},
					},
					body: {
						nodeType: 'Block',
						nodes: [],
						position: {
							line: 1,
							column: 45,
						},
					},
					position: {
						line: 1,
						column: 1,
					},
				},
				members: {},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse empty function literals with more than two parameters', () => {
			let input = `(parameter Type, parameter2 Type, parameter3 Type) -> Type {}`
			let output = [{
				nodeType: 'Value',
				type: 'Function',
				value: {
					nodeType: 'FunctionDefinition',
					parameters: [{
						nodeType: 'Parameter',
						name: 'parameter',
						type: {
							nodeType: 'TypeDeclaration',
							name: 'Type',
							position: {
								line: 1,
								column: 12,
							},
						},
						position: {
							line: 1,
							column: 2,
						},
					}, {
						nodeType: 'Parameter',
						name: 'parameter2',
						type: {
							nodeType: 'TypeDeclaration',
							name: 'Type',
							position: {
								line: 1,
								column: 30,
							},
						},
						position: {
							line: 1,
							column: 18,
						},
					}, {
						nodeType: 'Parameter',
						name: 'parameter3',
						type: {
							nodeType: 'TypeDeclaration',
							name: 'Type',
							position: {
								line: 1,
								column: 48,
							},
						},
						position: {
							line: 1,
							column: 36,
						},
					}],
					returnType: {
						nodeType: 'TypeDeclaration',
						name: 'Type',
						position: {
							line: 1,
							column: 57,
						},
					},
					body: {
						nodeType: 'Block',
						nodes: [],
						position: {
							line: 1,
							column: 63,
						},
					},
					position: {
						line: 1,
						column: 1,
					},
				},
				members: {},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse function literals with statements', () => {
			let input = `() -> Type {
				<- identifier
			}`
			let output = [{
				nodeType: 'Value',
				type: 'Function',
				value: {
					nodeType: 'FunctionDefinition',
					parameters: [],
					returnType: {
						nodeType: 'TypeDeclaration',
						name: 'Type',
						position: {
							line: 1,
							column: 6,
						},
					},
					body: {
						nodeType: 'Block',
						nodes: [{
							nodeType: 'ReturnStatement',
							expression: {
								nodeType: 'Identifier',
								content: 'identifier',
								position: {
									line: 2,
									column: 7,
								},
							},
							position: {
								line: 2,
								column: 1,
							},
						}],
						position: {
							line: 1,
							column: 12,
						},
					},
					position: {
						line: 1,
						column: 1,
					},
				},
				members: {},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse function invocations without arguments', () => {
			let input = `invocation()`
			let output = [{
				nodeType: 'FunctionInvocation',
				name: {
					nodeType: 'Identifier',
					content: 'invocation',
					position: {
						line: 1,
						column: 1,
					},
				},
				arguments: [],
				position: {
					line: 1,
					column: 12,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse function invocations with one argument', () => {
			let input = `invocation(argument)`
			let output = [{
				nodeType: 'FunctionInvocation',
				name: {
					nodeType: 'Identifier',
					content: 'invocation',
					position: {
						line: 1,
						column: 1,
					},
				},
				arguments: [{
					nodeType: 'Identifier',
					content: 'argument',
					position: {
						line: 1,
						column: 13,
					},
				}],
				position: {
					line: 1,
					column: 12,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse function invocations with two arguments', () => {
			let input = `invocation(argument, argument2)`
			let output = [{
				nodeType: 'FunctionInvocation',
				name: {
					nodeType: 'Identifier',
					content: 'invocation',
					position: {
						line: 1,
						column: 1,
					},
				},
				arguments: [{
					nodeType: 'Identifier',
					content: 'argument',
					position: {
						line: 1,
						column: 13,
					},
				}, {
					nodeType: 'Identifier',
					content: 'argument2',
					position: {
						line: 1,
						column: 23,
					},
				}],
				position: {
					line: 1,
					column: 12,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse function invocations with more than two arguments', () => {
			let input = `invocation(argument, argument2, argument3)`
			let output = [{
				nodeType: 'FunctionInvocation',
				name: {
					nodeType: 'Identifier',
					content: 'invocation',
					position: {
						line: 1,
						column: 1,
					},
				},
				arguments: [{
					nodeType: 'Identifier',
					content: 'argument',
					position: {
						line: 1,
						column: 13,
					},
				}, {
					nodeType: 'Identifier',
					content: 'argument2',
					position: {
						line: 1,
						column: 23,
					},
				}, {
					nodeType: 'Identifier',
					content: 'argument3',
					position: {
						line: 1,
						column: 35,
					},
				}],
				position: {
					line: 1,
					column: 12,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse anonymous empty type constructors', () => {
			let input = `{}`
			let output = [{
				nodeType: 'Value',
				type: null,
				value: null,
				members: {},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse anonymous type constructors with a KeyValuePair', () => {
			let input = `{ key = value, }`
			let output = [{
				nodeType: 'Value',
				type: null,
				value: null,
				members: {
					key: {
						nodeType: 'Identifier',
						content: 'value',
						position: {
							line: 1,
							column: 8,
						},
					},
				},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse anonymous type constructors with multiple KeyValuePairs', () => {
			let input = `{ key = value, key2 = value2, }`
			let output = [{
				nodeType: 'Value',
				type: null,
				value: null,
				members: {
					key: {
						nodeType: 'Identifier',
						content: 'value',
						position: {
							line: 1,
							column: 8,
						},
					},
					key2: {
						nodeType: 'Identifier',
						content: 'value2',
						position: {
							line: 1,
							column: 23,
						},
					}
				},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse named empty type constructors', () => {
			let input = `Type{}`
			let output = [{
				nodeType: 'Value',
				type: 'Type',
				value: null,
				members: {},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse named type constructors with a KeyValuePair', () => {
			let input = `Type{ key = value, }`
			let output = [{
				nodeType: 'Value',
				type: 'Type',
				value: null,
				members: {
					key: {
						nodeType: 'Identifier',
						content: 'value',
						position: {
							line: 1,
							column: 13,
						},
					}
				},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse named type constructors with multiple KeyValuePairs', () => {
			let input = `Type{ key = value, key2 = value2, }`
			let output = [{
				nodeType: 'Value',
				type: 'Type',
				value: null,
				members: {
					key: {
						nodeType: 'Identifier',
						content: 'value',
						position: {
							line: 1,
							column: 13,
						},
					},
					key2: {
						nodeType: 'Identifier',
						content: 'value2',
						position: {
							line: 1,
							column: 28,
						},
					}
				},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse simple lookup', () => {
			let input = `lookup.member`
			let output = [{
				nodeType: 'Lookup',
				base: {
					nodeType: 'Identifier',
					content: 'lookup',
					position: {
						line: 1,
						column: 1,
					},
				},
				member: 'member',
				position: {
					line: 1,
					column: 8,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse simple lookup with invocation', () => {
			let input = `lookup.member()`
			let output = [{
				nodeType: 'FunctionInvocation',
				name: {
					nodeType: 'Lookup',
					base: {
						nodeType: 'Identifier',
						content: 'lookup',
						position: {
							line: 1,
							column: 1,
						},
					},
					member: 'member',
					position: {
						line: 1,
						column: 8,
					},
				},
				arguments: [],
				position: {
					line: 1,
					column: 16,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse complex lookup', () => {
			let input = `lookup.member1.member2`
			let output = [{
				nodeType: 'Lookup',
				base: {
					nodeType: 'Lookup',
					base: {
						nodeType: 'Identifier',
						content: 'lookup',
						position: {
							line: 1,
							column: 1,
						},
					},
					member: 'member1',
					position: {
						line: 1,
						column: 8,
					},
				},
				member: 'member2',
				position: {
					line: 1,
					column: 17,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse raw method lookups', () => {
			let input = `lookup::member`
			let output = [{
				nodeType: 'MethodLookup',
				base: {
					nodeType: 'Identifier',
					content: 'lookup',
					position: {
						line: 1,
						column: 1,
					},
				},
				member: 'member',
				position: {
					line: 1,
					column: 8,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse method lookups with invocation', () => {
			let input = `lookup::member()`
			let output = [{
				nodeType: 'MethodInvocation',
				name: {
					nodeType: 'MethodLookup',
					base: {
						nodeType: 'Identifier',
						content: 'lookup',
						position: {
							line: 1,
							column: 1,
						},
					},
					member: 'member',
					position: {
						line: 1,
						column: 8,
					},
				},
				arguments: [],
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse multiple method lookups with invocation', () => {
			let input = `lookup::member()::member()`
			let output = [{
				nodeType: 'MethodInvocation',
				name: {
					nodeType: 'MethodLookup',
					base: {
						nodeType: 'MethodInvocation',
						name: {
							nodeType: 'MethodLookup',
							base: {
								nodeType: 'Identifier',
								content: 'lookup',
								position: {
									line: 1,
									column: 1,
								},
							},
							member: 'member',
							position: {
								line: 1,
								column: 8,
							},
						},
						arguments: [],
						position: {
							line: 1,
							column: 1,
						},
					},
					member: 'member',
					position: {
						line: 1,
						column: 19,
					},
				},
				arguments: [],
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should not parse complex raw method lookups', () => {
			let input = `lookup::member1::member2`
			let output = [{
				nodeType: 'MethodLookup',
				base: {
					nodeType: 'MethodLookup',
					base: {
						nodeType: 'Identifier',
						content: 'lookup',
						position: {
							line: 1,
							column: 1,
						},
					},
					member: 'member1',
					position: {
						line: 1,
						column: 8,
					},
				},
				member: 'member2',
				position: {
					line: 1,
					column: 18,
				},
			}]

			expect(() => parse(lex(input))).toThrow()
		})

		it('should not parse native prefix without identifier', () => {
			let input = `__`
			let output = []

			expect(() => parse(lex(input))).toThrow()
		})

		it('should not parse native lookups without second identifier', () => {
			let input = `__lookup.`
			let output = []

			expect(() => parse(lex(input))).toThrow()
		})

		it('should parse native function invocation without parameters', () => {
			let input = `__lookup()`
			let output = [{
				nodeType: 'NativeFunctionInvocation',
				name: {
					nodeType: 'Identifier',
					content: 'lookup',
					position: {
						line: 1,
						column: 3,
					},
				},
				arguments: [],
				position: {
					line: 1,
					column: 10,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse native function invocation without parameters after lookup', () => {
			let input = `__lookup.member()`
			let output = [{
				nodeType: 'NativeFunctionInvocation',
				name: {
					nodeType: 'NativeLookup',
					base: {
						nodeType: 'Identifier',
						content: 'lookup',
						position: {
							line: 1,
							column: 3,
						},
					},
					member: 'member',
					position: {
						line: 1,
						column: 11,
					},
				},
				arguments: [],
				position: {
					line: 1,
					column: 18,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse native function invocation with single argument', () => {
			let input = `__lookup(argument)`
			let output = [{
				nodeType: 'NativeFunctionInvocation',
				name: {
					nodeType: 'Identifier',
					content: 'lookup',
					position: {
						line: 1,
						column: 3,
					},
				},
				arguments: [{
					nodeType: 'Identifier',
					content: 'argument',
					position: {
						line: 1,
						column: 11,
					},
				}],
				position: {
					line: 1,
					column: 10,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse native function invocation with multiple arguments', () => {
			let input = `__lookup(argument, argument2)`
			let output = [{
				nodeType: 'NativeFunctionInvocation',
				name: {
					nodeType: 'Identifier',
					content: 'lookup',
					position: {
						line: 1,
						column: 3,
					},
				},
				arguments: [{
					nodeType: 'Identifier',
					content: 'argument',
					position: {
						line: 1,
						column: 11,
					},
				}, {
					nodeType: 'Identifier',
					content: 'argument2',
					position: {
						line: 1,
						column: 21,
					},
				}],
				position: {
					line: 1,
					column: 10,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})
	})

	describe('Statements', () => {
		it('should parse return statements', () => {
			let input = `<- identifier`
			let output = [{
				nodeType: 'ReturnStatement',
				expression: {
					nodeType: 'Identifier',
					content: 'identifier',
					position: {
						line: 1,
						column: 3,
					},
				},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse if statements', () => {
			let input = `if (identifier) {}`
			let output = [{
				nodeType: 'IfStatement',
				condition: {
					nodeType: 'Identifier',
					content: 'identifier',
					position: {
						line: 1,
						column: 5,
					},
				},
				body: {
					nodeType: 'Block',
					nodes: [],
					position: {
						line: 1,
						column: 17,
					},
				},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse if else statements', () => {
			let input = `if (identifier) {} else {}`
			let output = [{
				nodeType: 'IfElseStatement',
				condition: {
					nodeType: 'Identifier',
					content: 'identifier',
					position: {
						line: 1,
						column: 5,
					},
				},
				trueBody: {
					nodeType: 'Block',
					nodes: [],
					position: {
						line: 1,
						column: 17,
					},
				},
				falseBody: {
					nodeType: 'Block',
					nodes: [],
					position: {
						line: 1,
						column: 26,
					},
				},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse if else if statements', () => {
			let input = `if (identifier) {} else if (identifier2) {}`
			let output = [{
				nodeType: 'IfElseStatement',
				condition: {
					nodeType: 'Identifier',
					content: 'identifier',
					position: {
						line: 1,
						column: 5,
					},
				},
				trueBody: {
					nodeType: 'Block',
					nodes: [],
					position: {
						line: 1,
						column: 17,
					},
				},
				falseBody: {
					nodeType: 'Block',
					nodes: [{
						nodeType: 'IfStatement',
						condition: {
							nodeType: 'Identifier',
							content: 'identifier2',
							position: {
								line: 1,
								column: 30,
							},
						},
						body: {
							nodeType: 'Block',
							nodes: [],
							position: {
								line: 1,
								column: 43,
							},
						},
						position: {
							line: 1,
							column: 26,
						},
					}],
					position: {
						line: 1,
						column: 20,
					},
				},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse declaration statements without typeDeclaration', () => {
			let input = `let identifier = ''`
			let output = [{
				nodeType: 'DeclarationStatement',
				name: 'identifier',
				type: null,
				value: {
					nodeType: 'Value',
					type: 'String',
					value: '',
					members: {},
					position: {
						line: 1,
						column: 19,
					},
				},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse declaration statements with typeDeclaration', () => {
			let input = `let identifier Type = ''`
			let output = [{
				nodeType: 'DeclarationStatement',
				name: 'identifier',
				type: {
					nodeType: 'TypeDeclaration',
					name: 'Type',
					position: {
						line: 1,
						column: 16,
					},
				},
				value: {
					nodeType: 'Value',
					type: 'String',
					value: '',
					members: {},
					position: {
						line: 1,
						column: 24,
					},
				},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse assignment statements', () => {
			let input = `identifier = ''`
			let output = [{
				nodeType: 'AssignmentStatement',
				name: 'identifier',
				value: {
					nodeType: 'Value',
					type: 'String',
					value: '',
					members: {},
					position: {
						line: 1,
						column: 15,
					},
				},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse empty typeDefinition statements', () => {
			let input = `type Type {}`
			let output = [{
				nodeType: 'TypeDefinitionStatement',
				name: {
					nodeType: 'Identifier',
					content: 'Type',
					position: {
						line: 1,
						column: 6,
					},
				},
				properties: {},
				members: {},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse typeDefinition statements with one property', () => {
			let input = `type Type {
				property Type
			}`
			let output = [{
				nodeType: 'TypeDefinitionStatement',
				name: {
					nodeType: 'Identifier',
					content: 'Type',
					position: {
						line: 1,
						column: 6,
					},
				},
				properties: {
					property: {
						nodeType: 'TypeDeclaration',
						name: 'Type',
						position: {
							line: 2,
							column: 14,
						},
					},
				},
				members: {},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse typeDefinition statements with multiple properties', () => {
			let input = `type Type {
				property Type
				property2 Type
			}`
			let output = [{
				nodeType: 'TypeDefinitionStatement',
				name: {
					nodeType: 'Identifier',
					content: 'Type',
					position: {
						line: 1,
						column: 6,
					},
				},
				properties: {
					property: {
						nodeType: 'TypeDeclaration',
						name: 'Type',
						position: {
							line: 2,
							column: 14,
						},
					},
					property2: {
						nodeType: 'TypeDeclaration',
						name: 'Type',
						position: {
							line: 3,
							column: 15,
						},
					},
				},
				members: {},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse typeDefinition statements with one empty method', () => {
			let input = `type Type {
				method() -> Type {}
			}`
			let output = [{
				nodeType: 'TypeDefinitionStatement',
				name: {
					nodeType: 'Identifier',
					content: 'Type',
					position: {
						line: 1,
						column: 6,
					},
				},
				properties: {},
				members: {
					method: {
						nodeType: 'Value',
						type: 'Method',
						value: {
							nodeType: 'FunctionDefinition',
							parameters: [],
							returnType: {
								nodeType: 'TypeDeclaration',
								name: 'Type',
								position: {
									line: 2,
									column: 17,
								},
							},
							body: {
								nodeType: 'Block',
								nodes: [],
								position: {
									line: 2,
									column: 23,
								},
							},
							position: {
								line: 2,
								column: 12,
							},
						},
						members: {},
						position: {
							line: 2,
							column: 1,
						},
					},
				},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse typeDefinition statements with multiple empty methods', () => {
			let input = `type Type {
				method() -> Type {}
				method2() -> Type {}
			}`
			let output = [{
				nodeType: 'TypeDefinitionStatement',
				name: {
					nodeType: 'Identifier',
					content: 'Type',
					position: {
						line: 1,
						column: 6,
					},
				},
				properties: {},
				members: {
					method: {
						nodeType: 'Value',
						type: 'Method',
						value: {
							nodeType: 'FunctionDefinition',
							parameters: [],
							returnType: {
								nodeType: 'TypeDeclaration',
								name: 'Type',
								position: {
									line: 2,
									column: 17,
								},
							},
							body: {
								nodeType: 'Block',
								nodes: [],
								position: {
									line: 2,
									column: 23,
								},
							},
							position: {
								line: 2,
								column: 12,
							},
						},
						members: {},
						position: {
							line: 2,
							column: 1,
						},
					},
					method2: {
						nodeType: 'Value',
						type: 'Method',
						value: {
							nodeType: 'FunctionDefinition',
							parameters: [],
							returnType: {
								nodeType: 'TypeDeclaration',
								name: 'Type',
								position: {
									line: 3,
									column: 18,
								},
							},
							body: {
								nodeType: 'Block',
								nodes: [],
								position: {
									line: 3,
									column: 24,
								},
							},
							position: {
								line: 3,
								column: 13,
							},
						},
						members: {},
						position: {
							line: 3,
							column: 1,
						},
					},
				},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse typeDefinition statements with one nonempty method', () => {
			let input = `type Type {
				method(parameter ParameterType) -> Type {}
			}`
			let output = [{
				nodeType: 'TypeDefinitionStatement',
				name: {
					nodeType: 'Identifier',
					content: 'Type',
					position: {
						line: 1,
						column: 6,
					},
				},
				properties: {},
				members: {
					method: {
						nodeType: 'Value',
						type: 'Method',
						value: {
							nodeType: 'FunctionDefinition',
							parameters: [{
								nodeType: 'Parameter',
								name: 'parameter',
								type: {
									nodeType: 'TypeDeclaration',
									name: 'ParameterType',
									position: {
										line: 2,
										column: 23,
									},
								},
								position: {
									line: 2,
									column: 13,
								},
							}],
							returnType: {
								nodeType: 'TypeDeclaration',
								name: 'Type',
								position: {
									line: 2,
									column: 41,
								},
							},
							body: {
								nodeType: 'Block',
								nodes: [],
								position: {
									line: 2,
									column: 47,
								},
							},
							position: {
								line: 2,
								column: 12,
							},
						},
						members: {},
						position: {
							line: 2,
							column: 1,
						},
					},
				},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse typeDefinition statements with multiple nonempty methods', () => {
			let input = `type Type {
				method(parameter ParameterType) -> Type {}
				method2(parameter ParameterType) -> Type {}
			}`
			let output = [{
				nodeType: 'TypeDefinitionStatement',
				name: {
					nodeType: 'Identifier',
					content: 'Type',
					position: {
						line: 1,
						column: 6,
					},
				},
				properties: {},
				members: {
					method: {
						nodeType: 'Value',
						type: 'Method',
						value: {
							nodeType: 'FunctionDefinition',
							parameters: [{
								nodeType: 'Parameter',
								name: 'parameter',
								type: {
									nodeType: 'TypeDeclaration',
									name: 'ParameterType',
									position: {
										line: 2,
										column: 23,
									},
								},
								position: {
									line: 2,
									column: 13,
								},
							}],
							returnType: {
								nodeType: 'TypeDeclaration',
								name: 'Type',
								position: {
									line: 2,
									column: 41,
								},
							},
							body: {
								nodeType: 'Block',
								nodes: [],
								position: {
									line: 2,
									column: 47,
								},
							},
							position: {
								line: 2,
								column: 12,
							},
						},
						members: {},
						position: {
							line: 2,
							column: 1,
						},
					},
					method2: {
						nodeType: 'Value',
						type: 'Method',
						value: {
							nodeType: 'FunctionDefinition',
							parameters: [{
								nodeType: 'Parameter',
								name: 'parameter',
								type: {
									nodeType: 'TypeDeclaration',
									name: 'ParameterType',
									position: {
										line: 3,
										column: 24,
									},
								},
								position: {
									line: 3,
									column: 14,
								},
							}],
							returnType: {
								nodeType: 'TypeDeclaration',
								name: 'Type',
								position: {
									line: 3,
									column: 42,
								},
							},
							body: {
								nodeType: 'Block',
								nodes: [],
								position: {
									line: 3,
									column: 48,
								},
							},
							position: {
								line: 3,
								column: 13,
							},
						},
						members: {},
						position: {
							line: 3,
							column: 1,
						},
					},
				},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse typeDefinition statements with empty & nonempty methods', () => {
			let input = `type Type {
				method(parameter ParameterType) -> Type {}
				method2() -> Type {}
			}`
			let output = [{
				nodeType: 'TypeDefinitionStatement',
				name: {
					nodeType: 'Identifier',
					content: 'Type',
					position: {
						line: 1,
						column: 6,
					},
				},
				properties: {},
				members: {
					method: {
						nodeType: 'Value',
						type: 'Method',
						value: {
							nodeType: 'FunctionDefinition',
							parameters: [{
								nodeType: 'Parameter',
								name: 'parameter',
								type: {
									nodeType: 'TypeDeclaration',
									name: 'ParameterType',
									position: {
										line: 2,
										column: 23,
									},
								},
								position: {
									line: 2,
									column: 13,
								},
							}],
							returnType: {
								nodeType: 'TypeDeclaration',
								name: 'Type',
								position: {
									line: 2,
									column: 41,
								},
							},
							body: {
								nodeType: 'Block',
								nodes: [],
								position: {
									line: 2,
									column: 47,
								},
							},
							position: {
								line: 2,
								column: 12,
							},
						},
						members: {},
						position: {
							line: 2,
							column: 1,
						},
					},

					method2: {
						nodeType: 'Value',
						type: 'Method',
						value: {
							nodeType: 'FunctionDefinition',
							parameters: [],
							returnType: {
								nodeType: 'TypeDeclaration',
								name: 'Type',
								position: {
									line: 3,
									column: 18,
								},
							},
							body: {
								nodeType: 'Block',
								nodes: [],
								position: {
									line: 3,
									column: 24,
								},
							},
							position: {
								line: 3,
								column: 13,
							},
						},
						members: {},
						position: {
							line: 3,
							column: 1,
						},
					},
				},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse typeDefinition statements with methods and properties', () => {
			let input = `type Type {
				property PropertyType
				method(parameter ParameterType) -> Type {}
			}`
			let output = [{
				nodeType: 'TypeDefinitionStatement',
				name: {
					nodeType: 'Identifier',
					content: 'Type',
					position: {
						line: 1,
						column: 6,
					},
				},
				properties: {
					property: {
						nodeType: 'TypeDeclaration',
						name: 'PropertyType',
						position: {
							line: 2,
							column: 14,
						},
					},
				},
				members: {
					method: {
						nodeType: 'Value',
						type: 'Method',
						value: {
							nodeType: 'FunctionDefinition',
							parameters: [{
								nodeType: 'Parameter',
								name: 'parameter',
								type: {
									nodeType: 'TypeDeclaration',
									name: 'ParameterType',
									position: {
										line: 3,
										column: 23,
									},
								},
								position: {
									line: 3,
									column: 13,
								},
							}],
							returnType: {
								nodeType: 'TypeDeclaration',
								name: 'Type',
								position: {
									line: 3,
									column: 41,
								},
							},
							body: {
								nodeType: 'Block',
								nodes: [],
								position: {
									line: 3,
									column: 47,
								},
							},
							position: {
								line: 3,
								column: 12,
							},
						},
						members: {},
						position: {
							line: 3,
							column: 1,
						},
					},
				},
				position: {
					line: 1,
					column: 1,
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})
	})
})
