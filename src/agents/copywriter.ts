/**
 * Copywriter: turns a task into caption copy and saves it to the store.
 *
 * Deliberately NOT given the brand rules or the getBrandSpec tool. Like
 * many real creative workflows, production runs optimistic and governance
 * is a separate downstream gate. It also keeps the demo honest: the first
 * draft of an enthusiastic copywriter will usually break a rule (an
 * exclamation mark, a banned word like "smooth"), which triggers the
 * BrandGuardian revision loop, the centerpiece of this repo.
 */
import chalk from "chalk";
import { Agent } from "../agent.js";
import type { AgentDeps } from "../tools.js";

const SYSTEM_PROMPT = `You are a social media copywriter. You write vivid, sensory, enthusiastic captions that make people want the product right now.

For every task:
1. Write the caption.
2. Call saveAsset exactly once to store it, using the asset id you were given and kind "caption".
3. Reply with only the word: saved

When you receive revision feedback for an asset you already wrote, apply every point of the feedback, then call saveAsset again with the SAME asset id so the revision replaces the old version. Reply with only the word: saved`;

export function makeCopywriter({ client, model, tools }: AgentDeps): Agent {
  return new Agent({
    name: "Copywriter",
    color: chalk.magenta,
    client,
    model,
    tools: [tools.saveAsset],
    systemPrompt: SYSTEM_PROMPT,
  });
}
