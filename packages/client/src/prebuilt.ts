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

// Loads a Module compiled already, a bundle and the Descriptor beside it, with
// no compiler in reach. `esc build --embed` writes the pair. Nothing here may
// import the compiler at run time, and `prebuilt.spec.ts` checks that.

// The Descriptor beside `app.js` is `app.descriptor.json`. The CLI's
// `descriptorFileName` states the same rule, and a test loads a pair it built.
const DESCRIPTOR_EXTENSION = ".descriptor.json"

export function descriptorPath(bundlePath: string): string {
	// `extname` reads the base name alone, so a dot in a directory name is not
	// an extension.
	let extension = path.extname(bundlePath)

	return `${bundlePath.slice(
		0,
		bundlePath.length - extension.length,
	)}${DESCRIPTOR_EXTENSION}`
}

export type PrebuiltModule = ModuleBindings & {
	// This bundle's Type key and value constructors. The Type key is a Symbol
	// minted when the bundle is evaluated, so its Functions accept only values
	// built through this bridge.
	bridge: RuntimeBridge
	// The interpreter bound to that bridge, for a host that marshals values of
	// its own.
	interpreter: Interpreter
	// The Descriptor as read from disk.
	descriptor: ModuleDescriptor
}

// `signal` is the host's stop, as on `LoadOptions`. It becomes the root of
// every run this binding starts.
export type PrebuiltOptions = {
	signal?: AbortSignal
}

export async function loadPrebuilt(
	bundlePath: string,
	sidecarPath: string = descriptorPath(bundlePath),
	options: PrebuiltOptions = {},
): Promise<PrebuiltModule> {
	let descriptor = await readDescriptor(sidecarPath)
	// A URL, because a Windows path is not a specifier. The host's Module cache
	// keys off it, so two loads of one bundle evaluate its Program once.
	let namespace = (await import(pathToFileURL(bundlePath).href)) as Record<
		string,
		unknown
	>
	let bridge = runtimeBridgeOf(namespace)

	return {
		...bind(namespace, descriptor, { bridge, signal: options.signal }),
		bridge,
		interpreter: createInterpreter(bridge, descriptor, {
			signal: options.signal,
		}),
		descriptor,
	}
}

// The binding walks the Descriptor without checking it, so a file that is not
// one is refused here, where its name is still known.
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
