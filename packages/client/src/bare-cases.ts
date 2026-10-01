import type { CaseDescriptor, Descriptor } from "./descriptor"

// Describes how a Union puts two bare Cases, or a bare Case and a String, in
// one position with no JavaScript spelling, or answers `null`. The marshaller
// and `dts.ts` both ask. See "Bare Cases" in DEVELOPMENT.md.
export function bareCaseCollision(descriptor: Descriptor): string | null {
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
			// The tag is the identity, since `choice` is a display name two
			// Modules may share. One Case reached twice is no collision.
			return sharesName(sharing, arm)
		}

		firstBareCase ??= arm
	}

	return null
}

// The arms a JavaScript value is decided between. Nested Unions and both
// shapes of an `Optional` are flattened. See "Bare Cases" in DEVELOPMENT.md.
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
				flatten(item.of, into)
			}

			return
		}
		default:
			into.push(descriptor)
	}
}

// Names each arm as it is shown, in the words the reader wrote. This is the
// middle of a sentence, which the marshaller and the declaration file each frame.
function crossesAsText(bareCase: CaseDescriptor, text: Descriptor): string {
	return `a ${bareCase.shown} crosses as the string "${bareCase.name}", which a ${text.shown} is too`
}

// Names each Case as it is shown, or by its tag when both are shown alike, as
// for two Modules that each declare a `choice Direction`.
function sharesName(first: CaseDescriptor, second: CaseDescriptor): string {
	if (first.shown === second.shown) {
		return `'${first.tag}' and '${second.tag}' both cross as the string "${first.name}"`
	}

	return `a ${first.shown} and a ${second.shown} both cross as the string "${first.name}"`
}
