import * as common from "./common"

export type Scope = {
	parent: Scope | null
	members: Record<string, common.Type>
}
