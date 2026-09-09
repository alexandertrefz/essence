// NOTE: The runtime module of the `GroupedNonEmptyList` Namespace — the three
// crossings with the receiver's proof in hand. All three are `GroupedList`'s
// own natives re-exported straight through, so each entry is one Function
// under two names and can not come apart. `removeDuplicates` is `NonEmptyList`'s
// now, over a plain Map rather than over a store.
//
// NOTE: A refinement erases before anything runs, so what the proof buys is
// spent while compiling and the walk that produces the answer is the same one. A
// List with an item in it puts that item in a group, under a count, or at a key,
// so the Dictionary each answers holds an entry — which is the whole of what
// these three names say that `GroupedList`'s can not.
export { group, index, tally } from "./GroupedList"
