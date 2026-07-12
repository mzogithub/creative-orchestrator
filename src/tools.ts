/**
 * The tool registry and the shared asset store.
 *
 * Tools are where agents touch the real world. Every tool here is ordinary
 * TypeScript. The model only chooses WHEN to call them and with WHAT
 * arguments; the code below is what actually runs. Owning this layer is
 * what owning your agent stack means: swap the stub for a real API and
 * nothing else in the system changes.
 */
import { z } from "zod";
import type OpenAI from "openai";
import { defineTool, type Tool } from "./agent.js";
import { AssetKindSchema, type Asset, type AssetKind, type BrandSpec } from "./types.js";

/**
 * The shared asset store. Agents never talk to each other directly. They
 * collaborate through this state via the saveAsset tool, and the
 * orchestrator reads it between steps. In production this role is played
 * by a DAM (for example AEM Assets); here a Map is enough.
 */
export class AssetStore {
  private readonly assets = new Map<string, Asset>();

  /** Insert a new asset, or replace an existing one and bump its revision. */
  upsert(input: { id: string; kind: AssetKind; content: string; imageRef?: string }): Asset {
    const existing = this.assets.get(input.id);
    const asset: Asset = {
      ...input,
      revision: existing ? existing.revision + 1 : 1,
      // Every save, including a re-save, must pass brand review again.
      status: "draft",
    };
    this.assets.set(asset.id, asset);
    return asset;
  }

  get(id: string): Asset | undefined {
    return this.assets.get(id);
  }

  all(): Asset[] {
    return [...this.assets.values()];
  }

  setStatus(id: string, status: Asset["status"]): void {
    const asset = this.assets.get(id);
    if (asset) asset.status = status;
  }
}

/** The full menu of tools. Each agent gets an allowlisted subset, never all of them. */
export interface Toolset {
  saveAsset: Tool;
  getBrandSpec: Tool;
  generateImage: Tool;
  lintAsset: Tool;
}

/** Everything a role file in src/agents/ needs to construct its agent. */
export interface AgentDeps {
  client: OpenAI;
  model: string;
  tools: Toolset;
}

/**
 * Build the toolset, closed over the shared store and the brand spec.
 * Tools are created per pipeline run, not globally, so all shared state
 * is explicit and there are no module-level singletons to reset.
 */
export function buildTools(store: AssetStore, brand: BrandSpec): Toolset {
  const saveAsset = defineTool({
    name: "saveAsset",
    description:
      "Save a produced asset into the shared asset store. Saving with an existing id replaces that asset and bumps its revision.",
    parameters: z.object({
      id: z.string().describe("The stable asset id you were given, for example caption-1"),
      kind: AssetKindSchema.describe("What kind of asset this is"),
      content: z.string().describe("The caption text, or the full image generation prompt"),
      imageRef: z.string().optional().describe("For image concepts, the imageRef returned by generateImage"),
    }),
    execute: (args) => {
      const asset = store.upsert(args);
      return `Saved ${asset.kind} "${asset.id}" (revision ${asset.revision}).`;
    },
  });

  const getBrandSpec = defineTool({
    name: "getBrandSpec",
    description:
      "Get the full brand specification: voice, tone notes, banned words, color palette, and formatting rules.",
    parameters: z.object({}),
    execute: () => JSON.stringify(brand, null, 2),
  });

  // Stubbed on purpose. In production this is the node that calls a real
  // image API (Adobe Firefly Services: submit a generation job, poll it,
  // collect the rendition URLs). The stub returns a deterministic fake
  // reference derived from the prompt, so the demo runs for free, needs no
  // image service, and produces reproducible output.
  const generateImage = defineTool({
    name: "generateImage",
    description:
      "Render an image from a prompt and return an image reference. (Demo stub: no real image API is called.)",
    parameters: z.object({
      prompt: z.string().describe("The full image generation prompt"),
    }),
    execute: (args) =>
      JSON.stringify({
        imageRef: `firefly-stub://renders/${fauxHash(args.prompt)}.png`,
        width: 2048,
        height: 2048,
        note: "stubbed render, swap this tool for a real Firefly Services call in production",
      }),
  });

  // Hard rules are checked in code, not by the LLM. A model can overlook a
  // banned word; a regex cannot. The BrandGuardian calls this first, then
  // adds the judgment code cannot make (voice and tone fit).
  const lintAsset = defineTool({
    name: "lintAsset",
    description:
      "Run the deterministic brand checks (banned words, length, exclamation marks, hashtags, brand mention) against a saved asset. Returns the violations, empty when clean.",
    parameters: z.object({
      id: z.string().describe("Id of the asset to check"),
    }),
    execute: (args) => {
      const asset = store.get(args.id);
      if (!asset) return `Error: no asset with id "${args.id}"`;
      return JSON.stringify({ assetId: asset.id, violations: lintAgainstBrand(asset, brand) });
    },
  });

  return { saveAsset, getBrandSpec, generateImage, lintAsset };
}

/** The mechanical half of brand governance: every rule that a regex or a length check can decide. */
function lintAgainstBrand(asset: Asset, brand: BrandSpec): string[] {
  const violations: string[] = [];
  const text = asset.content;

  // Banned words apply to every asset kind, image prompts included.
  for (const word of brand.bannedWords) {
    if (new RegExp(`\\b${escapeRegExp(word)}\\b`, "i").test(text)) {
      violations.push(`contains the banned word "${word}"`);
    }
  }

  // The remaining rules are caption formatting rules.
  if (asset.kind !== "caption") return violations;

  if (brand.rules.mustMentionBrandName && !text.toLowerCase().includes(brand.name.toLowerCase())) {
    violations.push(`must mention the brand name "${brand.name}"`);
  }
  if (text.length > brand.rules.maxCaptionLength) {
    violations.push(`is ${text.length} characters long, the maximum is ${brand.rules.maxCaptionLength}`);
  }
  if (brand.rules.noExclamationMarks && text.includes("!")) {
    violations.push("contains exclamation marks, which the brand tone forbids");
  }

  const hashtags = text.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  if (hashtags.length > brand.rules.hashtags.max) {
    violations.push(`uses ${hashtags.length} hashtags, the maximum is ${brand.rules.hashtags.max}`);
  }
  for (const required of brand.rules.hashtags.mustInclude) {
    if (!hashtags.some((tag) => tag.toLowerCase() === required.toLowerCase())) {
      violations.push(`must include the hashtag ${required}`);
    }
  }

  return violations;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Deterministic fake id so stubbed "renders" are stable for a given prompt. */
function fauxHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}
