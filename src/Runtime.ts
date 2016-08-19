declare let require: (string) => any

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
						nodeType: 'Value',
						type: {
							nodeType: 'TypeDeclaration',
							name: { nodeType: 'Identifier', content: 'Function' }
						},
						value: {
							nodeType: 'FunctionDefinition',
							parameters: {
								nodeType: 'ParameterList',
								arguments: [
									{
										nodeType: 'Parameter',
										name: { nodeType: 'Identifier', content: 'self' },
										type: {
											nodeType: 'TypeDeclaration',
											name: { nodeType: 'Identifier', content: 'String' }
										}
									},
									{
										nodeType: 'Parameter',
										name: { nodeType: 'Identifier', content: 'string' },
										type: {
											nodeType: 'TypeDeclaration',
											name: { nodeType: 'Identifier', content: 'String' }
										}
									}
								]
							},
							returnType: {
								nodeType: 'TypeDeclaration',
								name: { nodeType: 'Identifier', content: 'String' }
							},
							body: [
								{
									nodeType: 'ReturnStatement',
									expression: {
										nodeType: 'NativeFunctionInvocation',
										name: { nodeType: 'Identifier', content: 'stringJoin' },
										arguments: {
											nodeType: 'UnnamedArgumentList',
											arguments: [
												{ nodeType: 'Identifier', content: 'self' },
												{ nodeType: 'Identifier', content: 'string' }
											]
										}
									}
								}
							],
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

	protected generateValueNode(type: string, value: any, members: any) {
		return {
			nodeType: 'Value',
			type: {
				nodeType: "TypeDeclaration",
				name: {
					nodeType: "Identifier",
					content: type
				}
			},
			value,
			members,
		}
	}

	protected memberLookup(base: IValueNode, member: IIdentifierNode): IValueNode {
		verboseLogs && log(base)
		verboseLogs && console.log(member.content)
		verboseLogs && log(base.members[member.content])
		return base.members[member.content]
	}

	protected lookup(node: IIdentifierNode | ILookupNode, scope: Scope): IValueNode {
		let searchScope: Scope | null = scope
		if (node.nodeType === 'Identifier') {
			verboseLogs && console.log('Simple Lookup:', node.content)
			while (true) {
				if (searchScope === null) {
					verboseLogs && log(scope)
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
			verboseLogs && console.log('Complex Lookup:', node.base.content + '.' + node.member.content)
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
			return value.name.content
		})

		for (let i = 0; i < argumentNames.length; i++) {
			scope[argumentNames[i]] = args[i]
		}

		for (let node of func.body) {
			if (node.nodeType === 'ReturnStatement') {
				return this.resolveExpression((node as IReturnStatementNode).expression, scope).result
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
			if ((node.value as IValueNode).value.nodeType === 'FunctionDefinition') {
				if ((node.value as IValueNode).value.scope === undefined) {
					(node.value as IValueNode).value.scope = {
						parent: scope
					}
				}
			}
		}

		scope[node.name.content] = this.resolveExpression(node.value, scope).result
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
		let func = this.nativeLookup(node.name)
		let args = node.arguments.arguments.map((value) => {
			return this.resolveExpression(value, scope).result
		})

		return this.nativeInvoke(func, args)
	}

	protected resolveExpression(node: IExpressionNode, scope: Scope): { result: IValueNode, scope: Scope } {
		let result: IValueNode

		if (node.nodeType === 'Identifier') {
			result = this.lookup(node as IIdentifierNode, scope)
		} else if (node.nodeType === 'Lookup') {
			result = this.lookup(node as ILookupNode, scope)
		} else if (node.nodeType === 'FunctionInvocation') {
			result = this.interpretFunctionInvocation(node as IFunctionInvocationNode, scope)
		} else if (node.nodeType === 'NativeFunctionInvocation') {
			result = this.interpretNativeFunctionInvocation(node as INativeFunctionInvocationNode, scope)
		} else { // node.nodeType must be 'Value'
			result = (node as IValueNode)
		}

		return { result, scope }
	}

	protected interpretNode(node: IASTNode, scope: Scope) {
		switch (node.nodeType) {
			case 'DeclarationStatement':
				;({ scope } = this.interpretDeclarationStatement(node as IDeclarationStatementNode, scope))
				break
			case 'FunctionInvocation':
				this.interpretFunctionInvocation(node as IFunctionInvocationNode, scope)
				break
			case 'NativeFunctionInvocation':
				this.interpretNativeFunctionInvocation(node as INativeFunctionInvocationNode, scope)
				break

			default:
				break
		}

		return { scope }
	}

	public loadFile(path) {
		require('fs').readFile(path, 'utf8', (err, data) => {
			if (err) throw err

			let nodes: Array<IASTNode> = JSON.parse(data)

			for (let node of nodes) {
				this.fileScope = this.interpretNode(node, this.fileScope).scope
			}
		})
	}
}
