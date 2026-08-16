import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

import { type RuntimeBridge, runtimeBridgeOf } from "./bridge"
import type { ModuleDescriptor } from "./descriptor"
import {
	bind,
	createInterpreter,
	type Interpreter,
	type ModuleBindings,
} from "./marshal-runtime"

// NOTE: A Module that was compiled ALREADY — a bundle on disk and the Descriptor
// written beside it — loaded without a Compiler anywhere in reach. `esc build
// --embed` writes the pair; everything below reads it.
//
// NOTE: Which is the whole point of a Descriptor being JSON. `loadModule`
// compiles, describes and binds in one call, and pays for a Compiler to do it;
// here the describing was over at build time and what is left is a `readFile`
// and an `import`. A shipped application does not need a toolchain to talk to
// the Essence inside it, and a container does not need one installed.
//
// NOTE: Nothing in this file may reach the Compiler, and `prebuilt.spec.ts`
// reads it back to say so under "The prebuilt door" — the one import that names
// it above is a type import, which is erased before anything runs.

// NOTE: What a Descriptor is written under beside its bundle: `app.js` and
// `app.descriptor.json`. `esc build --embed` spells the same rule from the other
// side, and the two are pinned together by a test that builds a pair and loads
// it — a rule stated twice is one that can only be kept by being checked.
const DESCRIPTOR_EXTENSION = ".descriptor.json"

export function descriptorPath(bundlePath: string): string {
	// NOTE: The extension of the FILE NAME — `extname` reads the base name
	// alone, so a dot in a directory above it is not one, and a name that is
	// nothing but an extension has none to replace. `esc`'s own
	// `descriptorFileName` is spelled out of the same call.
	let extension = path.extname(bundlePath)

	return `${bundlePath.slice(
		0,
		bundlePath.length - extension.length,
	)}${DESCRIPTOR_EXTENSION}`
}

export type PrebuiltModule = ModuleBindings & {
	// NOTE: This bundle's own Type key and value constructors, read off its
	// default export. Every Essence value carries its Type on a Symbol minted
	// when the bundle was evaluated, so the only values this Module's Functions
	// accept are the ones built here.
	bridge: RuntimeBridge
	// NOTE: The boundary itself, bound to that bridge — what `exports` was built
	// through, for a host that wants to marshal something of its own across.
	interpreter: Interpreter
	// NOTE: What was read off disk, as it was read. A host that generates
	// declarations or inspects the boundary has the same object the binding used.
	descriptor: ModuleDescriptor
}

export async function loadPrebuilt(
	bundlePath: string,
	sidecarPath: string = descriptorPath(bundlePath),
): Promise<PrebuiltModule> {
	let descriptor = await readDescriptor(sidecarPath)
	// NOTE: A URL rather than a path, because `import()` reads a specifier and a
	// Windows path is not one. The host's own Module cache keys off it, so two
	// loads of one bundle evaluate the Program inside it once.
	let namespace = (await import(pathToFileURL(bundlePath).href)) as Record<
		string,
		unknown
	>
	let bridge = runtimeBridgeOf(namespace)

	return {
		...bind(namespace, descriptor, { bridge }),
		bridge,
		interpreter: createInterpreter(bridge),
		descriptor,
	}
}

// NOTE: Checked for the one thing that tells a Descriptor from any other JSON,
// and named by the file it was read from. What follows walks this object without
// looking again, so a sidecar that is not one has to be caught where the file
// name is still known — the alternative is "cannot read properties of undefined"
// from somewhere inside the binding.
async function readDescriptor(sidecarPath: string): Promise<ModuleDescriptor> {
	let read = JSON.parse(
		await readFile(sidecarPath, "utf8"),
	) as ModuleDescriptor

	if (
		read === null ||
		typeof read !== "object" ||
		typeof read.exports !== "object"
	) {
		throw new Error(
			`'${sidecarPath}' is not a Module Descriptor — it has no 'exports'.`,
		)
	}

	return read
}
