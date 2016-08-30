/// <reference path='../typings/index.d.ts' />

let verboseLogs = false

let log = (node) => {
	console.log(require('util').inspect(node, { showHidden: false, depth: null }))
	console.log()
}

import {
	IASTNode,
	IStatementNode,
	IValueNode,
	IFunctionDefinitionNode,
	IFunctionInvocationNode,
	INativeFunctionInvocationNode,
	IDeclarationStatementNode,
	IAssignmentStatementNode,
	IIdentifierNode,
	IExpressionNode,
	ILookupNode,
	IIfStatementNode,
	IIfElseStatementNode,
	IScope,
} from './Interfaces'

type scopeAndMaybeReturnValue = { scope: IScope, returnValue: IValueNode | null, }
type scopeAndValue = { scope: IScope, value: IValueNode, }

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

			stringEquals: (self, str) => {
				return this.generateValueNode('Bool', self.value === str.value, {})
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
						content: 'TypeDeclaration',
					},
				},
				value: null,
				members: {
					join: {
						nodeType: 'Value',
						type: 'Function',
						value: {
							nodeType: 'FunctionDefinition',
							parameters: {
								nodeType: 'ParameterList',
								arguments: [{
									nodeType: 'Parameter',
									name: 'self',
									type: {
										nodeType: 'TypeDeclaration',
										name: {
											nodeType: 'Identifier',
											content: 'String',
										},
									},
								}, {
									nodeType: 'Parameter',
									name: 'string',
									type: {
										nodeType: 'TypeDeclaration',
										name: {
											nodeType: 'Identifier',
											content: 'String',
										},
									},
								}],
							},
							returnType: {
								nodeType: 'TypeDeclaration',
								name: {
									nodeType: 'Identifier',
									content: 'String',
								},
							},
							body: {
								nodeType: 'Block',
								body: [{
									nodeType: 'ReturnStatement',
									expression: {
										nodeType: 'NativeFunctionInvocation',
										name: {
											nodeType: 'Identifier',
											content: 'stringJoin',
										},
										arguments: {
											nodeType: 'UnnamedArgumentList',
											arguments: [{
												nodeType: 'Identifier',
												content: 'self',
											}, {
												nodeType: 'Identifier',
												content: 'string',
											}],
										},
									},
								}],
							},
							scope: {
								parent: null,
							},
						},
						members: {},
					},

					equals: {
						nodeType: 'Value',
						type: 'Function',
						value: {
							nodeType: 'FunctionDefinition',
							parameters: {
								nodeType: 'ParameterList',
								arguments: [{
									nodeType: 'Parameter',
									name: 'self',
									type: {
										nodeType: 'TypeDeclaration',
										name: {
											nodeType: 'Identifier',
											content: 'String',
										},
									},
								}, {
									nodeType: 'Parameter',
									name: 'other',
									type: {
										nodeType: 'TypeDeclaration',
										name: {
											nodeType: 'Identifier',
											content: 'String',
										},
									},
								}],
							},
							returnType: {
								nodeType: 'TypeDeclaration',
								name: {
									nodeType: 'Identifier',
									content: 'Bool',
								},
							},
							body: {
								nodeType: 'Block',
								body: [{
									nodeType: 'ReturnStatement',
									expression: {
										nodeType: 'NativeFunctionInvocation',
										name: {
											nodeType: 'Identifier',
											content: 'stringEquals',
										},
										arguments: {
											nodeType: 'UnnamedArgumentList',
											arguments: [{
												nodeType: 'Identifier',
												content: 'self',
											}, {
												nodeType: 'Identifier',
												content: 'other',
											}],
										},
									},
								}],
							},
							scope: {
								parent: null,
							},
						},
						members: {},
					},
				},
			},
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

	protected lookup(node: IIdentifierNode | ILookupNode, scope: IScope): IValueNode {
		let searchScope: IScope | null = scope
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
		let returnValue: IValueNode | null = null

		let argumentNames = func.parameters.arguments.map((value) => {
			return value.name
		})

		for (let i = 0; i < argumentNames.length; i++) {
			scope[argumentNames[i]] = args[i]
		}

		for (let node of func.body.body) {
			if (node.nodeType === 'ReturnStatement') {
				return this.resolveExpression(node.expression, scope).value
			} else {
				; ({ scope, returnValue } = this.interpretNode(node, scope))
				if (returnValue !== null) {
					return returnValue
				}
			}
		}

		throw new Error('Function ended without a ReturnStatement - File a Bug Report!')
	}

	protected nativeInvoke(func: Function, args: Array<IASTNode>): IValueNode {
		return func.apply(undefined, args)
	}

	protected interpretDeclarationStatement(node: IDeclarationStatementNode, scope: IScope): { scope: IScope } {
		if (node.value.nodeType === 'Value') {
			if (node.value.value.nodeType === 'FunctionDefinition') {
				if (node.value.value.scope === undefined) {
					node.value.value.scope = {
						parent: scope,
					}
				}
			}
		}

		scope[node.name] = this.resolveExpression(node.value, scope).value
		return { scope }
	}

	protected interpretAssignmentStatement(node: IAssignmentStatementNode, scope: IScope): { scope: IScope } {
		if (node.value.nodeType === 'Value') {
			if (node.value.value.nodeType === 'FunctionDefinition') {
				if (node.value.value.scope === undefined) {
					node.value.value.scope = {
						parent: scope,
					}
				}
			}
		}

		let searchScope: IScope | null = scope
		while (true) {
			if (searchScope === null) {
				log(scope)
				throw new Error('Can not find variable \'' + node.name + '\' in this Scope - File a Bug Report!')
			}
			if (searchScope[node.name] != null) {
				verboseLogs && console.log('Found:')
				verboseLogs && log(searchScope[node.name])
				searchScope[node.name] = this.resolveExpression(node.value, scope).value
				return { scope }
			} else {
				searchScope = searchScope.parent
			}
		}
	}

	protected interpretFunctionInvocation(node: IFunctionInvocationNode, scope: IScope): IValueNode {
		let func = this.lookup(node.name, scope)
		let args

		args = node.arguments.arguments.map((value) => {
			return this.resolveExpression(value, scope).value
		})

		return this.invoke(func.value, args)
	}

	protected interpretNativeFunctionInvocation(node: INativeFunctionInvocationNode, scope: IScope): IValueNode {
		verboseLogs && console.log('NativeFunctionInvocation:')
		verboseLogs && log(node)
		let func = this.nativeLookup(node.name)
		let args = node.arguments.arguments.map((value) => {
			return this.resolveExpression(value, scope).value
		})

		return this.nativeInvoke(func, args)
	}

	protected interpretIfStatement(node: IIfStatementNode, scope: IScope): scopeAndMaybeReturnValue {
		let condition = this.resolveExpression(node.condition, scope).value
		let returnValue: IValueNode | null = null

		if (condition.value) {
			let subScope: IScope = {
				parent: scope,
			}

			for (let subNode of node.body.body) {
				// If we find a return, resolve the expression since only we know the correct scope,
				// and return a new IReturnStatementNode so that the parent can deal with it
				if (subNode.nodeType === 'ReturnStatement') {
					returnValue = this.resolveExpression(subNode.expression, subScope).value
				} else {
					({ scope: subScope, returnValue } = this.interpretNode(subNode, subScope))
				}
			}
		}

		return { scope, returnValue }
	}

	protected interpretIfElseStatement(node: IIfElseStatementNode, scope: IScope): scopeAndMaybeReturnValue {
		let condition = this.resolveExpression(node.condition, scope).value
		let body: Array<IStatementNode>
		let returnValue: IValueNode | null = null

		if (condition.value) {
			body = node.trueBody.body
		} else {
			body = node.falseBody.body
		}

		let subScope: IScope = {
			parent: scope,
		}

		for (let subNode of body) {
				// If we find a return, resolve the expression since only we know the correct scope,
				// and return a new IReturnStatementNode so that the parent can deal with it
				if (subNode.nodeType === 'ReturnStatement') {
					returnValue = this.resolveExpression(subNode.expression, subScope).value
				} else {
					; ({ scope: subScope, returnValue } = this.interpretNode(subNode, subScope))
				}
			}

		return { scope, returnValue }
	}

	protected resolveExpression(node: IExpressionNode, scope: IScope): scopeAndValue {
		let value: IValueNode

		switch (node.nodeType) {
			case 'Identifier':
				value = this.lookup(node, scope)
				break
			case 'Lookup':
				value = this.lookup(node, scope)
				break
			case 'FunctionInvocation':
				value = this.interpretFunctionInvocation(node, scope)
				break
			case 'NativeFunctionInvocation':
				value = this.interpretNativeFunctionInvocation(node, scope)
				break
			case 'Value':
				value = node
				break
			default:
				throw new Error(`Unknown ExpressionNode of type: ${(node as IExpressionNode).nodeType}`)
		}

		return { scope, value }
	}

	protected interpretNode(node: IStatementNode | IExpressionNode, scope: IScope): scopeAndMaybeReturnValue {
		let returnValue: IValueNode | null = null

		switch (node.nodeType) {
			case 'DeclarationStatement':
				; ({ scope } = this.interpretDeclarationStatement(node, scope))
				break
			case 'AssignmentStatement':
				; ({ scope } = this.interpretAssignmentStatement(node, scope))
				break
			case 'FunctionInvocation':
				this.interpretFunctionInvocation(node, scope)
				break
			case 'NativeFunctionInvocation':
				this.interpretNativeFunctionInvocation(node, scope)
				break
			case 'IfStatement':
				; ({ returnValue } = this.interpretIfStatement(node, scope))
				break
			case 'IfElseStatement':
				; ({ returnValue } = this.interpretIfElseStatement(node, scope))
				break
			default:
				log(node)
				throw new Error(`Unknown Node of type: ${node.nodeType}`)
		}

		return { scope, returnValue }
	}

	public loadFile(path: string): void {
		require('fs').readFile(path, 'utf8', (err, data) => {
			if (err) { throw err }

			let nodes: Array<IExpressionNode | IStatementNode> = JSON.parse(data)

			for (let node of nodes) {
				let result = this.interpretNode(node, this.fileScope)

				if (result.returnValue) {
					throw new Error('Returning out of files is not allowed - File a Bug Report!')
				} else {
					this.fileScope = result.scope
				}
			}
		})
	}
}
