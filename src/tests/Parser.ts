/// <reference path="../../typings/index.d.ts" />

import { lex } from '../Lexer'
import { parse } from '../Parser'

describe('Parser', () => {
	describe('Expressions', () => {
		it('should parse identifiers', () => {
			let input = `identifier`
			let output = [{
				nodeType: 'Identifier',
				content: 'identifier',
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
					},
					body: {
						nodeType: 'Block',
						nodes: [],
					}
				},
				members: {},
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
					},
					body: {
						nodeType: 'Block',
						nodes: [],
					}
				},
				members: {},
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
							name: 'Type'
						}
					}],
					returnType: {
						nodeType: 'TypeDeclaration',
						name: 'Type',
					},
					body: {
						nodeType: 'Block',
						nodes: [],
					}
				},
				members: {},
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
							name: 'Type'
						}
					}, {
						nodeType: 'Parameter',
						name: 'parameter2',
						type: {
							nodeType: 'TypeDeclaration',
							name: 'Type'
						}
					}],
					returnType: {
						nodeType: 'TypeDeclaration',
						name: 'Type',
					},
					body: {
						nodeType: 'Block',
						nodes: [],
					}
				},
				members: {},
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
							name: 'Type'
						}
					}, {
						nodeType: 'Parameter',
						name: 'parameter2',
						type: {
							nodeType: 'TypeDeclaration',
							name: 'Type'
						}
					}, {
						nodeType: 'Parameter',
						name: 'parameter3',
						type: {
							nodeType: 'TypeDeclaration',
							name: 'Type'
						}
					}],
					returnType: {
						nodeType: 'TypeDeclaration',
						name: 'Type',
					},
					body: {
						nodeType: 'Block',
						nodes: [],
					}
				},
				members: {},
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
					},
					body: {
						nodeType: 'Block',
						nodes: [{
							nodeType: 'ReturnStatement',
							expression: {
								nodeType: 'Identifier',
								content: 'identifier',
							}
						}],
					}
				},
				members: {},
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
				},
				arguments: []
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
				},
				arguments: [{
					nodeType: 'Identifier',
					content: 'argument'
				}]
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
				},
				arguments: [{
					nodeType: 'Identifier',
					content: 'argument'
				}, {
					nodeType: 'Identifier',
					content: 'argument2'
				}]
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
				},
				arguments: [{
					nodeType: 'Identifier',
					content: 'argument'
				}, {
					nodeType: 'Identifier',
					content: 'argument2'
				}, {
					nodeType: 'Identifier',
					content: 'argument3'
				}]
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
				},
				member: 'member'
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
					},
					member: 'member'
				},
				arguments: []
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
					},
					member: 'member1'
				},
				member: 'member2'
			}]

			expect(parse(lex(input))).toEqual(output)
		})

		it('should not parse native prefix without identifier', () => {
			let input = `__`
			let output = []

			expect(parse(lex(input))).toEqual(output)
		})

		it('should not parse native lookups without second identifier', () => {
			let input = `__lookup.`
			let output = []

			expect(parse(lex(input))).toEqual(output)
		})

		it('should parse native function invocation without parameters', () => {
			let input = `__lookup()`
			let output = [{
				nodeType: 'NativeFunctionInvocation',
				name: {
					nodeType: 'Identifier',
					content: 'lookup',
				},
				arguments: []
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
					},
					member: 'member',
				},
				arguments: []
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
				},
				arguments: [{
					nodeType: 'Identifier',
					content: 'argument'
				}]
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
				},
				arguments: [{
					nodeType: 'Identifier',
					content: 'argument'
				}, {
					nodeType: 'Identifier',
					content: 'argument2'
				}]
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
				}
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
				},
				body: {
					nodeType: 'Block',
					nodes: [],
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
				},
				trueBody: {
					nodeType: 'Block',
					nodes: [],
				},
				falseBody: {
					nodeType: 'Block',
					nodes: [],
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
				},
				trueBody: {
					nodeType: 'Block',
					nodes: [],
				},
				falseBody: {
					nodeType: 'Block',
					nodes: [{
						nodeType: 'IfStatement',
						condition: {
							nodeType: 'Identifier',
							content: 'identifier2',
						},
						body: {
							nodeType: 'Block',
							nodes: [],
						},
					}],
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
					members: {}
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
				},
				value: {
					nodeType: 'Value',
					type: 'String',
					value: '',
					members: {}
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
					members: {}
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
				},
				properties: {},
				members: {},
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
				},
				properties: {
					property: {
						nodeType: 'TypeDeclaration',
						name: 'Type',
					},
				},
				members: {},
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
				},
				properties: {
					property: {
						nodeType: 'TypeDeclaration',
						name: 'Type',
					},
					property2: {
						nodeType: 'TypeDeclaration',
						name: 'Type',
					},
				},
				members: {},
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
							},
							body: {
								nodeType: 'Block',
								nodes: [],
							}
						},
						members: {},
					},
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
							},
							body: {
								nodeType: 'Block',
								nodes: [],
							}
						},
						members: {},
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
							},
							body: {
								nodeType: 'Block',
								nodes: [],
							}
						},
						members: {},
					},
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
								},
							}],
							returnType: {
								nodeType: 'TypeDeclaration',
								name: 'Type',
							},
							body: {
								nodeType: 'Block',
								nodes: [],
							}
						},
						members: {},
					},
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
								},
							}],
							returnType: {
								nodeType: 'TypeDeclaration',
								name: 'Type',
							},
							body: {
								nodeType: 'Block',
								nodes: [],
							}
						},
						members: {},
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
								},
							}],
							returnType: {
								nodeType: 'TypeDeclaration',
								name: 'Type',
							},
							body: {
								nodeType: 'Block',
								nodes: [],
							}
						},
						members: {},
					},
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
								},
							}],
							returnType: {
								nodeType: 'TypeDeclaration',
								name: 'Type',
							},
							body: {
								nodeType: 'Block',
								nodes: [],
							}
						},
						members: {},
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
							},
							body: {
								nodeType: 'Block',
								nodes: [],
							}
						},
						members: {},
					},
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
				},
				properties: {
					property: {
						nodeType: 'TypeDeclaration',
						name: 'PropertyType',
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
								},
							}],
							returnType: {
								nodeType: 'TypeDeclaration',
								name: 'Type',
							},
							body: {
								nodeType: 'Block',
								nodes: [],
							}
						},
						members: {},
					},
				},
			}]

			expect(parse(lex(input))).toEqual(output)
		})
	})
})
