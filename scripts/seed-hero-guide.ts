import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { maybeOne, one, query } from "../server/src/db.js";
import { synthesizeNarration } from "../server/src/pipeline/narration.js";
import { pathFor } from "../server/src/storage.js";

const ARTICLE_NUMBER = "10609002";
const PROMPT_VERSION = "tranered-hand-reviewed-v1";

const STEPS = [
  {
    title: "Förbered arbetsytan",
    instruction: "Lägg bordsskivan upp och ned på ett mjukt underlag och ta fram en kryssmejsel samt ett måttband.",
    narration: "Lägg bordsskivan upp och ned på ett mjukt underlag. Ta fram en kryssmejsel och ett måttband.",
    warning: "Montera på ett mjukt underlag så att bordsskivan inte repas.", page: 2, region: "center", parts: [], tools: ["Kryssmejsel", "Måttband"], seconds: 10,
  },
  {
    title: "Fäst de smala beslagen",
    instruction: "Fäst ett smalt beslag 10135625 på varje metallbåge med de försänkta skruvarna 10087142.",
    narration: "Fäst ett smalt beslag på varje metallbåge. Använd de försänkta skruvarna som visas, inte de korta skruvarna.",
    warning: null, page: 4, region: "center", parts: ["2 smala beslag 10135625", "2 skruvar 10087142", "2 metallbågar"], tools: ["Kryssmejsel"], seconds: 12,
  },
  {
    title: "Fäst de slitsade beslagen",
    instruction: "Fäst ett slitsat beslag 10135623 på varje metallbåge med de återstående försänkta skruvarna 10087142.",
    narration: "Fäst nu ett slitsat beslag på varje metallbåge. Använd de återstående försänkta skruvarna som visas.",
    warning: null, page: 5, region: "center", parts: ["2 slitsade beslag 10135623", "2 skruvar 10087142", "2 metallbågar"], tools: ["Kryssmejsel"], seconds: 11,
  },
  {
    title: "Vänd bordsskivan",
    instruction: "Vänd bordsskivan så att undersidan med monteringshålen ligger uppåt på det mjuka underlaget.",
    narration: "Vänd bordsskivan försiktigt. Låt undersidan med monteringshålen ligga uppåt.",
    warning: "Skydda ovansidan mot repor när du vänder skivan.", page: 6, region: "top", parts: ["Bordsskiva"], tools: [], seconds: 8,
  },
  {
    title: "Montera den fasta bågen",
    instruction: "Skruva fast bågen med de smala beslagen i bordsskivans fasta hål med skruvarna 109067 och brickorna 100828 som visas.",
    narration: "Montera bågen med de smala beslagen i de fasta hålen. Lägg brickorna under skruvarna och dra åt med kryssmejseln.",
    warning: null, page: 6, region: "bottom", parts: ["Båge med smala beslag", "Skruvar 109067", "Brickor 100828"], tools: ["Kryssmejsel"], seconds: 13,
  },
  {
    title: "Montera den justerbara bågen",
    instruction: "Skruva fast bågen med de slitsade beslagen i bordsskivan med skruvarna 109067 och brickorna 100828 som visas.",
    narration: "Montera den andra bågen med de slitsade beslagen. Lägg brickorna under skruvarna och låt beslagen kunna glida.",
    warning: null, page: 7, region: "center", parts: ["Båge med slitsade beslag", "Skruvar 109067", "Brickor 100828"], tools: ["Kryssmejsel"], seconds: 13,
  },
  {
    title: "Ställ in bredden",
    instruction: "Skjut den justerbara bågen tills avståndet mellan bågarna passar armstödets bredd.",
    narration: "Mät armstödets bredd. Skjut den justerbara bågen tills samma avstånd visas mellan bågarna.",
    warning: "Brickan ska bara användas på ett plant, vågrätt armstöd.", page: 7, region: "bottom", parts: ["Monterad bricka"], tools: ["Måttband"], seconds: 11,
  },
  {
    title: "Dra åt och kontrollera",
    instruction: "Dra åt skruvarna på de slitsade beslagen och kontrollera att bågarna sitter stadigt innan brickan vänds rätt.",
    narration: "Dra åt skruvarna på båda slitsade beslagen och kontrollera att bågarna sitter stadigt. Klart. Snyggt jobbat.",
    warning: "Efterdra skruvarna regelbundet och belasta brickan med högst 3 kg.", page: 8, region: "top", parts: ["Monterad bricka"], tools: ["Kryssmejsel"], seconds: 12,
  },
] as const;

