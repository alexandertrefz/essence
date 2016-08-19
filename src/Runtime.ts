/// <reference path="../typings/index.d.ts" />

let verboseLogs = false

let log = (node) => {
	console.log(require('util').inspect(node, { showHidden: false, depth: null }))
	console.log()
}

import {
	IASTNode,
	IStatementNode,
	ITypeNode,
	IValueNode,
	IParameterNode,
	IParameterListNode,
	IUnnamedArgumentListNode,
	INamedArgumentNode,
	INamedArgumentListNode,
	IPackageAssignmentStatementNode,
	IImportStatementNode,
	IPropertyDeclarationNode,
	IFunctionDefinitionNode,
	IFunctionInvocationNode,
	INativeFunctionInvocationNode,
	IMethodDefinitionNode,
	IReturnStatementNode,
	IDeclarationStatementNode,
	IAssignmentStatementNode,
	ITypeDefinitionStatementNode,
	IIdentifierNode,
	IExpressionNode,
	ILookupNode,
} from './Interfaces'

interface Scope {
	parent: Scope | null
}

export class Runtime {
	public fileScope: any
	public nativeScope: any

	constructor() {
		this.nativeScope = {
			parent: null,

			stringJoin: (self, str) => {
				let newValue = self.value + str.value

				return this.generateValueNode('String', newValue, {})
			},

			print: (message) => {
				console.log(message.value)
				return message
			},
		}

		this.fileScope = {
			parent: null,
			String: {
				nodeType: 'Value',
				type: {
					nodeType: 'TypeDeclaration',
					name: {
						nodeType: 'Identifier',
						content: 'TypeDeclaration'
					},
				},
				value: null,
				members: {
					join: {
						nodeType: "Value",
						type: "Function",
						value: {
							nodeType: "FunctionDefinition",
							parameters: {
								nodeType: "ParameterList",
								arguments: [{
									nodeType: "Parameter",
									name: "self",
									type: {
										nodeType: "TypeDeclaration",
										name: {
											nodeType: "Identifier",
											content: "String"
										}
									}
								}, {
									nodeType: "Parameter",
									name: "string",
									type: {
										nodeType: "TypeDeclaration",
										name: {
											nodeType: "Identifier",
											content: "String"
										}
									}
								}]
							},
							returnType: {
								nodeType: "TypeDeclaration",
								name: {
									nodeType: "Identifier",
									content: "String"
								}
							},
							body: [{
								nodeType: "ReturnStatement",
								expression: {
									nodeType: "NativeFunctionInvocation",
									name: {
										nodeType: "Identifier",
										content: "stringJoin"
									},
									arguments: {
										nodeType: "UnnamedArgumentList",
										arguments: [{
											nodeType: "Identifier",
											content: "self"
										}, {
											nodeType: "Identifier",
											content: "string"
										}]
									}
								}
							}],
							scope: {
								parent: null
							}
						},
						members: {}
					}
				}
			}
		}
	}

	protected generateValueNode(type: string, value: any, members: any): IValueNode {
		return {
			nodeType: 'Value',
			type,
			value,
			members,
		}
	}

	protected memberLookup(base: IValueNode, member: string): IValueNode {
		verboseLogs && log(base)
		verboseLogs && console.log(member)
		verboseLogs && log(base.members[member])
		return base.members[member]
	}

	protected lookup(node: IIdentifierNode | ILookupNode, scope: Scope): IValueNode {
		let searchScope: Scope | null = scope
		if (node.nodeType === 'Identifier') {
			verboseLogs && console.log('Simple Lookup:', node.content)
			while (true) {
				if (searchScope === null) {
					log(scope)
					throw new Error('Can not find variable \'' + node.content + '\' in this Scope - File a Bug Report!')
				}
				if (searchScope[node.content] != null) {
					verboseLogs && console.log('Found:')
					verboseLogs && log(searchScope[node.content])
					return searchScope[node.content]
				} else {
					searchScope = searchScope.parent
				}
			}
		} else {
			verboseLogs && console.log('Complex Lookup:', node.base.content + '.' + node.member)
			return this.memberLookup(this.lookup(node.base, scope), node.member)
		}
	}

	protected nativeLookup(node: IIdentifierNode | ILookupNode): Function {
		if (node.nodeType === 'Identifier') {
			verboseLogs && console.log('Simple Native Lookup:', node.content)
			return this.nativeScope[node.content]
		} else {
			throw new Error('Complex Native Lookups are not supported yet!')
		}
	}

