/// <reference path='../typings/index.d.ts' />
let equal = require('deep-equal')

import {
	IScope,
	INativeScope,
	IExpressionNode,
	IStatementNode,
	ITypeDeclarationNode,
	ITypeDefinitionStatementNode,
	IDeclarationStatementNode,
	IAssignmentStatementNode,
	IFunctionDefinitionNode,
	IReturnStatementNode,
	ILookupNode,
	IIdentifierNode,
	IValueNode,
	IIfStatementNode,
	IIfElseStatementNode,
	IFunctionInvocationNode,
} from './Interfaces'

type IdentifierValue
	= ITypeDeclarationNode
	| ITypeDefinitionStatementNode

type IScopeAndMaybeReturnType = {
	scope: IScope
	returnType: ITypeDeclarationNode | null
}

class ReturnError extends Error {
	constructor() {
		super()

		this.name = 'ReturnError'
		this.message = `You can not return outside of functions!`
	}
}

class NameError extends Error {
	constructor(name: string) {
		super()

		this.name = 'NameError'
		this.message = `${name} is already declared!`
	}
}

class MismatchError extends Error {
	constructor(leftType: string, rightType: string) {
		super()

		this.name = 'MismatchError'
		this.message = `Type ${rightType} does not match ${leftType}!`
	}
}

class UndeclaredError extends Error {
	constructor(name: string) {
		super()

		this.name = 'UndeclaredError'
		this.message = `${name} is not declared yet!`
	}
}

class Validator {
	scope: IScope
	nativeScope: INativeScope

	constructor() {
		this.scope = {
			parent: null,
		}

		this.nativeScope = {
			parent: null,
		}
	}

	protected lookupIdentifier(node: IIdentifierNode, scope: IScope): IdentifierValue {
		let searchScope: IScope | null = scope

		while (true) {
			if (searchScope == null) {
				throw new Error(`Can not find variable '${node.content}' in this Scope`)
			}

			if (searchScope[node.content] != null) {
				return searchScope[node.content]
			} else {
				if (searchScope.parent == null) {
					console.log(searchScope)
				}
				searchScope = searchScope.parent
			}
		}
	}

	resolveExpressionType(node: IExpressionNode, scope: IScope): ITypeDeclarationNode {
		let type: string

		switch (node.nodeType) {
			case 'Value':
				if (node.value.nodeType === 'FunctionDefinition') {
					let func = node.value
					this.validateFunctionDefinition(func, scope)

					let parameters = func.parameters.map(parameter => parameter.type.name)

					type = `(${parameters}) -> ${func.returnType.name}`
				} else {
					type = node.type
				}

				break
			case 'Identifier':
				let resolvedValue = this.lookupIdentifier(node, scope)

				if (resolvedValue.nodeType === 'TypeDeclaration') {
					type = resolvedValue.name
				} else {
					type = 'TypeDefinition'
				}

				break
			case 'NativeFunctionInvocation':
				// TODO: Find a way of defining the return types of native functions
				type = 'Native'
				break
			case 'FunctionInvocation':
				let functionType = this.resolveExpressionType(node.name, scope)

				if (functionType.name !== 'Native') {
					let typeStrings = functionType.name.split(' ')
					functionType.name = typeStrings[typeStrings.length - 1]
				}

				type = functionType.name
				break
			case 'Lookup':
				type = 'Native'
				break
			default:
				throw new Error('This should never happen - File a Bug Report!')
		}

		return {
			nodeType: 'TypeDeclaration',
			name: type,
		}
	}

	validateFunctionDefinition(node: IFunctionDefinitionNode, scope: IScope): void {
		for (let parameter of node.parameters) {
			node.scope[parameter.name] = parameter.type
		}

		for (let bodyNode of node.body.nodes) {
			if (bodyNode.nodeType === 'ReturnStatement') {
				let expressionType = this.resolveExpressionType(bodyNode.expression, node.scope)
				if (!equal(node.returnType, expressionType) && expressionType.name !== 'Native') {
					throw new MismatchError(node.returnType.name, expressionType.name)
				}
			} else {
				node.scope = this.validateNode(bodyNode, node.scope).scope
			}
		}
	}

	validateTypeDefinitionStatement(node: ITypeDefinitionStatementNode, scope: IScope): IScope {
		if (scope[node.name.content] !== undefined) {
			throw new NameError(`${node.name.content} is already declared!`)
		}

		for (let member in node.members) {
			if (node.members.hasOwnProperty(member)) {
				node.members[member].value.scope = {
					parent: scope,
				}

				this.validateFunctionDefinition(node.members[member].value, scope)
			}
		}

		scope[node.name.content] = node

		return scope
	}

	validateDeclarationStatement(node: IDeclarationStatementNode, scope: IScope): IScope {
		if (scope[node.name] === undefined) {
			if (node.value.nodeType === 'Value') {
				let value = node.value.value
				if (value.nodeType === 'FunctionDefinition') {
					if (value.scope === undefined) {
						value.scope = {
							parent: scope,
						}
					}
				}
			}

			let expressionType = this.resolveExpressionType(node.value, scope)

			if (node.type === null) {
				node.type = expressionType
			}

			scope[node.name] = node.type

			if (!equal(node.type, expressionType) && expressionType.name !== 'Native') {
				throw new MismatchError(node.type.name, expressionType.name)
			}
		} else {
			throw new NameError(node.name)
		}

		return scope
	}

