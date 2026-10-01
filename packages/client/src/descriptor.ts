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

// The compiler's side of the boundary. Descriptors are defined in
// `@essence-lang/compiler/embed/describe`, where `esc build --embed` reaches them
// too. This file adds the Marshaller, which takes a `common.Type` and answers
// through the interpreter.
//
// `marshal-runtime.ts` imports the Descriptor types from here, so no specifier
// in it leads to the compiler.
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
	type Fill,
	type FunctionDescriptor,
	type Members,
	type ModuleDescriptor,
	type NamespaceDescriptor,
	type NamespaceMethod,
	type OverloadDescriptor,
} from "@essence-lang/compiler/embed/describe"

// #region The Marshaller

// The interpreter for a host that holds compiler Types rather than Descriptors,
// such as one with a `raw` binding and an Export Surface. Each call describes
// the Type it is handed.
export type Marshaller = {
	// An Essence value out, as the JavaScript it maps to. `path` is what an
	// Error calls the value. `expected` matters for a Function, which carries no
	// Type: with it, the Function is wrapped into a callable.
	toJS: (value: unknown, path?: string, expected?: common.Type) => unknown
	// A JavaScript value in, as the Essence Type it is being handed to.
	fromJS: (
		value: unknown,
		expected: common.Type,
		path?: string,
	) => EssenceValue
	// One Essence Function as a JavaScript one. Arguments are marshalled against
	// the declared Parameter Types and passed by position, as every Essence call
	// is emitted. `name` is what an Error calls the Function.
	wrapFunction: (
		target: EssenceFunction,
		signature: common.BaseFunction,
		name: string,
	) => (...args: Array<unknown>) => unknown
}

export type MarshallerOptions = {
	// The canonical path of the entry the bundle was emitted for. Inside a
	// bundle a Case tag is spelled relative to its entry (`emittedIdentity`).
	entryPath: string
	// The whole Module, which tells the interpreter whether a Case belongs to a
	// unit Choice and crosses as a bare string. It is required, so a `toJS`
	// without a Type spells a Case as a declared position would.
	module: ModuleDescriptor
	// The host's stop, the root of every run this Marshaller starts. See
	// `InterpreterOptions`.
	signal?: AbortSignal
}

export function createMarshaller(
	bridge: RuntimeBridge,
	options: MarshallerOptions,
): Marshaller {
	let interpreter = createInterpreter(bridge, options.module, {
		signal: options.signal,
	})
	let context: DescribeContext = { entryPath: options.entryPath }
	// A Type always describes the same way, so its Descriptor is kept. The
	// interpreter keys its compiled rules by Descriptor, so a second value of one
	// Type reuses them.
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
