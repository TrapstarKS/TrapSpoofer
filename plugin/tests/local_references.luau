--!nocheck
-- Run from the repository root: lune run plugin/tests/local_references.luau
local fs = require("@lune/fs")
local luau = require("@lune/luau")

local source = ""
for _, file in ipairs({
	"types/assets",
	"state/registry",
	"util/assets",
	"patch/mesh",
	"patch/patcher",
	"bridge/polling",
}) do
	source ..= fs.readFile("plugin/src/" .. file .. ".luau") .. "\n"
end
source ..= [[
return {
	apply = applyPatch,
	register = registerObject,
	normalize = normalizePatch,
	contains = stringContainsAssetReference,
	pollUrl = getPollUrl,
}
]]

local original = "rbxasset://textures/face.png"
local uploaded = "rbxassetid://987654321"
local meshOriginal = "rbxasset://models/body.mesh"
local meshUploaded = "rbxassetid://123456789"
local createdMeshes = {}
local changeDuringLoad: (() -> ())? = nil
local nextId = 0
local api = luau.load(source, {
	debugName = "local reference patching",
	environment = {
		typeof = function(value: any): string
			return if type(value) == "table" and value.isContent then "Content" else typeof(value)
		end,
		Content = {
			fromUri = function(uri: string): any
				return { Uri = uri, isContent = true }
			end,
		},
		game = {
			PlaceId = 123,
			Name = "Test Place",
			CreatorType = { Name = "Group" },
			CreatorId = 456,
		},
		HttpService = {
			GenerateGUID = function(): string
				nextId += 1
				return tostring(nextId)
			end,
			UrlEncode = function(_self: any, value: string): string
				return (string.gsub(value, " ", "%%20"))
			end,
		},
		AssetService = {
			CreateMeshPartAsync = function(_self: any, content: any): any
				if changeDuringLoad then
					changeDuringLoad()
				end
				local temporary = {
					uri = content.Uri,
					IsA = function(_obj: any, className: string): boolean
						return className == "MeshPart"
					end,
					Destroy = function(obj: any): ()
						obj.destroyed = true
					end,
				}
				table.insert(createdMeshes, temporary)
				return temporary
			end,
		},
		RunService = {
			IsRunning = function(): boolean
				return false
			end,
			IsEdit = function(): boolean
				return true
			end,
		},
		task = { wait = function(): () end },
		logToPlugin = function(): () end,
	},
})()

local function object(className: string): any
	return {
		Parent = {},
		Name = "Target",
		ClassName = className,
		IsA = function(_self: any, query: string): boolean
			return query == className
				or (query == "LuaSourceContainer" and className == "ModuleScript")
		end,
		GetFullName = function(): string
			return "Workspace.Target"
		end,
		ApplyMesh = function(self: any, mesh: any): ()
			self.MeshId = mesh.uri
		end,
	}
end

local function apply(obj: any, raw: any): (boolean, string?)
	raw.token = api.register(obj)
	local patch, err = api.normalize(raw)
	assert(patch, err)
	return api.apply(patch)
end

for _, property in ipairs({
	"TextureID",
	"TextureId",
	"Texture",
	"ColorMap",
	"ShirtTemplate",
	"PantsTemplate",
	"Image",
	"MeshId",
}) do
	local obj = object("SpecialMesh")
	obj[property] = original
	local ok, err = apply(
		obj,
		{ action = "setProperty", property = property, value = uploaded, expectedValue = original }
	)
	assert(ok, err)
	assert(obj[property] == uploaded, property)
	assert(apply(obj, {
		action = "setProperty",
		property = property,
		value = uploaded,
		expectedValue = original,
	}))
	obj[property] = "rbxasset://textures/user-edit.png"
	local staleOk = apply(
		obj,
		{ action = "setProperty", property = property, value = uploaded, expectedValue = original }
	)
	assert(not staleOk, "stale property must be rejected")
end

local contentObj = object("SpecialMesh")
contentObj.MeshContent = { Uri = meshOriginal, isContent = true }
assert(apply(contentObj, {
	action = "setProperty",
	property = "MeshContent",
	value = meshUploaded,
	expectedValue = meshOriginal,
}))
assert(contentObj.MeshContent.Uri == meshUploaded and contentObj.MeshContent.isContent)

local scriptObj = object("ModuleScript")
scriptObj.Source = "return Content.fromUri('" .. original .. "')"
local originalSource = scriptObj.Source
local replacedSource = "return Content.fromUri('" .. uploaded .. "')"
assert(
	apply(
		scriptObj,
		{ action = "replaceScriptSource", value = replacedSource, expectedValue = originalSource }
	)
)
assert(scriptObj.Source == replacedSource)
assert(
	apply(
		scriptObj,
		{ action = "replaceScriptSource", value = replacedSource, expectedValue = originalSource }
	)
)
scriptObj.Source = "return 'user edit'"
assert(
	not apply(
		scriptObj,
		{ action = "replaceScriptSource", value = replacedSource, expectedValue = originalSource }
	)
)