async function audioIsReady(guideId: string): Promise<boolean> {
  for (let index = 1; index <= STEPS.length; index += 1) {
    try {
      await fs.access(pathFor(`audio/${guideId}/step-${String(index).padStart(2, "0")}.mp3`));
    } catch {
      return false;
    }
  }
  return true;
}

async function main(): Promise<void> {
  const product = await one<{ id: string; name: string }>(
    "SELECT id,name FROM products WHERE regexp_replace(ikea_item_number,'\\D','','g')=$1",
    [ARTICLE_NUMBER],
  );
  const manual = await one<{ id: string; canonical_url: string }>(
    `SELECT sd.id,sd.canonical_url
       FROM product_documents pd JOIN source_documents sd ON sd.id=pd.document_id
      WHERE pd.product_id=$1 AND pd.relationship='assembly_manual' AND sd.status='ready'
      ORDER BY sd.updated_at DESC LIMIT 1`,
    [product.id],
  );

  const existing = await maybeOne<{ id: string; status: string }>(
    "SELECT id,status::text FROM assembly_guides WHERE product_id=$1 AND prompt_version=$2 LIMIT 1",
    [product.id, PROMPT_VERSION],
  );
  if (existing?.status === "ready" && await audioIsReady(existing.id)) {
    console.log(JSON.stringify({ hero: product.name, guideId: existing.id, steps: STEPS.length, cache: "ready" }));
    return;
  }

  const guide = existing
    ? await one<{ id: string }>(
        `UPDATE assembly_guides SET manual_document_id=$2,status='generating',language='sv',title=$3,summary=$4,updated_at=NOW() WHERE id=$1 RETURNING id`,
        [existing.id, manual.id, "Montera TRANERED", "En handgranskad guide baserad på IKEAs officiella monteringsanvisning."],
      )
    : await one<{ id: string }>(
        `INSERT INTO assembly_guides
           (product_id,manual_document_id,status,language,title,summary,generator_provider,generator_model,prompt_version,source_fingerprint)
         VALUES ($1,$2,'generating','sv',$3,$4,'monterra','hand-reviewed',$5,$6) RETURNING id`,
        [product.id, manual.id, "Montera TRANERED", "En handgranskad guide baserad på IKEAs officiella monteringsanvisning.", PROMPT_VERSION, manual.canonical_url],
      );

  await query("DELETE FROM assembly_steps WHERE guide_id=$1", [guide.id]);
  for (const [index, step] of STEPS.entries()) {
    await query(
      `INSERT INTO assembly_steps
         (guide_id,step_number,title,instruction,narration_script,safety_warning,estimated_seconds,manual_pages,parts,tools,visual_prompt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
      [guide.id, index + 1, step.title, step.instruction, step.narration, step.warning, step.seconds, [step.page], JSON.stringify(step.parts), JSON.stringify(step.tools), JSON.stringify({ page: step.page, region: step.region, motion: "slow_zoom" })],
    );
  }

  const started = performance.now();
  const narration = await synthesizeNarration(guide.id);
  await query("UPDATE assembly_guides SET status='ready',published_at=NOW(),updated_at=NOW() WHERE id=$1", [guide.id]);
  console.log(JSON.stringify({ hero: product.name, guideId: guide.id, steps: STEPS.length, narrationCharacters: narration.total_characters, generatedMs: Math.round(performance.now() - started), cache: "seeded" }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
