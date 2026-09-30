import type { common } from "@essence-lang/interfaces"

import type { AlgebraicType } from "./Algebraic"
import type { BooleanType } from "./Boolean"
import type { DictionaryType } from "./Dictionary"
import type { FutureType, StartedType } from "./Future"
import type { HttpFailureType } from "./HttpFailure"
import type { IntegerType } from "./Integer"
import type { ListType } from "./List"
import { caughtUp } from "./listWrites"
import type { OrderingType } from "./Ordering"
import type { RandomnessType } from "./Randomness"
import type { RationalType } from "./Rational"
import type { RecordType } from "./Record"
import type { StringType } from "./String"
import type { TranscendentalType } from "./Transcendental"

export const typeKeySymbol = Symbol("$type")

// The runtime half of Union Method dispatch. Each case holds a member Type,
// the Method chosen for it, its conformance Arguments, the Arguments only this
// case is given, and its defaulted Parameters. See "Union Method dispatch" in
// DEVELOPMENT.md.
export function dispatchMethod(
	receiver: AnyType,
	args: Array<unknown>,
	cases: Array<
		[
			common.Type,
			(...args: Array<unknown>) => unknown,
			Array<unknown>,
			Array<[number, unknown]>?,
			Array<number>?,
		]
	>,
): unknown {
	for (let [
		type,
		method,
		conformanceArguments,
		contextualArguments,
		omittedParameterIndices,
	] of cases) {
		if (isValueOfType(receiver, type)) {
			let caseArguments = args

			if (contextualArguments !== undefined) {
				caseArguments = [...args]

				for (let [index, argument] of contextualArguments) {
					caseArguments[index] = argument
				}
			}

			// Opens an `undefined` hole for each Parameter this case's Method
			// defaults. The indices count the receiver as 0, so index `i` lands at
			// `i - 1`, and they arrive in Parameter order.
			if (omittedParameterIndices !== undefined) {
				let total =
					caseArguments.length + omittedParameterIndices.length
				// oxlint-disable-next-line unicorn/no-new-array -- the length
				let opened: Array<unknown> = new Array(total)
				let next = 0
				let hole = 0

				for (let index = 0; index < total; index++) {
					if (omittedParameterIndices[hole] === index + 1) {
						opened[index] = undefined
						hole++
					} else {
						opened[index] = caseArguments[next++]
					}
				}

				caseArguments = opened
			}

			return method(receiver, ...caseArguments, ...conformanceArguments)
		}
	}

	return noDispatchCaseMatched()
}

// The end of a dispatch, whether `dispatchMethod` searched it or the Optimiser
// wrote it out as a chain. Unreachable in a Program that compiled clean.
export function noDispatchCaseMatched(): never {
	throw new Error("No dispatch case matched the receiver.")
}

// A conditional conformance's witness: each Method curried with the witnesses
// of the `where` conditions. The `structural` brand holds only where every
// condition's witness has it. See "Conformance witnesses" in DEVELOPMENT.md.
export function boundConformance(
	// Typed loosely: each Method takes its own conformance Arguments, and the
	// `true` is the `structural` brand riding in the same map.
	methods: Record<string, ((...args: Array<any>) => unknown) | true>,
	conditions: Array<unknown>,
): Record<string, ((...args: Array<any>) => unknown) | true> {
	let bound: Record<string, ((...args: Array<any>) => unknown) | true> = {}

	for (let [name, method] of Object.entries(methods)) {
		if (typeof method !== "function") {
			continue
		}

		bound[name] = (...args: Array<unknown>) =>
			method(...args, ...conditions)
	}

	if (
		methods.structural === true &&
		conditions.every(
			(condition) =>
				(condition as { structural?: true }).structural === true,
		)
	) {
		bound.structural = true
	}

	return bound
}

// A witness whose provided bodies are each curried with the witness itself.
// The `structural` brand passes through, since no Protocol provides that name.
export function providedConformance(
	methods: Record<string, ((...args: Array<any>) => unknown) | true>,
	provided: Record<string, (...args: Array<any>) => unknown>,
): Record<string, ((...args: Array<any>) => unknown) | true> {
	let witness: Record<string, ((...args: Array<any>) => unknown) | true> = {
		...methods,
	}

	for (let [name, method] of Object.entries(provided)) {
		witness[name] = (...args: Array<unknown>) => method(...args, witness)
	}

	return witness
}

