// NOTE: The Rewriter turns a simplified Program into JavaScript. This barrel is
// the phase's name; `./rewrite` is the phase itself.
export {
	BUNDLE_TARGET,
	checkEssenceMethodsAreDeclared,
	type EmitTarget,
	emitTargetKey,
	emittedIdentity,
	escapeName,
	type EssenceMember,
	essenceMemberBands,
	type EssenceMemberReferences,
	essenceMethodReferences,
	type ModuleInput,
	namespaceMemberName,
	orderEssenceMembers,
	type PreludeReach,
	reachableEssenceMethods,
	rewrite,
	rewriteModules,
	RUNTIME_PACKAGE,
	runtimeNamespaceNames,
	type SourceMapOptions,
} from "./rewrite"
