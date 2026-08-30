import fs from "node:fs/promises";
import { one, query } from "../server/src/db.js";
import { renderVideo } from "../server/src/pipeline/render.js";
import { pathFor } from "../server/src/storage.js";

const ARTICLE_NUMBER = "10609002";
const PROMPT_VERSION = "tranered-hand-reviewed-v1";

async function assetExists(storageKey: string | null): Promise<boolean> {
  if (!storageKey) return false;
  try {
    await fs.access(pathFor(storageKey));
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const guide = await one<{
    id: string;
    title: string;
    step_count: number;
    video_status: string | null;
    duration_seconds: number | null;
    video_key: string | null;
    thumbnail_key: string | null;
  }>(
    `SELECT ag.id,ag.title,
            (SELECT count(*)::int FROM assembly_steps s WHERE s.guide_id=ag.id) AS step_count,
            gv.status::text AS video_status,gv.duration_seconds,
            va.storage_key AS video_key,ta.storage_key AS thumbnail_key
       FROM products p
       JOIN assembly_guides ag ON ag.product_id=p.id
       LEFT JOIN generated_videos gv ON gv.guide_id=ag.id
       LEFT JOIN media_assets va ON va.id=gv.video_asset_id
       LEFT JOIN media_assets ta ON ta.id=gv.thumbnail_asset_id
      WHERE regexp_replace(p.ikea_item_number,'\\D','','g')=$1
        AND ag.prompt_version=$2 AND ag.status='ready'
      ORDER BY ag.updated_at DESC LIMIT 1`,
    [ARTICLE_NUMBER, PROMPT_VERSION],
  );

  if (guide.step_count !== 8) throw new Error(`expected 8 TRANERED steps, found ${guide.step_count}`);
  if (
    guide.video_status === "ready"
    && await assetExists(guide.video_key)
    && await assetExists(guide.thumbnail_key)
  ) {
    console.log(JSON.stringify({
      hero: "TRANERED",
      guideId: guide.id,
      steps: guide.step_count,
      durationSeconds: guide.duration_seconds,
      videoUrl: `/api/assets/${guide.video_key}`,
      cache: "ready",
    }));
    return;
  }

  try {
    const result = await renderVideo(guide.id, (done, total, label) => {
      console.log(`HERO_VIDEO ${done}/${total} ${label}`);
    });
    console.log(JSON.stringify({
      hero: "TRANERED",
      guideId: guide.id,
      steps: guide.step_count,
      ...result,
      cache: "seeded",
    }));
  } catch (error) {
    await query(
      `UPDATE generated_videos SET status='failed',error_message=$2,updated_at=NOW()
        WHERE guide_id=$1 AND status<>'ready'`,
      [guide.id, String((error as Error).message).slice(0, 500)],
    ).catch(() => undefined);
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