	validateAssignmentStatement(node: IAssignmentStatementNode, scope: IScope): IScope {
		try {
			let identifierNode: IIdentifierNode = {
				nodeType: 'Identifier',
				content: node.name,
			}

			this.lookupIdentifier(identifierNode, scope)
		} catch (e) {
			throw new UndeclaredError(node.name)
		}

		let nodeType = scope[node.name]
		let expressionType = this.resolveExpressionType(node.value, scope)

		if (node.value.nodeType === 'Value') {
			let value = node.value.value
			if (value.nodeType === 'FunctionDefinition') {
				if (value.scope == null) {
					value.scope = {
						parent: scope,
					}
				}
			}
		}

		if (!equal(nodeType, expressionType) && expressionType.name !== 'Native') {
			throw new MismatchError(node.name, expressionType.name)
		}

		return scope
	}

	validateIfStatement(node: IIfStatementNode, scope: IScope): IScopeAndMaybeReturnType {
		let returnType: ITypeDeclarationNode | null = null

		let conditionType = this.resolveExpressionType(node.condition, scope)

		if (conditionType.name !== 'Boolean' && conditionType.name !== 'Native') {
			throw new MismatchError(conditionType.name, 'Boolean')
		}

		let subScope = { parent: scope }
		for (let bodyNode of node.body.nodes) {
			if (bodyNode.nodeType === 'ReturnStatement') {
				if (returnType === null) {
					returnType = this.resolveExpressionType(bodyNode.expression, subScope)
				} else {
					let newReturnType = this.resolveExpressionType(bodyNode.expression, subScope)
					if (!equal(returnType, newReturnType)) {
						/* TODO: Handle compound return types properly
						returnType.name += ` | ${newReturnType.name}`
						//*/
						throw new Error('Compound types are not supported yet.')
					}
				}
			} else {
				this.validateNode(bodyNode, subScope)
			}
		}

		return { scope, returnType }
	}

	validateIfElseStatement(node: IIfElseStatementNode, scope: IScope): IScopeAndMaybeReturnType {
		let returnType: ITypeDeclarationNode | null = null

		let conditionType = this.resolveExpressionType(node.condition, scope)

		if (conditionType.name !== 'Boolean' && conditionType.name !== 'Native') {
			throw new MismatchError(conditionType.name, 'Boolean')
		}

		let validateBodyNodes = (nodes) => {
			let subScope = { parent: scope }

			for (let bodyNode of nodes) {
				if (bodyNode.nodeType === 'ReturnStatement') {
					if (returnType === null) {
						returnType = this.resolveExpressionType(bodyNode.expression, subScope)
					} else {
						let newReturnType = this.resolveExpressionType(bodyNode.expression, subScope)
						if (!equal(returnType, newReturnType)) {
							/* TODO: Handle compound return types properly
							returnType.name += ` | ${newReturnType.name}`
							//*/
							throw new Error('Compound types are not supported yet.')
						}
					}
				} else {
					this.validateNode(bodyNode, subScope)
				}
			}
		}

		validateBodyNodes(node.trueBody.nodes)
		validateBodyNodes(node.falseBody.nodes)

		return { scope, returnType }
	}

	validateFunctionInvocation(node: IFunctionInvocationNode, scope: IScope): IScope {
		let functionType = this.resolveExpressionType(node.name, scope).name
		let argumentTypes = functionType.slice(1).split(')')[0].split(',')

		let argumentsAreValid = node.arguments.every((value, index, array) => {
			let expressionType = this.resolveExpressionType(value, scope)
			if (expressionType.name !== argumentTypes[index]) {
				throw new MismatchError(expressionType.name, argumentTypes[index])
			}

			return true
		})

		return scope
	}

	validateNode(node: IExpressionNode | IStatementNode, scope: IScope): IScopeAndMaybeReturnType {
		let returnType: ITypeDeclarationNode | null = null

		switch (node.nodeType) {
			case 'TypeDefinitionStatement':
				scope = this.validateTypeDefinitionStatement(node, scope)
				break
			case 'DeclarationStatement':
				scope = this.validateDeclarationStatement(node, scope)
				break
			case 'AssignmentStatement':
				scope = this.validateAssignmentStatement(node, scope)
				break
			case 'IfStatement':
				; ({ scope, returnType } = this.validateIfStatement(node, scope))
				break
			case 'IfElseStatement':
				; ({ scope, returnType } = this.validateIfElseStatement(node, scope))
				break
			case 'FunctionInvocation':
				scope = this.validateFunctionInvocation(node, scope)
				break
			default:
				console.log(node.nodeType)
				// throw new Error(`Unknown Node Type: ${node.nodeType}`)
		}

		return { scope, returnType }
	}

	validateNodes(nodes: Array<IExpressionNode | IStatementNode>): void {
		for (let node of nodes) {
			if (node.nodeType === 'IfStatement') {
				for (let bodyNode of node.body.nodes) {
					if (bodyNode.nodeType === 'ReturnStatement') {
						throw new ReturnError()
					}
				}
			}

			if (node.nodeType === 'IfElseStatement') {
				for (let trueNode of node.trueBody.nodes) {
					if (trueNode.nodeType === 'ReturnStatement') {
						throw new ReturnError()
					}
				}

				for (let falseNode of node.falseBody.nodes) {
					if (falseNode.nodeType === 'ReturnStatement') {
						throw new ReturnError()
					}
				}
			}

			this.scope = this.validateNode(node, this.scope).scope
		}
	}
}

export let validateProgram = (nodes: Array<IExpressionNode | IStatementNode>): void => {
	let validator = new Validator()
	validator.validateNodes(JSON.parse(JSON.stringify(nodes)))
}
