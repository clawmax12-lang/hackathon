import { synthesizeNarration } from "../server/src/pipeline/narration.js";
import { query } from "../server/src/db.js";

const articles = (process.argv.find((argument) => argument.startsWith("--articles="))?.split("=")[1] ?? "")
  .split(",")
  .map((article) => article.replace(/\D/g, ""))
  .filter(Boolean);

interface GuideRow {
  id: string;
  article_no: string;
  name: string;
  steps: number;
}

async function main(): Promise<void> {
  if (articles.length === 0) throw new Error("Pass --articles=20538721,10269696");

  const guides = await query<GuideRow>(
    `SELECT DISTINCT ON (p.article_no)
            ag.id,p.article_no,p.name,
            (SELECT count(*)::int FROM assembly_steps s WHERE s.guide_id=ag.id) AS steps
       FROM products p
       JOIN assembly_guides ag ON ag.product_id=p.id
      WHERE p.article_no=ANY($1::text[]) AND ag.status<>'ready'
      ORDER BY p.article_no,ag.updated_at DESC`,
    [articles],
  );

  for (const article of articles) {
    const guide = guides.find((candidate) => candidate.article_no === article);
    if (!guide) throw new Error(`No incomplete guide found for ${article}`);
    if (guide.steps === 0) throw new Error(`${guide.name} ${article} has no steps to recover`);

    const startedAt = Date.now();
    const narration = await synthesizeNarration(guide.id);
    await query(
      "UPDATE assembly_guides SET status='ready',published_at=NOW(),updated_at=NOW() WHERE id=$1",
      [guide.id],
    );
    console.log(JSON.stringify({
      articleNumber: article,
      product: guide.name,
      guideId: guide.id,
      steps: guide.steps,
      narratedSteps: narration.steps.length,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      status: "ready",
    }));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
