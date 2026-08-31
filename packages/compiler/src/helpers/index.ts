// NOTE: The package boundary for `@essence-lang/compiler/helpers`. The Compiler's
// own phases import the module they actually need — `./types`, `./describe` and
// the rest — so that a file's imports say which of these concerns it depends on.
// This barrel exists for the packages OUTSIDE the Compiler, which have one
// subpath to reach rather than nine.

export {
	computeConformanceMethodMap,
	type ConformanceCheckResult,
	conformanceKey,
	type ConformanceMethodMap,
	providedMethodProtocol,
} from "./conformance"
export {
	caseDefaults,
	openArgumentHoles,
	parameterDefaults,
	recordDefaultMembers,
	recordDefaultNesting,
} from "./defaults"
export {
	choiceIdentity,
	countOf,
	describeArgumentCount,
	describeParameter,
	describeSignature,
	describeType,
	displayChoiceName,
	displayedRefinementArguments,
	displayGenericName,
	lastRequiredParameterIndex,
	requiredParameterCount,
	withArticle,
} from "./describe"
export {
	conformanceParameterName,
	isSynthesizedName,
	parameterInternalName,
} from "./names"
export {
	memberExpression,
	stripPosition,
	stripPositionFromArray,
} from "./nodes"
export {
	type PatternBinding,
	patternBindings,
	type PatternStep,
	refutablePatternMembers,
} from "./patterns"
export { bodyDefinitelyReturns } from "./returns"
export { closestMatch, editDistance } from "./suggest"
export {
	answersForBase,
	applyGenericBindings,
	type ArgumentMatchResult,
	type ArgumentPairing,
	argumentPairingInverse,
	borrowedGenericName,
	buildUnion,
	canonicalPredicateConjuncts,
	closePendingRefinementCopies,
	createFreshenedChoiceInference,
	createFreshenedInference,
	createInferenceContext,
	filterMostSpecificByTarget,
	flattenUnionMembers,
	type GenericBindings,
	type GenericInferenceContext,
	genericNamesMentioned,
	impliedConjunctKeys,
	isMergedLevel,
	isPartialOf,
	isUnitType,
	type MatchableArgument,
	matchArguments,
	matchesType,
	matchesTypeWithBindings,
	mentionsUnsolvedTypeParameter,
	mergedRecordType,
	mergeUnionMembers,
	missingRecordMembers,
	namespaceAnswersForBase,
	type NamespaceTarget,
	negatedPredicateConjunct,
	openPendingRefinementCopies,
	overloadIndexOf,
	pairArguments,
	pendingRefinementCopiesOf,
	predicateConjunctKey,
	provenConjuncts,
	refinableBaseTag,
	refinementWithTypeArguments,
	resolveOverloadedMethodName,
	resolveUnknownSlots,
	typeContainsError,
	typeContainsRefinement,
	typeContainsUnknown,
	typeMentionsGeneric,
	unfreshenBindings,
	unionMembersKeepingNames,
} from "./types"
