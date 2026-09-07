// NOTE: The runtime module of the `GroupedNonEmptyList` Namespace — the two
// crossings with the receiver's proof in hand. Both are `GroupedList`'s own
// natives re-exported straight through, so the two entries are one Function
// under two names and can not come apart.
//
// NOTE: A refinement erases before anything runs, so what the proof buys is
// spent while compiling and the walk that produces the answer is the same one. A
// List with an item in it puts that item in a group, so the Dictionary either
// answers holds an entry — which is the whole of what these two names say that
// `GroupedList`'s can not.
export { group, tally } from "./GroupedList"
