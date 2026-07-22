implementation {

	§ A conditional conformance — Boxes are only Comparable when their Item
	§ is. The `where` clause supplies the bound, and the Method body leans on
	§ it: `compareTo` on the Items is exactly what the condition proves.
	namespace Boxes<infer Item> for { value: Item }
		is Comparable where Item is Comparable
	{
		compareTo(_ other: { value: Item }) -> Ordering {
			<- @.value::compareTo(other.value)
		}
	}

	constant boxes = [{ value = 3 }, { value = 1 }, { value = 2 }]

	__print(boxes::sorted()::map((box) { <- box.value }))  § [ 1, 2, 3 ]

	§ List conforms the same way — `is Comparable where ItemType is
	§ Comparable` — so Lists of Lists sort, the witnesses composing all the
	§ way down.
	__print([[3], [1, 2]]::sorted())                   § [ [ 1, 2 ], [ 3 ] ]
	__print([[[2]], [[1]]]::sorted())                  § [ [ [ 1 ] ], [ [ 2 ] ] ]

	§ Two Lists compare lexicographically; on an equal prefix, shorter first.
	__print([1, 2]::compareTo([1, 2, 3])::toString())  § "Less"

	§ Where a condition can not be proven, the compiler explains the chain:
	§ sorting a List of Booleans reports that List<Boolean> is Comparable
	§ only where Boolean is Comparable — and Boolean is not.
}
