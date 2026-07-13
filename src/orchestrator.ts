/**
 * The orchestrator: deterministic code that wires the agents into a pipeline.
 *
 * Notice what is NOT here: no planner LLM deciding the control flow. The
 * pipeline shape (plan, produce, validate, revise) is ordinary code, because
 * in production you want the workflow predictable, debuggable, and cheap.
 * The LLM creativity lives inside the agents; the routing between them does
 * not need to be smart.
 *
 * This is the same shape enterprise creative-workflow platforms use:
 * nodes with clear contracts, composed into a governed graph.
 */
import chalk from "chalk";
import type OpenAI from "openai";
import { z } from "zod";
import { Agent, preview } from "./agent.js";
import { makeArtDirector } from "./agents/artDirector.js";
import { makeBrandGuardian } from "./agents/brandGuardian.js";
import { makeCopywriter } from "./agents/copywriter.js";
import { makeDirector } from "./agents/director.js";
import { AssetStore, buildTools } from "./tools.js";
import {
  TaskListSchema,
  ValidationResultSchema,
  type Asset,
  type BrandSpec,
  type Brief,
  type Task,
  type ValidationResult,
} from "./types.js";

/** How many validate-and-revise rounds an asset gets before it is rejected. */
const MAX_REVISION_ROUNDS = 3;

export class Orchestrator {
  private readonly store = new AssetStore();
  private readonly brand: BrandSpec;
  private readonly director: Agent;
  private readonly copywriter: Agent;
  private readonly artDirector: Agent;
  private readonly brandGuardian: Agent;

  constructor(config: { client: OpenAI; model: string; brand: BrandSpec }) {
    this.brand = config.brand;
    // One toolset closed over one shared store: this is how agents share state.
    const deps = {
      client: config.client,
      model: config.model,
      tools: buildTools(this.store, config.brand),
    };
    this.director = makeDirector(deps);
    this.copywriter = makeCopywriter(deps);
    this.artDirector = makeArtDirector(deps);
    this.brandGuardian = makeBrandGuardian(deps);
  }

  /** The whole pipeline: plan, produce, then govern until clean (or out of rounds). */
  async run(brief: Brief): Promise<Asset[]> {
    const tasks = await this.plan(brief);
    await this.produce(tasks);
    await this.validateAndRevise();
    return this.store.all();
  }

  /** Step 1: the Director turns the brief into a validated task list. */
  private async plan(brief: Brief): Promise<Task[]> {
    banner("1/3 Plan: Director turns the brief into tasks");
    const { tasks } = await runForJson(
      this.director,
      `Here is the campaign brief:\n${JSON.stringify(brief, null, 2)}\n\nDecompose it into the task list.`,
      TaskListSchema,
    );
    for (const task of tasks) {
      console.log(chalk.dim(`  plan: ${task.id} (${task.kind}) ${preview(task.instruction, 90)}`));
    }
    return tasks;
  }

  /** Step 2: route each task to its producer agent. */
  private async produce(tasks: Task[]): Promise<void> {
    banner("2/3 Produce: Copywriter and ArtDirector work the tasks");
    // Sequential on purpose: the trace stays readable and cheap models rarely
    // hit rate limits. Swap the loop for Promise.all if throughput matters.
    for (const task of tasks) {
      const worker = this.workerFor(task.kind);
      console.log(chalk.bold(`\n  ${task.id} -> ${worker.name}`));
      await this.produceOne(worker, task);
    }
  }

  private async produceOne(worker: Agent, task: Task): Promise<void> {
    await worker.run(
      `New task (asset id: "${task.id}", kind: "${task.kind}").\n${task.instruction}\nStore the result with saveAsset before you reply.`,
    );

    // Agents are probabilistic, contracts are not. Verify the asset actually
    // landed in the store, and nudge once if the agent skipped the tool call.
    if (!this.store.get(task.id)) {
      console.log(chalk.yellow(`  [orchestrator] ${task.id} was not saved, asking ${worker.name} again`));
      await worker.run(
        `You did not call saveAsset. Call it now with asset id "${task.id}" and kind "${task.kind}", then reply: saved`,
      );
    }
    if (!this.store.get(task.id)) {
      throw new Error(`${worker.name} never saved asset ${task.id}`);
    }
  }

