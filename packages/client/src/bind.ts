import { resolveOverloadedMethodName } from "@essence-lang/compiler/helpers"
import type { ExportSurface } from "@essence-lang/compiler/modules"
import { printSignature } from "@essence-lang/compiler/printType"
import { escapeName } from "@essence-lang/compiler/rewriter"
import type { common } from "@essence-lang/interfaces"

import type { EssenceValue } from "./bridge"
import { EssenceCallError } from "./errors"
import { type Marshaller, plainObject } from "./marshal"

// NOTE: The Module's exports as things a host can USE — a Function it can call,
// a Namespace it can reach a Method on — rather than the tagged values the
// bundle binds. Marshalling says what a value crossing the boundary becomes;
// this says how a call crosses it.
//
// NOTE: What a name is bound to is decided by the Export Surface's TYPE, never
// by its `kind`. A `type Rectangle` sharing its name with `namespace Rectangle`
// is exported under kind `type` and is a Namespace value, so binding by kind
// would hand back a constant that is really a class.

export type ModuleBindings = {
	// NOTE: JavaScript all the way down: values marshalled, Functions callable
	// with JavaScript Arguments, Namespaces plain objects of the same.
	exports: Readonly<Record<string, unknown>>
	// NOTE: The bundle's own bindings under the names their author wrote, and
	// nothing else done to them.
	raw: Readonly<Record<string, unknown>>
}

type Callable = (...args: Array<unknown>) => unknown

type EssenceFunction = (...args: Array<EssenceValue>) => EssenceValue

export function bindModule(
	bundle: Record<string, unknown>,
	surface: ExportSurface,
	marshal: Marshaller,
): ModuleBindings {
	let raw = bindRaw(bundle, surface)
	let exports: Record<string, unknown> = {}

	for (let [name, type] of Object.entries(surface.values)) {
		// NOTE: An Overload set binds nothing under its own name, so it is the
		// one export whose binding is not read off `raw` — it is bound to the
		// refusal that says why, and where its Overloads are instead.
		if (isOverloaded(type)) {
			exports[name] = overloadedCall(type, name)

			continue
		}

		if (!Object.hasOwn(raw, name)) {
			continue
		}

		bindValue(exports, name, () => raw[name], type, name, marshal)
	}

	return { exports: Object.freeze(exports), raw }
}

// NOTE: The Module's exports under the names they were WRITTEN under. The
// Rewriter escapes a name JavaScript can not spell — `ok?` is bound as
// `$user_ok_3f_` — and asking `escapeName` rather than reading the bundle's own
// key list is what keeps the two spellings from drifting.
//
// NOTE: `surface.values` is the list, not `surface.kinds`. `kinds` says what a
// name was DECLARED as, and a Type Alias that shares its name with a Namespace
// is exported as a value while its kind reads `type`; `values` holds exactly the
// exports that have a runtime binding. A name it lists that the bundle does not
// bind would be a Compiler bug, and is left out rather than bound to `undefined`
// — reading it then says "no such export" instead of handing back nothing.
function bindRaw(
	bundle: Record<string, unknown>,
	surface: ExportSurface,
): Readonly<Record<string, unknown>> {
	let raw: Record<string, unknown> = {}

	for (let [name, type] of Object.entries(surface.values)) {
		// NOTE: An Overload set binds no name of its own — each Overload is its
		// own `name__overload$N` — so the whole set is put on `raw` under those
		// names, which are the only ones a host can actually call. (No user
		// Module reaches this today: `overload function` is the standard
		// library's alone, and the `declarations` files that may write it may
		// not export. It is here because `raw` promises the bundle's bindings,
		// and a promise with a hole in it is worse than a branch that waits.)
		if (isOverloaded(type)) {
			for (let index of type.overloads.keys()) {
				let overloadName = resolveOverloadedMethodName(name, index)
				let binding = escapeName(overloadName)

				if (binding in bundle) {
					raw[overloadName] = bundle[binding]
				}
			}

			continue
		}

		let binding = escapeName(name)

		if (binding in bundle) {
			raw[name] = bundle[binding]
		}
	}

	return Object.freeze(raw)
}

function bindValue(
	target: Record<string, unknown>,
	key: string,
	read: () => unknown,
	type: common.Type,
	name: string,
	marshal: Marshaller,
): void {
	switch (type.type) {
		case "Function":
			target[key] = wrapFunction(
				read() as EssenceFunction,
				type,
				name,
				marshal,
			)

			break
		case "Namespace":
			target[key] = bindNamespace(read(), type, marshal)

			break
		// NOTE: Everything a value can be MADE of — a constant, and nothing
		// else, since the Validator refuses to export a `variable` and a Method
		// is only ever reached through the Namespace that holds it.
		default:
			defineConstant(target, key, read, name, marshal)
	}
}

