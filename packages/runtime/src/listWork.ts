declare global {
	// Set only by a spec that counts List work. Every bundle defines it false,
	// the Compiler's and a client plugin host's, so it drops every count.
	var essenceCountsListWork: boolean | undefined
}

// How many items the natives that edit a List's runs have copied, where a spec
// counts. See "Counting a List's work" in DEVELOPMENT.md.
export const listWork = { copied: 0 }

export function countCopied(items: number): void {
	if (globalThis.essenceCountsListWork === true) {
		listWork.copied += items
	}
}
