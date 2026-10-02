--!nocheck
-- Run from the repository root: lune run plugin/tests/animation_patcher.luau
-- Uses Lune's native instance model; the animation provider never makes network calls.
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local roblox = require("@lune/roblox")
local Instance = roblox.Instance

local sourceCode = fs.readFile("plugin/src/types/assets.luau")
	.. "\n"
	.. fs.readFile("plugin/src/state/registry.luau")
	.. "\n"
	.. fs.readFile("plugin/src/patch/patcher.luau")
	.. [[
return {
	apply = applyPatch,
	register = registerObject,
	get = getRegisteredObject,
	reset = resetObjectRegistry,
	clear = clearAnimationClipCache,
}
]]

local ORIGINAL = "123456789"
local UPLOADED = "987654321"
local ORIGINAL_URI = "rbxassetid://" .. ORIGINAL
local UPLOADED_URI = "rbxassetid://" .. UPLOADED

local function equal(actual, expected)
	assert(
		actual == expected,
		string.format("Expected %s, got %s", tostring(expected), tostring(actual))
	)
end

local function newInstance(className, name, parent)
	local instance = Instance.new(className)
	instance.Name = name or className
	instance.Parent = parent
	return instance
end

local function nativeClip(className)
	local clip = newInstance(className, "OriginalClip")
	clip.Loop = true
	clip.Priority = roblox.Enum.AnimationPriority.Action
	clip:SetAttribute("NativeMetadata", "keep")
	clip:AddTag("NativeTag")
	if className == "KeyframeSequence" then
		local frame = newInstance("Keyframe", "Frame", clip)
		frame.Time = 0.375
		local pose = newInstance("Pose", "Root", frame)
		pose.CFrame = roblox.CFrame.new(1, 2, 3)
		pose.Weight = 0.625
		local marker = newInstance("KeyframeMarker", "Event", frame)
		marker.Value = "keep marker"
	else
		local channel = newInstance("Folder", "Root", clip)
		newInstance("FloatCurve", "X", channel):SetAttribute("ChannelMetadata", "keep curve")
	end
	return clip
end

local function fixture(className)
	local result = {
		calls = {},
		source = nativeClip(className or "KeyframeSequence"),
		root = newInstance("Folder", "Workspace"),
	}
	result.animation = newInstance("Animation", "Run", result.root)
	result.animation.AnimationId = ORIGINAL_URI
	result.animation:SetAttribute("AnimationMetadata", "keep animation")
	result.animation:AddTag("AnimationTag")
	result.attachment = newInstance("Folder", "Settings", result.animation)
	newInstance("StringValue", "Config", result.attachment).Value = "keep config"
	local guid = 0
	result.api = luau.load(sourceCode, {
		debugName = "animation patcher under test",
		environment = {
			game = {
				GetService = function(_, service)
					equal(service, "AnimationClipProvider")
					return {
						GetAnimationClipAsync = function(_, uri)
							table.insert(result.calls, uri)
							if result.load then
								return result.load(uri)
							end
							return result.source
						end,
					}
				end,
			},
			HttpService = {
				GenerateGUID = function()
					guid += 1
					return tostring(guid)
				end,
			},
			CollectionService = {
				GetTags = function(_, obj)
					return obj:GetTags()
				end,
				AddTag = function(_, obj, tag)
					if result.addTag then
						result.addTag(obj, tag)
					end
					obj:AddTag(tag)
				end,
				RemoveTag = function(_, obj, tag)
					obj:RemoveTag(tag)
				end,
			},
			task = { wait = function() end },
			logToPlugin = function() end,
		},
	})()
	result.token = result.api.register(result.animation)
	function result.patch(mode)
		return {
			token = result.token,
			action = if mode == "animation" then "setProperty" else "replaceAnimationClip",
			property = "AnimationId",
			expectedValue = ORIGINAL_URI,
			value = UPLOADED_URI,
			animationMode = mode,
		}
	end
	function result.apply(mode)
		return result.api.apply(result.patch(mode))
	end
	return result
end

local passed = 0
local failed = 0
local function test(name, callback)
	local ok, err = pcall(callback)
	if ok then
		passed += 1
		print("PASS " .. name)
	else
		failed += 1
		warn("FAIL " .. name .. ": " .. tostring(err))
	end
end

