/**
 * Director: reads the brief, plans the work.
 *
 * Note that this is the same Agent class as every other role. Only the
 * system prompt and the tool allowlist differ. That is the whole trick of
 * multi-agent systems: one primitive, many configurations.
 */
import chalk from "chalk";
import { Agent } from "../agent.js";
import type { AgentDeps } from "../tools.js";

// The Director deliberately does NOT forward compliance rules to the
// workers. Production is optimistic and governance is a separate gate
// (the BrandGuardian), exactly like a real studio. It is also what makes
// the revision loop visible when the demo runs.
const SYSTEM_PROMPT = `You are the Director of a creative production pipeline.

You receive a campaign brief. Decompose it into concrete production tasks, one task per deliverable.

Process:
1. Call getBrandSpec so you know the brand before writing instructions.
2. Reply with the task list.

Your final reply must be ONLY a JSON object, with no markdown fences and no commentary, in exactly this shape:
{"tasks":[{"id":"caption-1","kind":"caption","instruction":"..."}]}

Rules for the task list:
- kind is "caption" for copy deliverables and "image_concept" for image deliverables.
- ids are caption-1..N and image-1..N.
- Each instruction must be self-contained, because the worker who receives it never sees the brief. Include the product, the audience, and the objective.
- Give every task a distinct creative angle so the final set has variety.
- Do not include brand compliance rules in the instructions. Compliance is checked by a separate reviewer later.`;

export function makeDirector({ client, model, tools }: AgentDeps): Agent {
  return new Agent({
    name: "Director",
    color: chalk.cyan,
    client,
    model,
    tools: [tools.getBrandSpec],
    systemPrompt: SYSTEM_PROMPT,
  });
}
