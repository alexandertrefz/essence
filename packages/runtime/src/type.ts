import type { common } from "@essence-lang/interfaces"

import type { AlgebraicType } from "./Algebraic"
import type { BooleanType } from "./Boolean"
import type { IntegerType } from "./Integer"
import type { ListType } from "./List"
import type { OrderingType } from "./Ordering"
import type { RationalType } from "./Rational"
import type { RecordType } from "./Record"
import type { StringType } from "./String"
import type { TranscendentalType } from "./Transcendental"

export const typeKeySymbol = Symbol("$type")

// NOTE: The runtime half of Union Method dispatch — each case holds a member
// Type descriptor, the statically chosen Method, that Method's hidden
// conformance Arguments, and the Arguments this case alone is given. The
// Enricher orders the cases most specific first and only emits a dispatch when
// some case is guaranteed to match.
//
// NOTE: An Argument means something different in every branch when its Type
// came from the branch: the Function literal `(item) { <- item::label() }`
// calls one Namespace's `label` for a `List<Alpha>` receiver and another's for
// a `List<Beta>` one — so the Enricher compiles one copy per branch and lists
// each here under the position it stands in for. Only the matched case's copies
// are ever reached. Everything else is shared: `args` is built once at the call
// site, before any case is tried, so an Argument with a side effect happens
// exactly once however many branches the dispatch has, and the overrides are
// written into a copy so one case's Arguments can not become another's.
export function dispatchMethod(
	receiver: AnyType,
	args: Array<unknown>,
	cases: Array<
		[
			common.Type,
			(...args: Array<unknown>) => unknown,
			Array<unknown>,
			Array<[number, unknown]>?,
		]
	>,
): unknown {
	for (let [
		type,
		method,
		conformanceArguments,
		contextualArguments,
	] of cases) {
		if (isValueOfType(receiver, type)) {
			let caseArguments = args

			if (contextualArguments !== undefined) {
				caseArguments = [...args]

				for (let [index, argument] of contextualArguments) {
					caseArguments[index] = argument
				}
			}

			return method(receiver, ...caseArguments, ...conformanceArguments)
		}
	}

	return noDispatchCaseMatched()
}

// NOTE: The end of a dispatch, whether the search above walked it or
// `compile-union-dispatch` wrote it out as a chain of tests — one throw for
// both, so which of the two a Program was built with does not change what it
// says when it goes wrong. The Enricher emits a dispatch only where every
// member of the receiver's Union has a case, so this is unreachable in a
// Program that compiled clean, and reaching it means a case's runtime check
// disagrees with the Type the Enricher gave it.
export function noDispatchCaseMatched(): never {
	throw new Error("No dispatch case matched the receiver.")
}

// NOTE: The runtime half of a conditional conformance — each fulfilling Method
// is curried with the `where` conditions' own witnesses, which the bounded
// helper (`List.compare`) receives as its hidden trailing conformance
// Arguments. The unconditional case never reaches here: the Rewriter emits its
// method map as a plain object literal instead.
export function boundConformance(
	// NOTE: The fulfilling Methods carry concrete runtime signatures
	// (`List.compare` takes its own conformance Argument), so the map is
	// typed loosely here — the curried witnesses restore the exact shape the
	// bounded helper expects.
	methods: Record<string, (...args: Array<any>) => unknown>,
	conditions: Array<unknown>,
): Record<string, (...args: Array<any>) => unknown> {
	let bound: Record<string, (...args: Array<any>) => unknown> = {}

	for (let [name, method] of Object.entries(methods)) {
		bound[name] = (...args: Array<unknown>) =>
			method(...args, ...conditions)
	}

	return bound
}

// NOTE: The runtime shape of a constructed Choice Case — the payload's
// members with the Case's tag (`"CalculatorOperation#Add"`) on the hidden
// Type key. Unit Cases simply carry no further members.
export type CaseInstanceType = {
	[typeKeySymbol]: string
	[key: string]: AnyType
}

// NOTE: A unit Case carries nothing but its tag, so every value of one holds
// exactly what every other value of it holds — and Case equality goes by that
// tag, with no operator anywhere in the language asking whether two values are
// the SAME value. So one instance per tag is built and handed out ever after,
// which is what `Ordering`, `Side` and the other builtin Choices have always
// done with their Cases as Module consts; this does it for the ones a Program
// declares.
//
// NOTE: The Map is bounded by how many distinct unit Case tags the Program
// CONSTRUCTS, which is a property of its text rather than of its work — a
// constant pool that fills once, not a cache that grows with what the Program
// is asked to do.
const unitCaseInstances = new Map<string, CaseInstanceType>()

export function createCase(
	tag: string,
	payload?: Record<string, AnyType>,
): CaseInstanceType {
	if (payload === undefined) {
		let instance = unitCaseInstances.get(tag)

		if (instance === undefined) {
			instance = { [typeKeySymbol]: tag }
			unitCaseInstances.set(tag, instance)
		}

		return instance
	}

	return { ...payload, [typeKeySymbol]: tag }
}

// NOTE: CaseInstanceType is deliberately NOT part of AnyType — its
// `[typeKeySymbol]: string` would defeat the tag-based narrowing every
// runtime helper relies on. Case values still flow through these helpers at
// runtime; only the compile-time union stays precise.
export type AnyType =
	| RecordType
	| ListType<any>
	| StringType
	| IntegerType
	| RationalType
	| AlgebraicType
	| TranscendentalType
	| BooleanType
	| OrderingType

