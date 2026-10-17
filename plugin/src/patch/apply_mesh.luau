--!nocheck
--!nolint

type MeshApplyRequest = {
	operationId: string,
	meshId: string,
	instancePath: string,
	meshPartName: string?,
	preserveSize: boolean?,
}

local function validMeshApplyPath(path: any): boolean
	return type(path) == "string"
		and #path > 0
		and #path <= 2048
		and not string.find(path, "%c")
		and not string.find(path, "%.%.")
		and string.sub(path, 1, 1) ~= "."
		and string.sub(path, -1) ~= "."
end

local function normalizeMeshApplyRequest(value: any): (MeshApplyRequest?, string?)
	if type(value) ~= "table" then
		return nil, "Invalid mesh apply request"
	end
	if
		type(value.operationId) ~= "string"
		or not string.match(
			value.operationId,
			"^%x%x%x%x%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$"
		)
	then
		return nil, "Invalid mesh operation ID"
	end
	if
		type(value.meshId) ~= "string"
		or #value.meshId > 20
		or not string.match(value.meshId, "^%d+$")
		or not string.find(value.meshId, "[1-9]")
	then
		return nil, "meshId must be a positive numeric asset ID"
	end
	if not validMeshApplyPath(value.instancePath) then
		return nil, "Invalid mesh target path"
	end
	if
		value.meshPartName ~= nil
		and (
			type(value.meshPartName) ~= "string"
			or #value.meshPartName == 0
			or #value.meshPartName > 100
			or string.find(value.meshPartName, "[%c%.]")
		)
	then
		return nil, "meshPartName must be a name of 1 to 100 characters without dots"
	end
	if value.preserveSize ~= nil and type(value.preserveSize) ~= "boolean" then
		return nil, "preserveSize must be a boolean"
	end
	return value :: MeshApplyRequest, nil
end

local function resolveMeshApplyTarget(path: string): (Instance?, string?)
	local parts = string.split(string.gsub(path, "^game%.", ""), ".")
	if #parts > 100 or not table.find(SERVICES_TO_SCAN, parts[1]) then
		return nil, "Mesh target path must start with a supported service such as Workspace"
	end
	local current: Instance = game
	for _, name in ipairs(parts) do
		local childrenOk, children = pcall(function()
			return current:GetChildren()
		end)
		if not childrenOk then
			return nil, "Could not read mesh target path"
		end
		local matched: Instance? = nil
		for _, child in ipairs(children) do
			if child.Name == name then
				if matched then
					return nil, "Mesh target path is ambiguous: duplicate child name " .. name
				end
				matched = child
			end
		end
		if not matched then
			return nil, "Mesh target was not found: " .. path
		end
		current = matched
	end
	return current, nil
end

local function applyMeshToTarget(request: MeshApplyRequest): (boolean, string?, boolean?)
	if RunService:IsRunning() or not RunService:IsEdit() then
		return false, "Mesh application is only available in Studio Edit mode"
	end
	local target, targetErr = resolveMeshApplyTarget(request.instancePath)
	if not target then
		return false, targetErr
	end
	local meshUri = "rbxassetid://" .. request.meshId
	if target:IsA("MeshPart") then
		if request.meshPartName ~= nil then
			return false, "meshPartName is only valid when instancePath points to a Model"
		end
		local meshObj = target :: MeshPart
		local meshId, textureId = meshObj.MeshId, meshObj.TextureID
		local ok, err = applyMeshPartInPlace(
			meshObj,
			meshUri,
			nil,
			meshId,
			textureId,
			request.preserveSize,
			function(): boolean
				return resolveMeshApplyTarget(request.instancePath) == target
			end
		)
		return ok, err, false
	end
	if not target:IsA("Model") then
		return false, "Mesh target must be an existing MeshPart or a Model"
	end
	if not request.meshPartName then
		return false, "meshPartName is required when instancePath points to a Model"
	end
	if target:FindFirstChild(request.meshPartName) then
		return false, "The target Model already contains a child named " .. request.meshPartName
	end
	local created, createErr = createMeshPartFromUri(meshUri, {}, request.meshPartName)
	if not created then
		return false, createErr
	end
	local current = resolveMeshApplyTarget(request.instancePath)
	local parentOk, parentErr = pcall(function()
		if current ~= target or not target.Parent then
			error("The target Model changed while loading the mesh")
		end
		if target:FindFirstChild(request.meshPartName) then
			error("The target name was taken while loading the mesh")
		end
		if RunService:IsRunning() or not RunService:IsEdit() then
			error("Studio left Edit mode while loading the mesh")
		end
		created.Name = request.meshPartName :: string
		created.Size = created.MeshSize
		created.CFrame = (target :: Model):GetPivot()
		created.Parent = target
	end)
	if not parentOk then
		pcall(function()
			created:Destroy()
		end)
		return false, tostring(parentErr)
	end
	return true, nil, true
end

local function runMeshApplyRequest(value: any): any
	local request, requestErr = normalizeMeshApplyRequest(value)
	if not request then
		return {
			operationId = if type(value) == "table" then value.operationId else nil,
			success = false,
			error = requestErr,
		}
	end
	local recording = nil
	pcall(function()
		recording = ChangeHistoryService:TryBeginRecording("TrapSpoofer Apply Mesh")
	end)
	local callOk, ok, err, created = pcall(applyMeshToTarget, request)
	if not callOk then
		err = tostring(ok)
		ok = false
	end
	if recording then
		pcall(function()
			ChangeHistoryService:FinishRecording(recording, Enum.FinishRecordingOperation.Commit)
		end)
	end
	return {
		operationId = request.operationId,
		success = ok,
		error = if ok then nil else string.sub(tostring(err), 1, 8192),
		created = if ok then created else nil,
		instancePath = if ok and created
			then request.instancePath .. "." .. request.meshPartName
			else request.instancePath,
	}
end