local function success(ok, err)
	assert(ok, tostring(err))
end

for _, className in ipairs({ "KeyframeSequence", "CurveAnimation" }) do
	for _, mode in ipairs({ "animation", "clip_replace", "clip_parent", "clip_parent_id" }) do
		test(className .. " / " .. mode, function()
			local f = fixture(className)
			local sourceBefore = roblox.serializeModel({ f.source })
			success(f.apply(mode))
			if mode == "animation" then
				equal(f.animation.AnimationId, UPLOADED_URI)
				equal(f.animation.Parent, f.root)
				equal(#f.calls, 0)
			else
				local clip = f.root:GetChildren()[1]
				equal(#f.root:GetChildren(), 1)
				equal(clip.ClassName, className)
				equal(clip.Name, "Run")
				equal(clip.Loop, true)
				equal(clip.Priority, f.source.Priority)
				equal(clip:GetAttribute("NativeMetadata"), "keep")
				equal(clip:GetAttribute("AnimationMetadata"), "keep animation")
				assert(table.find(clip:GetTags(), "NativeTag"))
				assert(table.find(clip:GetTags(), "AnimationTag"))
				equal(f.calls[1], ORIGINAL_URI)
				equal(#f.calls, 1)
				if mode == "clip_replace" then
					equal(f.api.get(f.token), clip)
					equal(f.attachment.Parent, clip)
					equal(clip:GetAttribute("TrapSpooferClipContainer"), false)
				else
					equal(f.api.get(f.token), f.animation)
					equal(f.animation.Parent, clip)
					equal(f.attachment.Parent, f.animation)
					equal(
						f.animation.AnimationId,
						if mode == "clip_parent" then ORIGINAL_URI else UPLOADED_URI
					)
					equal(clip:GetAttribute("TrapSpooferClipContainer"), true)
				end
				if className == "KeyframeSequence" then
					equal(clip.Frame.Time, 0.375)
					equal(clip.Frame.Root.CFrame, roblox.CFrame.new(1, 2, 3))
					equal(clip.Frame.Root.Weight, 0.625)
					equal(clip.Frame.Event.Value, "keep marker")
				else
					equal(clip.Root.X.ClassName, "FloatCurve")
					equal(clip.Root.X:GetAttribute("ChannelMetadata"), "keep curve")
				end
			end
			equal(roblox.serializeModel({ f.source }), sourceBefore)
		end)
	end
end

test("clip_parent preserves the exact original URI", function()
	local f = fixture()
	f.animation.AnimationId = "https://www.roblox.com/asset/?id=" .. ORIGINAL
	success(f.apply("clip_parent"))
	equal(f.animation.AnimationId, "https://www.roblox.com/asset/?id=" .. ORIGINAL)
end)

test("original failure falls back to the uploaded asset", function()
	local f = fixture("CurveAnimation")
	f.load = function(uri)
		if uri == ORIGINAL_URI then
			error("original unavailable")
		end
		return f.source
	end
	success(f.apply("clip_parent"))
	equal(#f.calls, 2)
	equal(f.calls[2], UPLOADED_URI)
	equal(f.animation.Parent.ClassName, "CurveAnimation")
	equal(f.animation.AnimationId, ORIGINAL_URI)
end)

test("failure of both sources preserves the Animation and reports failure", function()
	local f = fixture()
	f.load = function()
		error("unavailable")
	end
	local ok, err = f.apply("clip_replace")
	equal(ok, false)
	assert(string.find(err, "original Animation was preserved", 1, true))
	equal(f.animation.Parent, f.root)
	equal(f.animation.AnimationId, ORIGINAL_URI)
	equal(f.attachment.Parent, f.animation)
	equal(#f.root:GetChildren(), 1)
	equal(f.api.get(f.token), f.animation)
end)

test("empty original clips retry before the upload fallback", function()
	local f = fixture()
	f.load = function(uri)
		return if uri == ORIGINAL_URI then newInstance("KeyframeSequence") else f.source
	end
	success(f.apply("clip_replace"))
	equal(#f.calls, 4)
	equal(f.calls[4], UPLOADED_URI)
end)

test("missing expectedValue loads the Animation's current asset", function()
	local f = fixture()
	local patch = f.patch("clip_parent")
	patch.expectedValue = nil
	success(f.api.apply(patch))
	equal(f.calls[1], ORIGINAL_URI)
	equal(f.animation.AnimationId, ORIGINAL_URI)
end)

test("invalid expectedValue fails before loading", function()
	local f = fixture()
	local patch = f.patch("clip_parent")
	patch.expectedValue = "invalid"
	equal(f.api.apply(patch), false)
	equal(#f.calls, 0)
end)

test("parent modes reuse one wrapper and enforce the requested ID", function()
	local f = fixture()
	success(f.apply("clip_parent"))
	local clip = f.animation.Parent
	clip.Frame.Time = 2.5
	clip.Loop = false
	clip:SetAttribute("UserMetadata", "edited")
	clip:AddTag("UserTag")
	local custom = newInstance("Folder", "UserData", clip)
	success(f.apply("clip_parent_id"))
	equal(f.animation.AnimationId, UPLOADED_URI)
	success(f.apply("clip_parent_id"))
	success(f.apply("clip_parent"))
	equal(f.animation.AnimationId, ORIGINAL_URI)
	equal(f.animation.Parent, clip)
	equal(clip.Parent, f.root)
	equal(#f.root:GetChildren(), 1)
	equal(clip.Frame.Time, 2.5)
	equal(clip.Loop, false)
	equal(clip:GetAttribute("UserMetadata"), "edited")
	assert(table.find(clip:GetTags(), "UserTag"))
	equal(custom.Parent, clip)
	equal(#f.calls, 1)
end)

test("replacement reuses the wrapper without deleting its edited native data", function()
	local f = fixture()
	success(f.apply("clip_parent"))
	local clip = f.animation.Parent
	local frame = clip.Frame
	frame:SetAttribute("TrapSpooferImportedClipData", true)
	frame.Time = 3.5
	clip:AddTag("UserTag")
	success(f.apply("clip_replace"))
	equal(f.api.get(f.token), clip)
	equal(clip.Frame, frame)
	equal(frame.Time, 3.5)
	equal(f.attachment.Parent, clip)
	assert(table.find(clip:GetTags(), "UserTag"))
	success(f.apply("clip_replace"))
	equal(f.apply("clip_parent"), false)
	equal(f.apply("clip_parent_id"), false)
	equal(#f.calls, 1)
end)

test("a mapping chain reuses compatible native data", function()
	local f = fixture()
	success(f.apply("clip_parent_id"))
	local clip = f.animation.Parent
	local patch = f.patch("clip_parent_id")
	patch.expectedValue = UPLOADED_URI
	patch.value = "rbxassetid://456789123"
	success(f.api.apply(patch))
	equal(f.animation.Parent, clip)
	equal(f.animation.AnimationId, patch.value)
	equal(#f.calls, 1)
end)

test("incompatible wrappers fail without losing their data", function()
	local f = fixture()
	success(f.apply("clip_parent"))
	local clip = f.animation.Parent
	clip:SetAttribute("TrapSpooferClipAssetId", "456789123")
	equal(f.apply("clip_replace"), false)
	equal(f.animation.Parent, clip)
	equal(clip.Parent, f.root)
	equal(clip.Frame.Time, 0.375)
end)

for _, change in ipairs({ "id", "name", "parent", "ancestor", "registry" }) do
	test("rejects " .. change .. " changes made during clip loading", function()
		local f = fixture()
		local destination = newInstance("Folder", "Destination")
		f.load = function()
			coroutine.yield("loading")
			return f.source
		end
		local thread = coroutine.create(function()
			return f.apply("clip_parent_id")
		end)
		local started, state = coroutine.resume(thread)
		equal(started, true)
		equal(state, "loading")
		if change == "id" then
			f.animation.AnimationId = "rbxassetid://456789123"
		elseif change == "name" then
			f.animation.Name = "User renamed"
		elseif change == "parent" then
			f.animation.Parent = destination
		elseif change == "ancestor" then
			f.root.Parent = destination
		else
			f.api.reset()
		end
		local resumed, ok, err = coroutine.resume(thread)
		equal(resumed, true)
		equal(coroutine.status(thread), "dead")
		equal(ok, false)
		assert(string.find(err, "changed while loading", 1, true))
		equal(f.attachment.Parent, f.animation)
		equal(f.animation.Parent, if change == "parent" then destination else f.root)
		equal(
			f.animation.AnimationId,
			if change == "id" then "rbxassetid://456789123" else ORIGINAL_URI
		)
	end)
end

test("stale scan fails before any provider call", function()
	local f = fixture()
	f.animation.AnimationId = "rbxassetid://456789123"
	equal(f.apply("clip_parent_id"), false)
	equal(#f.calls, 0)
	equal(f.animation.Parent, f.root)
end)

test("metadata failure rolls back an existing wrapper", function()
	local f = fixture()
	success(f.apply("clip_parent"))
	local clip = f.animation.Parent
	f.animation:SetAttribute("LaterMetadata", "new")
	f.animation:AddTag("LaterTag")
	f.addTag = function(_, tag)
		if tag == "LaterTag" then
			error("injected tag failure")
		end
	end
	local ok, err = f.apply("clip_parent_id")
	equal(ok, false)
	assert(string.find(err, "injected tag failure", 1, true))
	equal(clip:GetAttribute("LaterMetadata"), nil)
	equal(clip:GetAttribute("TrapSpooferClipContainer"), true)
	equal(f.animation.AnimationId, ORIGINAL_URI)
	equal(f.animation.Parent, clip)
	equal(clip.Frame.Time, 0.375)
end)

-- Proxies inject a setter failure while their backing hierarchy remains native.
local function faultProxy(instance, beforeSet, children)
	return setmetatable({ instance = instance }, {
		__index = function(_, key)
			if key == "GetChildren" and children then
				return function()
					return children
				end
			end
			local value = instance[key]
			if type(value) == "function" then
				return function(_, ...)
					return value(instance, ...)
				end
			end
			return value
		end,
		__newindex = function(_, key, value)
			if type(value) == "table" and rawget(value, "instance") then
				value = value.instance
			end
			if beforeSet then
				beforeSet(key, value)
			end
			instance[key] = value
		end,
	})
end

for _, rejectRestore in ipairs({ false, true }) do
	test(
		if rejectRestore
			then "failed rollback retains all surviving data"
			else "partial child movement rolls back",
		function()
			local f = fixture()
			local extra = newInstance("Folder", "Extra", f.animation)
			local first = faultProxy(f.attachment, function(key, value)
				if rejectRestore and key == "Parent" and value == f.animation then
					error("injected restore failure")
				end
			end)
			local second = faultProxy(extra, function(key, value)
				if key == "Parent" and value:IsA("AnimationClip") then
					error("injected movement failure")
				end
			end)
			local animation = faultProxy(f.animation, nil, { first, second })
			f.api.reset()
			f.token = f.api.register(animation)
			local ok, err = f.apply("clip_replace")
			equal(ok, false)
			assert(string.find(err, "injected movement failure", 1, true))
			equal(f.animation.Parent, f.root)
			equal(f.animation.AnimationId, ORIGINAL_URI)
			equal(extra.Parent, f.animation)
			equal(f.api.get(f.token), animation)
			equal(f.attachment.Config.Value, "keep config")
			if rejectRestore then
				assert(string.find(err, "rollback incomplete (clip retained)", 1, true))
				equal(f.attachment.Parent.ClassName, "KeyframeSequence")
				equal(f.attachment.Parent.Parent, f.root)
				equal(#f.root:GetChildren(), 2)
			else
				equal(f.attachment.Parent, f.animation)
				equal(#f.root:GetChildren(), 1)
			end
		end
	)
end

test("the cache returns independent clones and never mutates the source", function()
	local f = fixture()
	success(f.apply("clip_parent"))
	local first = f.animation.Parent
	first.Frame.Time = 9
	local another = newInstance("Animation", "Walk", f.root)
	another.AnimationId = ORIGINAL_URI
	local patch = f.patch("clip_parent")
	patch.token = f.api.register(another)
	success(f.api.apply(patch))
	assert(another.Parent ~= first)
	equal(another.Parent.Frame.Time, 0.375)
	equal(f.source.Frame.Time, 0.375)
	equal(#f.calls, 1)
	f.api.clear()
	equal(first.Frame.Time, 9)
	equal(another.Parent.Frame.Time, 0.375)
end)

print(string.format("Animation patcher: %d passed, %d failed", passed, failed))
assert(failed == 0, "Animation patcher regressions failed")