// NOTE: A constant is marshalled ON READ rather than at bind time, for two
// reasons that happen to have one answer.
//
// A value the Marshaller has no mapping for — the numeric tower above Rational,
// today — would otherwise take the whole Module down: one `constant root =
// 2::squareRoot()` and `exports`, `raw`, `bridge` and `marshaller` are all
// unreachable over an export nobody asked for. Bound this way, the refusal lands
// on the export that caused it, where it can be read and worked around.
//
// And what a read hands back is a fresh value every time, exactly as
// `marshaller.toJS(raw.…)` is. A single marshalled Array shared by every reader
// is one a host can push onto, which changes what every other holder of the same
// Module sees — while `Object.freeze(exports)` says, wrongly, that it cannot.
function defineConstant(
	target: Record<string, unknown>,
	key: string,
	read: () => unknown,
	name: string,
	marshal: Marshaller,
): void {
	Object.defineProperty(target, key, {
		get: () => marshal.toJS(read(), name),
		enumerable: true,
	})
}

// #region Functions

// NOTE: One Essence Function as a JavaScript one: Arguments marshalled against
// the Parameter Types the Module declared, the call made positionally — which is
// how every Essence call is emitted, labels and all — and the answer marshalled
// back. Everything a caller can get wrong before the first Argument is even
// looked at is an `EssenceCallError`; everything about a value is an
// `EssenceMarshalError`. The two are told apart because they are fixed in
// different places.
function wrapFunction(
	target: EssenceFunction,
	signature: common.BaseFunction,
	name: string,
	marshal: Marshaller,
): Callable {
	let parameters = signature.parameterTypes
	let labels = labelsOf(signature)

	return (...args: Array<unknown>): unknown => {
		let call = readCall(args, signature, labels, name)
		let marshalled = call.ordered.map((argument, position) =>
			marshal.fromJS(
				argument,
				parameters[position]!.type,
				argumentPath(parameters[position]!, position, call.labelled),
			),
		)

		return marshal.toJS(target(...marshalled), "return value")
	}
}

// NOTE: The Arguments a call resolved to, and which of the two ways it was
// written — an Error names an Argument by its label where the caller wrote one,
// and by its position where they counted.
type Call = { ordered: Array<unknown>; labelled: boolean }

// NOTE: The Arguments in the order the emitted Function takes them, whichever
// way the caller wrote the call.
//
// A Function whose every Parameter carries a label may be called with one
// object instead — `Rectangle.of({ width: 3n, height: 4n })` — because that is
// the call Essence itself writes, and dropping to positional Arguments at the
// boundary would lose the one thing the Declaration insisted on. The keys have
// to be EXACTLY the labels: a labelled call with a missing or a misspelled one
// is a mistake, not a positional call that happens to pass an object.
function readCall(
	args: Array<unknown>,
	signature: common.BaseFunction,
	labels: Array<string> | null,
	name: string,
): Call {
	if (labels !== null && args.length === 1) {
		let given = plainObject(args[0])

		if (given !== null) {
			let keys = Object.keys(given)

			if (sameNames(keys, labels)) {
				return {
					ordered: labels.map((label) => given[label]),
					labelled: true,
				}
			}

			// NOTE: One object that is not a labelled call is only a positional
			// call while the Function takes exactly one Argument. Where it takes
			// more, the caller plainly meant the labels and got them wrong, and
			// saying which is worth more than "takes 2 Arguments, 1 was passed".
			if (signature.parameterTypes.length !== 1) {
				throw new EssenceCallError(
					`${callShape(signature, labels, name)}. It was passed one object with ${
						keys.length === 0 ? "no keys" : quoted(keys)
					}.`,
				)
			}
		}
	}

	if (args.length !== signature.parameterTypes.length) {
		throw new EssenceCallError(
			`${callShape(signature, labels, name)}; ${count(
				args.length,
				"Argument",
			)} ${args.length === 1 ? "was" : "were"} passed.`,
		)
	}

	return { ordered: args, labelled: false }
}

// NOTE: How the Function may be called, as the first half of every refusal —
// the signature it was declared with, and both ways of writing a call to it.
// The caller who got one wrong is reading it to find the other.
function callShape(
	signature: common.BaseFunction,
	labels: Array<string> | null,
	name: string,
): string {
	let positions = count(signature.parameterTypes.length, "Argument")

	return labels === null
		? `${printSignature(signature, name)} takes ${positions}`
		: `${printSignature(
				signature,
				name,
			)} takes ${positions} positionally, or one object with the labels ${quoted(
				labels,
			)}`
}

// NOTE: The labels a call may be written with, or `null` where it may not be
// written that way at all. Every Parameter has to carry one: a Function with a
// single `_` among its Parameters can not be called by label in Essence either,
// and half a labelled call is no call.
//
// NOTE: A Function of ONE Record Parameter is positional whatever its label
// says. Both readings take an object, and the Record is the one that can hold
// any shape at all — so `describe({ width: 3n, height: 4n })` passes the
// Rectangle rather than looking for a label named `width`. This is the whole of
// the ambiguity: with two Parameters or more the key set decides, since a
// labelled call's keys are the labels and a positional call passes no object.
function labelsOf(signature: common.BaseFunction): Array<string> | null {
	let parameters = signature.parameterTypes

	if (parameters.length === 0) {
		return null
	}

	if (
		parameters.length === 1 &&
		underlying(parameters[0]!.type) === "Record"
	) {
		return null
	}

	let labels: Array<string> = []

	for (let parameter of parameters) {
		if (parameter.name === null) {
			return null
		}

		labels.push(parameter.name)
	}

	return labels
}

