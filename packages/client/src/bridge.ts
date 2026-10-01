import type { RuntimeBridge } from "@essence-lang/compiler/embed/bridge"

// Reads the runtime bridge back off an imported bundle, which needs no
// compiler. The compiler writes the bridge in `@essence-lang/compiler/embed/bridge`.
// It is the bundle's default export, so this side keeps no table of names that
// could disagree with the one the bundle was written from.
export type {
	EssenceValue,
	FutureContext,
	RuntimeBridge,
} from "@essence-lang/compiler/embed/bridge"

export function runtimeBridgeOf(
	namespace: Record<string, unknown>,
): RuntimeBridge {
	let bridge = namespace.default

	// Only the Type key is checked. No other kind of default export carries
	// one, and a bridge missing a later member would be a compiler bug.
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