// Every group built, under the witness it answers with.
const groups = new WeakMap<object, Array<unknown>>()

// One conformer's witnesses for several Protocols, the first being the
// answer. `curried` indexes `conditions` and then the `shared` ones; every map
// is built before a body closes over one, so bodies may call across witnesses.
export function providedConformances(
	methods: Array<Record<string, ((...args: Array<any>) => unknown) | true>>,
	provided: Array<Record<string, [(...args: Array<any>) => unknown, number]>>,
	conditions: Array<unknown> = [],
	curried: Array<Array<number>> = [],
	shared: Array<[number, number]> = [],
): Record<string, ((...args: Array<any>) => unknown) | true> {
	let taken = [
		...conditions,
		...shared.map(([at, witness]) => groupOf(conditions[at])[witness]),
	]
	let witnesses = methods.map(
		(
			entries,
			index,
		): Record<string, ((...args: Array<any>) => unknown) | true> => {
			let curriedOn = curried[index] ?? []

			return curriedOn.length === 0
				? { ...entries }
				: boundConformance(
						entries,
						curriedOn.map((at) => taken[at]),
					)
		},
	)

	for (let [index, entries] of provided.entries()) {
		for (let [name, [method, curried]] of Object.entries(entries)) {
			witnesses[index]![name] = (...args: Array<unknown>) =>
				method(...args, witnesses[curried])
		}
	}

	groups.set(witnesses[0]!, witnesses)

	return witnesses[0]!
}

function groupOf(witness: unknown): Array<unknown> {
	let group =
		typeof witness === "object" && witness !== null
			? groups.get(witness)
			: undefined

	if (group === undefined) {
		throw new Error(
			"A condition taken from a group names a witness no group built. This is a bug in the Compiler.",
		)
	}

	return group
}

// A constructed Case: the payload's members, and the Case's tag under the
// Type key. A unit Case carries nothing else.
export type CaseInstanceType = {
	[typeKeySymbol]: string
	[key: string]: AnyType
}

// One shared instance per unit Case tag, as the builtin Choices keep theirs.
// The Map holds only the tags a Program's text constructs, so it stops growing.
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

// `CaseInstanceType` stays out of `AnyType`: its `[typeKeySymbol]: string`
// would defeat the tag narrowing every runtime helper relies on.
export type AnyType =
	| RecordType
	| ListType<any>
	| DictionaryType<any, any>
	| StringType
	| IntegerType
	| RationalType
	| AlgebraicType
	| TranscendentalType
	| BooleanType
	| OrderingType
	// Named here so the printer and the type test know it, though no Essence
	// code builds one.
	| RandomnessType
	// A List of Futures is a value, and `ListType` takes an item of this union.
	// Both are registered kinds, so their rendering and equality live in
	// `Future.ts`. See "The kind registry" in DEVELOPMENT.md.
	| FutureType<any>
	| StartedType<any>
	// Most Cases reach no native and stay out of this union. `Http.send`
	// answers a `Result<Response, HttpFailure>`, and the generated native
	// contract renders it against `ResultType`, which this union bounds.
	| HttpFailureType

// The one Dictionary type the readers outside `Dictionary.ts` share.
export type AnyDictionary = DictionaryType<AnyType, AnyType>

// Whether every live entry of a Dictionary box answers `check`, stopping at the
// first that does not. See "Why `type.ts` reads containers itself" in
// DEVELOPMENT.md.
export function everyLiveEntry(
	dictionary: AnyDictionary,
	check: (key: AnyType, value: AnyType) => boolean,
): boolean {
	// Read once, before the walk: `check` may be user code, and a write inside
	// it can move this box onto a store of its own.
	let generation = dictionary.generation

	for (let slot of dictionary.store.slots) {
		let versions = slot.versions

		for (let index = versions.length - 1; index >= 0; index--) {
			let version = versions[index]!

			if (version.generation > generation) {
				continue
			}

			if (
				typeof version.value !== "symbol" &&
				!check(slot.key, version.value)
			) {
				return false
			}

			break
		}
	}

	return true
}

// The live entries as an Array, for a reader that looks entries up. Built on
// `everyLiveEntry` so there is one reading of what a box holds.
export function liveEntriesOf(
	dictionary: AnyDictionary,
): Array<[AnyType, AnyType]> {
	let entries: Array<[AnyType, AnyType]> = []

	everyLiveEntry(dictionary, (key, value) => {
		entries.push([key, value])

		return true
	})

	return entries
}

