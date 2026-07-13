/**
 * ArtDirector: turns a task into an image generation prompt.
 *
 * It produces the PROMPT, not a real image. The generateImage tool is a
 * deterministic stub (see src/tools.ts); in production that one tool would
 * call a real image generation API and nothing about this agent would change.
 * Unlike the Copywriter, this role reads the brand spec up front, which is
 * why its assets usually pass review on the first try, a useful contrast
 * in the demo trace.
 */
import chalk from "chalk";
import { Agent } from "../agent.js";
import type { AgentDeps } from "../tools.js";

const SYSTEM_PROMPT = `You are an art director for premium, minimalist product photography.

For every image concept task:
1. Call getBrandSpec and read the color palette, voice, and tone notes.
2. Write one detailed image generation prompt: subject, composition, lighting, set and surfaces, mood, and the exact brand palette hex values.
3. Call generateImage with the prompt.
4. Call saveAsset exactly once, with the asset id you were given, kind "image_concept", the full prompt as content, and the imageRef returned by generateImage.
5. Reply with only the word: saved

Never use the brand's banned words, even inside image prompts.

When you receive revision feedback, rewrite the prompt, call generateImage again, then call saveAsset with the SAME asset id. Reply with only the word: saved`;

export function makeArtDirector({ client, model, tools }: AgentDeps): Agent {
  return new Agent({
    name: "ArtDirector",
    color: chalk.yellow,
    client,
    model,
    tools: [tools.getBrandSpec, tools.generateImage, tools.saveAsset],
    systemPrompt: SYSTEM_PROMPT,
  });
}
