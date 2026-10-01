// The `NonZeroInteger` Namespace: `Integer`'s Functions under its names. See
// "Refined Namespaces" in DEVELOPMENT.md.
//
// Only the first `multiply` entry is native. The first `raise` entry is
// `power`, since the proof rules out zero to a negative exponent. The second is
// declared again because a refined Namespace hides the base Method's name.
export {
	absolute,
	divide__overload$4 as divide,
	multiply__overload$1,
	negate,
	power as raise__overload$1,
	raise__overload$3 as raise__overload$2,
} from "./Integer"
