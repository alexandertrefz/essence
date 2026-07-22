implementation {

	§ Recursive Type declarations are not part of the language yet — a Type
	§ may not name itself, directly or through another declaration. Once it
	§ can, this file becomes the Tree it sketches:

	§ choice Tree<Value> {
	§ 	Node { left: Tree<Value>, right: Tree<Value> },
	§ 	Leaf { value: Value },
	§ }

	§ function sumOf(_ tree: Tree<Integer>) -> Integer {
	§ 	<- match tree -> Integer {
	§ 		case #Leaf { <- @.value }
	§ 		case #Node { <- sumOf(@.left)::add(sumOf(@.right)) }
	§ 	}
	§ }

	§ __print(sumOf(#Node({
	§ 	left = #Leaf({ value = 1 }),
	§ 	right = #Node({
	§ 		left = #Leaf({ value = 2 }),
	§ 		right = #Leaf({ value = 3 }),
	§ 	}),
	§ })))                                  § 6

}
