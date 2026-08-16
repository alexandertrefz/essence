import type { CaseDescriptor, Descriptor } from "./descriptor"

// NOTE: The one rule about a UNIT Choice that both halves of this package have
// to know, written once so that they can not come to disagree about it. The
// marshaller reads it to decide whether a position can be crossed at all, and
// `dts.ts` reads it to decide whether a position can be PRINTED at all — the
// same question asked of the same Descriptor, and a second copy of the answer
// is the only way one could start refusing what the other still declares.
//
// NOTE: The rule itself. A unit Choice's Cases cross as their bare names — a
// `Direction` is the string `"Up"` — and such a Case is a BARE Case throughout
// this package. Not a "unit Case": the Compiler already uses that phrase for
// any Case without a payload, and `Shape#Blank` is one of those without being
// bare, because `Shape` has Cases with payloads and so crosses as an object.
// Bare-name spelling is the whole ergonomic point of a unit Choice and
// also the whole difficulty: a string is what a String is too, and one Choice's
// `#Up` is spelled exactly like another's. Where a Union puts two of those in
// one position, the position has no unambiguous JavaScript spelling, and the
// boundary refuses it rather than deciding it. Deciding it would mean a String
// `"Up"` handed in coming back out as a `Direction#Up`, and losing data is the
// one thing this boundary may not do — which is why the "first arm wins" stance
// the ordinary Union arms are compiled under deliberately does not reach here.
//
// NOTE: Per CASE NAME, not per pair of Choices. `Direction | Vertical` is
// perfectly spellable when the two share no Case name; it is only the shared
// `#Up` that has nowhere to go. And per bare Case: a Choice with payloads
// crosses as a `$case` object, which no string is, so `Direction | Shape` is
// spellable too.
export function bareCaseCollision(descriptor: Descriptor): string | null {
	// NOTE: Asked of a Union and of nothing else. A lone bare Case, or one
	// inside an `Optional`, has the position to itself and nothing to collide
	// with; every OTHER position that could hold two shapes at once — a
	// Record's member, a List's item — is a Union of its own and is asked
	// about where it is reached.
	if (descriptor.kind !== "union") {
		return null
	}

	let arms: Array<Descriptor> = []

	flatten(descriptor, arms)

	let firstText: Descriptor | null = null
	let firstBareCase: CaseDescriptor | null = null
	let byName = new Map<string, CaseDescriptor>()

	for (let arm of arms) {
		if (arm.kind === "string") {
			if (firstBareCase !== null) {
				return crossesAsText(firstBareCase, arm)
			}

			firstText ??= arm

			continue
		}

		if (arm.kind !== "case" || !arm.unitChoice) {
			continue
		}

		if (firstText !== null) {
			return crossesAsText(arm, firstText)
		}

		let sharing = byName.get(arm.name)

		if (sharing === undefined) {
			byName.set(arm.name, arm)
		} else if (sharing.tag !== arm.tag) {
			// NOTE: Told apart by TAG rather than by `choice`, which is a
			// display name: two Modules may each declare a `choice Direction`,
			// and their `#Up`s are two Cases spelled one way. The tag is the
			// identity, so the same Case reached twice through a Union that
			// mentions it twice is not a collision and those two are.
			return sharesName(sharing, arm)
		}

		firstBareCase ??= arm
	}

	return null
}

// NOTE: The arms a JavaScript value is actually decided between, which is not
// the same list as the Union's own arms. A nested Union is flattened because
// its arms stand in the outer position unchanged, and an `Optional` because it
// is spelled by ABSENCE — its item stands in the position beside everything
// else, and `undefined` collides with nothing.
//
// NOTE: `Optional` reaches a Descriptor in two shapes and both are unwrapped
// here. As the `optional` node, where `describeUnion` collapsed the pair; and
// as its two Cases still standing apart, which is what a Union of more than
// those two leaves behind — `Optional<String> | Direction` is four arms, so
// nothing collapses, and the `#Value` carrying the String is the arm that
// collides with `#Up`. `#Empty` carries nothing and contributes nothing.
function flatten(descriptor: Descriptor, into: Array<Descriptor>): void {
	switch (descriptor.kind) {
		case "union":
			for (let arm of descriptor.arms) {
				flatten(arm, into)
			}

			return
		case "optional":
			flatten(descriptor.of, into)

			return
		case "case": {
			if (!descriptor.optional) {
				into.push(descriptor)

				return
			}

			let item = descriptor.payload.item

			if (descriptor.name === "Value" && item !== undefined) {
				flatten(item, into)
			}

			return
		}
		default:
			into.push(descriptor)
	}
}

// NOTE: Named by what each arm is SHOWN as, so that the sentence a refusal
// carries and the Type the reader wrote are the same words. Deliberately not a
// whole sentence: it is the middle of one, and both the marshaller's refusal
// and the notice a declaration file prints put their own frame around it.
function crossesAsText(bareCase: CaseDescriptor, text: Descriptor): string {
	return `a ${bareCase.shown} crosses as the string "${bareCase.name}", which a ${text.shown} is too`
}

// NOTE: By what each arm is SHOWN as while the two are shown differently, and
// by TAG where they are not. Two Modules may each declare a `choice Direction`,
// and "a Direction#Up and a Direction#Up" names the collision without naming
// either side of it — the tag is what tells those two apart, so it is what the
// sentence falls back to when the display names can not. Which is the same rule
// the comparison above is made under, said in the words a reader is given.
function sharesName(first: CaseDescriptor, second: CaseDescriptor): string {
	if (first.shown === second.shown) {
		return `'${first.tag}' and '${second.tag}' both cross as the string "${first.name}"`
	}

	return `a ${first.shown} and a ${second.shown} both cross as the string "${first.name}"`
}
