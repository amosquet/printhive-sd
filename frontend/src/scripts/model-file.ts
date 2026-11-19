/**
 * Client-side model readers shared by the preview worker and the slicing worker.
 * STL parsing mirrors the deployed PrintHive server validator (chunked binary or
 * strict line-oriented ASCII); OBJ support is added for FR-02 (.stl/.obj intake).
 * Only a small file slice is held at a time.
 */
import { PreviewError, type Limits } from '@time-estimator/browser-preview';
import { MAX_FILE_SIZE } from './file-validation.js';

export interface STLInfo { triangles: number; min: number[]; max: number[] }

const fail = () => { throw new Error('Invalid model file. Use a complete ASCII or binary STL, or a Wavefront OBJ with finite coordinates.'); };

function makeInfo(): STLInfo {
  return { triangles: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

function accept(info: STLInfo, vertices: number[], triangle?: (vertices: number[], index: number) => void) {
  for (let i = 0; i < 9; i++) {
    const n = vertices[i];
    if (!Number.isFinite(n) || Math.abs(n) > 1e12) fail();
    info.min[i % 3] = Math.min(info.min[i % 3], n);
    info.max[i % 3] = Math.max(info.max[i % 3], n);
  }
  triangle?.(vertices, info.triangles);
  info.triangles++;
}

export async function parseSTL(blob: Blob, triangle?: (vertices: number[], index: number) => void): Promise<STLInfo> {
  const info = makeInfo();
  const header = await blob.slice(0, 84).arrayBuffer();
  const count = header.byteLength === 84 ? new DataView(header).getUint32(80, true) : 0;
  if (count > 0 && 84 + count * 50 <= blob.size) {
    for (let first = 0; first < count; first += 1024) {
      const amount = Math.min(1024, count - first);
      const data = new DataView(await blob.slice(84 + first * 50, 84 + (first + amount) * 50).arrayBuffer());
      for (let i = 0; i < amount; i++) {
        const offset = i * 50;
        // STL normals are advisory. Orca recomputes damaged normals from the finite vertices.
        accept(info, Array.from({ length: 9 }, (_, j) => data.getFloat32(offset + 12 + j * 4, true)), triangle);
      }
    }
  } else {
    // Standard line-oriented ASCII STL; names following solid/endsolid may contain spaces.
    let pending = '', state = 0, vertices: number[] = [], opened = false, closed = false;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const number = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
    const normal = /^facet\s+normal\s+\S+\s+\S+\s+\S+$/i;
    const vertex = new RegExp(`^vertex\\s+(${number})\\s+(${number})\\s+(${number})$`, 'i');
    function line(raw: string) {
      const s = raw.trim();
      if (!s) return;
      if (s.length > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) fail();
      if (state === 0) {
        if (!/^solid(?:\s.*)?$/i.test(s)) fail();
        opened = true; closed = false; state = 1;
      } else if (state === 1) {
        if (/^endsolid(?:\s.*)?$/i.test(s)) { closed = true; state = 0; return; }
        const match = normal.exec(s);
        if (!match) fail();
        state = 2;
      } else if (state === 2) {
        if (!/^outer\s+loop$/i.test(s)) fail();
        vertices = []; state = 3;
      } else if (state >= 3 && state <= 5) {
        const match = vertex.exec(s);
        if (!match) fail();
        vertices.push(...match!.slice(1).map(Number)); state++;
      } else if (state === 6) {
        if (!/^endloop$/i.test(s)) fail();
        state = 7;
      } else {
        if (!/^endfacet$/i.test(s)) fail();
        accept(info, vertices, triangle); state = 1;
      }
    }
    for (let offset = 0; offset < blob.size; offset += 65536) {
      pending += decoder.decode(await blob.slice(offset, offset + 65536).arrayBuffer(), { stream: true });
      const lines = pending.split(/\r\n|\n|\r/);
      pending = lines.pop()!;
      for (const value of lines) line(value);
      if (pending.length > 4096) fail();
    }
    pending += decoder.decode();
    if (pending) line(pending);
    if (!opened || !closed || state !== 0) fail();
  }
  if (!info.triangles) fail();
  return info;
}

function objIndex(token: string, count: number): number {
  const slash = token.indexOf('/');
  const raw = Number(slash === -1 ? token : token.slice(0, slash));
  if (!Number.isInteger(raw) || raw === 0) fail();
  return raw > 0 ? raw - 1 : count + raw;
}

export async function parseOBJ(blob: Blob, triangle?: (vertices: number[], index: number) => void): Promise<STLInfo> {
  const info = makeInfo();
  const vertices: number[] = [];
  const text = await blob.text();
  const lines = text.split(/\r\n|\n|\r/);
  for (const raw of lines) {
    if (raw.startsWith('v ')) {
      const parts = raw.slice(2).trim().split(/\s+/);
      if (parts.length < 3) fail();
      const x = Number(parts[0]), y = Number(parts[1]), z = Number(parts[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) fail();
      vertices.push(x, y, z);
    } else if (raw.startsWith('f ')) {
      const tokens = raw.slice(2).trim().split(/\s+/);
      if (tokens.length < 3) fail();
      const indices = tokens.map((token) => objIndex(token, vertices.length / 3));
      for (let i = 1; i + 1 < indices.length; i++) {
        const a = indices[0] * 3, b = indices[i] * 3, c = indices[i + 1] * 3;
        for (const base of [a, b, c]) {
          if (base < 0 || base + 2 >= vertices.length) fail();
        }
        accept(info, [vertices[a], vertices[a + 1], vertices[a + 2], vertices[b], vertices[b + 1], vertices[b + 2], vertices[c], vertices[c + 1], vertices[c + 2]], triangle);
      }
    }
  }
  if (!info.triangles) fail();
  return info;
}

export function isOBJ(name: string): boolean {
  return /\.obj$/i.test(name);
}

export async function parseModelFile(blob: Blob, name: string, triangle?: (vertices: number[], index: number) => void): Promise<STLInfo> {
  return isOBJ(name) ? parseOBJ(blob, triangle) : parseSTL(blob, triangle);
}

/** Retain all source triangles. Small files never allocate the maximum mesh budget. */
export async function readFullMesh(file: Blob, name: string, limits: Limits) {
  if (!(file instanceof Blob) || file.size > MAX_FILE_SIZE)
    throw new PreviewError('mesh_limit', 'Choose a model file up to 50 MB.');
  const chunks: Float32Array[] = [];
  let chunk = new Float32Array(32768 * 9), used = 0;
  const info = await parseModelFile(file, name, (vertices, index) => {
    if (index >= limits.maxTriangles)
      throw new PreviewError('mesh_limit', 'This model exceeds the available browser memory budget.');
    if (used === chunk.length) {
      chunks.push(chunk);
      chunk = new Float32Array(32768 * 9);
      used = 0;
    }
    chunk.set(vertices, used);
    used += 9;
  });
  if (!chunks.length) return { positions: used === chunk.length ? chunk : chunk.slice(0, used) };
  const positions = new Float32Array(info.triangles * 9);
  let offset = 0;
  for (const part of chunks) {
    positions.set(part, offset);
    offset += part.length;
  }
  positions.set(chunk.subarray(0, used), offset);
  return { positions };
}
