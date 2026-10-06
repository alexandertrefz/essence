import type * as common from "./common/index"

// A Namespace another Module of the graph exports and this one does not
// import, with the specifier an import of it would write.
export type UnimportedNamespace = {
	name: string
	specifier: string
	modulePath: string
	namespace: common.NamespaceType
}

// A Module that publishes a Protocol under the name asked for. `declares` is
// false where the Module declares it under another name. `exportedAs` is null
// where the Module declares it but keeps it private.
export type ProtocolDeclaration = {
	modulePath: string
	declares: boolean
	exportedAs: string | null
}

// A `parser.AbandonedDeclaration` as the enricher reads it. Where `hoists` is
// false, a read of the name is silenced only inside `enclosing` and after
// `position`.
export type AbandonedDeclaration = {
	name: string
	position: common.Position
	enclosing: common.Position
	hoists: boolean
}

// A position a `complete` can not be written in, named so a report can say
// which. See "Barriers" in DEVELOPMENT.md.
export type CompletionBarrier =
	| "parameter-default"
	| "test-name"
	| "benchmark-body"
	| "property-body"

export type Scope = {
	parent: Scope | null
	members: Record<string, common.Type>
	// Where each name in `members` was declared. A builtin has no source and
	// no entry.
	declarations: Record<string, common.Position>
	// The names in `members` that can not be reassigned.
	constants: Set<string>
	// The names in `constants` a `constant` Declaration wrote, the only ones a
	// refused assignment may ask to be declared with `variable` instead.
	writtenConstants?: Set<string>
	// What each Constant of a Program's top level was given, read by Case
	// payload defaults. Absent on every other Scope. See "Constant values" in
	// DEVELOPMENT.md.
	constantValues?: Record<string, common.typed.ExpressionNode>
	types: Record<string, common.Type>
	// Apart from `types`, because a Protocol is not a Type and a Type
	// position refuses a Protocol's name with a Diagnostic of its own.
	protocols: Record<string, common.ProtocolType>
	// Every Protocol the compile declared, by identity, so a stored identity
	// reads back where no name binds it. One Map serves every Module of a graph.
	protocolRegistry?: Map<string, common.ProtocolType>
	// Set on a Program's top level Scope. A Protocol declared in any other
	// Scope carries its Position in its identity.
	programTop?: true
	// The canonical path of the Module, which a Choice declared in it takes
	// its identity from. Absent for a Program that is no Module, whose Choices
	// are identified by name alone.
	modulePath?: string
	// A function rather than an Array, because only a Diagnostic reads it and
	// the answer walks every dependency's export surface. Absent for a Program
	// that is no Module.
	unimportedNamespaces?: () => Array<UnimportedNamespace>
	// Every Module this one reaches that publishes a Protocol of this name,
	// asked when a bound names a Protocol out of sight. Absent for a Program
	// that is no Module.
	protocolDeclarations?: (name: string) => Array<ProtocolDeclaration>
	// The Types a Module of the graph exports, by public name, or null for a
	// Module the link has no surface for. Asked by a Help that offers an
	// import. Absent for a Program that is no Module.
	exportedTypes?: (modulePath: string) => Record<string, common.Type> | null
	// The Types a Module of the graph binds at its top level, private ones
	// included. Null for a Module the link has no surface for. Asked by a Help
	// about a Choice no name here binds. Absent for a Program that is no Module.
	moduleTypes?: (modulePath: string) => Record<string, common.Type> | null
	// The Type a `<-` here is expected to produce, which a bare Case such as
	// `<- #Less` resolves against first. `null` is a barrier. See "Barriers" in
	// DEVELOPMENT.md.
	expectedReturnType?: common.Type | null
	// Whether a `complete` may be written here, and the Type it is held to.
	// `null` is a barrier. See "Barriers" in DEVELOPMENT.md.
	completing?: common.Type | "top-level" | null
	// Which barrier a `completing: null` on the same Scope is.
	completingBarrier?: CompletionBarrier
	// The Namespace this Scope stands inside, read through the parent chain.
	// No name resolves through it. A report about an unknown name asks whether
	// the Namespace declares one.
	// INVARIANT: a Scope that declares a Namespace's Type Parameter carries
	// the Namespace, since `namespaceDeclaringGeneric` asks only that Scope.
	namespace?: { name: string; type: common.NamespaceType }
	// The Namespace Method whose body this Scope is, read through the parent
	// chain. A `where` on a conformance answers a bound only for a Method that
	// fulfils that conformance.
	methodName?: string
	// A barrier for `@`. See "Barriers" in DEVELOPMENT.md.
	isStaticMethodBody?: boolean
	// Set on a Match Handler's body, whose `@` is the value matched rather
	// than a receiver. A report about an unknown name reads it to say which `@`
	// stands here.
	isMatchHandlerBody?: boolean
	// Set on the Scope a refinement's predicate is read in, where every call
	// asks a Method of `@`. A report reads it to offer only edits that fit.
	isRefinementPredicate?: true
	// The identity of the Protocol whose provided Method this Scope is the
	// body of. The body is emitted once, outside every Program that reaches it,
	// so the name walk reports a name of the Program read from inside it.
	providedMethodOf?: string
	// The names the emitted prelude binds, taken on the top level Scope
	// before the Program's own declarations join the same `members` table.
	// Absent while the standard library itself loads, since it is the prelude.
	preludeNames?: ReadonlySet<string>
	// The prelude's Protocols, which tell a standard library Protocol from one
	// a single file declares.
	preludeProtocols?: ReadonlySet<string>
	// What the Parser abandoned, set on the top level Scope. A read of a name
	// whose Declaration was dropped resolves to an Error without a Diagnostic,
	// so one syntax error reports once. Absent where the Parser dropped nothing.
	abandonedDeclarations?: ReadonlyArray<AbandonedDeclaration>
	// Every name the Parameter list binds, and which default is being read.
	// See "Barriers" in DEVELOPMENT.md.
	parameterDefaultBarrier?: {
		names: ReadonlyMap<string, BarredParameterName>
		index: number
	}
	// Names a Matcher's bindings lend their Guard as members of `@`. See
	// "Names that stand for a member of `@`" in DEVELOPMENT.md.
	selfMemberAliases?: Record<
		string,
		{
			path: Array<string>
			stepPositions: Array<common.Position>
			selfType: common.Type
		}
	>
}

// A name a Parameter list binds, as a default sees it. A Pattern binding is
// barred wherever it was written. A Parameter is barred only from its own
// default and the defaults to its left.
export type BarredParameterName = {
	kind: "parameter" | "pattern"
	index: number
	position: common.Position
}
