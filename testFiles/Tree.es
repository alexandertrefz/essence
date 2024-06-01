implementation {
	type Node<_ NodeType> = { left: NodeType, right: NodeType }
	type Tree<_ ValueType> = Node<Tree<ValueType>> | ValueType

	variable integerTreeOne: Tree<Integer> = { left = 1, right = 2 }
	variable integerTreeTwo: Tree<Integer> = { left = { left = 1, right = 2 }, right = { left = 3, right = 4 } }
	variable integerTreeThree: Tree<Integer> = { left = { left = 1, right = 2 }, right = 3 }
}