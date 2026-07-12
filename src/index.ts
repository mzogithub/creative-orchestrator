/**
 * Entry point: load config and inputs, run the pipeline, write the asset sheet.
 */
import dotenv from "dotenv";
import chalk from "chalk";
import OpenAI from "openai";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "./orchestrator.js";
import { BrandSpecSchema, BriefSchema, type Asset, type BrandSpec, type Brief } from "./types.js";

dotenv.config({ quiet: true });

/** Project root, resolved from this file so the demo works from any cwd. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    console.error(
      chalk.red("Missing LLM_API_KEY. Copy .env.example to .env and add a key (OpenRouter, OpenAI, or any OpenAI-compatible endpoint)."),
    );
    process.exit(1);
  }
  const baseURL = process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1";
  const model = process.env.LLM_MODEL ?? "openai/gpt-4o-mini";

  // Inputs are validated at the boundary, exactly like the agents' outputs.
  const brand = BrandSpecSchema.parse(JSON.parse(await readFile(path.join(ROOT, "brand.json"), "utf8")));
  const brief = BriefSchema.parse(JSON.parse(await readFile(path.join(ROOT, "examples", "brief.json"), "utf8")));

  console.log(chalk.bold("\ncreative-orchestrator"));
  console.log(chalk.dim(`brand: ${brand.name} | campaign: ${brief.campaign} | model: ${model}`));

  const orchestrator = new Orchestrator({ client: new OpenAI({ apiKey, baseURL }), model, brand });
  const assets = await orchestrator.run(brief);

  const outputPath = path.join(ROOT, "output", "assets.md");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderAssetSheet(assets, brief, brand, model), "utf8");

  const approved = assets.filter((asset) => asset.status === "approved").length;
  const rejected = assets.filter((asset) => asset.status === "rejected").length;
  const revised = assets.filter((asset) => asset.revision > 1).length;
  console.log(
    chalk.bold(
      `\nDone. ${approved}/${assets.length} assets approved` +
        (rejected > 0 ? `, ${rejected} rejected` : "") +
        `, ${revised} went through revision.`,
    ),
  );
  console.log(`Asset sheet: ${chalk.underline(outputPath)}\n`);
}

/** The human-readable deliverable: one markdown sheet with every asset and its review history. */
function renderAssetSheet(assets: Asset[], brief: Brief, brand: BrandSpec, model: string): string {
  const captions = assets.filter((asset) => asset.kind === "caption");
  const concepts = assets.filter((asset) => asset.kind === "image_concept");
  return [
    `# Asset sheet: ${brief.campaign}`,
    "",
    `Brand: **${brand.name}** (${brand.tagline})`,
    `Model: \`${model}\``,
    `Generated: ${new Date().toISOString()}`,
    "",
    'Every asset passed through the BrandGuardian gate. "Revision" counts saves, so anything above 1 was sent back and fixed at least once.',
    "",
    "## Captions",
    ...captions.flatMap(renderAsset),
    "",
    "## Image concepts",
    ...concepts.flatMap(renderAsset),
    "",
  ].join("\n");
}

function renderAsset(asset: Asset): string[] {
  const lines = [
    "",
    `### ${asset.id} (${asset.status.toUpperCase()}, revision ${asset.revision})`,
    "",
    ...asset.content.split("\n").map((line) => `> ${line}`),
  ];
  if (asset.imageRef) lines.push("", `Image reference: \`${asset.imageRef}\``);
  return lines;
}

main().catch((error: unknown) => {
  console.error(chalk.red(`\nPipeline failed: ${error instanceof Error ? error.message : String(error)}`));
  process.exit(1);
});
