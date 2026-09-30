--!nocheck
--!nolint
-- luacheck: ignore
---@diagnostic disable: undefined-global, unused-local, unused-function, lowercase-global

type Record = {
	token: string,
	className: string,
	name: string,
	fullName: string,
	property: string,
	value: string,
}

type PatchAction =
	"setProperty"
	| "replaceEmotes"
	| "replaceAccessories"
	| "replaceTags"
	| "replaceAttribute"
	| "replaceScriptSource"
	| "replaceMeshPart"
	| "replaceAnimationClip"

type Patch = {
	token: string,
	fullName: string?,
	action: PatchAction,
	property: string,
	value: any,
	meshId: string?,
	textureId: string?,
	animationMode: string?,
	expectedValue: string?,
	operationId: string?,
}