// NOTE: What an Error calls the Argument that went wrong. A labelled call has no
// positions to count, so it is named the way it was written.
function argumentPath(
	parameter: common.Parameter,
	position: number,
	labelled: boolean,
): string {
	return labelled && parameter.name !== null
		? `argument '${parameter.name}'`
		: `argument ${position + 1}`
}

// NOTE: WHICH Overload a call means is a question only the Compiler answers —
// it reads the Argument Types, and a JavaScript value has none to read. So the
// name is bound to the refusal rather than left off: reaching it says what is
// wrong and where the Overloads are, where a missing name would only say that
// something the Module exports is not there.
function overloadedCall(
	type: common.OverloadedMethodType | common.OverloadedStaticMethodType,
	name: string,
): Callable {
	let signatures = type.overloads.map(
		(overload, index) =>
			`  ${printSignature(overload, resolveOverloadedMethodName(name, index))}`,
	)

	return () => {
		throw new EssenceCallError(
			`'${name}' is overloaded, and which Overload a call means is decided by the Argument Types — which a JavaScript value does not carry. Call one of its Overloads by name instead:\n${signatures.join(
				"\n",
			)}`,
		)
	}
}

// #endregion

// #region Namespaces

// NOTE: A Namespace is emitted as a class of static Methods, so it comes back as
// a plain object of the same names — a host writes `Rectangle.of(…)` either way.
// An INSTANCE Method keeps the receiver it is emitted with as its first
// Argument, `Point.shifted(point, 4n)`, because there is no `::` on this side to
// put it before the name. The Export Surface already carries it as Parameter one
// typed as the Namespace's target, so nothing here has to add it.
function bindNamespace(
	value: unknown,
	type: common.NamespaceType,
	marshal: Marshaller,
): Readonly<Record<string, unknown>> {
	let namespace = value as Record<string, unknown>
	let bound: Record<string, unknown> = {}

	// NOTE: A Namespace's members are keyed by the name as it was WRITTEN —
	// `memberKey` quotes what JavaScript can not spell rather than escaping it,
	// so a Method named `ok?` is the property `"ok?"`. `escapeName` belongs to
	// the top level alone and would look for a member nothing binds.
	//
	// NOTE: OWN members, because a Namespace is emitted as a class and a class
	// inherits `name`, `length`, `call` and `bind` from `Function` — an `in`
	// would answer for a Method the bundle does not bind and hand back
	// JavaScript's own.
	//
	// NOTE: A static constant is bound ON READ for the reasons `defineConstant`
	// states — a constant is a constant wherever it sits, and one the Marshaller
	// has no mapping for would otherwise take the whole Namespace with it.
	for (let name of Object.keys(type.properties)) {
		if (Object.hasOwn(namespace, name)) {
			defineConstant(
				bound,
				name,
				() => namespace[name],
				`${type.name}.${name}`,
				marshal,
			)
		}
	}

	for (let [name, methodType] of Object.entries(type.methods)) {
		let qualified = `${type.name}.${name}`

		if (isOverloaded(methodType)) {
			bound[name] = overloadedCall(methodType, qualified)

			continue
		}

		if (
			Object.hasOwn(namespace, name) &&
			typeof namespace[name] === "function"
		) {
			bound[name] = wrapFunction(
				namespace[name] as EssenceFunction,
				methodType,
				qualified,
				marshal,
			)
		}
	}

	return Object.freeze(bound)
}

// #endregion

// #region Reading values

function isOverloaded(
	type: common.Type,
): type is common.OverloadedMethodType | common.OverloadedStaticMethodType {
	return (
		type.type === "OverloadedMethod" ||
		type.type === "OverloadedStaticMethod"
	)
}

// NOTE: What a Type IS underneath the names it is reachable by. A checked
// refinement is its base and an unapplied Alias is its body, which is the same
// unwrapping `fromJS` does — the two have to agree, or a Parameter would be read
// as a Record by one and not the other.
function underlying(type: common.Type): common.Type["type"] {
	switch (type.type) {
		case "Refinement":
			return underlying(type.base)
		case "GenericAlias":
			return underlying(type.aliasedType)
		default:
			return type.type
	}
}

function sameNames(given: Array<string>, expected: Array<string>): boolean {
	return (
		given.length === expected.length &&
		expected.every((name) => given.includes(name))
	)
}

// #endregion

// #region Wording

function quoted(names: Array<string>): string {
	return names.map((name) => `'${name}'`).join(", ")
}

function count(amount: number, noun: string): string {
	return `${amount} ${noun}${amount === 1 ? "" : "s"}`
}

// #endregion
