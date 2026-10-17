--!nocheck
-- Run from the repository root: lune run plugin/tests/mesh_apply.luau
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local roblox = require("@lune/roblox")

local source = ""
for _, file in ipairs({ "util/assets", "patch/mesh", "patch/apply_mesh" }) do
	source ..= fs.readFile("plugin/src/" .. file .. ".luau") .. "\n"
end
source ..= "\nreturn { run = runMeshApplyRequest, normalize = normalizeMeshApplyRequest }\n"

local function equal(actual: any, expected: any): ()
	assert(
		actual == expected,
		string.format("Expected %s, got %s", tostring(expected), tostring(actual))
	)
end

local function instance(className: string, name: string, parent: any): any
	local values = { ClassName = className, Name = name, children = {} }
	local obj = setmetatable({}, {
		__index = values,
		__newindex = function(self: any, key: string, value: any): ()
			if key == "Parent" then
				if values.Parent then
					local index = table.find(values.Parent.children, self)
					if index then
						table.remove(values.Parent.children, index)
					end
				end
				if value then
					table.insert(value.children, self)
				end
			end
			values[key] = value
		end,
	})
	function obj:IsA(query: string): boolean
		return className == query
	end
	function obj:GetChildren(): { any }
		return table.clone(values.children)
	end
	function obj:FindFirstChild(childName: string): any
		for _, child in ipairs(values.children) do
			if child.Name == childName then
				return child
			end
		end
		return nil
	end
	function obj:GetPivot(): any
		return values.pivot
	end
	function obj:Destroy(): ()
		self.Parent = nil
		self.destroyed = true
	end
	function obj:ApplyMesh(mesh: any): ()
		if values.applyError then
			error(values.applyError)
		end
		for _, property in ipairs({
			"MeshId",
			"TextureID",
			"MeshSize",
			"CollisionFidelity",
			"RenderFidelity",
			"FluidFidelity",
		}) do
			self[property] = mesh[property]
		end
		self.applyCount = (values.applyCount or 0) + 1
	end
	obj.Parent = parent
	return obj
end

local function fixture(): any
	local f = { calls = {}, temporaries = {}, waits = {}, running = false, edit = true }
	f.game = instance("DataModel", "game", nil)
	f.workspace = instance("Workspace", "Workspace", f.game)
	f.model = instance("Model", "Model", f.workspace)
	f.model.pivot = roblox.CFrame.new(7, 8, 9)
	f.part = instance("MeshPart", "Mesh", f.model)
	f.part.MeshId = "rbxassetid://123456789"
	f.part.TextureID = ""
	f.part.MeshSize = roblox.Vector3.new(1, 2, 3)
	f.part.Size = roblox.Vector3.new(4, 5, 6)
	f.part.CFrame = roblox.CFrame.new(10, 20, 30)
	f.part.Color = roblox.Color3.fromRGB(123, 45, 67)
	f.part.Material = roblox.Enum.Material.Neon
	f.part.MaterialVariant = "CustomMaterial"
	f.part.CanCollide = false
	f.part.CastShadow = false
	f.part.Anchored = true
	f.part.Transparency = 0.25
	f.part.CollisionFidelity = roblox.Enum.CollisionFidelity.Hull
	f.part.RenderFidelity = roblox.Enum.RenderFidelity.Precise
	f.part.FluidFidelity = roblox.Enum.FluidFidelity.Automatic
	f.attachment = instance("Attachment", "Attachment", f.part)
	f.light = instance("PointLight", "Light", f.part)
	f.particles = instance("ParticleEmitter", "Particles", f.attachment)
	f.externalReference = f.part
	f.api = luau.load(source, {
		debugName = "mesh apply under test",
		environment = {
			game = f.game,
			SERVICES_TO_SCAN = { "Workspace", "ReplicatedStorage" },
			Content = {
				fromUri = function(uri: string): any
					return { Uri = uri }
				end,
			},
			RunService = {
				IsRunning = function(): boolean
					return f.running
				end,
				IsEdit = function(): boolean
					return f.edit
				end,
			},
			AssetService = {
				CreateMeshPartAsync = function(_self: any, content: any, options: any): any
					table.insert(f.calls, { uri = content.Uri, options = options })
					if f.load then
						f.load()
					end
					local mesh = instance("MeshPart", "LoadedMesh", nil)
					mesh.MeshId = content.Uri
					mesh.TextureID = "rbxassetid://111222333"
					mesh.MeshSize = roblox.Vector3.new(11, 12, 13)
					mesh.Size = mesh.MeshSize
					for key, value in pairs(options) do
						mesh[key] = value
					end
					table.insert(f.temporaries, mesh)
					return mesh
				end,
			},
			ChangeHistoryService = {
				TryBeginRecording = function(): string
					return "recording"
				end,
				FinishRecording = function(): ()
					f.recorded = true
				end,
			},
			Enum = roblox.Enum,
			task = {
				wait = function(duration: number?): ()
					table.insert(f.waits, duration or 0)
				end,
			},
			logToPlugin = function(): () end,
		},
	})()
	function f.request(path: string?, name: string?): any
		return {
			operationId = "12345678-1234-1234-1234-123456789012",
			meshId = "987654321",
			instancePath = path or "Workspace.Model.Mesh",
			meshPartName = name,
		}
	end
	function f.run(request: any?): any
		return f.api.run(request or f.request())
	end
	return f
