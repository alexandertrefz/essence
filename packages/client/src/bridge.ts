import type { RuntimeBridge } from "@essence-lang/compiler/embed/bridge"

// NOTE: The bridge read back off an imported bundle — the half of it that needs
// no Compiler, and so the half that may be imported by a path that must not have
// one. Putting a bridge INTO a bundle is emit-time work and lives in the
// Compiler, at `@essence-lang/compiler/embed/bridge`, which says why a bundle
// carries one at all.
//
// NOTE: One name to read, because the bridge is the bundle's DEFAULT export.
// That is what keeps this side free of the table the other side is written out
// of: a second copy of which Function is bound under which name is the only way
// the two could ever come apart, and there is no second copy of one name.
export type {
	EssenceValue,
	RuntimeBridge,
} from "@essence-lang/compiler/embed/bridge"

export function runtimeBridgeOf(
	namespace: Record<string, unknown>,
): RuntimeBridge {
	let bridge = namespace.default

	// NOTE: The Type key is what is checked, rather than every member in turn: it
	// is the one member no other kind of default export would carry, and a
	// missing member past it would be a Compiler bug rather than a bundle built
	// some other way. Saying so out loud beats a `TypeError` about `undefined`
	// from whichever constructor a caller happened to reach for first.
	if (
		bridge === null ||
		typeof bridge !== "object" ||
		typeof (bridge as RuntimeBridge).typeKey !== "symbol"
	) {
		throw new Error(
			"This bundle exports no runtime bridge — it was not built for " +
				"embedding. Compile it through `loadModule`, the bundler " +
				"plugin, or `esc build --embed`.",
		)
	}

	return bridge as RuntimeBridge
}
