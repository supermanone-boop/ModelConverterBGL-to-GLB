const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const ATTR_ORDER = ["COLOR_0", "NORMAL", "POSITION", "TANGENT", "TEXCOORD_0", "TEXCOORD_1"];
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readU32(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) throw new Error("BGL/GLB内の読み取り範囲が不正です。");
  return viewOf(bytes).getUint32(offset, true);
}

function readTag(bytes, offset) {
  return TEXT_DECODER.decode(bytes.subarray(offset, offset + 4));
}

function findBytes(bytes, needle, start, end) {
  const n = needle.length;
  for (let i = start; i + n <= end; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (bytes[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

function getModelDataRanges(bytes) {
  const ranges = [];
  if (bytes.length < 0x38 || readU32(bytes, 0) !== 0x19920201) return ranges;
  const sectionCount = readU32(bytes, 0x14);
  if (sectionCount > 4096 || 0x38 + sectionCount * 20 > bytes.length) return ranges;

  for (let i = 0; i < sectionCount; i++) {
    const section = 0x38 + i * 20;
    if (readU32(bytes, section) !== 0x2b) continue;
    const value = readU32(bytes, section + 4);
    const subCount = readU32(bytes, section + 8);
    const tableOffset = readU32(bytes, section + 12);
    const subSize = (((value & 0x10000) | 0x40000) >>> 14);
    if (!subCount || subCount > 100000 || subSize < 16 || tableOffset + subCount * subSize > bytes.length) continue;

    for (let j = 0; j < subCount; j++) {
      const sub = tableOffset + j * subSize;
      const dataOffset = readU32(bytes, sub + 8);
      const dataSize = readU32(bytes, sub + 12);
      if (dataSize > 0 && dataOffset >= 0x38 && dataOffset + dataSize <= bytes.length) {
        ranges.push({ start: dataOffset, end: dataOffset + dataSize });
      }
    }
  }
  return ranges;
}

function xmlAttribute(xml, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp("(?:^|\\s)" + escaped + "\\s*=\\s*[\\\"']([^\\\"']*)[\\\"']", "i"));
  return match ? match[1] : "";
}

function xmlLodNames(xml) {
  const names = [];
  const re = /<LOD\b([^>]*)\/?\s*>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const file = xmlAttribute(m[1], "ModelFile");
    const minSize = xmlAttribute(m[1], "MinSize");
    names.push({ file, minSize: minSize === "" ? null : Number(minSize) });
  }
  return names;
}

function parseEmbeddedGLB(bytes) {
  if (bytes.length < 20 || readTag(bytes, 0) !== "glTF") throw new Error("MDL内に有効なglTF 2.0データがありません。");
  const version = readU32(bytes, 4);
  const declaredLength = readU32(bytes, 8);
  if (version !== 2 || declaredLength < 20 || declaredLength > bytes.length) {
    throw new Error("埋め込みGLBのヘッダーまたはサイズが不正です。");
  }

  let cursor = 12;
  let json = null;
  let binary = new Uint8Array(0);
  while (cursor + 8 <= declaredLength) {
    const chunkLength = readU32(bytes, cursor);
    const chunkType = readTag(bytes, cursor + 4);
    const dataStart = cursor + 8;
    const dataEnd = dataStart + chunkLength;
    if (chunkLength > declaredLength || dataEnd > declaredLength) throw new Error("GLBチャンクのサイズが不正です。");
    if (chunkType === "JSON") {
      let jsonText = TEXT_DECODER.decode(bytes.subarray(dataStart, dataEnd));
      jsonText = jsonText.replace(/[\0\s]+$/g, "");
      json = JSON.parse(jsonText);
    } else if (chunkType === "BIN\0") {
      binary = bytes.slice(dataStart, dataEnd);
    }
    cursor = dataEnd;
    if (cursor % 4) cursor += 4 - (cursor % 4);
  }
  if (!json) throw new Error("GLBにJSONチャンクがありません。");
  if (!json.buffers || !json.buffers.length) throw new Error("GLBにbuffer定義がありません。");
  const requiredLength = json.buffers[0].byteLength || 0;
  if (binary.length < requiredLength) throw new Error(`GLBのBINが不足しています（必要 ${requiredLength} bytes / 実際 ${binary.length} bytes）。`);
  if (binary.length > requiredLength) binary = binary.slice(0, requiredLength);
  return { json, binary };
}

function parseGLBD(bytes, start, length, modelName, lodList, bglName, guid) {
  const models = [];
  const end = start + length;
  let cursor = start;
  let lodIndex = 0;
  while (cursor + 8 <= end) {
    const tag = readTag(bytes, cursor);
    const chunkLength = readU32(bytes, cursor + 4);
    const dataStart = cursor + 8;
    const dataEnd = dataStart + chunkLength;
    if (chunkLength <= 0 || dataEnd > end) break;

    if (tag === "GLB\0") {
      const glb = parseEmbeddedGLB(bytes.subarray(dataStart, dataEnd));
      const lodMeta = lodList[lodIndex] || {};
      models.push({
        modelName,
        lodIndex,
        lodFile: lodMeta.file || "",
        minSize: lodMeta.minSize,
        bglName,
        guid,
        glb
      });
      lodIndex++;
    }
    cursor = dataEnd;
    if (cursor % 2) cursor++;
  }
  return models;
}

function parseRiffModel(bytes, offset, regionEnd, bglName) {
  const riffSize = readU32(bytes, offset + 4);
  const riffEnd = offset + 8 + riffSize;
  if (riffEnd > regionEnd || riffEnd <= offset + 12 || readTag(bytes, offset + 8) !== "GLTF") return [];

  let cursor = offset + 12;
  let xml = "";
  const glbdChunks = [];
  while (cursor + 8 <= riffEnd) {
    const tag = readTag(bytes, cursor);
    const size = readU32(bytes, cursor + 4);
    const dataStart = cursor + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > riffEnd) break;
    if (tag === "GXML") {
      xml = TEXT_DECODER.decode(bytes.subarray(dataStart, dataEnd)).replace(/\0+$/g, "");
    } else if (tag === "GLBD") {
      glbdChunks.push({ start: dataStart, length: size });
    }
    cursor = dataEnd;
    if (cursor % 2) cursor++;
  }

  if (!glbdChunks.length) return [];
  const modelName = xmlAttribute(xml, "name") || `${bglName.replace(/\.bgl$/i, "")}_model`;
  const guid = xmlAttribute(xml, "guid");
  const lodList = xmlLodNames(xml);
  const output = [];
  for (const glbd of glbdChunks) {
    output.push(...parseGLBD(bytes, glbd.start, glbd.length, modelName, lodList, bglName, guid));
  }
  return output;
}

export function parseBGLModels(inputBytes, bglName = "input.BGL") {
  const bytes = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes);
  const ranges = getModelDataRanges(bytes);
  const scanRanges = ranges.length ? ranges : [{ start: 0, end: bytes.length }];
  const models = [];
  const seenOffsets = new Set();

  for (const range of scanRanges) {
    let cursor = range.start;
    while (cursor + 12 <= range.end) {
      const riff = findBytes(bytes, [0x52, 0x49, 0x46, 0x46], cursor, range.end);
      if (riff < 0) break;
      if (riff + 12 <= range.end && readTag(bytes, riff + 8) === "GLTF") {
        const parsed = parseRiffModel(bytes, riff, range.end, bglName);
        if (parsed.length && !seenOffsets.has(riff)) {
          seenOffsets.add(riff);
          models.push(...parsed);
        }
        const size = readU32(bytes, riff + 4);
        const after = riff + 8 + size;
        cursor = after > riff && after <= range.end ? after : riff + 4;
      } else {
        cursor = riff + 4;
      }
    }
  }
  return models;
}

