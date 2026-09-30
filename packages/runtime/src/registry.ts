import type { RationalType } from "./Rational"
import type { AnyType } from "./type"

// Where a module that owns a container says how its values render and compare.
// This module imports nothing at run time. See "The kind registry" in
// DEVELOPMENT.md.
const kinds = new Map<string, RegisteredKind>()

// The width a single-line rendering may reach before it breaks over lines,
// shared so a registered renderer breaks where the printer around it does.
export const singleLineMaxLength = 60

// The Choice and Case of a tag, without the Module a user Choice's tag starts
// with. See "Case text" in DEVELOPMENT.md. The `-1` guard is for the reader:
// slicing would answer a tag with no `#` whole anyway.
export function caseText(tag: string): string {
	let separator = tag.lastIndexOf("#")

	return separator === -1
		? tag
		: tag.slice(tag.lastIndexOf("#", separator - 1) + 1)
}

// The printer's own walk, handed to a registered renderer for the values its
// container holds. Takes the first four arguments of `getStringRepresentation`.
export type RenderPart = (
	value: AnyType,
	indentLevel: number,
	rationalForm: (rational: RationalType) => string,
	listPadding: string,
) => string

export type RegisteredKind = {
	// The brackets the difference in `Testing.ts` writes around the parts.
	open: string
	close: string
	render: (
		value: AnyType,
		indentLevel: number,
		rationalForm: (rational: RationalType) => string,
		listPadding: string,
		renderPart: RenderPart,
	) => string
	// The parts the difference pairs two values up by, each under the name a
	// reader reads it by. Naming a part renders it, so the renderer comes in.
	parts: (
		value: AnyType,
		render: (value: AnyType) => string,
	) => Array<[string, AnyType]>
	// The universal comparison, with `same` for whatever the values hold. It
	// may use an index of the container's own.
	equals: (
		first: AnyType,
		second: AnyType,
		same: (first: AnyType, second: AnyType) => boolean,
	) => boolean
	// The comparison by a rule for each half of what the value holds. Neither
	// rule is the kind's own equality, so no index may shortcut it.
	equalsBy: (
		first: AnyType,
		second: AnyType,
		sameKey: (first: AnyType, second: AnyType) => boolean,
		sameValue: (first: AnyType, second: AnyType) => boolean,
	) => boolean
}

// Called by the owning module under the tag its values carry. Registering the
// same module twice replaces the kind with itself.
export function registerKind(tag: string, kind: RegisteredKind): void {
	kinds.set(tag, kind)
}

// `undefined` for a tag no loaded module registered, where each walk keeps its
// own answer for an unknown value.
export function kindOf(tag: string): RegisteredKind | undefined {
	return kinds.get(tag)
}
