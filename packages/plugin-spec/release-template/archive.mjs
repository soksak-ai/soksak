import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const BLOCK = 512;

function octal(value, width) {
  const digits = value.toString(8);
  if (digits.length > width - 1) throw new Error(`tar numeric field overflow: ${value}`);
  return `${"0".repeat(width - digits.length - 1)}${digits}\0`;
}

function field(buffer, offset, width, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > width) throw new Error(`tar field too long: ${value}`);
  bytes.copy(buffer, offset);
}

function header(name, size, mode) {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar path exceeds 100 bytes: ${name}`);
  const out = Buffer.alloc(BLOCK);
  field(out, 0, 100, name);
  field(out, 100, 8, octal(mode, 8));
  field(out, 108, 8, octal(0, 8));
  field(out, 116, 8, octal(0, 8));
  field(out, 124, 12, octal(size, 12));
  field(out, 136, 12, octal(0, 12));
  out.fill(0x20, 148, 156);
  out[156] = 0x30;
  field(out, 257, 6, "ustar\0");
  field(out, 263, 2, "00");
  field(out, 265, 32, "root");
  field(out, 297, 32, "root");
  const checksum = out.reduce((sum, byte) => sum + byte, 0);
  field(out, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return out;
}

function safeRelative(relative) {
  if (typeof relative !== "string" || relative.length === 0) {
    throw new Error("archive path must be a non-empty string");
  }
  if (!/^[\x20-\x7e]+$/.test(relative) || relative.includes("\\") || relative.startsWith("/")) {
    throw new Error(`unsafe archive path: ${relative}`);
  }
  const parts = relative.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`unsafe archive path: ${relative}`);
  }
  return parts;
}

function compareNames(left, right) {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function collect(root, relative, out) {
  const parts = safeRelative(relative);
  const name = parts.join("/");
  const absolute = path.resolve(root, ...parts);
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  if (!absolute.startsWith(rootPrefix)) throw new Error(`archive path escapes root: ${relative}`);

  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`symbolic links are forbidden: ${name}`);
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(absolute).sort()) collect(root, `${name}/${child}`, out);
    return;
  }
  if (!stat.isFile()) throw new Error(`only regular files may be archived: ${name}`);
  out.push({ name, absolute, mode: stat.mode & 0o111 ? 0o755 : 0o644 });
}

export function createRegularFileArchive({ root, files }) {
  if (!Array.isArray(files) || files.length === 0) throw new Error("archive files must be non-empty");
  const entries = [];
  for (const relative of files) collect(root, relative, entries);
  entries.sort(compareNames);
  if (new Set(entries.map((entry) => entry.name)).size !== entries.length) {
    throw new Error("duplicate archive path");
  }

  const blocks = [];
  for (const entry of entries) {
    const bytes = fs.readFileSync(entry.absolute);
    blocks.push(header(entry.name, bytes.length, entry.mode), bytes);
    const padding = (BLOCK - (bytes.length % BLOCK)) % BLOCK;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(BLOCK * 2));

  const gzip = zlib.gzipSync(Buffer.concat(blocks), { level: 9, mtime: 0 });
  gzip.writeUInt32LE(0, 4);
  gzip[9] = 255;
  return gzip;
}

function parseOctal(block, offset, width, label) {
  const value = block.subarray(offset, offset + width).toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]*$/.test(value)) throw new Error(`invalid tar ${label}`);
  return Number.parseInt(value || "0", 8);
}

export function readRegularFileArchive(bytes) {
  const tar = zlib.gunzipSync(bytes);
  const entries = [];
  const seen = new Set();
  for (let offset = 0; offset + BLOCK <= tar.length; ) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;

    const storedChecksum = parseOctal(block, 148, 8, "checksum");
    const checksumBlock = Buffer.from(block);
    checksumBlock.fill(0x20, 148, 156);
    const actualChecksum = checksumBlock.reduce((sum, byte) => sum + byte, 0);
    if (storedChecksum !== actualChecksum) throw new Error("invalid tar checksum");

    const name = block.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    safeRelative(name);
    if (seen.has(name)) throw new Error(`duplicate archive path: ${name}`);
    seen.add(name);
    const size = parseOctal(block, 124, 12, "size");
    const type = String.fromCharCode(block[156]);
    if (type !== "0") throw new Error(`non-regular archive entry: ${name}`);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error(`truncated archive entry: ${name}`);
    entries.push({ name, size, type, data: tar.subarray(dataStart, dataEnd) });
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

export function inspectRegularFileArchive(bytes) {
  return readRegularFileArchive(bytes).map(({ name, size, type }) => ({ name, size, type }));
}

export function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
