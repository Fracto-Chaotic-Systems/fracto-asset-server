import { MeshoptEncoder } from "meshoptimizer/encoder";
import { MeshoptDecoder } from "meshoptimizer/decoder";

const EXT = "EXT_meshopt_compression";
export function read_glb(bytes) {
  if (
    bytes.length < 28 ||
    bytes.readUInt32LE(0) !== 0x46546c67 ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length ||
    bytes.readUInt32LE(16) !== 0x4e4f534a
  )
    throw new Error("unsupported_optimization_glb");
  const end = 20 + bytes.readUInt32LE(12);
  if (
    end + 8 > bytes.length ||
    bytes.readUInt32LE(end + 4) !== 0x004e4942 ||
    end + 8 + bytes.readUInt32LE(end) !== bytes.length
  )
    throw new Error("unsupported_optimization_glb");
  return {
    json: JSON.parse(bytes.subarray(20, end).toString("utf8")),
    binary: bytes.subarray(end + 8),
  };
}
export function write_glb(json, binary) {
  const text = Buffer.from(JSON.stringify(json));
  const json_size = (text.length + 3) & ~3,
    bin_size = (binary.length + 3) & ~3;
  const bytes = Buffer.alloc(28 + json_size + bin_size);
  bytes.writeUInt32LE(0x46546c67, 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(json_size, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  bytes.fill(0x20, 20, 20 + json_size);
  text.copy(bytes, 20);
  bytes.writeUInt32LE(bin_size, 20 + json_size);
  bytes.writeUInt32LE(0x004e4942, 24 + json_size);
  binary.copy(bytes, 28 + json_size);
  return bytes;
}

// Lossless byte encoding only: no quantization, simplification, key removal,
// vertex reordering or texture conversion. Version 0 supports Three's decoder.
export async function optimize_glb(bytes) {
  const { json, binary } = read_glb(bytes);
  if (
    json.buffers?.length !== 1 ||
    json.buffers[0].uri ||
    json.extensionsUsed?.length ||
    json.extensionsRequired?.length ||
    json.bufferViews?.some((v) => v.buffer !== 0 || v.extensions)
  )
    throw new Error("unsupported_optimization_layout");
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  const images = new Set((json.images || []).map((i) => i.bufferView));
  const chunks = [];
  let offset = 0,
    compressed_views = 0;
  const put = (data) => {
    const aligned = (offset + 3) & ~3;
    if (aligned !== offset) chunks.push(Buffer.alloc(aligned - offset));
    chunks.push(data);
    offset = aligned + data.length;
    return aligned;
  };
  const original = structuredClone(json);
  for (const [index, view] of json.bufferViews.entries()) {
    const start = view.byteOffset || 0;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(view.byteLength) ||
      start < 0 ||
      view.byteLength < 1 ||
      start + view.byteLength > binary.length
    )
      throw new Error("invalid_optimization_view");
    const raw = binary.subarray(start, start + view.byteLength);
    const stride = view.byteStride || 4;
    if (!images.has(index) && stride % 4 === 0 && raw.length % stride === 0) {
      const count = raw.length / stride;
      const encoded = Buffer.from(
        MeshoptEncoder.encodeGltfBuffer(raw, count, stride, "ATTRIBUTES", 0),
      );
      const decoded = new Uint8Array(raw.length);
      MeshoptDecoder.decodeGltfBuffer(
        decoded,
        count,
        stride,
        encoded,
        "ATTRIBUTES",
        "NONE",
      );
      if (!raw.equals(Buffer.from(decoded)))
        throw new Error("optimization_not_lossless");
      if (encoded.length < raw.length) {
        view.buffer = 1;
        view.extensions = {
          [EXT]: {
            buffer: 0,
            byteOffset: put(encoded),
            byteLength: encoded.length,
            byteStride: stride,
            count,
            mode: "ATTRIBUTES",
            filter: "NONE",
          },
        };
        compressed_views++;
        continue;
      }
    }
    view.byteOffset = put(raw);
  }
  if (!compressed_views) throw new Error("optimization_no_savings");
  json.buffers = [
    { byteLength: offset },
    { ...original.buffers[0], extensions: { [EXT]: { fallback: true } } },
  ];
  json.extensionsUsed = [EXT];
  json.extensionsRequired = [EXT];
  const result = write_glb(json, Buffer.concat(chunks));
  if (result.length >= bytes.length) throw new Error("optimization_no_savings");
  return { bytes: result, compressed_views };
}
