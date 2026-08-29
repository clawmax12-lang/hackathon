import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./env.js";
import { maybeOne, one } from "./db.js";

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function pathFor(storageKey: string): string {
  const abs = path.resolve(config.storageDir, storageKey);
  if (!abs.startsWith(path.resolve(config.storageDir))) throw new Error("path escape");
  return abs;
}

export async function putFile(storageKey: string, data: Buffer): Promise<string> {
  const abs = pathFor(storageKey);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, data);
  return abs;
}

export async function readFile(storageKey: string): Promise<Buffer> {
  return fs.readFile(pathFor(storageKey));
}

export async function exists(storageKey: string): Promise<boolean> {
  try {
    await fs.access(pathFor(storageKey));
    return true;
  } catch {
    return false;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
};

export function mimeFor(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export type AssetKind =
  | "scan_image"
  | "product_image"
  | "manual_pdf"
  | "source_snapshot"
  | "guide_video"
  | "guide_thumbnail"
  | "step_visual";

/** Store bytes and upsert the media_assets row; returns the asset id. */
export async function storeAsset(opts: {
  kind: AssetKind;
  storageKey: string;
  data: Buffer;
  sourceUrl?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  await putFile(opts.storageKey, opts.data);
  const checksum = sha256(opts.data);
  const existing = await maybeOne<{ id: string }>(
    "SELECT id FROM media_assets WHERE storage_key = $1",
    [opts.storageKey],
  );
  if (existing) {
    await one(
      `UPDATE media_assets SET byte_size = $2, checksum_sha256 = $3, mime_type = $4,
         source_url = COALESCE($5, source_url), metadata = COALESCE($6::jsonb, metadata)
       WHERE id = $1 RETURNING id`,
      [existing.id, opts.data.length, checksum, mimeFor(opts.storageKey), opts.sourceUrl ?? null, opts.metadata ? JSON.stringify(opts.metadata) : null],
    );
    return existing.id;
  }
  const row = await one<{ id: string }>(
    `INSERT INTO media_assets (kind, storage_key, source_url, mime_type, byte_size, checksum_sha256, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [opts.kind, opts.storageKey, opts.sourceUrl ?? null, mimeFor(opts.storageKey), opts.data.length, checksum, JSON.stringify(opts.metadata ?? {})],
  );
  return row.id;
}
