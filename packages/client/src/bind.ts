import { resolveOverloadedMethodName } from "@essence-lang/compiler/helpers"
import type { ExportSurface } from "@essence-lang/compiler/modules"
import { printSignature } from "@essence-lang/compiler/printType"
import {
	escapeName,
	namespaceMemberName,
} from "@essence-lang/compiler/rewriter"
import type { common } from "@essence-lang/interfaces"

import { EssenceCallError } from "./errors"
import type { EssenceFunction, Marshaller } from "./marshal"

// NOTE: The Module's exports as things a host can USE — a Function it can call,
// a Namespace it can reach a Method on — rather than the tagged values the
// bundle binds. Marshalling says what a value crossing the boundary becomes;
// this says which name is bound to what.
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
			target[key] = marshal.wrapFunction(
				read() as EssenceFunction,
				type,
				name,
			)

			break
		case "Namespace":
			target[key] = bindNamespace(read(), type, marshal)

			break
		// NOTE: Everything a value can be MADE of — a constant, and nothing
		// else, since the Validator refuses to export a `variable` and a Method
		// is only ever reached through the Namespace that holds it.
		default:
			defineConstant(target, key, read, type, name, marshal)
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
//
// NOTE: The declared Type rides along for the one value a tag does not
// describe — a Function inside the constant, which `toJS` wraps against it.
function defineConstant(
	target: Record<string, unknown>,
	key: string,
	read: () => unknown,
	type: common.Type,
	name: string,
	marshal: Marshaller,
): void {
	Object.defineProperty(target, key, {
		get: () => marshal.toJS(read(), name, type),
		enumerable: true,
	})
}

// #region Functions

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
	// the top level alone and would look for a member nothing binds. The one
	// exception is `namespaceMemberName`'s own: a class refuses a static member
	// named `prototype` or `constructor`, so the Rewriter mangles those two, and
	// the read here has to ask the same question — `prototype` would otherwise
	// answer with the class-prototype object every class owns, and
	// `constructor` with `Function` off the prototype chain.
	//
	// NOTE: OWN members, because a Namespace is emitted as a class and a class
	// inherits `name`, `length`, `call` and `bind` from `Function` — an `in`
	// would answer for a Method the bundle does not bind and hand back
	// JavaScript's own.
	//
	// NOTE: A static constant is bound ON READ for the reasons `defineConstant`
	// states — a constant is a constant wherever it sits, and one the Marshaller
	// has no mapping for would otherwise take the whole Namespace with it.
	for (let [name, propertyType] of Object.entries(type.properties)) {
		let binding = namespaceMemberName(name)

		if (Object.hasOwn(namespace, binding)) {
			defineConstant(
				bound,
				name,
				() => namespace[binding],
				propertyType,
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

		let binding = namespaceMemberName(name)

		if (
			Object.hasOwn(namespace, binding) &&
			typeof namespace[binding] === "function"
		) {
			bound[name] = marshal.wrapFunction(
				namespace[binding] as EssenceFunction,
				methodType,
				qualified,
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

// #endregion
