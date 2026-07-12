/**
 * Shared types and zod schemas for the pipeline.
 *
 * Every piece of data that crosses an agent boundary is validated with zod.
 * LLMs return text, and text is untrusted input, so the orchestrator never
 * assumes an agent produced well-formed data. It parses, validates, and
 * retries with feedback when validation fails.
 */
import { z } from "zod";

/** The campaign brief, the single input to the whole pipeline. */
export const BriefSchema = z.object({
  campaign: z.string(),
  product: z.string(),
  audience: z.string(),
  objective: z.string(),
  deliverables: z.object({
    captions: z.number().int().positive(),
    imageConcepts: z.number().int().positive(),
  }),
  notes: z.string().optional(),
});
export type Brief = z.infer<typeof BriefSchema>;

/** The brand spec, the rulebook the BrandGuardian enforces. */
export const BrandSpecSchema = z.object({
  name: z.string(),
  tagline: z.string(),
  voice: z.array(z.string()),
  toneNotes: z.string(),
  bannedWords: z.array(z.string()),
  colorPalette: z.array(z.string()),
  rules: z.object({
    mustMentionBrandName: z.boolean(),
    maxCaptionLength: z.number().int().positive(),
    noExclamationMarks: z.boolean(),
    hashtags: z.object({
      max: z.number().int().nonnegative(),
      mustInclude: z.array(z.string()),
    }),
  }),
});
export type BrandSpec = z.infer<typeof BrandSpecSchema>;

/** The two kinds of assets this pipeline produces. */
export const AssetKindSchema = z.enum(["caption", "image_concept"]);
export type AssetKind = z.infer<typeof AssetKindSchema>;

/** One unit of work the Director hands to a producer agent. */
export const TaskSchema = z.object({
  id: z.string(),
  kind: AssetKindSchema,
  instruction: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

/** The Director's full plan. This is what we parse out of its final answer. */
export const TaskListSchema = z.object({
  tasks: z.array(TaskSchema).min(1),
});
export type TaskList = z.infer<typeof TaskListSchema>;

/** A produced asset living in the shared store. */
export interface Asset {
  id: string;
  kind: AssetKind;
  /** Caption text, or the full image generation prompt for image concepts. */
  content: string;
  /** For image concepts, the reference returned by the (stubbed) image tool. */
  imageRef?: string;
  /** Starts at 1, bumped every time an agent saves a revision. */
  revision: number;
  status: "draft" | "approved" | "rejected";
}

/** The BrandGuardian's verdict for a single asset. */
export const ValidationResultSchema = z.object({
  assetId: z.string(),
  pass: z.boolean(),
  reasons: z.array(z.string()),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;