local meshObj = object("MeshPart")
meshObj.MeshId = meshOriginal
meshObj.TextureID = original
local meshPatch = {
	action = "replaceMeshPart",
	meshId = "123456789",
	textureId = "987654321",
	expectedMeshId = meshOriginal,
	expectedTextureId = original,
}
assert(apply(meshObj, meshPatch))
assert(meshObj.MeshId == meshUploaded and meshObj.TextureID == uploaded)
assert(#createdMeshes == 1 and createdMeshes[1].destroyed)
assert(apply(meshObj, meshPatch))
assert(#createdMeshes == 1, "repeated mesh aliases must not load another mesh")
meshObj.MeshId = "rbxasset://models/user-edit.mesh"
assert(not apply(meshObj, meshPatch))
assert(#createdMeshes == 1, "stale mesh must be rejected before loading")

meshObj.MeshId = meshOriginal
meshObj.TextureID = original
changeDuringLoad = function(): ()
	meshObj.TextureID = "rbxasset://textures/user-edit.png"
end
assert(not apply(meshObj, meshPatch))
assert(meshObj.MeshId == meshOriginal and meshObj.TextureID == "rbxasset://textures/user-edit.png")
assert(createdMeshes[2].destroyed, "temporary mesh must be released after a concurrent edit")

local function aliasObject(
	className: string,
	properties: { string },
	initialUri: string
): (any, () -> number)
	local currentUri = initialUri
	local writes = 0
	local aliases = {}
	for _, property in ipairs(properties) do
		aliases[property] = true
	end
	local obj = setmetatable(object(className), {
		__index = function(_self: any, property: string): any
			if not aliases[property] then
				return nil
			end
			return if string.sub(property, -7) == "Content"
				then { Uri = currentUri, isContent = true }
				else currentUri
		end,
		__newindex = function(self: any, property: string, value: any): ()
			if aliases[property] then
				currentUri = if type(value) == "table" then value.Uri else value
				writes += 1
			else
				rawset(self, property, value)
			end
		end,
	})
	return obj, function(): number
		return writes
	end
end

for _, fixture in ipairs({
	{
		className = "Decal",
		properties = { "Texture", "ColorMap", "ColorMapContent", "TextureContent" },
	},
	{ className = "SpecialMesh", properties = { "MeshId", "MeshContent" } },
}) do
	local obj, writes = aliasObject(fixture.className, fixture.properties, original)
	for _, property in ipairs(fixture.properties) do
		assert(apply(obj, {
			action = "setProperty",
			property = property,
			value = uploaded,
			expectedValue = original,
		}))
	end
	assert(writes() == 1, fixture.className .. " aliases must share one successful mutation")
end

for _, timing in ipairs({ "before", "during" }) do
	changeDuringLoad = nil
	local obj = aliasObject("MeshPart", { "TextureID", "TextureContent" }, original)
	obj.MeshId = meshOriginal
	local function updateTextureAlias(): ()
		assert(apply(obj, {
			action = "setProperty",
			property = "TextureContent",
			value = uploaded,
			expectedValue = original,
		}))
	end
	if timing == "before" then
		updateTextureAlias()
	else
		changeDuringLoad = updateTextureAlias
	end
	local meshCount = #createdMeshes
	local ok, err = apply(obj, meshPatch)
	assert(ok, err)
	assert(obj.MeshId == meshUploaded and obj.TextureID == uploaded)
	assert(#createdMeshes == meshCount + 1 and createdMeshes[#createdMeshes].destroyed)
end

local editedMesh = aliasObject("MeshPart", { "TextureID", "TextureContent" }, original)
editedMesh.MeshId = meshOriginal
changeDuringLoad = function(): ()
	editedMesh.TextureContent = { Uri = "rbxasset://textures/user-edit.png", isContent = true }
end
assert(not apply(editedMesh, meshPatch))
assert(editedMesh.MeshId == meshOriginal)
assert(editedMesh.TextureID == "rbxasset://textures/user-edit.png")
assert(createdMeshes[#createdMeshes].destroyed)

changeDuringLoad = nil
for _, replacement in ipairs({
	{ meshId = "123456789", textureId = "987654321" },
	{ meshId = "123456789" },
	{ textureId = "987654321" },
}) do
	local obj = object("MeshPart")
	obj.MeshId = "rbxassetid://444555666"
	obj.TextureID = "rbxassetid://555666777"
	local meshCount = #createdMeshes
	local ok, err = apply(obj, {
		action = "replaceMeshPart",
		meshId = replacement.meshId,
		textureId = replacement.textureId,
	})
	assert(ok, err)
	assert(obj.MeshId == (if replacement.meshId then meshUploaded else "rbxassetid://444555666"))
	assert(obj.TextureID == (if replacement.textureId then uploaded else "rbxassetid://555666777"))
	assert(#createdMeshes == meshCount + (if replacement.meshId then 1 else 0))
	if replacement.meshId then
		assert(createdMeshes[#createdMeshes].destroyed)
	end
end

assert(api.contains(original), "local assets must survive property scanning")
assert(
	api.pollUrl()
		== "/poll?place_id=123&place_name=Test%20Place&creator_type=Group&creator_id=456&mesh_apply=true"
)
print("PASS local property, Content, script, mesh, stale scan and owner polling checks")