  /**
   * Step 3, the centerpiece: the brand-governance loop.
   *
   * Every asset goes through the BrandGuardian. Failures are sent BACK to
   * the agent that produced them, together with the specific reasons and
   * the rules to satisfy, then re-reviewed. Assets that still fail after
   * MAX_REVISION_ROUNDS are rejected rather than shipped, a governed
   * pipeline needs a terminal state for unfixable work.
   */
  private async validateAndRevise(): Promise<void> {
    banner("3/3 Govern: BrandGuardian reviews, failures loop back");
    let pending = this.store.all();
    let round = 0;

    while (pending.length > 0) {
      console.log(chalk.bold(`\n  Review pass ${round + 1} (${pending.length} asset${pending.length === 1 ? "" : "s"})`));

      const failures: ValidationResult[] = [];
      for (const asset of pending) {
        const verdict = await this.review(asset);
        if (verdict.pass) {
          this.store.setStatus(asset.id, "approved");
          console.log(chalk.green(`  PASS ${asset.id} approved (revision ${asset.revision})`));
        } else {
          failures.push(verdict);
          console.log(chalk.red(`  FAIL ${asset.id}:`));
          for (const reason of verdict.reasons) console.log(chalk.red(`       - ${reason}`));
        }
      }

      if (failures.length === 0) return;

      if (round >= MAX_REVISION_ROUNDS) {
        for (const failure of failures) this.store.setStatus(failure.assetId, "rejected");
        console.log(chalk.yellow(`\n  Revision budget exhausted, ${failures.length} asset(s) rejected.`));
        return;
      }

      round++;
      console.log(chalk.bold.yellow(`\n  Revision round ${round}: ${failures.length} asset(s) sent back`));
      for (const failure of failures) {
        await this.revise(failure);
      }

      // Only the revised assets need another review pass.
      pending = failures
        .map((failure) => this.store.get(failure.assetId))
        .filter((asset): asset is Asset => asset !== undefined);
    }
  }

  /** Ask the BrandGuardian for a structured verdict on one asset. */
  private async review(asset: Asset): Promise<ValidationResult> {
    const verdict = await runForJson(
      this.brandGuardian,
      [
        "Review this asset against the brand.",
        `Asset id: ${asset.id}`,
        `Kind: ${asset.kind}`,
        "Content:",
        '"""',
        asset.content,
        '"""',
      ].join("\n"),
      ValidationResultSchema,
    );
    // Trust the id we already know; models occasionally echo the wrong one.
    return { ...verdict, assetId: asset.id };
  }

  /** Send a failed asset back to the agent that made it, with the reasons and the rules. */
  private async revise(failure: ValidationResult): Promise<void> {
    const asset = this.store.get(failure.assetId);
    if (!asset) return;
    const owner = this.workerFor(asset.kind);
    console.log(chalk.yellow(`  BACK ${asset.id} -> ${owner.name}`));
    await owner.run(
      [
        `Revision request for asset "${asset.id}". Brand review failed it for these reasons:`,
        ...failure.reasons.map((reason) => `- ${reason}`),
        "",
        `Rules the revision must satisfy: ${this.brandRulesDigest(asset.kind)}`,
        `Fix every reason, then call saveAsset with the SAME id "${asset.id}" and kind "${asset.kind}".`,
      ].join("\n"),
    );
  }

  /** Captions go to the Copywriter, image concepts to the ArtDirector. */
  private workerFor(kind: Asset["kind"]): Agent {
    return kind === "caption" ? this.copywriter : this.artDirector;
  }

  /**
   * A compact restatement of the brand rules, sent only with revision
   * requests. First drafts stay rule-blind on purpose (see copywriter.ts),
   * revisions get everything they need to converge fast.
   */
  private brandRulesDigest(kind: Asset["kind"]): string {
    const brand = this.brand;
    const parts = [
      `Voice: ${brand.voice.join(", ")}.`,
      `Tone: ${brand.toneNotes}`,
      `Never use these words: ${brand.bannedWords.join(", ")}.`,
    ];
    if (kind === "caption") {
      parts.push(
        `Mention "${brand.name}".`,
        `Maximum ${brand.rules.maxCaptionLength} characters.`,
        `At most ${brand.rules.hashtags.max} hashtags, and ${brand.rules.hashtags.mustInclude.join(" and ")} must be included.`,
      );
      if (brand.rules.noExclamationMarks) parts.push("No exclamation marks.");
    }
    return parts.join(" ");
  }
}

/**
 * Run an agent and parse its final answer against a schema, retrying with
 * feedback. This is the trick that turns free-form LLM text into a typed,
 * trustworthy value: validate, and on failure tell the model exactly what
 * was wrong so it can try again.
 */
async function runForJson<S extends z.ZodType>(
  agent: Agent,
  input: string,
  schema: S,
  retries = 2,
): Promise<z.infer<S>> {
  let request = input;
  for (let attempt = 0; ; attempt++) {
    const reply = await agent.run(request);
    try {
      return schema.parse(JSON.parse(extractJson(reply)));
    } catch (error) {
      if (attempt >= retries) {
        throw new Error(`${agent.name} did not produce valid JSON after ${retries + 1} attempts`);
      }
      const message = error instanceof Error ? error.message : String(error);
      request = `Your reply could not be used. Problem: ${preview(message, 300)}\nReply again with ONLY the corrected JSON object, no fences, no commentary.`;
    }
  }
}

/** Models love wrapping JSON in prose or fences; cut out the outermost object. */
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

function banner(title: string): void {
  console.log(`\n${chalk.bold.inverse(` ${title} `)}`);
}
