import { config } from "../env.js";
import { one, query } from "../db.js";
import { readFile } from "../storage.js";
import { anthropicClient } from "./identify.js";

/** Follow-up Q&A grounded in the guide steps and, when small enough, the manual PDF itself. */
export async function answerQuestion(guideId: string, question: string): Promise<string> {
  const guide = await one<{ title: string; summary: string | null; product_name: string; storage_key: string | null }>(
    `SELECT ag.title, ag.summary, p.name AS product_name, ma.storage_key
       FROM assembly_guides ag
       JOIN products p ON p.id = ag.product_id
       LEFT JOIN source_documents sd ON sd.id = ag.manual_document_id
       LEFT JOIN media_assets ma ON ma.id = sd.asset_id
      WHERE ag.id = $1`,
    [guideId],
  );
  const steps = await query<{ step_number: number; title: string; instruction: string; narration_script: string | null; safety_warning: string | null; parts: string[] | null; tools: string[] | null }>(
    "SELECT step_number, title, instruction, narration_script, safety_warning, parts, tools FROM assembly_steps WHERE guide_id = $1 ORDER BY step_number",
    [guideId],
  );

  if (!config.anthropicApiKey) {
    return "Jag kan tyvärr inte svara på följdfrågor just nu. Titta i steglistan under videon – varje steg visar delar, verktyg och varningar.";
  }

  const client = anthropicClient();
  const stepsText = steps
    .map(
      (s) =>
        `Steg ${s.step_number}: ${s.title}. ${s.instruction}${s.safety_warning ? ` VARNING: ${s.safety_warning}` : ""}${
          s.parts?.length ? ` Delar: ${s.parts.join(", ")}.` : ""
        }${s.tools?.length ? ` Verktyg: ${s.tools.join(", ")}.` : ""}`,
    )
    .join("\n");

  const content: ({ type: "text"; text: string } | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } })[] = [];
  if (guide.storage_key) {
    try {
      const pdf = await readFile(guide.storage_key);
      if (pdf.length < 8 * 1024 * 1024) {
        content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } });
      }
    } catch {
      /* manual missing on disk; answer from steps only */
    }
  }
  content.push({ type: "text", text: question });

  const resp = await client.messages.create({
    model: config.orchestratorModel,
    max_tokens: 1200,
    system: `Du är en lugn och hjälpsam monteringscoach för "${guide.product_name}". Guiden: ${guide.title}. ${guide.summary ?? ""}
Stegen:
${stepsText}

Svara på svenska, kort och konkret (max 5 meningar). Hänvisa till stegnummer och manualsidor när det hjälper. Om frågan gäller något som kan vara farligt eller kräver två personer – säg det först. Om du inte vet: säg det ärligt och föreslå IKEA:s kundtjänst.`,
    messages: [{ role: "user", content }],
  });

  const textBlock = resp.content.find((b) => b.type === "text");
  return textBlock && "text" in textBlock ? textBlock.text : "Jag kunde tyvärr inte ta fram ett svar just nu.";
}
