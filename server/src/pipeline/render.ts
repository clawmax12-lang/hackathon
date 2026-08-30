import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import pLimit from "p-limit";
import { query, maybeOne, one } from "../db.js";
import { pathFor } from "../storage.js";
import { storeAsset } from "../storage.js";
import { audioDurationSeconds } from "./narration.js";
import { listPageFiles } from "./manual.js";
import { generateStepClip } from "./animate.js";

const exec = promisify(execFile);

function installedFont(name: "Bold" | "Regular"): string {
  const candidates = [
    // Debian/Ubuntu (fonts-liberation / fonts-liberation2)
    `/usr/share/fonts/truetype/liberation2/LiberationSans-${name}.ttf`,
    `/usr/share/fonts/liberation-sans/LiberationSans-${name}.ttf`,
    `/usr/share/fonts/truetype/liberation/LiberationSans-${name}.ttf`,
    // Fedora/RHEL
    `/usr/share/fonts/liberation/LiberationSans-${name}.ttf`,
    // macOS Homebrew (brew install --cask font-liberation)
    `/opt/homebrew/Caskroom/font-liberation/*/LiberationSans-${name}.ttf`,
    `${process.env.HOME ?? ""}/Library/Fonts/LiberationSans-${name}.ttf`,
    `/Library/Fonts/LiberationSans-${name}.ttf`,
  ];
  for (const candidate of candidates) {
    if (candidate.includes("*")) {
      const [dir, rest] = candidate.split("*");
      try {
        const match = fsSync.readdirSync(dir).find((entry) => fsSync.existsSync(path.join(dir, entry, rest.replace(/^\//, ""))));
        if (match) return path.join(dir, match, rest.replace(/^\//, ""));
      } catch {
        /* dir doesn't exist on this platform — try the next candidate */
      }
      continue;
    }
    if (fsSync.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Liberation Sans ${name} is not installed. Install it: apt-get install fonts-liberation (Debian/Ubuntu), ` +
      `dnf install liberation-sans-fonts (Fedora/RHEL), or brew install --cask font-liberation (macOS).`,
  );
}

const FONT = installedFont("Bold");
const FONT_REGULAR = installedFont("Regular");
const PAPER = "0xf7f4ee";
const INK = "0x1a1c20";
const AMBER = "0xb45309";
const FPS = 30;

function wrap(text: string, width: number, maxLines: number): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width && cur) {
      lines.push(cur.trim());
      cur = w;
      if (lines.length === maxLines) break;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur.trim());
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length + cur.length) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{3}$/, "…");
  }
  return lines.join("\n");
}

async function imageSize(file: string): Promise<{ w: number; h: number }> {
  const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], {
    timeout: 20000,
  });
  const [w, h] = stdout.trim().split(",").map(Number);
  return { w, h };
}

interface SceneSpec {
  name: string;
  imagePath: string | null; // null -> plain paper card
  videoPath: string | null; // animated clip for this step; takes priority over imagePath
  audioPath: string | null;
  titleText: string; // headline overlay
  captionText: string; // smaller body text
  safetyText: string | null;
  focusRegion: "top" | "center" | "bottom" | "full";
  narrationSeconds: number;
}

async function buildScene(scene: SceneSpec, workDir: string, index: number): Promise<string> {
  const D = Math.max(3.5, scene.narrationSeconds + 0.9);
  const frames = Math.round(D * FPS);
  const out = path.join(workDir, `scene-${String(index).padStart(2, "0")}.mp4`);

  const titleFile = path.join(workDir, `t-${index}.txt`);
  const capFile = path.join(workDir, `c-${index}.txt`);
  await fs.writeFile(titleFile, scene.titleText);
  await fs.writeFile(capFile, scene.captionText);

  const filters: string[] = [];
  let vin: string;

  if (scene.videoPath) {
    // Already-animated clip (real motion, no zoompan needed) — fit it onto
    // the same 4K work canvas as the manual-page path so downstream filters
    // and concat params stay identical either way.
    filters.push(
      `[0:v]scale=3840:2160:flags=lanczos:force_original_aspect_ratio=decrease,pad=3840:2160:(ow-iw)/2:(oh-ih)/2:color=${PAPER},fps=${FPS}[zoomed]`,
    );
    vin = "[zoomed]";
  } else if (scene.imagePath) {
    const { w, h } = await imageSize(scene.imagePath);
    if (scene.focusRegion === "full") {
      filters.push(`[0:v]scale=-2:2160:flags=lanczos,pad=3840:2160:(ow-iw)/2:0:color=${PAPER}[base]`);
    } else {
      // scale to 3840 wide, crop a 16:9 band from the requested page region
      const scaledH = Math.round((h / w) * 3840);
      const cropY = scene.focusRegion === "top" ? 0 : scene.focusRegion === "bottom" ? Math.max(0, scaledH - 2160) : Math.max(0, Math.round((scaledH - 2160) / 2));
      if (scaledH <= 2160) {
        filters.push(`[0:v]scale=3840:-2:flags=lanczos,pad=3840:2160:0:(oh-ih)/2:color=${PAPER}[base]`);
      } else {
        filters.push(`[0:v]scale=3840:-2:flags=lanczos,crop=3840:2160:0:${cropY}[base]`);
      }
    }
    filters.push(
      `[base]zoompan=z='1+0.10*on/${frames}':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=${frames}:s=1920x1080:fps=${FPS}[zoomed]`,
    );
    vin = "[zoomed]";
  } else {
    filters.push(`color=c=${PAPER}:s=1920x1080:r=${FPS}:d=${D}[zoomed]`);
    vin = "[zoomed]";
  }

  // headline. The no-image (intro/outro) title wraps up to 2 lines at a large
  // font — centering title and caption independently around the frame's
  // vertical middle let a 2-line title's box grow into the caption's fixed
  // offset. Anchor both from a fixed top position instead, with a gap sized
  // for the worst-case (2-line) title height, so they never collide.
  const hasVisual = Boolean(scene.videoPath || scene.imagePath);
  filters.push(
    `${vin}drawtext=fontfile=${FONT}:textfile='${titleFile}':fontsize=${hasVisual ? 56 : 84}:fontcolor=${INK}:box=1:boxcolor=${PAPER}@0.92:boxborderw=20:x=72:y=${hasVisual ? 64 : 220}:line_spacing=14[v1]`,
  );
  // caption
  filters.push(
    `[v1]drawtext=fontfile=${FONT_REGULAR}:textfile='${capFile}':fontsize=40:fontcolor=${INK}:box=1:boxcolor=${PAPER}@0.88:boxborderw=18:x=72:y=${hasVisual ? "h-text_h-84" : 470}:line_spacing=12[v2]`,
  );
  let last = "[v2]";
  if (scene.safetyText) {
    const sFile = path.join(workDir, `s-${index}.txt`);
    await fs.writeFile(sFile, scene.safetyText);
    filters.push(
      `[v2]drawtext=fontfile=${FONT}:textfile='${sFile}':fontsize=38:fontcolor=0xffffff:box=1:boxcolor=${AMBER}@0.94:boxborderw=16:x=72:y=170:line_spacing=10[v3]`,
    );
    last = "[v3]";
  }
  filters.push(`${last}fade=t=in:d=0.3,fade=t=out:st=${(D - 0.35).toFixed(2)}:d=0.3,format=yuv420p[vout]`);

  // audio: pad/delay narration to scene length; silence if no narration
  const audioInput = scene.audioPath ? ["-i", scene.audioPath] : ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"];
  filters.push(`[1:a]adelay=400|400,apad,aresample=44100,aformat=channel_layouts=stereo[aout]`);

  const args = [
    "-y",
    ...(scene.videoPath
      ? ["-stream_loop", "-1", "-i", scene.videoPath]
      : scene.imagePath
        ? ["-loop", "1", "-i", scene.imagePath]
        : ["-f", "lavfi", "-i", `color=c=${PAPER}:s=16x16:r=${FPS}`]),
    ...audioInput,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-t",
    D.toFixed(2),
    "-r",
    String(FPS),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "44100",
    out,
  ];
  await exec("ffmpeg", args, { timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  return out;
}

export interface RenderResult {
  video_url: string;
  thumbnail_url: string;
  duration_seconds: number;
}

export async function renderVideo(
  guideId: string,
  onProgress: (done: number, total: number, label: string) => void,
): Promise<RenderResult> {
  const guide = await one<{ id: string; product_id: string; manual_document_id: string | null; title: string; summary: string | null }>(
    "SELECT id, product_id, manual_document_id, title, summary FROM assembly_guides WHERE id = $1",
    [guideId],
  );
  const product = await one<{ name: string }>("SELECT name FROM products WHERE id = $1", [guide.product_id]);
  const steps = await query<{
    step_number: number;
    title: string;
    instruction: string;
    safety_warning: string | null;
    estimated_seconds: number | null;
    manual_pages: number[] | null;
    parts: string[] | null;
    tools: string[] | null;
    focus_region: string | null;
    visual_prompt: string | null;
  }>(
    `SELECT step_number, title, instruction, safety_warning, estimated_seconds, manual_pages, parts, tools, visual_prompt,
            to_jsonb(assembly_steps)->>'focus_region' AS focus_region
       FROM assembly_steps WHERE guide_id = $1 ORDER BY step_number`,
    [guideId],
  );
  if (steps.length === 0) throw new Error("guide has no steps");

  await query(
    `INSERT INTO generated_videos (guide_id, status, generator_provider, generator_model)
     VALUES ($1, 'generating', 'monterra-ffmpeg', 'ffmpeg-zoompan-v1')
     ON CONFLICT DO NOTHING`,
    [guideId],
  );
  await query(`UPDATE generated_videos SET status = 'generating', updated_at = now() WHERE guide_id = $1`, [guideId]);

  const pageFiles = guide.manual_document_id ? await listPageFiles(guide.manual_document_id, "video") : [];
  // Jobs for the same guide can overlap during a deploy restart or retry. Give
  // each one an isolated workspace and only replace public assets once the
  // staged files are complete.
  const workDir = pathFor(`work/${guideId}-${randomUUID()}`);
  await fs.mkdir(workDir, { recursive: true });

  const audioFor = async (key: string): Promise<{ path: string; seconds: number } | null> => {
    const p = pathFor(key);
    try {
      await fs.access(p);
      return { path: p, seconds: await audioDurationSeconds(p) };
    } catch {
      return null;
    }
  };

  const allParts = [...new Set(steps.flatMap((s) => s.parts ?? []))].slice(0, 8);
  const allTools = [...new Set(steps.flatMap((s) => s.tools ?? []))].slice(0, 5);
  const totalMinutes = Math.max(1, Math.ceil(steps.reduce((acc, s) => acc + (s.estimated_seconds ?? 10), 8) / 60));

  const scenes: SceneSpec[] = [];

  const introAudio = await audioFor(`audio/${guideId}/intro.mp3`);
  scenes.push({
    name: "intro",
    imagePath: null,
    videoPath: null,
    audioPath: introAudio?.path ?? null,
    titleText: wrap(guide.title, 34, 2),
    captionText:
      wrap(`${steps.length} steg · cirka ${totalMinutes} min`, 44, 1) +
      (allParts.length ? `\nDelar: ${wrap(allParts.join(", "), 52, 2)}` : "") +
      (allTools.length ? `\nVerktyg: ${wrap(allTools.join(", "), 52, 1)}` : ""),
    safetyText: null,
    focusRegion: "full",
    narrationSeconds: introAudio?.seconds ?? 4,
  });

  for (const step of steps) {
    const pageNum = step.manual_pages?.[0] ?? null;
    const imagePath = pageNum && pageFiles[pageNum - 1] ? pageFiles[pageNum - 1] : pageFiles[0] ?? null;
    const focus: SceneSpec["focusRegion"] = (["top", "center", "bottom", "full"] as const).includes(
      step.focus_region as never,
    )
      ? (step.focus_region as SceneSpec["focusRegion"])
      : "full";
    const audio = await audioFor(`audio/${guideId}/step-${String(step.step_number).padStart(2, "0")}.mp3`);

    let videoPath: string | null = null;
    if (step.visual_prompt) {
      try {
        // Fixed short clip length by design (cheap default) — the scene gets
        // looped/trimmed to the real narration length in buildScene either way.
        videoPath = await generateStepClip(step.visual_prompt);
      } catch (err) {
        // Animated generation is best-effort (plan tier, quota, moderation,
        // outages) — fall back to the real manual-page image for this step
        // rather than fail the whole guide.
        console.error(`[render] animated clip failed for step ${step.step_number}, falling back to manual page:`, (err as Error).message);
      }
    }

    scenes.push({
      name: `step-${step.step_number}`,
      imagePath,
      videoPath,
      audioPath: audio?.path ?? null,
      titleText: `Steg ${step.step_number} av ${steps.length} — ${wrap(step.title, 30, 1)}`,
      captionText: wrap(step.instruction, 58, 2),
      safetyText: step.safety_warning ? `VARNING: ${wrap(step.safety_warning, 48, 2)}` : null,
      focusRegion: focus,
      narrationSeconds: audio?.seconds ?? 5,
    });
  }

  const outroAudio = await audioFor(`audio/${guideId}/outro.mp3`);
  scenes.push({
    name: "outro",
    imagePath: null,
    videoPath: null,
    audioPath: outroAudio?.path ?? null,
    titleText: "Klart!",
    captionText: wrap(`${product.name} är färdigmonterad. Kontrollera att alla skruvar är åtdragna.`, 52, 2),
    safetyText: null,
    focusRegion: "full",
    narrationSeconds: outroAudio?.seconds ?? 4,
  });

  const total = scenes.length + 1;
  let done = 0;
  const limit = pLimit(3);
  const sceneFiles = new Array<string>(scenes.length);
  await Promise.all(
    scenes.map((scene, i) =>
      limit(async () => {
        sceneFiles[i] = await buildScene(scene, workDir, i);
        done += 1;
        onProgress(done, total, scene.name);
      }),
    ),
  );

  // concat with stream copy (identical codec params across scenes)
  const listFile = path.join(workDir, "concat.txt");
  await fs.writeFile(listFile, sceneFiles.map((f) => `file '${f}'`).join("\n"));
  const videoKey = `videos/${guideId}.mp4`;
  const stagedVideo = path.join(workDir, "video.mp4");
  await fs.mkdir(path.dirname(pathFor(videoKey)), { recursive: true });
  await exec("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", stagedVideo], {
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
  await fs.rename(stagedVideo, pathFor(videoKey));

  const thumbKey = `thumbs/${guideId}.jpg`;
  const stagedThumb = path.join(workDir, "thumbnail.jpg");
  await fs.mkdir(path.dirname(pathFor(thumbKey)), { recursive: true });
  const firstStepScene = sceneFiles[1] ?? sceneFiles[0];
  await exec(
    "ffmpeg",
    ["-y", "-ss", "1.0", "-i", firstStepScene, "-frames:v", "1", "-update", "1", "-vf", "scale=1280:-2", stagedThumb],
    { timeout: 60000 },
  );
  await fs.rename(stagedThumb, pathFor(thumbKey));

  const durationSeconds = await audioDurationSeconds(pathFor(videoKey));

  const videoAssetId = await storeAsset({ kind: "guide_video", storageKey: videoKey, data: await fs.readFile(pathFor(videoKey)) });
  const thumbAssetId = await storeAsset({ kind: "guide_thumbnail", storageKey: thumbKey, data: await fs.readFile(pathFor(thumbKey)) });

  await query(
    `UPDATE generated_videos
        SET status = 'ready', video_asset_id = $2, thumbnail_asset_id = $3,
            duration_seconds = $4, published_at = now(), updated_at = now()
      WHERE guide_id = $1`,
    [guideId, videoAssetId, thumbAssetId, Math.round(durationSeconds)],
  );
  await query(`UPDATE assembly_guides SET status = 'ready', published_at = now(), updated_at = now() WHERE id = $1`, [guideId]);

  await fs.rm(workDir, { recursive: true, force: true });
  onProgress(total, total, "publicerad");

  return {
    video_url: `/api/assets/${videoKey}`,
    thumbnail_url: `/api/assets/${thumbKey}`,
    duration_seconds: Math.round(durationSeconds),
  };
}
