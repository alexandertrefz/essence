import {
	describe,
	describeSignature,
	type DescribeContext,
	type Descriptor,
	type ModuleDescriptor,
} from "@essence-lang/compiler/embed/describe"
import type { common } from "@essence-lang/interfaces"

import type { EssenceValue, RuntimeBridge } from "./bridge"
import { createInterpreter, type EssenceFunction } from "./marshal-runtime"

// NOTE: The Compiler-side door onto the boundary. What a Descriptor IS and how
// one is written down lives in the Compiler — `@essence-lang/compiler/embed/describe`,
// which is where both writers of one can reach it, this package and `esc build
// --embed` alike. What is added here is the one thing that needs BOTH halves: a
// Marshaller, which takes the Compiler's own `common.Type` and answers through
// the interpreter, describing each Type on the way past.
//
// NOTE: Re-exported rather than reached through directly by the rest of this
// package, so that `marshal-runtime.ts` can spell the shapes it marshals by
// without ever naming the Compiler — a type import is erased, but a specifier is
// a specifier, and the one rule that file is written under is that nothing in it
// can be followed to a toolchain.
export {
	type CaseDescriptor,
	type ChoiceDescriptor,
	type DeclaredType,
	describe,
	type DescribeContext,
	type Descriptor,
	describeModule,
	describeSignature,
	describeTypes,
	type ExportDescriptor,
	type FunctionDescriptor,
	type ModuleDescriptor,
	type NamespaceDescriptor,
	type NamespaceMethod,
	type OverloadDescriptor,
} from "@essence-lang/compiler/embed/describe"

// #region The Marshaller

// NOTE: The boundary as a host reaches it — `common.Type` in, and the answers the
// interpreter gives. It is the Compiler-side door onto the interpreter and
// nothing else: every call describes the Type it was handed and hands the
// Descriptor on. A host holding a `raw` binding and an Export Surface has exactly
// those two Types and no Descriptor, which is why the door is spelled in theirs.
export type Marshaller = {
	// NOTE: An Essence value out, as the JavaScript it maps to. The optional name
	// is what an Error calls the value — a caller marshalling a return value or a
	// constant says which — and everything below it is spelled relative to that.
	// The optional Type is for the one value that carries none of its own: a
	// Function met where the Type declares one is wrapped into a callable rather
	// than handed over raw.
	toJS: (value: unknown, path?: string, expected?: common.Type) => unknown
	// NOTE: A JavaScript value in, as the Essence Type it is being handed to.
	fromJS: (
		value: unknown,
		expected: common.Type,
		path?: string,
	) => EssenceValue
	// NOTE: One Essence Function as a JavaScript one: Arguments marshalled
	// against the Parameter Types the Module declared, the call made
	// positionally — which is how every Essence call is emitted, labels and all —
	// and the answer marshalled back. The name is what an Error calls the
	// Function.
	wrapFunction: (
		target: EssenceFunction,
		signature: common.BaseFunction,
		name: string,
	) => (...args: Array<unknown>) => unknown
}

export type MarshallerOptions = {
	// NOTE: The canonical path of the entry the bridge's bundle was emitted for.
	// A Case tag is spelled relative to the entry INSIDE a bundle, so building one
	// takes the entry as well as the Type — see `emittedIdentity`.
	entryPath: string
	// NOTE: The whole Module. Nothing here reads it — it is handed straight to
	// the interpreter, which needs it for the one question a value can not
	// answer about itself: whether the Case it carries is a unit Choice's, and so
	// crosses as a bare string. Required rather than optional, so that a `toJS`
	// with no Type over it answers the same string a declared position would —
	// a door that could be built without it would spell one Case two ways.
	module: ModuleDescriptor
}

export function createMarshaller(
	bridge: RuntimeBridge,
	options: MarshallerOptions,
): Marshaller {
	let interpreter = createInterpreter(bridge, options.module)
	let context: DescribeContext = { entryPath: options.entryPath }
	// NOTE: One Descriptor per Type, kept against the Type itself. Describing is
	// the whole of what this door pays for having been spelled in the Compiler's
	// vocabulary, and it answers the same thing every time it is asked about the
	// same Type — a Surface is settled long before a value crosses against it.
	// The interpreter keeps its compiled rules against the Descriptor NODE in the
	// same way, so a door asked twice about one Type walks nothing the second
	// time: the same object comes back, and the same closures with it.
	let described = new WeakMap<common.Type, Descriptor>()

	function describeOnce(type: common.Type): Descriptor {
		let descriptor = described.get(type)

		if (descriptor === undefined) {
			descriptor = describe(type, context)
			described.set(type, descriptor)
		}

		return descriptor
	}

	return {
		toJS: (value, path, expected) =>
			interpreter.toJS(
				value,
				path,
				expected === undefined ? undefined : describeOnce(expected),
			),
		fromJS: (value, expected, path) =>
			interpreter.fromJS(value, describeOnce(expected), path),
		wrapFunction: (target, signature, name) =>
			interpreter.wrapFunction(
				target,
				describeSignature(signature, context),
				name,
			),
	}
}

// #endregion
