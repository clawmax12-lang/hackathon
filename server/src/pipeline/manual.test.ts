import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathFor } from "../storage.js";
import {
  inspectManualRegion,
  validateNormalizedRegion,
} from "./manual.js";

const exec = promisify(execFile);

test("manual region inspection crops and enlarges a normalized page area", async () => {
  const documentId = randomUUID();
  const pageDir = pathFor(`pages/${documentId}/video`);
  const pagePath = path.join(pageDir, "p-1.png");
  await fs.mkdir(pageDir, { recursive: true });

  try {
    await exec(
      "ffmpeg",
      ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=white:s=100x80", "-frames:v", "1", pagePath],
      { timeout: 20_000 },
    );
    const crop = await inspectManualRegion(documentId, 1, {
      x0: 0.25,
      y0: 0.25,
      x1: 0.75,
      y1: 0.75,
    });

    assert.deepEqual(crop.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(crop.readUInt32BE(16), 2048);
    assert.equal(crop.readUInt32BE(20), 1638);
  } finally {
    await fs.rm(pathFor(`pages/${documentId}`), { recursive: true, force: true });
  }
});

test("manual region validation rejects unsafe coordinates", () => {
  assert.throws(
    () => validateNormalizedRegion({ x0: 0.5, y0: 0, x1: 0.5, y1: 1 }),
    /0 <= x0 < x1/,
  );
  assert.throws(
    () => validateNormalizedRegion({ x0: 0, y0: 0, x1: 0.02, y1: 1 }),
    /at least 3%/,
  );
});