export function isValueOfType(value: AnyType, type: common.Type): boolean {
	if (type.type === "Boolean") {
		return value[typeKeySymbol] === "Boolean"
	} else if (type.type === "String") {
		return value[typeKeySymbol] === "String"
	} else if (type.type === "Integer") {
		return value[typeKeySymbol] === "Integer"
	} else if (type.type === "Rational") {
		return value[typeKeySymbol] === "Rational"
	} else if (type.type === "Algebraic") {
		return value[typeKeySymbol] === "Algebraic"
	} else if (type.type === "Transcendental") {
		return value[typeKeySymbol] === "Transcendental"
	} else if (type.type === "Record") {
		if (value[typeKeySymbol] !== "Record") {
			return false
		}

		// NOTE: Structural and open — the value has to carry every member the
		// Matcher names, matching in Type, but may carry more besides.
		return Object.entries(type.members).every(
			([name, memberType]) =>
				name in value && isValueOfType(value[name], memberType),
		)
	} else if (type.type === "List" || type.type === "GenericList") {
		if (value[typeKeySymbol] !== "List") {
			return false
		}

		// NOTE: Item Types erase at runtime — narrowing a List means looking
		// at the items it happens to hold. Every item has to fit, so the
		// empty List fits any List matcher, the same way an empty literal is
		// assignable to any List.
		if (type.type === "List" && type.itemType.type !== "Unknown") {
			return (value as ListType<AnyType>).value.every((item) =>
				isValueOfType(item, type.itemType),
			)
		}

		return true
	} else if (type.type === "Case") {
		// NOTE: Nominal first — the tag says which Case, and a structurally
		// identical plain Record is not this Case however its members line up.
		if (value[typeKeySymbol] !== `${type.choice}#${type.name}`) {
			return false
		}

		// NOTE: Then the payload, because one tag is carried by every
		// instantiation of a generic Case: `Box<Integer>#Full` and
		// `Box<String>#Full` are both "Box#Full", and the tag alone let a
		// Matcher for one accept values of the other — a String payload
		// arrived where the Handler had been told it was an Integer. A payload
		// is CLOSED (the Case declares every member it has), so unlike a
		// Record this asks about all of it.
		//
		// NOTE: Inside generic code the members are still Type Parameters, and
		// a GenericUse answers true below, so the check degrades to the tag
		// alone exactly where nothing more is known about the payload.
		//
		// NOTE: Cast because `CaseInstanceType` is deliberately kept out of
		// `AnyType` — the tag matched above is what says this value is one.
		let instance = value as unknown as CaseInstanceType

		return Object.entries(type.members).every(
			([name, memberType]) =>
				name in instance && isValueOfType(instance[name], memberType),
		)
	} else if (type.type === "UnionType") {
		return type.types.some((memberType) => isValueOfType(value, memberType))
	} else if (type.type === "Function") {
		// NOTE: A Function is the one runtime value carrying no Type key — it
		// is emitted as a bare JavaScript function — so `typeof` is what
		// answers for it, exactly as `getStringRepresentation` and `anyIs`
		// answer for it. Its Signature is erased by the time the check runs:
		// Parameter and Return Types leave nothing behind to compare, and
		// `Function.length` counts only the emitted Parameters, which the
		// hidden conformance Arguments of a bounded Function add to. So
		// callability IS the whole check, and two Matchers naming
		// Function-typed members ask the same question however differently
		// they are declared — which is why the Validator reports the second of
		// them as a Case that can never match rather than letting it look like
		// it narrows.
		//
		// NOTE: This used to fall through to the "not implemented" branch
		// below and answer FALSE, so a Record Matcher naming a callback member
		// could never match: every Handler declined, the emitted `if` chain
		// fell off its end, and the Match answered `undefined`.
		return typeof (value as unknown) === "function"
	} else if (type.type === "GenericUse") {
		// NOTE: Types erase at runtime — a Generic matcher stands for any
		// value. Handlers are tested in order, so concrete matchers narrow
		// the value before a Generic matcher catches the rest. A Handler
		// written BELOW such a matcher can therefore never run, which the
		// Validator reports as an unreachable Case.
		return true
	} else if (type.type === "Unknown") {
		// NOTE: The Type a wildcard Handler (`case _`) resolves to once no
		// Types are left to narrow — like a Generic matcher, it accepts
		// whatever the Handlers before it did not catch.
		return true
	} else {
		// NOTE: Every Type a Matcher or a dispatch case can name is answered
		// above, so reaching here is a Compiler bug rather than a Program one
		// — a descriptor was emitted that the runtime does not know. It used
		// to `console.log` and answer false, which put a line of Compiler
		// prose in the Program's own output and then silently took a wrong
		// branch; a throw names the descriptor instead of hiding it.
		throw new Error(
			`Type '${type.type}' can not be checked at runtime. This is a bug in the Compiler.`,
		)
	}
}

// NOTE: The end of an emitted Match's `if` chain — reached only when no
// Handler accepted the value. The Validator refuses a Match that does not
// cover its Union, so this is unreachable in a Program that compiled clean,
// and reaching it means a Matcher's runtime check disagrees with the Type the
// Enricher gave it. The chain used to simply END here: the emitted wrapper
// answered `undefined`, which is not an Essence value at all, and the failure
// surfaced somewhere else entirely — as a `TypeError` in whatever read the
// missing Type key next, or as a wrong value flowing on unnoticed.
//
// NOTE: The value is named by its Type key and nothing more — enough to say
// WHICH value fell through, while staying small enough to carry: this Module
// is not shaken out of any Program's bundle, so every line here is a line
// every Program pays for. Rendering the value itself is
// `getStringRepresentation`'s job, and reaching for it would make the runtime's
// Type Module depend on the printing one.
export function noCaseMatched(value: AnyType): never {
	let description =
		typeof (value as unknown) === "function"
			? "Function"
			: String(value[typeKeySymbol])

	throw new Error(
		`No Case of this Match matched the ${description} it was given. This is a bug in the Compiler.`,
	)
}
