use base64::Engine;
use serde_json::json;
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct MeshVector {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl From<[f64; 3]> for MeshVector {
    fn from(value: [f64; 3]) -> Self {
        Self { x: value[0], y: value[1], z: value[2] }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct MeshBounds {
    pub min: MeshVector,
    pub max: MeshVector,
    pub center: MeshVector,
    pub size: MeshVector,
}

impl MeshBounds {
    fn from_positions(positions: impl IntoIterator<Item = [f64; 3]>) -> Result<Self, String> {
        let mut min = [f64::INFINITY; 3];
        let mut max = [f64::NEG_INFINITY; 3];
        for position in positions {
            for axis in 0..3 {
                if !position[axis].is_finite() {
                    return Err("Mesh contains a non-finite coordinate".into());
                }
                min[axis] = min[axis].min(position[axis]);
                max[axis] = max[axis].max(position[axis]);
            }
        }
        if !min[0].is_finite() {
            return Err("Mesh contains no geometry".into());
        }
        Ok(Self {
            min: min.into(),
            max: max.into(),
            center: std::array::from_fn::<_, 3, _>(|axis| min[axis] * 0.5 + max[axis] * 0.5).into(),
            size: std::array::from_fn::<_, 3, _>(|axis| max[axis] - min[axis]).into(),
        })
    }
}

pub struct PreparedMesh {
    pub bytes: Vec<u8>,
    pub extension: String,
    pub bounds: MeshBounds,
    pub source_bounds: MeshBounds,
    pub axis_conversion: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug)]
struct Vertex {
    position: [f32; 3],
    normal: [f32; 3],
    uv: [f32; 2],
    color: [u8; 4],
}

#[derive(Default)]
struct Geometry {
    vertices: Vec<Vertex>,
    faces: Vec<[u32; 3]>,
}

impl Geometry {
    fn bounds(&self) -> Result<MeshBounds, String> {
        MeshBounds::from_positions(
            self.faces
                .iter()
                .flatten()
                .map(|index| self.vertices[*index as usize].position.map(f64::from)),
        )
    }

    fn center(&mut self, bounds: MeshBounds) {
        for vertex in &mut self.vertices {
            for (value, center) in
                vertex.position.iter_mut().zip([bounds.center.x, bounds.center.y, bounds.center.z])
            {
                *value = (f64::from(*value) - center) as f32;
            }
        }
    }
}

fn u16_at(data: &[u8], offset: usize) -> Result<u16, String> {
    Ok(u16::from_le_bytes(
        data.get(offset..offset + 2)
            .ok_or("Truncated mesh header")?
            .try_into()
            .map_err(|_| "Truncated mesh header")?,
    ))
}

fn u32_at(data: &[u8], offset: usize) -> Result<u32, String> {
    Ok(u32::from_le_bytes(
        data.get(offset..offset + 4)
            .ok_or("Truncated mesh data")?
            .try_into()
            .map_err(|_| "Truncated mesh data")?,
    ))
}

fn f32_at(data: &[u8], offset: usize) -> Result<f32, String> {
    let value = f32::from_bits(u32_at(data, offset)?);
    if !value.is_finite() {
        return Err("Mesh contains a non-finite coordinate".into());
    }
    Ok(value)
}

fn parse_binary_geometry(
    data: &[u8],
    vertex_offset: usize,
    vertex_count: usize,
    stride: usize,
    face_offset: usize,
    face_count: usize,
) -> Result<Geometry, String> {
    if vertex_count == 0
        || vertex_count > 2_000_000
        || face_count == 0
        || face_count > 2_000_000
        || !matches!(stride, 36 | 40)
    {
        return Err("Invalid mesh vertex/face counts or vertex stride".into());
    }
    let vertex_end = vertex_offset
        .checked_add(vertex_count.checked_mul(stride).ok_or("Mesh size overflow")?)
        .ok_or("Mesh size overflow")?;
    let face_end = face_offset
        .checked_add(face_count.checked_mul(12).ok_or("Mesh size overflow")?)
        .ok_or("Mesh size overflow")?;
    if vertex_end > data.len() || face_end > data.len() {
        return Err("Truncated mesh geometry".into());
    }
    let mut geometry = Geometry::default();
    for i in 0..vertex_count {
        let offset = vertex_offset + i * stride;
        geometry.vertices.push(Vertex {
            position: [f32_at(data, offset)?, f32_at(data, offset + 4)?, f32_at(data, offset + 8)?],
            normal: [
                f32_at(data, offset + 12)?,
                f32_at(data, offset + 16)?,
                f32_at(data, offset + 20)?,
            ],
            uv: [f32_at(data, offset + 24)?, f32_at(data, offset + 28)?],
            color: if stride == 40 {
                data[offset + 36..offset + 40].try_into().map_err(|_| "Invalid vertex color")?
            } else {
                [255; 4]
            },
        });
    }
    for i in 0..face_count {
        let offset = face_offset + i * 12;
        let face = [u32_at(data, offset)?, u32_at(data, offset + 4)?, u32_at(data, offset + 8)?];
        if face.iter().any(|index| *index as usize >= vertex_count) {
            return Err("Mesh face references a missing vertex".into());
        }
        geometry.faces.push(face);
    }
    Ok(geometry)
}

fn parse_draco(data: &[u8]) -> Result<Geometry, String> {
    use draco_core::{DecoderBuffer, Mesh, MeshDecoder};
    let size = u32_at(data, 0)? as usize;
    let stream = data.get(4..4 + size).ok_or("Truncated Draco mesh")?;
    let mut mesh = Mesh::new();
    MeshDecoder::new()
        .decode(
            &mut DecoderBuffer::new(stream).with_limits(
                draco_core::DecodeLimits::default()
                    .with_max_points(500_000)
                    .with_max_faces(2_000_000)
                    .with_max_decoded_bytes(100 * 1024 * 1024),
            ),
            &mut mesh,
        )
        .map_err(|_| "Could not decode Draco mesh")?;
    let count = mesh.num_points();
    if count == 0 || count > 2_000_000 || mesh.num_faces() > 2_000_000 {
        return Err("Invalid Draco mesh size".into());
    }
    let positions =
        mesh.attribute_by_unique_id(0).ok_or("Draco mesh has no positions")?.read_f32s(count, 3);
    let normals = mesh.attribute_by_unique_id(1).map(|attribute| attribute.read_f32s(count, 3));
    let uvs = mesh.attribute_by_unique_id(2).map(|attribute| attribute.read_f32s(count, 2));
    let mut geometry = Geometry::default();
    for i in 0..count {
        geometry.vertices.push(Vertex {
            position: [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]],
            normal: normals
                .as_ref()
                .map_or([0.0, 1.0, 0.0], |v| [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]]),
            uv: uvs.as_ref().map_or([0.0; 2], |v| [v[i * 2], v[i * 2 + 1]]),
            color: [255; 4],
        });
    }
    for i in 0..mesh.num_faces() {
        let face = mesh.face(draco_core::geometry_indices::FaceIndex(i as u32));
        geometry.faces.push([face[0].0, face[1].0, face[2].0]);
    }
    Ok(geometry)
}