	protected invoke(func: IFunctionDefinitionNode, args: Array<IASTNode>): IValueNode {
		let scope = func.scope

		let argumentNames = func.parameters.arguments.map((value) => {
			return value.name
		})

		for (let i = 0; i < argumentNames.length; i++) {
			scope[argumentNames[i]] = args[i]
		}

		for (let node of func.body) {
			if (node.nodeType === 'ReturnStatement') {
				return this.resolveExpression(node.expression, scope).result
			} else {
				;({ scope } = this.interpretNode(node, scope))
			}
		}

		throw new Error('Function ended without a ReturnStatement - File a Bug Report!')
	}

	protected nativeInvoke(func: Function, args: Array<IASTNode>): IValueNode {
		return func.apply(undefined, args)
	}

	protected interpretDeclarationStatement(node: IDeclarationStatementNode, scope: Scope): { scope: Scope } {
		if (node.value.nodeType === 'Value') {
			if (node.value.value.nodeType === 'FunctionDefinition') {
				if (node.value.value.scope === undefined) {
					node.value.value.scope = {
						parent: scope
					}
				}
			}
		}

		scope[node.name] = this.resolveExpression(node.value, scope).result
		return { scope }
	}

	protected interpretAssignmentStatement(node: IAssignmentStatementNode, scope: Scope): { scope: Scope } {
		if (node.value.nodeType === 'Value') {
			if (node.value.value.nodeType === 'FunctionDefinition') {
				if (node.value.value.scope === undefined) {
					node.value.value.scope = {
						parent: scope
					}
				}
			}
		}

		scope[node.name] = this.resolveExpression(node.value, scope).result
		return { scope }
	}

	protected interpretFunctionInvocation(node: IFunctionInvocationNode, scope: Scope): IValueNode {
		let func = this.lookup(node.name, scope)
		let args

		if (node.arguments.nodeType === 'UnnamedArgumentList') {
			args = node.arguments.arguments.map((value) => {
				return this.resolveExpression(value, scope).result
			})
		} else {
			throw new Error('Named Argument Lists are not supported yet!')
		}

		return this.invoke(func.value, args)
	}

	protected interpretNativeFunctionInvocation(node: INativeFunctionInvocationNode, scope: Scope): IValueNode {
		verboseLogs && console.log('NativeFunctionInvocation:')
		verboseLogs && log(node)
		let func = this.nativeLookup(node.name)
		let args = node.arguments.arguments.map((value) => {
			return this.resolveExpression(value, scope).result
		})

		return this.nativeInvoke(func, args)
	}

	protected resolveExpression(node: IExpressionNode, scope: Scope): { result: IValueNode, scope: Scope } {
		let result: IValueNode

		switch (node.nodeType) {
			case 'Identifier':
				result = this.lookup(node, scope)
				break
			case 'Lookup':
				result = this.lookup(node, scope)
				break
			case 'FunctionInvocation':
				result = this.interpretFunctionInvocation(node, scope)
				break
			case 'NativeFunctionInvocation':
				result = this.interpretNativeFunctionInvocation(node, scope)
				break
			case 'Value':
				result = node
				break
			default:
				throw new Error(`Unknown ExpressionNode of type: ${(node as IExpressionNode).nodeType}`)
		}

		return { result, scope }
	}

	protected interpretNode(node: IStatementNode | IExpressionNode, scope: Scope) {
		switch (node.nodeType) {
			case 'DeclarationStatement':
				;({ scope } = this.interpretDeclarationStatement(node, scope))
				break
			case 'AssignmentStatement':
				;({ scope } = this.interpretAssignmentStatement(node, scope))
				break
			case 'FunctionInvocation':
				this.interpretFunctionInvocation(node, scope)
				break
			case 'NativeFunctionInvocation':
				this.interpretNativeFunctionInvocation(node, scope)
				break
			default:
				throw new Error(`Unknown Node of type: ${node.nodeType}`)
		}

		return { scope }
	}

	public loadFile(path) {
		require('fs').readFile(path, 'utf8', (err, data) => {
			if (err) throw err

			let nodes: Array<IExpressionNode | IStatementNode> = JSON.parse(data)

			for (let node of nodes) {
				this.fileScope = this.interpretNode(node, this.fileScope).scope
			}
		})
	}
}