function halfToFloat(bits) {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

function typeComponents(type) {
  const count = COMPONENTS[type];
  if (!count) throw new Error(`未対応のアクセサ型です: ${type}`);
  return count;
}

function componentByteSize(componentType) {
  switch (componentType) {
    case 5120: case 5121: return 1;
    case 5122: case 5123: return 2;
    case 5125: case 5126: return 4;
    default: throw new Error(`未対応のcomponentTypeです: ${componentType}`);
  }
}

function decodeAttribute(sourceAccessor, semantic, sourceViews, sourceBinary) {
  if (sourceAccessor.sparse) throw new Error(`sparse accessorは未対応です: ${semantic}`);
  if (!Number.isInteger(sourceAccessor.bufferView)) throw new Error(`bufferViewのない属性です: ${semantic}`);
  const bufferView = sourceViews[sourceAccessor.bufferView];
  if (!bufferView || (bufferView.buffer !== undefined && bufferView.buffer !== 0)) {
    throw new Error(`bufferView参照が不正です: ${semantic}`);
  }
  const sourceComponents = typeComponents(sourceAccessor.type);
  const outputComponents = semantic === "NORMAL" ? 3 : sourceComponents;
  const count = sourceAccessor.count;
  const componentSize = componentByteSize(sourceAccessor.componentType);
  const stride = bufferView.byteStride || componentSize * sourceComponents;
  const baseOffset = (bufferView.byteOffset || 0) + (sourceAccessor.byteOffset || 0);
  const sourceView = viewOf(sourceBinary);
  const outputType = new Uint8Array(count * outputComponents * 4);
  const outputView = new DataView(outputType.buffer);

  for (let i = 0; i < count; i++) {
    const vertexOffset = baseOffset + i * stride;
    if (semantic === "NORMAL" || semantic === "TANGENT") {
      if (sourceAccessor.componentType !== 5120 || sourceComponents < 3) {
        throw new Error(`${semantic}は3成分以上のsigned byte形式ではありません。`);
      }
      const f32 = Math.fround;
      const x = f32(sourceView.getInt8(vertexOffset) / 127);
      const y = f32(sourceView.getInt8(vertexOffset + 1) / 127);
      const z = f32(sourceView.getInt8(vertexOffset + 2) / 127);
      const lengthSquared = f32(f32(f32(x * x) + f32(y * y)) + f32(z * z));
      const length = f32(Math.sqrt(lengthSquared));
      const divisor = length > 0 ? length : 1;
      const out = i * outputComponents * 4;
      outputView.setFloat32(out, f32(x / divisor), true);
      outputView.setFloat32(out + 4, f32(y / divisor), true);
      outputView.setFloat32(out + 8, f32(z / divisor), true);
      if (semantic === "TANGENT" && outputComponents >= 4) {
        const w = sourceView.getInt8(vertexOffset + 3);
        outputView.setFloat32(out + 12, Math.max(-1, w / 127), true);
      }
      continue;
    }

    for (let c = 0; c < outputComponents; c++) {
      const at = vertexOffset + c * componentSize;
      let value;
      if (semantic === "POSITION") {
        if (sourceAccessor.componentType !== 5126) throw new Error("POSITIONはfloat32形式ではありません。");
        value = sourceView.getFloat32(at, true);
      } else if (semantic.startsWith("TEXCOORD_") || semantic === "COLOR_0") {
        if (sourceAccessor.componentType !== 5122 && sourceAccessor.componentType !== 5123) {
          throw new Error(`${semantic}は16bit half-float形式ではありません。`);
        }
        value = halfToFloat(sourceView.getUint16(at, true));
      } else {
        throw new Error(`未対応の頂点属性です: ${semantic}`);
      }
      outputView.setFloat32((i * outputComponents + c) * 4, value, true);
    }
  }

  return {
    bytes: outputType,
    accessor: {
      bufferView: -1,
      componentType: 5126,
      count,
      type: semantic === "NORMAL" ? "VEC3" : sourceAccessor.type,
      ...(sourceAccessor.name ? { name: sourceAccessor.name } : {}),
      ...(semantic === "POSITION" && sourceAccessor.min ? { min: sourceAccessor.min } : {}),
      ...(semantic === "POSITION" && sourceAccessor.max ? { max: sourceAccessor.max } : {})
    }
  };
}

function readIndexValue(dataView, offset, componentType) {
  if (componentType === 5121) return dataView.getUint8(offset);
  if (componentType === 5123) return dataView.getUint16(offset, true);
  if (componentType === 5125) return dataView.getUint32(offset, true);
  throw new Error(`未対応のindex componentTypeです: ${componentType}`);
}

function makePrimitiveIndexAccessor(sourceAccessor, sourceViews, sourceBinary, sourcePrimitive) {
  const accessor = { ...sourceAccessor };
  const range = sourcePrimitive.extras && sourcePrimitive.extras.ASOBO_primitive;
  if (!range || !Number.isInteger(range.PrimitiveCount)) return accessor;

  const startIndex = Number.isInteger(range.StartIndex) ? range.StartIndex : 0;
  const indexCount = range.PrimitiveCount * 3;
  if (startIndex < 0 || indexCount < 0 || startIndex + indexCount > sourceAccessor.count) {
    throw new Error(`プリミティブのindex範囲が不正です（StartIndex=${startIndex}, PrimitiveCount=${range.PrimitiveCount}, accessor.count=${sourceAccessor.count}）。`);
  }
  const sourceBufferView = sourceViews[sourceAccessor.bufferView];
  if (!sourceBufferView || (sourceBufferView.buffer !== undefined && sourceBufferView.buffer !== 0)) {
    throw new Error("index bufferView参照が不正です。");
  }
  const componentSize = componentByteSize(sourceAccessor.componentType);
  const indexByteOffset = (sourceAccessor.byteOffset || 0) + startIndex * componentSize;
  const absoluteOffset = (sourceBufferView.byteOffset || 0) + indexByteOffset;
  const view = viewOf(sourceBinary);
  let minimum = Infinity;
  let maximum = -Infinity;
  for (let i = 0; i < indexCount; i++) {
    const value = readIndexValue(view, absoluteOffset + i * componentSize, sourceAccessor.componentType);
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  accessor.byteOffset = indexByteOffset;
  accessor.count = indexCount;
  accessor.min = [minimum];
  accessor.max = [maximum];
  return accessor;
}

class BinaryAppender {
  constructor(initialBytes) {
    this.parts = [initialBytes];
    this.length = initialBytes.length;
  }

  append(bytes, alignment = 4) {
    const padLength = (alignment - (this.length % alignment)) % alignment;
    if (padLength) {
      this.parts.push(new Uint8Array(padLength));
      this.length += padLength;
    }
    const offset = this.length;
    this.parts.push(bytes);
    this.length += bytes.length;
    return { offset, byteLength: bytes.length };
  }

  finish() {
    const paddedLength = (this.length + 3) & ~3;
    const out = new Uint8Array(paddedLength);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

function cloneJSONValue(value) {
  if (Array.isArray(value)) return value.map(cloneJSONValue);
  if (value && typeof value === "object") {
    const clone = {};
    for (const [key, child] of Object.entries(value)) clone[key] = cloneJSONValue(child);
    return clone;
  }
  return value;
}

function mergeIntoExtras(target, key, value) {
  target.extras = target.extras && typeof target.extras === "object" ? target.extras : {};
  target.extras[key] = { ...(target.extras[key] || {}), ...value };
}

function moveExtensionsToExtras(target, key = "MSFS_extensions") {
  if (!target.extensions || !Object.keys(target.extensions).length) return;
  mergeIntoExtras(target, key, target.extensions);
  delete target.extensions;
}

function normalizeMSFSMetadata(json) {
  json.asset = json.asset || { version: "2.0" };
  json.asset.generator = "RJBE GeoFS BGL conversion pipeline (reference-aligned)";
  moveExtensionsToExtras(json.asset);

  let scaleChanged = false;
  for (const node of json.nodes || []) {
    if (!Array.isArray(node.scale) || node.scale.length !== 3) continue;
    const original = node.scale.slice();
    let sum = 0;
    let compensation = 0;
    for (const value of original) {
      const adjusted = value - compensation;
      const next = sum + adjusted;
      compensation = (next - sum) - adjusted;
      sum = next;
    }
    const average = sum / 3;
    const uniform = [average, average, average];
    if (Math.max(...original) - Math.min(...original) > 1e-7) {
      node.scale = uniform;
      node.extras = node.extras && typeof node.extras === "object" ? node.extras : {};
      node.extras.MSFS_original_scale = original;
      scaleChanged = true;
    }
  }
  if (scaleChanged) {
    json.extras = json.extras && typeof json.extras === "object" ? json.extras : {};
    json.extras.MSFS_scale_restore = "arithmetic_mean_uniform_scale";
  }

  for (const material of json.materials || []) moveExtensionsToExtras(material);

  for (const mesh of json.meshes || []) {
    for (const primitive of mesh.primitives || []) {
      const sourcePrimitive = primitive.extras && primitive.extras.ASOBO_primitive;
      if (sourcePrimitive) {
        const range = { ...sourcePrimitive };
        if (range.StartIndex === undefined) range.StartIndex = 0;
        primitive.extras = { ...(primitive.extras || {}) };
        delete primitive.extras.ASOBO_primitive;
        primitive.extras.MSFS_source_primitive_range = range;
      }
    }
  }

  for (const texture of json.textures || []) {
    const ddsSource = texture.extensions && texture.extensions.MSFT_texture_dds && texture.extensions.MSFT_texture_dds.source;
    if (Number.isInteger(ddsSource)) texture.source = ddsSource;
    if (texture.extensions) {
      const remainder = { ...texture.extensions };
      delete remainder.MSFT_texture_dds;
      if (Object.keys(remainder).length) mergeIntoExtras(texture, "MSFS_extensions", remainder);
      delete texture.extensions;
    }
  }
  json.extensionsUsed = [];
  json.extensionsRequired = [];
}

function sanitizeTexturePath(path) {
  const normalized = String(path || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const sceneryIndex = normalized.toLowerCase().indexOf("scenery/");
  if (sceneryIndex >= 0) return normalized.slice(sceneryIndex);
  const pieces = normalized.split("/").filter(Boolean);
  return pieces.length > 1 ? pieces.slice(1).join("/") : normalized;
}

function mimeForPath(path) {
  const lower = String(path).toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function rgb565(value) {
  const r5 = (value >>> 11) & 31;
  const g6 = (value >>> 5) & 63;
  const b5 = value & 31;
  return [((r5 << 3) | (r5 >>> 2)), ((g6 << 2) | (g6 >>> 4)), ((b5 << 3) | (b5 >>> 2)), 255];
}

export async function decodeDdsDxt1ToPng(bytes) {
  if (readTag(bytes, 0) !== "DDS ") throw new Error("DDSヘッダーがありません。");
  const header = viewOf(bytes);
  const height = header.getUint32(12, true);
  const width = header.getUint32(16, true);
  const fourCC = readTag(bytes, 84);
  if (fourCC !== "DXT1") throw new Error(`DDS形式 ${fourCC} は未対応です（現在はDXT1）。`);
  if (!width || !height || width > 16384 || height > 16384) throw new Error("DDSの画像サイズが不正です。");

  const blocksWide = Math.ceil(width / 4);
  const blocksHigh = Math.ceil(height / 4);
  const topMipLength = blocksWide * blocksHigh * 8;
  const dataOffset = 128;
  if (dataOffset + topMipLength > bytes.length) throw new Error("DDSのトップミップデータが不足しています。");

  const rgba = new Uint8ClampedArray(width * height * 4);
  const data = viewOf(bytes);
  let blockOffset = dataOffset;
  for (let by = 0; by < blocksHigh; by++) {
    for (let bx = 0; bx < blocksWide; bx++) {
      const c0 = data.getUint16(blockOffset, true);
      const c1 = data.getUint16(blockOffset + 2, true);
      const indices = data.getUint32(blockOffset + 4, true);
      const color0 = rgb565(c0);
      const color1 = rgb565(c1);
      let color2, color3;
      if (c0 > c1) {
        color2 = [0, 1, 2].map(i => Math.floor((2 * color0[i] + color1[i]) / 3)).concat(255);
        color3 = [0, 1, 2].map(i => Math.floor((color0[i] + 2 * color1[i]) / 3)).concat(255);
      } else {
        color2 = [0, 1, 2].map(i => Math.floor((color0[i] + color1[i]) / 2)).concat(255);
        color3 = [0, 0, 0, 0];
      }
      const palette = [color0, color1, color2, color3];
      for (let py = 0; py < 4; py++) {
        const y = by * 4 + py;
        if (y >= height) continue;
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          if (x >= width) continue;
          const selector = (indices >>> (2 * (py * 4 + px))) & 3;
          const color = palette[selector];
          const out = (y * width + x) * 4;
          rgba[out] = color[0];
          rgba[out + 1] = color[1];
          rgba[out + 2] = color[2];
          rgba[out + 3] = color[3];
        }
      }
      blockOffset += 8;
    }
  }

  if (typeof document === "undefined") throw new Error("DDS→PNG変換にはブラウザのCanvasが必要です。");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("Canvasを初期化できませんでした。");
  const imageData = context.createImageData(width, height);
  imageData.data.set(rgba);
  context.putImageData(imageData, 0, 0);
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(result => result ? resolve(result) : reject(new Error("PNG画像の生成に失敗しました。")), "image/png");
  });
  canvas.width = 1;
  canvas.height = 1;
  return new Uint8Array(await blob.arrayBuffer());
}

function buildGLB(json, binary, declaredBufferLength = binary.length) {
  json.buffers = json.buffers && json.buffers.length ? json.buffers : [{ byteLength: declaredBufferLength }];
  json.buffers[0].byteLength = declaredBufferLength;
  delete json.buffers[0].uri;

  const jsonText = JSON.stringify(json, (_key, value) => Object.is(value, -0) ? "__BGL_GLB_NEGATIVE_ZERO__" : value)
    .replace(/"__BGL_GLB_NEGATIVE_ZERO__"/g, "-0");
  const jsonBytes = TEXT_ENCODER.encode(jsonText);
  const jsonPaddedLength = (jsonBytes.length + 3) & ~3;
  const binPaddedLength = (binary.length + 3) & ~3;
  const totalLength = 12 + 8 + jsonPaddedLength + 8 + binPaddedLength;
  const output = new Uint8Array(totalLength);
  const data = viewOf(output);
  data.setUint32(0, 0x46546c67, true);
  data.setUint32(4, 2, true);
  data.setUint32(8, totalLength, true);
  data.setUint32(12, jsonPaddedLength, true);
  output.set([0x4a, 0x53, 0x4f, 0x4e], 16);
  output.set(jsonBytes, 20);
  output.fill(0x20, 20 + jsonBytes.length, 20 + jsonPaddedLength);
  const binHeader = 20 + jsonPaddedLength;
  data.setUint32(binHeader, binPaddedLength, true);
  output.set([0x42, 0x49, 0x4e, 0x00], binHeader + 4);
  output.set(binary, binHeader + 8);
  return output;
}

export async function convertModelToGLB(model, findAsset, options = {}) {
  const json = cloneJSONValue(model.glb.json);
  const originalAccessors = json.accessors.slice();
  const originalViews = json.bufferViews.slice();
  const appender = new BinaryAppender(model.glb.binary.slice());

  let processedMeshes = 0;
  for (const mesh of json.meshes || []) {
    const cache = new Map();
    for (const primitive of mesh.primitives || []) {
      const attributes = primitive.attributes || {};
      for (const semantic of ATTR_ORDER) {
        const sourceIndex = attributes[semantic];
        if (!Number.isInteger(sourceIndex)) continue;
        const key = `${semantic}:${sourceIndex}`;
        let outputIndex = cache.get(key);
        if (outputIndex === undefined) {
          const sourceAccessor = originalAccessors[sourceIndex];
          if (!sourceAccessor) throw new Error(`アクセサ${sourceIndex}が見つかりません。`);
          const converted = decodeAttribute(sourceAccessor, semantic, originalViews, model.glb.binary);
          const viewInfo = appender.append(converted.bytes, 4);
          const viewIndex = json.bufferViews.length;
          json.bufferViews.push({ buffer: 0, byteOffset: viewInfo.offset, byteLength: viewInfo.byteLength, target: 34962 });
          converted.accessor.bufferView = viewIndex;
          outputIndex = json.accessors.length;
          json.accessors.push(converted.accessor);
          cache.set(key, outputIndex);
        }
        attributes[semantic] = outputIndex;
      }
    }
    processedMeshes++;
    if (options.onProgress && processedMeshes % 40 === 0) {
      options.onProgress({ phase: "geometry", current: processedMeshes, total: json.meshes.length });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  // Keep each primitive's own index accessor, while reusing the original index bufferView.
  for (let meshIndex = 0; meshIndex < (json.meshes || []).length; meshIndex++) {
    const sourceMesh = model.glb.json.meshes[meshIndex];
    const outputMesh = json.meshes[meshIndex];
    for (let primitiveIndex = 0; primitiveIndex < (outputMesh.primitives || []).length; primitiveIndex++) {
      const sourcePrimitive = sourceMesh.primitives[primitiveIndex];
      const outputPrimitive = outputMesh.primitives[primitiveIndex];
      if (Number.isInteger(sourcePrimitive.indices)) {
        const sourceIndexAccessor = originalAccessors[sourcePrimitive.indices];
        if (!sourceIndexAccessor) throw new Error("indicesアクセサが見つかりません。");
        outputPrimitive.indices = json.accessors.length;
        json.accessors.push(makePrimitiveIndexAccessor(
          sourceIndexAccessor,
          originalViews,
          model.glb.binary,
          sourcePrimitive
        ));
      }
    }
  }

  normalizeMSFSMetadata(json);

  const sourceImages = json.images || [];
  for (let index = 0; index < sourceImages.length; index++) {
    const image = sourceImages[index];
    if (!image.uri) continue;
    const resolved = await findAsset(image.uri);
    if (!resolved || !resolved.bytes) throw new Error(`テクスチャが見つかりません: ${image.uri}`);

    const lowerPath = String(resolved.path || image.uri).toLowerCase();
    let imageBytes;
    let mimeType;
    if (lowerPath.endsWith(".dds")) {
      imageBytes = await (options.decodeDds || decodeDdsDxt1ToPng)(resolved.bytes);
      mimeType = "image/png";
    } else {
      imageBytes = resolved.bytes;
      mimeType = mimeForPath(resolved.path || image.uri);
      if (mimeType === "application/octet-stream") throw new Error(`未対応の画像形式です: ${image.uri}`);
    }

    const viewInfo = appender.append(imageBytes, 4);
    const viewIndex = json.bufferViews.length;
    json.bufferViews.push({ buffer: 0, byteOffset: viewInfo.offset, byteLength: viewInfo.byteLength });
    const previousExtras = image.extras;
    const extras = previousExtras && typeof previousExtras === "object" ? { ...previousExtras } : {};
    if (typeof previousExtras === "string") extras.MSFS_original_extras = previousExtras;
    extras.MSFS_source_texture = sanitizeTexturePath(resolved.path || image.uri);
    image.bufferView = viewIndex;
    image.mimeType = mimeType;
    image.extras = extras;
    delete image.uri;
    if (options.onProgress) options.onProgress({ phase: "textures", current: index + 1, total: sourceImages.length });
  }

  const outputBinary = appender.finish();
  const output = buildGLB(json, outputBinary, appender.length);
  return { bytes: output, json, binaryBytes: appender.length };
}

export function modelOutputName(model) {
  const base = String(model.modelName || "model").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, "_");
  return model.lodIndex > 0 ? `${base}_LOD${String(model.lodIndex).padStart(2, "0")}.glb` : `${base}.glb`;
}
