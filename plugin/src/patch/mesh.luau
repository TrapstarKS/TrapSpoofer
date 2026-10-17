--!nocheck
--!nolint
-- luacheck: ignore
---@diagnostic disable: undefined-global, unused-local, unused-function, lowercase-global

local function createMeshPartFromUri(
	targetMeshUri: string,
	options: any,
	partName: string
): (MeshPart?, string?)
	local contentOk, meshContent = pcall(function()
		return Content.fromUri(targetMeshUri)
	end)
	if not contentOk then
		return nil, "Could not create mesh Content: " .. tostring(meshContent)
	end

	task.wait()
	local maxAttempts = 5
	local attempt = 0
	local createOk = false
	local createdOrErr = nil

	while attempt < maxAttempts do
		attempt += 1
		createOk, createdOrErr = pcall(function()
			return AssetService:CreateMeshPartAsync(meshContent, options)
		end)
		if createOk and createdOrErr and createdOrErr:IsA("MeshPart") then
			break
		end

		local errStr = string.lower(tostring(createdOrErr))
		local isRateLimit = string.find(errStr, "limit")
			or string.find(errStr, "rate")
			or string.find(errStr, "429")
			or string.find(errStr, "exceed")
			or string.find(errStr, "too many")
			or string.find(errStr, "throttle")
			or string.find(errStr, "timeout")
			or string.find(errStr, "timed out")
			or string.find(errStr, "curlinfo")

		if isRateLimit and attempt < maxAttempts then
			logToPlugin(
				string.format(
					"[Warning] [TrapSpoofer] MeshPart rate limit hit on '%s'. Waiting 5s before retry (%d/%d)...",
					partName,
					attempt,
					maxAttempts
				)
			)
			task.wait(5)
		else
			break
		end
	end

	if not createOk or not createdOrErr or not createdOrErr:IsA("MeshPart") then
		if createOk and createdOrErr then
			pcall(function()
				createdOrErr:Destroy()
			end)
		end
		return nil, "CreateMeshPartAsync failed: " .. tostring(createdOrErr)
	end
	return createdOrErr :: MeshPart, nil
end

local function applyMeshPartInPlace(
	meshObj: MeshPart,
	targetMeshUri: string,
	targetTextureUri: string?,
	expectedMeshUri: string?,
	expectedTextureUri: string?,
	preserveSize: boolean?,
	validateTarget: (() -> boolean)?
): (boolean, string?)
	local originalParent = meshObj.Parent
	local originalName = meshObj.Name
	local options: any = {
		CollisionFidelity = meshObj.CollisionFidelity,
		RenderFidelity = meshObj.RenderFidelity,
	}
	pcall(function()
		options.FluidFidelity = (meshObj :: any).FluidFidelity
	end)

	local originalTexture = ""
	pcall(function()
		originalTexture = meshObj.TextureID
	end)
	local temporaryMesh, createErr = createMeshPartFromUri(targetMeshUri, options, meshObj.Name)
	if not temporaryMesh then
		return false, createErr
	end

	local stillValid = pcall(function()
		return meshObj.Parent
	end)
	if not stillValid or meshObj.Parent == nil then
		pcall(function()
			temporaryMesh:Destroy()
		end)
		return false, "Original MeshPart was destroyed while loading replacement mesh"
	end
	if meshObj.Parent ~= originalParent or meshObj.Name ~= originalName then
		temporaryMesh:Destroy()
		return false, "Original MeshPart moved while loading replacement mesh"
	end
	if validateTarget and not validateTarget() then
		temporaryMesh:Destroy()
		return false, "Mesh target path changed while loading replacement mesh"
	end
	if RunService:IsRunning() or not RunService:IsEdit() then
		temporaryMesh:Destroy()
		return false, "Studio left Edit mode while loading replacement mesh"
	end
	for property, expected in pairs({ MeshId = expectedMeshUri, TextureID = expectedTextureUri }) do
		local readOk, current = pcall(function()
			return (meshObj :: any)[property]
		end)
		local currentUri = contentValueToString(current) or (if current == "" then "" else nil)
		local targetUri = if property == "MeshId" then targetMeshUri else targetTextureUri
		if
			not readOk or (currentUri ~= expected and (not targetUri or currentUri ~= targetUri))
		then
			temporaryMesh:Destroy()
			return false, "Studio mesh reference changed while loading replacement; scan again"
		end
	end

	local applyOk, applyErr = pcall(function()
		meshObj:ApplyMesh(temporaryMesh)
		if preserveSize == false then
			meshObj.Size = temporaryMesh.MeshSize
		end
	end)
	pcall(function()
		temporaryMesh:Destroy()
	end)
	if not applyOk then
		return false, tostring(applyErr)
	end

	local textureToApply = targetTextureUri or originalTexture
	local textureOk, textureErr = pcall(function()
		meshObj.TextureID = textureToApply
	end)
	if not textureOk then
		return false, "Mesh applied but texture update failed: " .. tostring(textureErr)
	end

	return true, nil
end
