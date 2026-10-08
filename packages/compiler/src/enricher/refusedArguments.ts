import type { parser } from "@essence-lang/interfaces"

import { admittedTypeOf } from "../helpers/predicateEval"
import {
	holdsFunctionRefusedAsValue,
	measuredValue,
	refusedFunctionsAsHoles,
	typeContainsError,
} from "../helpers/types"
import type { ArgumentTyper } from "./enrichers"

// The typer with each Function refused as a value read as a hole, or null where
// no Argument holds one. A refused call is then measured around such a
// Function, as the validator measures a value. See "Holes" in
// packages/compiler/src/validator/DEVELOPMENT.md.
export function typerAroundRefusedFunctions(
	args: Array<parser.ArgumentNode>,
	typer: ArgumentTyper,
): ArgumentTyper | null {
	// Every Argument is read here, where its Diagnostics are reported, since a
	// probe matching around the holes discards them. A Function literal is left
	// untyped, since typing one away from its Parameter would report it.
	let read = args
		.filter((argument) => argument.value.nodeType !== "FunctionValue")
		.map((argument) => typer.enrichedArgumentValue(argument.value))

	if (!read.some((value) => holdsFunctionRefusedAsValue(value.type))) {
		return null
	}

	return {
		...typer,
		getType(value, expectedType, bindings, declaredType) {
			let type = typer.getType(
				value,
				expectedType,
				bindings,
				declaredType,
			)

			if (
				value.nodeType === "FunctionValue" ||
				!holdsFunctionRefusedAsValue(type)
			) {
				return type
			}

			// `[Integer.add]` still proves a `NonEmptyList` has an item.
			let measured = measuredValue(typer.enrichedArgumentValue(value))

			return (
				admittedTypeOf(expectedType, measured) ??
				refusedFunctionsAsHoles(type)
			)
		},
		enrichedArgumentValue: (value) =>
			measuredValue(typer.enrichedArgumentValue(value)),
	}
}

// Whether a written Argument holds a Function refused as a value and no other
// Error, read before any hole is made. A Function literal is never read away
// from its Parameter.
export function holdsOnlyHoles(
	argument: parser.ArgumentNode | undefined,
	typer: ArgumentTyper,
): boolean {
	if (argument === undefined || argument.value.nodeType === "FunctionValue") {
		return false
	}

	let type = typer.enrichedArgumentValue(argument.value).type

	return holdsFunctionRefusedAsValue(type) && !typeContainsError(type)
}
