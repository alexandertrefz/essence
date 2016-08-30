/// <reference path='../typings/index.d.ts' />
require('console.table')

let logger = {
	verbose: false,

	buffer: [] as { Action: string, Value: string }[],

	log(action: string = '', value: string = ''): void {
		logger.buffer.push({
			Action: action,
			Value: value,
		})
	},

	flush(): void {
		console.log()

		let trace = [{
			Action: ' '.repeat(70),
			Value: ' '.repeat(70),
		}, ...logger.buffer]

		if (trace[trace.length - 3].Action === 'ReturnStatement') {
			trace = trace.slice(0, trace.length - 2)
		}

		console.table('Stack Trace', trace)
	},

	linebreak(): void {
		console.log()
	},

	unwrapValue(value: IValueNode): string {
		if (value.value.nodeType) {
			return value.value.nodeType
		} else {
			return `'${value.value}'`
		}
	},

	debug(node: any): void {
		console.log(require('util').inspect(node, { showHidden: false, depth: null }))
		console.log()
	},
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
	INativeScope,
} from './Interfaces'

type scopeAndMaybeReturnValue = { scope: IScope, returnValue: IValueNode | null, }
type scopeAndValue = { scope: IScope, value: IValueNode, }

export class Runtime {
	public fileScope: IScope
	public nativeScope: INativeScope

	constructor() {
		this.nativeScope = {
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
		return base.members[member]
	}

	protected lookup(node: IIdentifierNode | ILookupNode, scope: IScope): IValueNode {
		let searchScope: IScope | null = scope
		if (node.nodeType === 'Identifier') {
			while (true) {
				if (searchScope === null) {
					throw new Error('Can not find variable \'' + node.content + '\' in this Scope - File a Bug Report!')
				}
				if (searchScope[node.content] != null) {
					return searchScope[node.content]
				} else {
					searchScope = searchScope.parent
				}
			}
		} else {
			return this.memberLookup(this.lookup(node.base, scope), node.member)
		}
	}

	protected nativeLookup(node: IIdentifierNode | ILookupNode): Function {
		if (node.nodeType === 'Identifier') {
			logger.log('Simple Native Lookup', node.content)
			return this.nativeScope[node.content]
		} else {
			logger.flush()
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
				let value = this.resolveExpression(node.expression, scope).value
				logger.log('ReturnStatement', logger.unwrapValue(value))
				logger.log()
				logger.log()
				return value
			} else {
				; ({ scope, returnValue } = this.interpretNode(node, scope))
				if (returnValue !== null) {
					return returnValue
				}
			}
		}

		logger.flush()
		throw new Error('Function ended without a ReturnStatement - File a Bug Report!')
	}

	protected nativeInvoke(func: Function, args: Array<IASTNode>): IValueNode {
		return func.apply(undefined, args)
	}

	protected interpretDeclarationStatement(node: IDeclarationStatementNode, scope: IScope): { scope: IScope } {
		logger.log('DeclarationStatement', node.name)

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
		logger.log('DeclarationSuccess', logger.unwrapValue(scope[node.name]))
		return { scope }
	}

	protected interpretAssignmentStatement(node: IAssignmentStatementNode, scope: IScope): { scope: IScope } {
		logger.log('AssignmentStatement', node.name)

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
				logger.flush()
				logger.linebreak()
				logger.debug(scope)
				throw new Error(`Can not find variable '${node.name}' in this Scope - File a Bug Report!`)
			}
			if (searchScope[node.name] != null) {
				searchScope[node.name] = this.resolveExpression(node.value, scope).value
				logger.log('AssignmentSuccess', logger.unwrapValue(searchScope[node.name]))
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
		logger.log('InterpretNativeFunctionInvocation')

		let func = this.nativeLookup(node.name)
		let args = node.arguments.arguments.map((value) => {
			return this.resolveExpression(value, scope).value
		})

		logger.log('ResolvedNativeFunctionInvocationArguments', args.map((value) => {
			return logger.unwrapValue(value)
		}).join(', '))

		return this.nativeInvoke(func, args)
	}

	protected interpretIfStatement(node: IIfStatementNode, scope: IScope): scopeAndMaybeReturnValue {
		logger.log('InterpretIfStatement')

		let condition = this.resolveExpression(node.condition, scope).value
		let returnValue: IValueNode | null = null

		if (condition.value) {
			logger.log('ResolvedCondition', 'true')
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
		} else {
			logger.log('ResolvedCondition', 'false')
		}

		return { scope, returnValue }
	}

	protected interpretIfElseStatement(node: IIfElseStatementNode, scope: IScope): scopeAndMaybeReturnValue {
		logger.log('InterpretIfElseStatement')

		let condition = this.resolveExpression(node.condition, scope).value
		let body: Array<IStatementNode>
		let returnValue: IValueNode | null = null

		if (condition.value) {
			logger.log('ResolvedCondition', 'true')
			body = node.trueBody.body
		} else {
			logger.log('ResolvedCondition', 'false')
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
				logger.flush()
				throw new Error(`Unknown ExpressionNode of type: ${(node as IExpressionNode).nodeType}`)
		}

		return { scope, value }
	}

	protected interpretNode(node: IStatementNode | IExpressionNode, scope: IScope): scopeAndMaybeReturnValue {
		logger.log('InterpretNode', node.nodeType)

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
				logger.flush()
				logger.linebreak()
				logger.debug(node)
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
					logger.flush()
					throw new Error('Returning out of files is not allowed - File a Bug Report!')
				} else {
					this.fileScope = result.scope
				}
			}

			logger.verbose && logger.flush()
		})
	}
}