end

local passed = 0
local function test(name: string, callback: () -> ()): ()
	callback()
	passed += 1
	print("PASS " .. name)
end

test(
	"ApplyMesh preserves identity, visual and physical properties, and child references",
	function()
		local f = fixture()
		local before = {}
		for _, key in ipairs({
			"CFrame",
			"Size",
			"Color",
			"Material",
			"MaterialVariant",
			"CanCollide",
			"CastShadow",
			"Anchored",
			"Transparency",
			"TextureID",
			"CollisionFidelity",
			"RenderFidelity",
			"FluidFidelity",
		}) do
			before[key] = f.part[key]
		end
		local result = f.run()
		assert(result.success, result.error)
		for key, value in pairs(before) do
			equal(f.part[key], value)
		end
		equal(f.part.MeshId, "rbxassetid://987654321")
		equal(f.part.applyCount, 1)
		equal(f.model:FindFirstChild("Mesh"), f.part)
		equal(f.externalReference, f.part)
		equal(f.attachment.Parent, f.part)
		equal(f.light.Parent, f.part)
		equal(f.particles.Parent, f.attachment)
		equal(#f.part:GetChildren(), 2)
		equal(f.temporaries[1].destroyed, true)
		equal(result.created, false)
		equal(f.recorded, true)
	end
)

test("preserveSize false uses loaded mesh bounds", function()
	local f = fixture()
	local request = f.request()
	request.preserveSize = false
	assert(f.run(request).success)
	equal(f.part.Size, roblox.Vector3.new(11, 12, 13))
	equal(f.part.CFrame, roblox.CFrame.new(10, 20, 30))
end)

test("Model creation uses the model pivot and asset bounds", function()
	local f = fixture()
	local result = f.run(f.request("game.Workspace.Model", "Created"))
	assert(result.success, result.error)
	local created = f.model:FindFirstChild("Created")
	equal(created.ClassName, "MeshPart")
	equal(created.CFrame, f.model.pivot)
	equal(created.Size, roblox.Vector3.new(11, 12, 13))
	equal(result.instancePath, "game.Workspace.Model.Created")
	equal(result.created, true)
	equal(f.part.MeshId, "rbxassetid://123456789")
	equal(created.destroyed, nil)
end)

test("invalid request fields fail before loading assets", function()
	for key, value in pairs({
		meshId = "https://example.com/mesh",
		instancePath = "Workspace..Mesh",
		meshPartName = "Name.With.Dot",
		operationId = "invalid",
		preserveSize = "false",
	}) do
		local f = fixture()
		local request = f.request()
		request[key] = value
		assert(not f.run(request).success, key)
		equal(#f.calls, 0)
	end
end)

test("invalid paths, unsupported targets and name collisions do not mutate", function()
	for _, request in ipairs({
		{ "Workspace.Missing" },
		{ "Players.Player" },
		{ "Workspace.Model" },
		{ "Workspace.Model", "Mesh" },
		{ "Workspace.Model.Mesh", "Name" },
		{ "Workspace.Model.Mesh.Attachment" },
	}) do
		local f = fixture()
		assert(not f.run(f.request(request[1], request[2])).success)
		equal(#f.calls, 0)
		equal(f.part.MeshId, "rbxassetid://123456789")
	end
	local f = fixture()
	instance("MeshPart", "Mesh", f.model)
	local result = f.run()
	assert(not result.success and string.find(result.error, "ambiguous"))
	equal(#f.calls, 0)
end)

test("asset loading retries rate limits and reports permission errors", function()
	local f = fixture()
	f.load = function(): ()
		if #f.calls < 3 then
			error("429 Too many requests")
		end
	end
	assert(f.run().success)
	equal(#f.calls, 3)
	equal(f.waits[2], 5)
	equal(f.waits[3], 5)
	local denied = fixture()
	denied.load = function(): ()
		error("Asset permission denied")
	end
	local result = denied.run()
	assert(not result.success and string.find(result.error, "permission denied"))
	equal(#denied.calls, 1)
	equal(denied.part.MeshId, "rbxassetid://123456789")
end)

test("stale references, moved targets and leaving Edit mode abort before ApplyMesh", function()
	for _, change in ipairs({ "mesh", "texture", "parent", "ancestor", "duplicate", "mode" }) do
		local f = fixture()
		f.load = function(): ()
			if change == "mesh" then
				f.part.MeshId = "rbxassetid://111222333"
			elseif change == "texture" then
				f.part.TextureID = "rbxassetid://111222333"
			elseif change == "parent" then
				f.part.Parent = f.workspace
			elseif change == "ancestor" then
				f.model.Parent = instance("Folder", "Moved", f.workspace)
			elseif change == "duplicate" then
				instance("MeshPart", "Mesh", f.model)
			else
				f.running = true
			end
		end
		assert(not f.run().success, change)
		equal(f.part.applyCount, nil)
		equal(f.temporaries[1].destroyed, true)
	end
end)

test("ApplyMesh errors keep the original part and dispose of the loaded mesh", function()
	local f = fixture()
	f.part.applyError = "Mesh application is unavailable"
	local result = f.run()
	assert(not result.success and string.find(result.error, "unavailable"))
	equal(f.part.MeshId, "rbxassetid://123456789")
	equal(f.part.Parent, f.model)
	equal(f.attachment.Parent, f.part)
	equal(f.temporaries[1].destroyed, true)
end)

test("Model races destroy the unparented loaded mesh", function()
	for _, change in ipairs({ "name", "target", "mode" }) do
		local f = fixture()
		f.load = function(): ()
			if change == "name" then
				instance("Folder", "Created", f.model)
			elseif change == "target" then
				f.model.Parent = nil
				instance("Model", "Model", f.workspace)
			else
				f.edit = false
			end
		end
		assert(not f.run(f.request("Workspace.Model", "Created")).success, change)
		equal(f.temporaries[1].destroyed, true)
	end
end)

test("mesh commands refuse Play and Run before loading", function()
	for _, mode in ipairs({ "play", "run", "notEdit" }) do
		local f = fixture()
		f.running = mode ~= "notEdit"
		f.edit = false
		assert(not f.run().success)
		equal(#f.calls, 0)
	end
end)

local function expanded(path: string): string
	local directory = string.match(path, "^(.*)/")
	local lines = {}
	for line in string.gmatch(fs.readFile(path), "[^\n]*\n?") do
		local relative = string.match(line, '^%-%-#include%s+"([^"\n]+)"')
		table.insert(lines, if relative then expanded(directory .. "/" .. relative) else line)
	end
	return table.concat(lines)
end

test("expanded plugin exits silently in Play and Run before any initialization", function()
	local pluginSource = expanded("plugin/plugin.luau")
	for _, mode in ipairs({ "playClient", "playServer", "run", "notEdit", "edit" }) do
		local services, prints = {}, 0
		local function unexpected(): ()
			prints += 1
			error("Plugin initialization reached")
		end
		local start = luau.load(pluginSource, {
			debugName = "Edit-only expanded plugin / " .. mode,
			environment = {
				game = {
					GetService = function(_self: any, service: string): any
						table.insert(services, service)
						if service ~= "RunService" then
							error("Reached Edit initialization")
						end
						return {
							IsRunning = function(): boolean
								return mode ~= "edit" and mode ~= "notEdit"
							end,
							IsEdit = function(): boolean
								return mode == "edit"
							end,
						}
					end,
				},
				plugin = { CreateToolbar = unexpected },
				print = unexpected,
				warn = unexpected,
				task = { spawn = unexpected },
			},
		})
		local ok, err = pcall(start)
		if mode == "edit" then
			assert(not ok and string.find(tostring(err), "Reached Edit initialization"))
			equal(services[2], "AssetService")
		else
			assert(ok, tostring(err))
			equal(#services, 1)
		end
		equal(prints, 0)
	end
end)

print(string.format("%d mesh application and Edit-only tests passed", passed))
