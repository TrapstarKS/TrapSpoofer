use serde_json::json;
use std::collections::HashMap;

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

#[cfg(test)]
mod tests {
    use super::*;
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
            for _ in 0..3 {
                vertices.extend_from_slice(&[0; 40]);
            }
            let mut body = Vec::new();
            if version == "6.00" {
                let mut core = 3u32.to_le_bytes().to_vec();
                core.extend_from_slice(&vertices);
                core.extend_from_slice(&1u32.to_le_bytes());
                core.extend_from_slice(&[0; 12]);
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
                body.extend_from_slice(&[0; 12]);
            }
            let mut bytes = format!("version {version}\n").into_bytes();
            bytes.extend_from_slice(&body);
            assert!(convert_to_glb(&bytes, "mesh").is_ok(), "{version}");
            bytes.truncate(20);
            assert!(convert_to_glb(&bytes, "mesh").is_err());
        }
    }
}
