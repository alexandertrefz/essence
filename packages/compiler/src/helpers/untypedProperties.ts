import type { common, enricher, parser } from "@essence-lang/interfaces"

// A static Property a settling hoist left without a Type. The enricher types
// it where it is read, and the validator reports the reads that could not. See
// "Static Properties while hoisting" in
// packages/compiler/src/enricher/DEVELOPMENT.md.
export type UntypedProperty = {
	namespaceName: string
	memberName: string
	value: parser.ExpressionNode
	selfScope: enricher.Scope
	name: common.Position
	modulePath: string | null
	// The Modules hoisted together with it. Another of them may be enriched
	// before the value, so it never reads the Property typed.
	group: ReadonlySet<string | null>
	typing: boolean
	// The Type a read gave it, before the in-order enrichment reached the
	// value.
	typedOnRead: common.Type | null
	// The value's own Type, once the in-order enrichment reached it, and
	// whether any part of the value was typed as an Error there.
	settledType: common.Type | null
	failsWhereWritten: boolean
	// Why each failed read failed, by the Position of its member. Weak, since
	// an Editor enriches a file again on every change.
	failures: WeakMap<common.Position, UntypedReadCause>
}

// Why a read could not type the value. It names what is not declared there,
// its Type holds an undecided slot, or the reader is another Module of the
// Property's import cycle. Anything else is `other`.
export type UntypedReadCause = "undeclared" | "undecided" | "cycle" | "other"

// Keyed by the Property map of the Namespace's hoisted Type.
const untyped = new WeakMap<
	Record<string, common.Type>,
	Map<string, UntypedProperty>
>()

export function recordUntypedProperty(
	properties: Record<string, common.Type>,
	property: UntypedProperty,
): void {
	untyped.set(
		properties,
		(untyped.get(properties) ?? new Map()).set(
			property.memberName,
			property,
		),
	)
}

export function untypedPropertyOf(
	namespace: common.NamespaceType,
	memberName: string,
): UntypedProperty | undefined {
	return untyped.get(namespace.properties)?.get(memberName)
}

// Whether any read failed in this process, so a validation that can find none
// skips its walk.
let failedReads = false

export function recordFailedRead(
	property: UntypedProperty,
	position: common.Position,
	cause: UntypedReadCause,
): void {
	property.failures.set(position, cause)
	failedReads = true
}

export function anyFailedReads(): boolean {
	return failedReads
}