export function isValueOfType(value: AnyType, type: common.Type): boolean {
	if (type.type === "Randomness") {
		return value[typeKeySymbol] === "Randomness"
	} else if (type.type === "Boolean") {
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

		// Open: the value carries every member the Matcher names, and may carry
		// more. `Object.hasOwn`, since `in` finds `toString` on the prototype.
		return Object.entries(type.members).every(
			([name, memberType]) =>
				Object.hasOwn(value, name) &&
				isValueOfType(value[name], memberType),
		)
	} else if (type.type === "List" || type.type === "GenericList") {
		if (value[typeKeySymbol] !== "List") {
			return false
		}

		// Every item has to fit, so the empty List fits any List Matcher. See
		// "Runtime type tests" in DEVELOPMENT.md.
		if (type.type === "List" && type.itemType.type !== "Unknown") {
			let list = value as ListType<AnyType>

			// The one write a type test makes, and it writes back what the box
			// was always answering.
			caughtUp(list)

			let front = list.front

			if (front !== undefined) {
				let frontCount = list.frontLen ?? front.length

				for (let index = frontCount - 1; index >= 0; index--) {
					if (!isValueOfType(front[index], type.itemType)) {
						return false
					}
				}
			}

			let back = list.value
			let backCount = list.length ?? back.length

			for (let index = 0; index < backCount; index++) {
				if (!isValueOfType(back[index], type.itemType)) {
					return false
				}
			}
		}

		return true
	} else if (
		type.type === "Dictionary" ||
		type.type === "GenericDictionary"
	) {
		if (value[typeKeySymbol] !== "Dictionary") {
			return false
		}

		// Each slot is checked only where the Matcher names a Type for it.
		if (type.type !== "Dictionary") {
			return true
		}

		let keyType = type.keyType
		let valueType = type.valueType

		if (keyType.type === "Unknown" && valueType.type === "Unknown") {
			return true
		}

		return everyLiveEntry(
			value as AnyDictionary,
			(key, held) =>
				(keyType.type === "Unknown" || isValueOfType(key, keyType)) &&
				(valueType.type === "Unknown" ||
					isValueOfType(held, valueType)),
		)
	} else if (type.type === "Case") {
		// Nominal first: a plain Record with the same members is not this Case.
		if (value[typeKeySymbol] !== `${type.choice}#${type.name}`) {
			return false
		}

		// Then the whole payload, since every instantiation of a generic Case
		// carries one tag. The cast stands in for `CaseInstanceType`, which is
		// kept out of `AnyType`.
		let instance = value as unknown as CaseInstanceType

		return Object.entries(type.members).every(
			([name, memberType]) =>
				Object.hasOwn(instance, name) &&
				isValueOfType(instance[name], memberType),
		)
	} else if (type.type === "Future" || type.type === "Started") {
		// The kind alone: what a Future answers does not exist until it runs.
		// Widened to a String, since neither kind is in `AnyType`.
		return String(value[typeKeySymbol]) === type.type
	} else if (type.type === "UnionType") {
		return type.types.some((memberType) => isValueOfType(value, memberType))
	} else if (type.type === "Function") {
		// A Function carries no Type key and its Signature is erased, so
		// callability is the whole test.
		return typeof (value as unknown) === "function"
	} else if (type.type === "GenericUse") {
		// A Type Parameter matches anything. Matchers are tried in order, so the
		// concrete ones narrow first.
		return true
	} else if (type.type === "Unknown") {
		// The wildcard `case _` resolves to `Unknown`, and matches anything.
		return true
	} else {
		// A descriptor the runtime does not know is a Compiler bug.
		throw new Error(
			`Type '${type.type}' can not be checked at runtime. This is a bug in the Compiler.`,
		)
	}
}

// The end of a Match no Handler accepted, unreachable in a Program that
// compiled clean. It names the value's Type key only, so that `type.ts` does
// not import the printer.
export function noCaseMatched(value: AnyType): never {
	let description =
		typeof (value as unknown) === "function"
			? "Function"
			: String(value[typeKeySymbol])

	throw new Error(
		`No Case of this Match matched the ${description} it was given. This is a bug in the Compiler.`,
	)
}