fn apply_lod(
    geometry: &mut Geometry,
    data: &[u8],
    offset: usize,
    count: usize,
) -> Result<(), String> {
    if count < 2 {
        return Ok(());
    }
    let start = u32_at(data, offset)? as usize;
    let end = u32_at(data, offset + 4)? as usize;
    if end == 0 {
        return Ok(());
    }
    if start > end || end > geometry.faces.len() {
        return Err("Mesh has invalid LOD offsets".into());
    }
    geometry.faces = geometry.faces[start..end].to_vec();
    Ok(())
}

fn parse_roblox_mesh(data: &[u8]) -> Result<Geometry, String> {
    let newline =
        data.iter().position(|byte| *byte == b'\n').ok_or("Missing Roblox mesh version header")?;
    let version =
        std::str::from_utf8(&data[..newline]).map_err(|_| "Invalid mesh version header")?;
    let data = &data[newline + 1..];
    if matches!(version, "version 6.00" | "version 7.00") {
        let mut offset = 0;
        let mut geometry = None;
        let mut lod = None;
        while offset < data.len() {
            let header = data.get(offset..offset + 16).ok_or("Truncated mesh chunk")?;
            let chunk_version = u32_at(header, 8)?;
            let size = u32_at(header, 12)? as usize;
            offset += 16;
            let chunk = data.get(offset..offset + size).ok_or("Truncated mesh chunk data")?;
            if &header[..8] == b"COREMESH" {
                geometry = Some(match chunk_version {
                    1 => {
                        let count = u32_at(chunk, 0)? as usize;
                        let faces_offset = 4usize
                            .checked_add(count.checked_mul(40).ok_or("Mesh size overflow")?)
                            .ok_or("Mesh size overflow")?;
                        parse_binary_geometry(
                            chunk,
                            4,
                            count,
                            40,
                            faces_offset + 4,
                            u32_at(chunk, faces_offset)? as usize,
                        )?
                    }
                    2 => parse_draco(chunk)?,
                    _ => return Err("Unsupported COREMESH chunk version".into()),
                });
            } else if header[..8].starts_with(b"LODS") && chunk_version == 1 {
                lod = Some(chunk);
            }
            offset += size;
        }
        let mut geometry = geometry.ok_or("Mesh has no COREMESH chunk")?;
        if let Some(lod) = lod {
            apply_lod(&mut geometry, lod, 7, u32_at(lod, 3)? as usize)?;
        }
        return Ok(geometry);
    }
    let header_size = usize::from(u16_at(data, 0)?);
    let (count, faces, stride, skinning, lod_count) = match version {
        "version 2.00" if header_size == 12 => (
            u32_at(data, 4)? as usize,
            u32_at(data, 8)? as usize,
            usize::from(*data.get(2).ok_or("Missing vertex stride")?),
            false,
            0,
        ),
        "version 3.00" | "version 3.01" if header_size == 16 => (
            u32_at(data, 8)? as usize,
            u32_at(data, 12)? as usize,
            usize::from(*data.get(2).ok_or("Missing vertex stride")?),
            false,
            usize::from(u16_at(data, 6)?),
        ),
        "version 4.00" | "version 4.01" | "version 5.00" if header_size >= 24 => (
            u32_at(data, 4)? as usize,
            u32_at(data, 8)? as usize,
            40,
            u16_at(data, 14)? > 0,
            usize::from(u16_at(data, 12)?),
        ),
        _ => return Err(format!("Unsupported Roblox mesh header: {version}")),
    };
    let face_offset = header_size
        .checked_add(
            count.checked_mul(stride + if skinning { 8 } else { 0 }).ok_or("Mesh size overflow")?,
        )
        .ok_or("Mesh size overflow")?;
    let mut geometry = parse_binary_geometry(data, header_size, count, stride, face_offset, faces)?;
    apply_lod(&mut geometry, data, face_offset + faces * 12, lod_count)?;
    Ok(geometry)
}

fn obj_index(value: &str, count: usize) -> Result<usize, String> {
    let index = value.parse::<i64>().map_err(|_| "Invalid OBJ face index")?;
    let index = if index < 0 { count as i64 + index } else { index - 1 };
    if index < 0 || index as usize >= count {
        return Err("OBJ face references a missing vertex".into());
    }
    Ok(index as usize)
}

fn parse_obj(data: &[u8]) -> Result<Geometry, String> {
    let source = std::str::from_utf8(data).map_err(|_| "OBJ file is not UTF-8 text")?;
    let mut positions = Vec::<[f32; 3]>::new();
    let mut normals = Vec::<[f32; 3]>::new();
    let mut uvs = Vec::<[f32; 2]>::new();
    let mut vertices = HashMap::new();
    let mut geometry = Geometry::default();
    for line in source.lines() {
        let mut parts = line.split('#').next().unwrap_or_default().split_whitespace();
        match parts.next() {
            Some(kind @ ("v" | "vn" | "vt")) => {
                let values = parts
                    .take(if kind == "vt" { 2 } else { 3 })
                    .map(|value| value.parse::<f32>().map_err(|_| "Invalid OBJ coordinate"))
                    .collect::<Result<Vec<_>, _>>()?;
                if values.len() != if kind == "vt" { 2 } else { 3 }
                    || values.iter().any(|value| !value.is_finite())
                {
                    return Err("Invalid OBJ coordinates".into());
                }
                match kind {
                    "v" => positions.push([values[0], values[1], values[2]]),
                    "vn" => normals.push([values[0], values[1], values[2]]),
                    _ => uvs.push([values[0], values[1]]),
                }
            }
            Some("f") => {
                let mut face = Vec::new();
                for value in parts {
                    let indices = value.split('/').collect::<Vec<_>>();
                    let p = obj_index(indices[0], positions.len())?;
                    let t = indices
                        .get(1)
                        .filter(|v| !v.is_empty())
                        .map(|v| obj_index(v, uvs.len()))
                        .transpose()?;
                    let n = indices
                        .get(2)
                        .filter(|v| !v.is_empty())
                        .map(|v| obj_index(v, normals.len()))
                        .transpose()?;
                    let next = geometry.vertices.len() as u32;
                    let index = *vertices.entry((p, t, n)).or_insert_with(|| {
                        geometry.vertices.push(Vertex {
                            position: positions[p],
                            normal: n.map_or([0.0, 1.0, 0.0], |i| normals[i]),
                            uv: t.map_or([0.0; 2], |i| [uvs[i][0], 1.0 - uvs[i][1]]),
                            color: [255; 4],
                        });
                        next
                    });
                    face.push(index);
                }
                if face.len() < 3 {
                    return Err("OBJ face has fewer than three vertices".into());
                }
                for i in 1..face.len() - 1 {
                    geometry.faces.push([face[0], face[i], face[i + 1]]);
                }
            }
            _ => {}
        }
    }
    if geometry.faces.is_empty() {
        return Err("OBJ has no faces".into());
    }
    Ok(geometry)
}

