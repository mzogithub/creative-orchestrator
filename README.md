# creative-orchestrator

A multi-agent creative pipeline built **from scratch** in TypeScript: a campaign brief goes in, brand-compliant marketing assets come out, with an automatic brand-governance loop that sends failing assets back for revision. No LangChain, no agent framework. The entire agent loop is one readable file, [`src/agent.ts`](src/agent.ts).

## What is an agent?

An agent is an LLM in a loop with tools and a goal. That is the whole definition.

You give the model a role (the system prompt), a goal (the user message), and a menu of tools it may call. Then you loop: if the model asks for a tool, your code runs it and feeds the result back; if the model answers in plain text, it is done.

```
        +-------------------------------------+
        |  system prompt  (the role)          |
        |  user message   (the goal)          |
        |  tool menu      (names + schemas)   |
        +------------------+------------------+
                           |
                           v
                  +-----------------+
    +------------>|       LLM       |
    |             +--------+--------+
    |                      |
    |            did it request a tool?
    |               |               |
    |              yes              no
    |               |               |
    |               v               v
    |     +-----------------+   +----------------------+
    |     |  run the tool   |   |  final answer, done  |
    |     |  (real code)    |   +----------------------+
    |     +--------+--------+
    |              |
    +---- append result to the conversation, go again
```

Two things make this more than a chat call:

- **The model decides what happens next.** It plans, acts, observes the result, and re-plans. That is agency.
- **Your code decides how it happens.** Tools are ordinary functions. The model never touches the world directly.

Everything else (memory, roles, orchestration) is composition on top of this loop. In this repo the loop is about forty lines inside `Agent.run()`.

## What is multi-agent orchestration?

One agent with twenty tools and a huge prompt gets confused, is hard to test, and fails opaquely. So you split the work into **roles**, each an agent with a narrow prompt and only the tools it needs, and you connect them with **handoffs**: the output of one becomes the input of the next.

This project is the example:

| Agent | Role | Allowed tools |
|---|---|---|
| **Director** | decomposes the brief into a task list (structured JSON, validated with zod) | `getBrandSpec` |
| **Copywriter** | writes the caption variants | `saveAsset` |
| **ArtDirector** | writes image-concept prompts and registers stub renders | `getBrandSpec`, `generateImage`, `saveAsset` |
| **BrandGuardian** | validates every asset against `brand.json`, pass/fail with reasons | `lintAsset`, `getBrandSpec` |

All four are instances of the **same `Agent` class**. Only the system prompt and the tool allowlist differ. The agents never talk to each other directly; they collaborate through a shared asset store, and deterministic orchestrator code routes the work between them.

The key point: **the routing is code, not another LLM.** The pipeline shape (plan, produce, validate, revise) is a plain loop in [`src/orchestrator.ts`](src/orchestrator.ts), so it is predictable, debuggable, and cheap. Creativity lives inside the agents; control flow does not need to be smart.

## Why build it from scratch (no LangChain)?

Because the loop **is** the product. Owning it means owning:

- **The tools.** Each tool is a plain function with a zod schema. Swapping the stub image tool for a real image generation API call touches one function.
- **The routing.** Handoffs, retries, and the revision loop are explicit code you can step through, not callbacks inside a framework's black box.
- **The cost.** You see every request, every token, every loop iteration. You can cap steps, cap revision rounds, and pick the model per agent.
- **The failure handling.** Malformed JSON gets validated and retried with feedback. A skipped tool call gets nudged. A tool error goes back to the model as text so it can self-correct. Frameworks hide exactly this part, and it is the part that matters in production.

A framework is fine for a proof of concept. In production, the parts a framework abstracts away (tool contracts, state, validation, recovery) are the parts you get paged for. This repo is the whole stack in about 700 lines you can read in one sitting.

## Architecture

```
examples/brief.json
        |
        v
   [ Director ]  ------ task list (zod-validated JSON)
        |
        +----------------------+
        v                      v
  [ Copywriter ]        [ ArtDirector ]
   captions               image prompts + stub renders
        |                      |
        +----------+-----------+
                   v
           shared AssetStore
                   |
                   v
          [ BrandGuardian ]  <---- brand.json
             pass / fail per asset, with reasons
                   |
     fail: asset goes BACK to the agent that made it,
     with the reasons (max 3 rounds, then rejected)
                   |
                   v
           output/assets.md
```

The revision loop is the centerpiece: the Copywriter is deliberately not given the brand rules up front, so its first drafts usually break one (an exclamation mark, a banned word like "smooth", a missing `#KAFO` hashtag). The BrandGuardian catches it, the orchestrator sends the asset back with the specific reasons, and the revised version is re-reviewed until it passes or the round budget runs out.

Hard rules (banned words, length, hashtag count) are checked by deterministic code in the `lintAsset` tool; the LLM only judges what code cannot, whether the copy sounds like the brand. This node-based, governed composition mirrors how enterprise creative-workflow platforms compose creative workflows.

## How to run

```bash
npm install
cp .env.example .env    # add your LLM_API_KEY
npm run demo
```

Configuration (all via `.env`, no secrets in the repo):

| Variable | Default | Notes |
|---|---|---|
| `LLM_API_KEY` | required | OpenRouter, OpenAI, xAI, any OpenAI-compatible key |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` | any OpenAI-compatible endpoint |
| `LLM_MODEL` | `openai/gpt-4o-mini` | cheap and sufficient; a full run costs about a cent |
| `REPLICATE_API_TOKEN` | optional | set it to generate real images (Google Nano Banana 2 on Replicate); leave empty to use the deterministic stub |

The console shows the full trace (color-coded per agent: plan, tool calls, reviews, revision rounds), and the finished assets land in `output/assets.md`. When `REPLICATE_API_TOKEN` is set, real renders are downloaded into `output/images/`; otherwise the image node returns a stub reference so the demo still runs offline and for free.

## How it maps to production

The demo is provider-agnostic on purpose. Every stubbed node has a real enterprise equivalent (Adobe's stack shown as one example, since it is where this pattern is heading).

| This demo | Enterprise equivalent (example) |
|---|---|
| stubbed `generateImage` tool | a hosted image generation API (e.g. Adobe Firefly Services, or any provider) |
| `brand.json` + BrandGuardian | brand governance systems (e.g. Adobe Brand Intelligence checks) |
| `src/orchestrator.ts` | a visual workflow engine (e.g. Adobe Firefly Workflow Builder, Monks.Flow) |
| in-memory `AssetStore` | a DAM such as AEM Assets |
| revision loop | automated QA gates plus human-in-the-loop review |
| zod-validated agent output | node contracts between workflow steps |

## Project layout

```
src/
  agent.ts          the agent loop primitive (start reading here)
  tools.ts          tool registry + shared asset store + brand linter
  orchestrator.ts   the pipeline: plan -> produce -> validate -> revise
  agents/           one file per role: same class, different prompt + tools
  types.ts          zod schemas for everything that crosses a boundary
  index.ts          entry point, writes output/assets.md
brand.json          the rulebook the BrandGuardian enforces
examples/brief.json the campaign brief the pipeline consumes
```
