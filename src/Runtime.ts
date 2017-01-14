/// <reference path='../typings/index.d.ts' />

import { parser, runtime } from './interfaces'

type IASTNode                      = parser.IASTNode
type IStatementNode                = parser.IStatementNode
type IValueNode                    = parser.IValueNode
type IFunctionDefinitionNode       = parser.IFunctionDefinitionNode
type IFunctionInvocationNode       = parser.IFunctionInvocationNode
type INativeFunctionInvocationNode = parser.INativeFunctionInvocationNode
type IDeclarationStatementNode     = parser.IDeclarationStatementNode
type IAssignmentStatementNode      = parser.IAssignmentStatementNode
type IIdentifierNode               = parser.IIdentifierNode
type IExpressionNode               = parser.IExpressionNode
type ILookupNode                   = parser.ILookupNode
type INativeLookupNode             = parser.INativeLookupNode
type IIfStatementNode              = parser.IIfStatementNode
type IIfElseStatementNode          = parser.IIfElseStatementNode
type ITypeDefinitionStatementNode  = parser.ITypeDefinitionStatementNode

type IScope       = runtime.IScope
type INativeScope = runtime.INativeScope

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

		if (trace.length > 3 && trace[trace.length - 3].Action === 'ReturnStatement') {
			trace = trace.slice(0, trace.length - 2)
		}

		console.table('Stack Trace', trace)
	},

	linebreak(): void {
		console.log()
	},

	unwrapValue(value: IValueNode): string {
		if (value.value && typeof value.value === 'object') {
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

import * as stringPrimitive from './runtimePrimitives/String'
import * as boolPrimitive from './runtimePrimitives/Bool'

type valueOrType = IValueNode | ITypeDefinitionStatementNode
type scopeAndMaybeReturnValue = { scope: IScope, returnValue: IValueNode | null, }
type scopeAndValue = { scope: IScope, value: IValueNode, }

export class Runtime {
	public fileScope: IScope
	public nativeScope: INativeScope

	constructor() {
		this.nativeScope = {
			print(message: IValueNode) {
				if (message.value === null) {
					const convertMessage = (message: IValueNode) => {
						const convertedMessage = {}
						Object.keys(message.members).map((key) => {
							if (message.members[key].value === null) {
								convertedMessage[key] = convertMessage(message.members[key])
							} else {
								convertedMessage[key] = message.members[key].value
							}
						})
						return convertedMessage
					}

					console.log(convertMessage(message))
				} else {
					console.log(message.value)
				}

				return message
			},

			String: stringPrimitive,

			Bool: boolPrimitive,
		}

		this.fileScope = {
			parent: null,
		}
	}

	protected memberLookup(node: ILookupNode, scope: IScope): IValueNode {
		if (node.base.nodeType === 'Identifier') {
			return this.identifierLookup(node.base, scope).members[node.member]
		} else {
			return this.resolveExpression(node.base, scope).value.members[node.member]
		}
	}

	protected identifierLookup(node: IIdentifierNode, scope: IScope): valueOrType {
		let searchScope: IScope | null = scope

		while (true) {
			if (searchScope === null) {
				logger.flush()
				logger.linebreak()
				logger.debug(scope)
				throw new Error(`Can not find variable '${node.content}' in this Scope - File a Bug Report!`)
			}
			if (searchScope[node.content] != null) {
				return searchScope[node.content]
			} else {
				searchScope = searchScope.parent
			}
		}
	}

	protected lookup(node: IIdentifierNode | ILookupNode, scope: IScope): valueOrType {
		let searchScope: IScope | null = scope
		if (node.nodeType === 'Identifier') {
			logger.log('Lookup Identifier', node.content)
			return this.identifierLookup(node, scope)
		} else {
			logger.log('Lookup Member', `<expression>.${node.member}`)
			return this.memberLookup(node, scope)
		}
	}

	protected valueLookup(node: IIdentifierNode | ILookupNode, scope: IScope): IValueNode {
		let result = this.lookup(node, scope)

		if (result.nodeType === 'Value') {
			return result
		} else {
			let variableName: string

			if (node.nodeType === 'Identifier') {
				variableName = node.content
			} else {
				variableName = '<expression>.' + node.member
			}

			logger.flush()
			throw new Error(`Can not find variable '${variableName}' in this Scope - File a Bug Report!`)
		}
	}

	protected nativeMemberLookup(node: INativeLookupNode): Function {
		if (node.base.nodeType === 'Identifier') {
			return this.nativeScope[node.base.content][node.member]
		} else {
			return this.nativeMemberLookup(node.base)
		}
	}

	protected nativeLookup(node: IIdentifierNode | INativeLookupNode): Function {
		if (node.nodeType === 'Identifier') {
			logger.log('Simple Native Lookup', node.content)
			return this.nativeScope[node.content]
		} else {
			logger.log('Complex Native Lookup', `expression.${node.member}`)
			return this.nativeMemberLookup(node)
		}
	}

	protected invoke(func: IFunctionDefinitionNode, args: Array<IASTNode>): IValueNode {
		let scope = func.scope
		let returnValue: IValueNode | null = null

		let argumentNames = func.parameters.map((value) => {
			return value.name
		})

		for (let i = 0; i < argumentNames.length; i++) {
			scope[argumentNames[i]] = args[i]
		}

		for (let node of func.body.nodes) {
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
			let value = node.value.value
			if (value && typeof value === 'object' && value.nodeType === 'FunctionDefinition') {
				if (value.scope === undefined) {
					value.scope = {
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
			let value = node.value.value
			if (value && typeof value === 'object' && value.nodeType === 'FunctionDefinition') {
				if (value.scope === undefined) {
					value.scope = {
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

	protected interpretTypeDefinitionStatement(node: ITypeDefinitionStatementNode, scope: IScope): { scope: IScope } {
		logger.log('TypeDefinitionStatement', node.name.content)

		for (let key in node.members) {
			if (node.members.hasOwnProperty(key)) {
				let value = node.members[key].value as IFunctionDefinitionNode

				value.scope = {
					parent: scope,
				}
			}
		}

		scope[node.name.content] = node
		return { scope }
	}

	protected interpretFunctionInvocation(node: IFunctionInvocationNode, scope: IScope): IValueNode {
		logger.log()
		logger.log()
		logger.log('InterpretFunctionInvocation')

		let func = this.resolveExpression(node.name, scope).value
		let args

		args = node.arguments.map((value) => {
			return this.resolveExpression(value, scope).value
		})

		logger.log('ResolvedFunctionInvocationArguments', args.map((value) => {
			return logger.unwrapValue(value)
		}).join(', '))

		return this.invoke(func.value as IFunctionDefinitionNode, args)
	}

	protected interpretNativeFunctionInvocation(node: INativeFunctionInvocationNode, scope: IScope): IValueNode {
		logger.log('InterpretNativeFunctionInvocation')

		let func = this.nativeLookup(node.name)
		let args = node.arguments.map((value) => {
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

			for (let subNode of node.body.nodes) {
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
			body = node.trueBody.nodes
		} else {
			logger.log('ResolvedCondition', 'false')
			body = node.falseBody.nodes
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
				value = this.valueLookup(node, scope)
				break
			case 'Lookup':
				value = this.memberLookup(node, scope)
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
			case 'TypeDefinitionStatement':
				; ({ scope } = this.interpretTypeDefinitionStatement(node, scope))
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