fn glb(geometry: Geometry) -> Result<Vec<u8>, String> {
    if geometry.vertices.is_empty() || geometry.faces.is_empty() {
        return Err("Mesh contains no geometry".into());
    }
    let mut bytes = Vec::new();
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for vertex in &geometry.vertices {
        for i in 0..3 {
            if !vertex.position[i].is_finite() {
                return Err("Mesh contains a non-finite coordinate".into());
            }
            min[i] = min[i].min(vertex.position[i]);
            max[i] = max[i].max(vertex.position[i]);
        }
        for value in vertex.position.iter().chain(&vertex.normal).chain(&vertex.uv) {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes.extend_from_slice(&vertex.color);
    }
    let index_offset = bytes.len();
    for face in &geometry.faces {
        for index in face {
            bytes.extend_from_slice(&index.to_le_bytes());
        }
    }
    let mut document = serde_json::to_vec(&json!({
        "asset":{"version":"2.0","generator":"TrapSpoofer"},"scene":0,"scenes":[{"nodes":[0]}],"nodes":[{"mesh":0}],
        "meshes":[{"primitives":[{"attributes":{"POSITION":0,"NORMAL":1,"TEXCOORD_0":2,"COLOR_0":3},"indices":4}]}],
        "buffers":[{"byteLength":bytes.len()}],
        "bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":index_offset,"byteStride":36,"target":34962},{"buffer":0,"byteOffset":index_offset,"byteLength":bytes.len()-index_offset,"target":34963}],
        "accessors":[{"bufferView":0,"byteOffset":0,"componentType":5126,"count":geometry.vertices.len(),"type":"VEC3","min":min,"max":max},{"bufferView":0,"byteOffset":12,"componentType":5126,"count":geometry.vertices.len(),"type":"VEC3"},{"bufferView":0,"byteOffset":24,"componentType":5126,"count":geometry.vertices.len(),"type":"VEC2"},{"bufferView":0,"byteOffset":32,"componentType":5121,"normalized":true,"count":geometry.vertices.len(),"type":"VEC4"},{"bufferView":1,"componentType":5125,"count":geometry.faces.len()*3,"type":"SCALAR"}]
    })).map_err(|_| "Could not encode mesh metadata")?;
    while document.len() % 4 != 0 {
        document.push(b' ');
    }
    while bytes.len() % 4 != 0 {
        bytes.push(0);
    }
    let length = 12 + 8 + document.len() + 8 + bytes.len();
    let mut result = b"glTF".to_vec();
    result.extend_from_slice(&2u32.to_le_bytes());
    result.extend_from_slice(&(length as u32).to_le_bytes());
    result.extend_from_slice(&(document.len() as u32).to_le_bytes());
    result.extend_from_slice(b"JSON");
    result.extend_from_slice(&document);
    result.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    result.extend_from_slice(b"BIN\0");
    result.extend_from_slice(&bytes);
    Ok(result)
}

pub fn convert_to_glb(data: &[u8], extension: &str) -> Result<Vec<u8>, String> {
    glb(if extension.eq_ignore_ascii_case("obj") {
        parse_obj(data)?
    } else {
        parse_roblox_mesh(data)?
    })
}

pub fn roblox_bounds(data: &[u8]) -> Result<MeshBounds, String> {
    parse_roblox_mesh(data)?.bounds()
}

