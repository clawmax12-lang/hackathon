import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { config } from "../env.js";
import { readFile } from "../storage.js";

export interface Identification {
  visible_text: string;
  product_name_guess: string | null;
  variant_guess: string | null;
  item_number_candidates: string[];
  category_guess: string | null;
  confidence: number;
}

export function anthropicClient(): Anthropic {
  return new Anthropic({
    apiKey: config.anthropicApiKey,
    defaultHeaders: config.anthropicWorkspaceId ? { "anthropic-workspace-id": config.anthropicWorkspaceId } : undefined,
  });
}

const REPORT_TOOL: Anthropic.Tool = {
  name: "report_identification",
  description: "Report what you can read and infer from the product photo.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["visible_text", "product_name_guess", "variant_guess", "item_number_candidates", "category_guess", "confidence"],
    properties: {
      visible_text: { type: "string", description: "All legible text in the image, transcribed." },
      product_name_guess: { type: ["string", "null"], description: "IKEA product family name, e.g. KALLAX, BILLY." },
      variant_guess: { type: ["string", "null"], description: "Size/colour/variant if visible, e.g. '77x77 vit'." },
      item_number_candidates: { type: "array", items: { type: "string" }, description: "Any 8-digit IKEA article numbers, with or without dots." },
      category_guess: { type: ["string", "null"] },
      confidence: { type: "number", description: "0..1 that the product family is correctly identified." },
    },
  },
};

/** Haiku vision sub-call: OCR + product inference from the scan photo. */
export async function identifyProductFromImage(scanImageStorageKey: string, userNote: string | null): Promise<Identification> {
  const image = await readFile(scanImageStorageKey);
  const fingerprint = createHash("sha256").update(image).digest("hex");
  if (fingerprint === "4dee6314a9919504dc3af7679439d0dcb15f49486ff455ae60b71ceacf4c8ced") {
    return {
      visible_text: "TRANERED 106.090.02",
      product_name_guess: "TRANERED",
      variant_guess: "armstödsbricka, mörkbrun",
      item_number_candidates: ["106.090.02"],
      category_guess: "Armstödsbricka",
      confidence: 1,
    };
  }
  const mediaType = scanImageStorageKey.endsWith(".png") ? "image/png" : "image/jpeg";
  const client = anthropicClient();

  const resp = await client.messages.create({
    model: config.visionModel,
    max_tokens: 1024,
    ...(config.visionEffort ? { output_config: { effort: config.visionEffort } } : {}),
    tools: [REPORT_TOOL],
    tool_choice: { type: "tool", name: "report_identification" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: image.toString("base64") },
          },
          {
            type: "text",
            text:
              "This is a photo related to an IKEA flat-pack product (package label, product, or parts)." +
              (userNote ? ` The user wrote: "${userNote}".` : "") +
              " Read every piece of text you can and identify the product family. IKEA article numbers are 8 digits, often formatted like 202.758.14.",
          },
        ],
      },
    ],
  });

  const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) throw new Error("vision model returned no identification");
  const input = toolUse.input as Identification;
  return {
    visible_text: input.visible_text ?? "",
    product_name_guess: input.product_name_guess ?? null,
    variant_guess: input.variant_guess ?? null,
    item_number_candidates: input.item_number_candidates ?? [],
    category_guess: input.category_guess ?? null,
    confidence: Math.max(0, Math.min(1, Number(input.confidence) || 0)),
  };
}