fn parse_fbx(data: &[u8]) -> Result<(Geometry, String), String> {
    let scene = ufbx::load_memory(
        data,
        ufbx::LoadOpts {
            target_axes: ufbx::CoordinateAxes::right_handed_y_up(),
            generate_missing_normals: true,
            evaluate_skinning: true,
            load_external_files: false,
            node_depth_limit: 256,
            temp_allocator: ufbx::AllocatorOpts {
                memory_limit: 256 * 1024 * 1024,
                ..Default::default()
            },
            result_allocator: ufbx::AllocatorOpts {
                memory_limit: 256 * 1024 * 1024,
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .map_err(|error| format!("Could not read FBX geometry: {}", error.description))?;
    let mut geometry = Geometry::default();
    let mut indices = Vec::new();
    for node in &scene.nodes {
        let Some(mesh) = node.mesh.as_ref() else { continue };
        if geometry.vertices.len().saturating_add(mesh.num_indices) > 6_000_000 {
            return Err("FBX geometry exceeds the conversion limit".into());
        }
        let normal_matrix = node.get_compatible_matrix_for_normals();
        let start = geometry.vertices.len() as u32;
        for index in 0..mesh.num_indices {
            let position = if mesh.skinned_is_local {
                ufbx::transform_position(&node.geometry_to_world, mesh.skinned_position[index])
            } else {
                mesh.skinned_position[index]
            };
            let normal = if mesh.skinned_normal.exists {
                if mesh.skinned_is_local {
                    ufbx::transform_direction(&normal_matrix, mesh.skinned_normal[index])
                } else {
                    mesh.skinned_normal[index]
                }
            } else {
                ufbx::Vec3 { x: 0.0, y: 1.0, z: 0.0 }
            };
            let magnitude =
                (normal.x * normal.x + normal.y * normal.y + normal.z * normal.z).sqrt();
            let uv =
                if mesh.vertex_uv.exists { mesh.vertex_uv[index] } else { ufbx::Vec2::default() };
            geometry.vertices.push(Vertex {
                position: [position.x as f32, position.y as f32, position.z as f32],
                normal: if magnitude > 0.0 {
                    [
                        (normal.x / magnitude) as f32,
                        (normal.y / magnitude) as f32,
                        (normal.z / magnitude) as f32,
                    ]
                } else {
                    [0.0, 1.0, 0.0]
                },
                uv: [uv.x as f32, 1.0 - uv.y as f32],
                color: [255; 4],
            });
        }
        for face in &mesh.faces {
            let count = ufbx::triangulate_face_vec(&mut indices, mesh, *face) as usize;
            for triangle in indices[..count * 3].chunks_exact(3) {
                geometry.faces.push([
                    start + triangle[0],
                    start + triangle[1],
                    start + triangle[2],
                ]);
            }
        }
    }
    let axes = &scene.settings.axes;
    let conversion = format!("FBX declared axes right={:?}, up={:?}, front={:?}; source unit={} meters. Local geometry conversion uses right-handed Y-up and retains numeric scene scale (1 source scene unit = 1 stud), without physical-unit rescaling", axes.right, axes.up, axes.front, scene.settings.unit_meters);
    Ok((geometry, conversion))
}

type Matrix = [[f64; 4]; 4];

fn identity() -> Matrix {
    std::array::from_fn(|column| std::array::from_fn(|row| if column == row { 1.0 } else { 0.0 }))
}

fn multiply(left: Matrix, right: Matrix) -> Matrix {
    std::array::from_fn(|column| {
        std::array::from_fn(|row| (0..4).map(|i| left[i][row] * right[column][i]).sum())
    })
}

fn transform(matrix: Matrix, position: [f32; 3]) -> [f64; 3] {
    std::array::from_fn(|row| {
        matrix[3][row]
            + (0..3).map(|column| matrix[column][row] * f64::from(position[column])).sum::<f64>()
    })
}

fn parse_gltf(data: &[u8]) -> Result<Geometry, String> {
    let parsed = gltf::Gltf::from_slice(data)
        .map_err(|error| format!("Could not read glTF geometry: {error}"))?;
    let mut buffers = Vec::new();
    for buffer in parsed.buffers() {
        let bytes = match buffer.source() {
            gltf::buffer::Source::Bin => parsed.blob.clone().ok_or("GLB has no binary buffer")?,
            gltf::buffer::Source::Uri(uri) => {
                let (header, payload) =
                    uri.split_once(',').ok_or("glTF buffers must be bundled data URIs")?;
                if !header.starts_with("data:") || !header.ends_with(";base64") {
                    return Err("glTF buffer must use a base64 data URI".into());
                }
                base64::engine::general_purpose::STANDARD
                    .decode(payload)
                    .map_err(|_| "Invalid glTF buffer data URI")?
            }
        };
        if bytes.len() < buffer.length() || bytes.len() > 100 * 1024 * 1024 {
            return Err("Invalid glTF buffer length".into());
        }
        buffers.push(bytes);
    }
    for view in parsed.views() {
        let end =
            view.offset().checked_add(view.length()).ok_or("glTF buffer view size overflow")?;
        if end > buffers[view.buffer().index()].len() {
            return Err("glTF buffer view exceeds its buffer".into());
        }
    }
    for accessor in parsed.accessors() {
        if accessor.count() == 0 || accessor.count() > 6_000_000 {
            return Err("glTF accessor exceeds the geometry limit".into());
        }
        if let Some(view) = accessor.view() {
            let size = accessor.size();
            let length = view
                .stride()
                .unwrap_or(size)
                .checked_mul(accessor.count() - 1)
                .and_then(|length| length.checked_add(size))
                .and_then(|length| length.checked_add(accessor.offset()))
                .ok_or("glTF accessor size overflow")?;
            if length > view.length() {
                return Err("glTF accessor exceeds its buffer view".into());
            }
        }
        if let Some(sparse) = accessor.sparse() {
            if sparse.count() == 0 || sparse.count() > accessor.count() {
                return Err("Invalid glTF sparse accessor count".into());
            }
            let indices = sparse.indices();
            let view = indices.view();
            let index_size = indices.index_type().size();
            let stride = view.stride().unwrap_or(index_size);
            let end = stride
                .checked_mul(sparse.count() - 1)
                .and_then(|length| length.checked_add(index_size))
                .and_then(|length| length.checked_add(indices.offset()))
                .ok_or("glTF sparse index size overflow")?;
            if end > view.length() {
                return Err("glTF sparse indices exceed their buffer view".into());
            }
            let bytes = &buffers[view.buffer().index()]
                [view.offset() + indices.offset()..view.offset() + end];
            let mut previous = None;
            for index in 0..sparse.count() {
                let offset = index * stride;
                let value = match index_size {
                    1 => usize::from(bytes[offset]),
                    2 => usize::from(u16_at(bytes, offset)?),
                    _ => u32_at(bytes, offset)? as usize,
                };
                if value >= accessor.count() || previous.is_some_and(|previous| value <= previous) {
                    return Err(
                        "glTF sparse indices must be increasing and within the accessor".into()
                    );
                }
                previous = Some(value);
            }
            let values = sparse.values();
            let view = values.view();
            let size = accessor.size();
            let end = view
                .stride()
                .unwrap_or(size)
                .checked_mul(sparse.count() - 1)
                .and_then(|length| length.checked_add(size))
                .and_then(|length| length.checked_add(values.offset()))
                .ok_or("glTF sparse value size overflow")?;
            if end > view.length() {
                return Err("glTF sparse values exceed their buffer view".into());
            }
        }
    }
    let scene =
        parsed.default_scene().or_else(|| parsed.scenes().next()).ok_or("glTF has no scene")?;
    let mut geometry = Geometry::default();
    let mut stack: Vec<_> = scene.nodes().map(|node| (node, identity(), 0)).collect();
    let mut world_transforms = HashMap::new();
    while let Some((node, parent, depth)) = stack.pop() {
        if depth > 256 || world_transforms.contains_key(&node.index()) {
            return Err("glTF has a cyclic or excessively deep node hierarchy".into());
        }
        let local = node.transform().matrix().map(|column| column.map(f64::from));
        let world = multiply(parent, local);
        world_transforms.insert(node.index(), world);
        for child in node.children() {
            stack.push((child, world, depth + 1));
        }
    }
    for node in parsed.nodes().filter(|node| world_transforms.contains_key(&node.index())) {
        let world = world_transforms[&node.index()];
        let joint_matrices = if let Some(skin) = node.skin() {
            let reader = skin.reader(|buffer| buffers.get(buffer.index()).map(Vec::as_slice));
            let inverse_bind: Vec<_> =
                reader.read_inverse_bind_matrices().map(Iterator::collect).unwrap_or_else(|| {
                    vec![
                        [
                            [1.0, 0.0, 0.0, 0.0],
                            [0.0, 1.0, 0.0, 0.0],
                            [0.0, 0.0, 1.0, 0.0],
                            [0.0, 0.0, 0.0, 1.0]
                        ];
                        skin.joints().len()
                    ]
                });
            let mut matrices = Vec::new();
            for (index, joint) in skin.joints().enumerate() {
                let bind = inverse_bind
                    .get(index)
                    .ok_or("glTF skin has missing inverse bind matrices")?
                    .map(|column| column.map(f64::from));
                matrices.push(multiply(
                    *world_transforms
                        .get(&joint.index())
                        .ok_or("glTF skin joint is outside the default scene")?,
                    bind,
                ));
            }
            Some(matrices)
        } else {
            None
        };
        if let Some(mesh) = node.mesh() {
            for primitive in mesh.primitives() {
                let reader =
                    primitive.reader(|buffer| buffers.get(buffer.index()).map(Vec::as_slice));
                let mut vertices: Vec<_> = reader.read_positions().ok_or("glTF positions cannot be decoded (compressed geometry is not supported for local bounds)")?.collect();
                let weights = node.weights().or_else(|| mesh.weights()).unwrap_or_default();
                for (index, (displacements, _, _)) in reader.read_morph_targets().enumerate() {
                    let weight = weights.get(index).copied().unwrap_or(0.0);
                    if let Some(displacements) = displacements {
                        if displacements.len() != vertices.len() {
                            return Err(
                                "glTF morph target attribute count does not match its positions"
                                    .into(),
                            );
                        }
                        for (vertex, displacement) in vertices.iter_mut().zip(displacements) {
                            for axis in 0..3 {
                                vertex[axis] += displacement[axis] * weight;
                            }
                        }
                    }
                }
                let mut evaluated =
                    vertices.iter().map(|position| transform(world, *position)).collect::<Vec<_>>();
                if let Some(matrices) = &joint_matrices {
                    let mut total_weights = vec![0.0; vertices.len()];
                    evaluated.fill([0.0; 3]);
                    for set in 0.. {
                        let Some(joints) = reader.read_joints(set) else { break };
                        let weights = reader
                            .read_weights(set)
                            .ok_or("glTF skin joint weights are missing")?;
                        for (index, (joints, weights)) in
                            joints.into_u16().zip(weights.into_f32()).enumerate()
                        {
                            let position =
                                *vertices.get(index).ok_or("Invalid glTF skin attribute count")?;
                            for (joint, weight) in joints.into_iter().zip(weights) {
                                if !weight.is_finite() || weight < 0.0 {
                                    return Err("glTF skin has invalid vertex weights".into());
                                }
                                if weight == 0.0 {
                                    continue;
                                }
                                let matrix = *matrices
                                    .get(joint as usize)
                                    .ok_or("glTF skin references a missing joint")?;
                                let transformed = transform(matrix, position);
                                for axis in 0..3 {
                                    evaluated[index][axis] += transformed[axis] * f64::from(weight);
                                }
                                total_weights[index] += f64::from(weight);
                            }
                        }
                    }
                    for (position, weight) in evaluated.iter_mut().zip(total_weights) {
                        if !weight.is_finite() || weight <= 0.0 {
                            return Err("glTF skin has invalid vertex weights".into());
                        }
                        for value in position {
                            *value /= weight;
                        }
                    }
                }
                let indices: Vec<_> = reader
                    .read_indices()
                    .map(|indices| indices.into_u32().collect())
                    .unwrap_or_else(|| (0..vertices.len() as u32).collect());
                if geometry.vertices.len().saturating_add(indices.len()) > 6_000_000 {
                    return Err("glTF geometry exceeds the conversion limit".into());
                }
                let triangles: Vec<[u32; 3]> = match primitive.mode() {
                    gltf::mesh::Mode::Triangles => {
                        if indices.len() % 3 != 0 {
                            return Err("glTF triangle indices are incomplete".into());
                        }
                        indices
                            .chunks_exact(3)
                            .map(|triangle| [triangle[0], triangle[1], triangle[2]])
                            .collect()
                    }
                    gltf::mesh::Mode::TriangleStrip => indices
                        .windows(3)
                        .enumerate()
                        .map(|(index, triangle)| {
                            if index % 2 == 0 {
                                [triangle[0], triangle[1], triangle[2]]
                            } else {
                                [triangle[1], triangle[0], triangle[2]]
                            }
                        })
                        .collect(),
                    gltf::mesh::Mode::TriangleFan => (1..indices.len().saturating_sub(1))
                        .map(|index| [indices[0], indices[index], indices[index + 1]])
                        .collect(),
                    _ => {
                        return Err(
                            "Only triangle geometry can be normalized or measured locally".into()
                        )
                    }
                };
                let uvs: Vec<_> = reader
                    .read_tex_coords(0)
                    .map(|values| values.into_f32().collect())
                    .unwrap_or_default();
                if geometry.faces.len().saturating_add(triangles.len()) > 2_000_000 {
                    return Err("glTF geometry exceeds the conversion limit".into());
                }
                for triangle in triangles {
                    let positions = triangle.map(|index| {
                        evaluated
                            .get(index as usize)
                            .copied()
                            .ok_or("glTF index references a missing vertex")
                    });
                    let [a, b, c] = [positions[0]?, positions[1]?, positions[2]?];
                    let ab: [f64; 3] = std::array::from_fn(|axis| b[axis] - a[axis]);
                    let ac: [f64; 3] = std::array::from_fn(|axis| c[axis] - a[axis]);
                    let cross = [
                        ab[1] * ac[2] - ab[2] * ac[1],
                        ab[2] * ac[0] - ab[0] * ac[2],
                        ab[0] * ac[1] - ab[1] * ac[0],
                    ];
                    let magnitude = cross.iter().map(|value| value * value).sum::<f64>().sqrt();
                    let normal = if magnitude > 0.0 {
                        cross.map(|value| (value / magnitude) as f32)
                    } else {
                        [0.0, 1.0, 0.0]
                    };
                    let start = geometry.vertices.len() as u32;
                    for (position, index) in [a, b, c].into_iter().zip(triangle) {
                        geometry.vertices.push(Vertex {
                            position: position.map(|value| value as f32),
                            normal,
                            uv: uvs.get(index as usize).copied().unwrap_or([0.0; 2]),
                            color: [255; 4],
                        });
                    }
                    geometry.faces.push([start, start + 1, start + 2]);
                }
            }
        }
    }
    geometry.bounds()?;
    Ok(geometry)
}

#[cfg(test)]
fn gltf_bounds(data: &[u8]) -> Result<MeshBounds, String> {
    parse_gltf(data)?.bounds()
}

/// Bounds use Roblox's default Studs import scale, preserving numeric distances.
/// glTF declares meters, but physical meters-to-studs rescaling would change existing uploads.
pub fn prepare_upload(
    data: &[u8],
    extension: &str,
    normalize_center: bool,
) -> Result<PreparedMesh, String> {
    let extension = extension.to_ascii_lowercase();
    let mut warnings = Vec::new();
    if matches!(extension.as_str(), "gltf" | "glb") {
        let mut geometry = parse_gltf(data)?;
        let source_bounds = geometry.bounds()?;
        if normalize_center {
            geometry.center(source_bounds);
        }
        let bounds = geometry.bounds()?;
        if normalize_center {
            warnings.push("Converted the default scene pose to static GLB geometry with centered vertex coordinates. Materials, rigging, animation, morph targets, vertex colors and smooth normals are not preserved".into());
        }
        return Ok(PreparedMesh {
            bytes: if normalize_center { glb(geometry)? } else { data.to_vec() },
            extension: if normalize_center { "glb".into() } else { extension },
            bounds,
            source_bounds,
            axis_conversion: "glTF right-handed +Y up, +Z front; XYZ axes preserved. glTF declares meters; local geometry conversion retains numeric distances (1 numeric unit = 1 stud), without physical-unit rescaling. Local source bounds describe the default scene pose".into(),
            warnings,
        });
    }
    let (mut geometry, axis_conversion) = match extension.as_str() {
        "obj" => (parse_obj(data)?, "OBJ has no declared axes or units; XYZ positions preserved as Roblox Y-up coordinates, 1 numeric unit = 1 stud".into()),
        "mesh" => (parse_roblox_mesh(data)?, "Roblox mesh XYZ coordinates preserved, +Y up, distances in studs".into()),
        "fbx" => parse_fbx(data)?,
        _ => return Err("Unsupported mesh format".into()),
    };
    let source_bounds = geometry.bounds()?;
    if normalize_center {
        geometry.center(source_bounds);
    }
    let bounds = geometry.bounds()?;
    let convert = extension != "fbx" || normalize_center;
    if convert {
        warnings.push("Converted to static GLB geometry. Materials, rigging and facial animation are not preserved".into());
    }
    Ok(PreparedMesh {
        bytes: if convert { glb(geometry)? } else { data.to_vec() },
        extension: if convert { "glb".into() } else { extension },
        bounds,
        source_bounds,
        axis_conversion,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    const SHIFTED_OBJ: &[u8] = b"v 10 20 30\nv 14 20 30\nv 10 26 38\nv 999 999 999\nf 1 2 3\n";

    #[test]
    fn bounds_measure_asymmetric_referenced_geometry_and_center_uploaded_positions() {
        let original = prepare_upload(SHIFTED_OBJ, "obj", false).expect("original");
        assert_eq!(original.bounds.min, [10.0, 20.0, 30.0].into());
        assert_eq!(original.bounds.max, [14.0, 26.0, 38.0].into());
        assert_eq!(original.bounds.center, [12.0, 23.0, 34.0].into());
        assert_eq!(original.bounds.size, [4.0, 6.0, 8.0].into());
        assert!(original.axis_conversion.contains("no declared axes or units"));
        let centered = prepare_upload(SHIFTED_OBJ, "obj", true).expect("centered");
        assert_eq!(centered.source_bounds, original.bounds);
        assert_eq!(centered.bounds.center, [0.0; 3].into());
        assert_eq!(centered.bounds.min, [-2.0, -3.0, -4.0].into());
        assert_eq!(gltf_bounds(&centered.bytes).expect("uploaded geometry"), centered.bounds);
        assert_ne!(centered.bytes, original.bytes);
    }

    #[test]
    fn gltf_normalization_bakes_scene_axis_transforms_into_centered_vertices() {
        let original = convert_to_glb(SHIFTED_OBJ, "obj").expect("fixture");
        let container = gltf::binary::Glb::from_slice(&original).expect("GLB");
        let mut document: serde_json::Value =
            serde_json::from_slice(&container.json).expect("document");
        document["nodes"][0]["translation"] = json!([2, 3, 4]);
        let half = std::f64::consts::FRAC_1_SQRT_2;
        document["nodes"][0]["rotation"] = json!([0.0, half, 0.0, half]);
        document["materials"] = json!([{"name":"Keep me"}]);
        let bytes = gltf::binary::Glb {
            header: container.header,
            json: std::borrow::Cow::Owned(serde_json::to_vec(&document).expect("JSON")),
            bin: container.bin,
        }
        .to_vec()
        .expect("GLB");
        let unchanged = prepare_upload(&bytes, "glb", false).expect("metadata");
        assert_eq!(unchanged.bytes, bytes, "default upload must preserve existing payload");
        assert!((unchanged.bounds.size.x - 8.0).abs() < 0.00001);
        assert!((unchanged.bounds.size.y - 6.0).abs() < 0.00001);
        assert!((unchanged.bounds.size.z - 4.0).abs() < 0.00001);
        let centered = prepare_upload(&bytes, "glb", true).expect("centered");
        let actual = gltf_bounds(&centered.bytes).expect("actual positions");
        assert!(
            actual.center.x.abs() < 0.00001
                && actual.center.y.abs() < 0.00001
                && actual.center.z.abs() < 0.00001
        );
        let encoded = gltf::binary::Glb::from_slice(&centered.bytes).expect("centered GLB");
        let encoded_document: serde_json::Value =
            serde_json::from_slice(&encoded.json).expect("JSON");
        assert_ne!(encoded.bin, gltf::binary::Glb::from_slice(&bytes).expect("GLB").bin);
        assert_eq!(encoded_document["materials"], serde_json::Value::Null);
        assert_eq!(encoded_document["nodes"][0], json!({"mesh":0}));
        for axis in 0..3 {
            let min = encoded_document["accessors"][0]["min"][axis].as_f64().expect("min");
            let max = encoded_document["accessors"][0]["max"][axis].as_f64().expect("max");
            assert!((min + max).abs() < 0.00001, "actual vertex accessor must be centered");
        }
    }

    #[test]
    fn gltf_normalization_bakes_the_skin_pose_into_centered_vertices() {
        let original = convert_to_glb(SHIFTED_OBJ, "obj").expect("fixture");
        let container = gltf::binary::Glb::from_slice(&original).expect("GLB");
        let mut document: serde_json::Value =
            serde_json::from_slice(&container.json).expect("JSON");
        let mut binary = container.bin.expect("buffer").into_owned();
        let joints_offset = binary.len();
        binary.extend_from_slice(&[0; 24]);
        let weights_offset = binary.len();
        for _ in 0..3 {
            for weight in [1.0f32, 0.0, 0.0, 0.0] {
                binary.extend_from_slice(&weight.to_le_bytes());
            }
        }
        document["buffers"][0]["byteLength"] = json!(binary.len());
        document["bufferViews"].as_array_mut().expect("views").extend([
            json!({"buffer":0,"byteOffset":joints_offset,"byteLength":24}),
            json!({"buffer":0,"byteOffset":weights_offset,"byteLength":48}),
        ]);
        document["accessors"].as_array_mut().expect("accessors").extend([
            json!({"bufferView":2,"componentType":5123,"count":3,"type":"VEC4"}),
            json!({"bufferView":3,"componentType":5126,"count":3,"type":"VEC4"}),
        ]);
        document["meshes"][0]["primitives"][0]["attributes"]["JOINTS_0"] = json!(5);
        document["meshes"][0]["primitives"][0]["attributes"]["WEIGHTS_0"] = json!(6);
        document["nodes"] =
            json!([{"mesh":0,"skin":0,"translation":[100,0,0]},{"translation":[2,3,4]}]);
        document["skins"] = json!([{"joints":[1]}]);
        document["scenes"][0]["nodes"] = json!([0, 1]);
        let bytes = gltf::binary::Glb {
            header: container.header,
            json: std::borrow::Cow::Owned(serde_json::to_vec(&document).expect("JSON")),
            bin: Some(std::borrow::Cow::Owned(binary)),
        }
        .to_vec()
        .expect("GLB");
        let prepared = prepare_upload(&bytes, "glb", true).expect("skin bounds");
        assert_eq!(prepared.source_bounds.center, [14.0, 26.0, 38.0].into());
        assert_eq!(prepared.source_bounds.size, [4.0, 6.0, 8.0].into());
        assert_eq!(
            gltf_bounds(&prepared.bytes).expect("centered joint pose").center,
            [0.0; 3].into()
        );
        let container = gltf::binary::Glb::from_slice(&prepared.bytes).expect("GLB");
        let document: serde_json::Value = serde_json::from_slice(&container.json).expect("JSON");
        assert_eq!(document["skins"], serde_json::Value::Null);
        assert_eq!(document["nodes"], json!([{"mesh":0}]));
    }

    fn fbx_fixture(up: i32, front: i32) -> Vec<u8> {
        let front_sign = if up == 1 { 1 } else { -1 };
        format!(
            r#"; FBX 7.4.0 project file
FBXHeaderExtension: {{ FBXHeaderVersion: 1003
 FBXVersion: 7400
}}
GlobalSettings: {{
 Properties70: {{
  P: "UpAxis", "int", "Integer", "",{up}
  P: "UpAxisSign", "int", "Integer", "",1
  P: "FrontAxis", "int", "Integer", "",{front}
  P: "FrontAxisSign", "int", "Integer", "",{front_sign}
  P: "CoordAxis", "int", "Integer", "",0
  P: "CoordAxisSign", "int", "Integer", "",1
  P: "UnitScaleFactor", "double", "Number", "",100
 }}
}}
Objects: {{
 Geometry: 1, "Geometry::triangle", "Mesh" {{
  Vertices: *9 {{ a: 10,20,30,14,20,30,10,26,38 }}
  PolygonVertexIndex: *3 {{ a: 0,1,-3 }}
 }}
 Model: 2, "Model::triangle", "Mesh" {{ Version: 232
  Properties70: {{ P: "Lcl Translation", "Lcl Translation", "", "A",2,3,4 }}
 }}
}}
Connections: {{
 C: "OO",1,2
 C: "OO",2,0
}}
"#
        )
        .into_bytes()
    }

    #[test]
    fn fbx_honors_declared_axes_and_node_translation_and_normalizes_real_geometry() {
        let source = fbx_fixture(1, 2);
        let original = prepare_upload(&source, "fbx", false).expect("FBX");
        assert_eq!(original.bytes, source, "default FBX remains passthrough");
        assert_eq!(original.bounds.size, [4.0, 6.0, 8.0].into());
        assert_eq!(original.bounds.center, [14.0, 26.0, 38.0].into());
        assert!(original.axis_conversion.contains("source unit=1 meters"));
        let centered = prepare_upload(&source, "fbx", true).expect("centered FBX");
        assert_eq!(centered.extension, "glb");
        assert_eq!(centered.bounds.center, [0.0; 3].into());
        assert_eq!(gltf_bounds(&centered.bytes).expect("centered uploaded bytes"), centered.bounds);
        let z_up = prepare_upload(&fbx_fixture(2, 1), "fbx", true).expect("Z-up FBX");
        assert_eq!(z_up.bounds.size, [4.0, 8.0, 6.0].into());
        assert_eq!(gltf_bounds(&z_up.bytes).expect("Z-up uploaded bytes"), z_up.bounds);
    }

    #[test]
    fn invalid_coordinates_do_not_produce_invented_bounds() {
        assert!(prepare_upload(b"v NaN 0 0\nf 1 1 1", "obj", true).is_err());
        assert!(prepare_upload(b"not an FBX", "fbx", true).is_err());
        assert!(MeshBounds::from_positions([[f64::INFINITY, 0.0, 0.0]]).is_err());
    }

    #[test]
    fn sparse_gltf_positions_are_measured_and_invalid_sparse_ranges_are_rejected() {
        let mut binary = vec![0u8, 1, 2, 0];
        for position in [[10.0f32, 20.0, 30.0], [14.0, 20.0, 30.0], [10.0, 26.0, 38.0]] {
            for value in position {
                binary.extend_from_slice(&value.to_le_bytes());
            }
        }
        let mut document = json!({
            "asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0]}],"nodes":[{"mesh":0}],
            "meshes":[{"primitives":[{"attributes":{"POSITION":0}}]}],
            "buffers":[{"byteLength":binary.len(),"uri":format!("data:application/octet-stream;base64,{}",base64::engine::general_purpose::STANDARD.encode(&binary))}],
            "bufferViews":[{"buffer":0,"byteLength":3},{"buffer":0,"byteOffset":4,"byteLength":36}],
            "accessors":[{"componentType":5126,"count":3,"type":"VEC3","min":[10,20,30],"max":[14,26,38],"sparse":{"count":3,"indices":{"bufferView":0,"componentType":5121},"values":{"bufferView":1}}}]
        });
        let original = serde_json::to_vec(&document).expect("JSON");
        let prepared = prepare_upload(&original, "gltf", true).expect("sparse geometry");
        assert_eq!(prepared.source_bounds.center, [12.0, 23.0, 34.0].into());
        assert_eq!(
            gltf_bounds(&prepared.bytes).expect("centered sparse geometry").center,
            [0.0; 3].into()
        );
        document["accessors"][0]["sparse"]["values"]["byteOffset"] = json!(usize::MAX);
        assert!(
            prepare_upload(&serde_json::to_vec(&document).expect("JSON"), "gltf", true).is_err()
        );
        document["accessors"][0]["sparse"]["values"]["byteOffset"] = json!(0);
        binary[2] = 4;
        document["buffers"][0]["uri"] = json!(format!(
            "data:application/octet-stream;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&binary)
        ));
        assert!(
            prepare_upload(&serde_json::to_vec(&document).expect("JSON"), "gltf", true).is_err()
        );
    }
    #[test]
    fn decodes_draco_in_version_seven_core_chunk() {
        // Google's Apache-2.0 Draco cube fixture: github.com/google/draco/testdata/cube_att.drc.
        let draco=hex::decode("445241434f0101010100000000000000080000000c000000020b000000000000002a00000003000000000000005f4b150100000000000000015506000000f3d453006e505506000000f3d453006e50000000000000000003ff000001010101000000000903000000020100000003090200000002010000000109030000000301010000000000000000000000000000803f0e0101020300000055250108ad120600000000000000cceeb256064500000000ff3f0000010100000000000000000000803f0c01010203000000591d551155110c000000000000005806355d2045df211d3ea48000000000ff0f000000020a01000b000000000130000000000000005505ad0a060000000000000025103a4a4d80ff010000fe07000820e0ff7f0000000200fe03ff030000ff010000").expect("fixture");
        let mut chunk = (draco.len() as u32).to_le_bytes().to_vec();
        chunk.extend_from_slice(&draco);
        let mut bytes = b"version 7.00\nCOREMESH".to_vec();
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&chunk);
        let result = convert_to_glb(&bytes, "mesh").expect("Draco geometry");
        assert_eq!(&result[..4], b"glTF");
    }
    #[test]
    fn obj_supports_negative_indices_and_triangulation() {
        let bytes = convert_to_glb(b"v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf -4 -3 -2 -1\n", "obj")
            .expect("OBJ");
        assert_eq!(&bytes[..4], b"glTF");
        let length = u32_at(&bytes, 12).expect("JSON size") as usize;
        let value: serde_json::Value =
            serde_json::from_slice(&bytes[20..20 + length]).expect("JSON");
        assert_eq!(value["accessors"][4]["count"], 6);
        assert!(convert_to_glb(b"v 0 0 0\nf 1 2 3", "obj").is_err());
    }
    #[test]
    fn parses_roblox_binary_versions_and_rejects_truncated_data() {
        for version in ["2.00", "3.01", "4.01", "5.00", "6.00"] {
            let mut vertices = Vec::new();
            for position in [[10.0f32, 20.0, 30.0], [14.0, 20.0, 30.0], [10.0, 26.0, 38.0]] {
                let mut vertex = [0; 40];
                for (axis, value) in position.into_iter().enumerate() {
                    vertex[axis * 4..axis * 4 + 4].copy_from_slice(&value.to_le_bytes());
                }
                vertices.extend_from_slice(&vertex);
            }
            let face = [0u32, 1, 2].into_iter().flat_map(u32::to_le_bytes).collect::<Vec<_>>();
            let mut body = Vec::new();
            if version == "6.00" {
                let mut core = 3u32.to_le_bytes().to_vec();
                core.extend_from_slice(&vertices);
                core.extend_from_slice(&1u32.to_le_bytes());
                core.extend_from_slice(&face);
                body.extend_from_slice(b"COREMESH");
                body.extend_from_slice(&1u32.to_le_bytes());
                body.extend_from_slice(&(core.len() as u32).to_le_bytes());
                body.extend_from_slice(&core);
            } else {
                let header_size = match version {
                    "2.00" => 12u16,
                    "3.01" => 16,
                    "5.00" => 32,
                    _ => 24,
                };
                body.resize(header_size as usize, 0);
                body[..2].copy_from_slice(&header_size.to_le_bytes());
                if matches!(version, "2.00" | "3.01") {
                    body[2] = 40;
                    body[3] = 12;
                }
                let offset = if version == "3.01" { 8 } else { 4 };
                body[offset..offset + 4].copy_from_slice(&3u32.to_le_bytes());
                body[offset + 4..offset + 8].copy_from_slice(&1u32.to_le_bytes());
                body.extend_from_slice(&vertices);
                body.extend_from_slice(&face);
            }
            let mut bytes = format!("version {version}\n").into_bytes();
            bytes.extend_from_slice(&body);
            assert!(convert_to_glb(&bytes, "mesh").is_ok(), "{version}");
            assert_eq!(roblox_bounds(&bytes).expect("bounds").center, [12.0, 23.0, 34.0].into());
            let prepared = prepare_upload(&bytes, "mesh", true).expect("centered Roblox mesh");
            assert_eq!(
                gltf_bounds(&prepared.bytes).expect("uploaded positions").center,
                [0.0; 3].into()
            );
            bytes.truncate(20);
            assert!(convert_to_glb(&bytes, "mesh").is_err());
        }
    }
}
