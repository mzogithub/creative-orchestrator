/**
 * The core agent primitive, written from scratch. No frameworks.
 *
 * An "agent" is not magic. It is a plain loop around an LLM chat call:
 *
 *   1. Send the conversation so far, plus the list of tools the model may use.
 *   2. If the model replies with plain text, that is the final answer. Stop.
 *   3. If the model replies with tool calls, run each tool in real code,
 *      append every result to the conversation, and go back to step 1.
 *
 * The model decides WHAT to do next, our code decides HOW it happens.
 * Everything else in this repo (roles, orchestration, the brand revision
 * loop) is composition on top of this one loop.
 */
import OpenAI from "openai";
import { z } from "zod";

/**
 * A tool is a named, described, schema-validated function.
 *
 * The name and description are read by the model (they are the docs it
 * plans with). The zod schema works twice: it is converted to JSON Schema
 * so the model knows the argument shape, and it validates whatever the
 * model actually sent before our code runs.
 */
export interface Tool {
  name: string;
  description: string;
  /** Typed loosely so tools with different shapes fit in one array. defineTool restores inference. */
  parameters: z.ZodObject<any>;
  execute: (args: any) => Promise<string> | string;
}

/** Gives tool authors fully typed args without casts at the definition site. */
export function defineTool<S extends z.ZodObject<any>>(tool: {
  name: string;
  description: string;
  parameters: S;
  execute: (args: z.infer<S>) => Promise<string> | string;
}): Tool {
  return tool;
}

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ToolCall = NonNullable<OpenAI.Chat.Completions.ChatCompletionMessage["tool_calls"]>[number];

export interface AgentConfig {
  name: string;
  /** The role. This is the ONLY thing that differentiates the four agents in src/agents/. */
  systemPrompt: string;
  /** The capabilities this agent is allowed to use. An empty array is fine. */
  tools: Tool[];
  model: string;
  client: OpenAI;
  /** chalk color for this agent's trace lines, so handoffs stay readable. */
  color: (text: string) => string;
  /** Safety cap on loop iterations, so a confused model cannot spin forever. */
  maxSteps?: number;
}

export class Agent {
  readonly name: string;
  private readonly tools: Tool[];
  private readonly model: string;
  private readonly client: OpenAI;
  private readonly color: (text: string) => string;
  private readonly maxSteps: number;

  /**
   * Conversation memory. Nothing fancy: the full message history of this
   * agent instance, kept across run() calls. This is why a later request
   * like "revise caption-2" works, the agent still has its own earlier
   * draft (and the tool results) in context.
   */
  private readonly messages: ChatMessage[] = [];

  constructor(config: AgentConfig) {
    this.name = config.name;
    this.tools = config.tools;
    this.model = config.model;
    this.client = config.client;
    this.color = config.color;
    this.maxSteps = config.maxSteps ?? 12;
    this.messages.push({ role: "system", content: config.systemPrompt });
  }

  /**
   * THE agent loop. Everything an "agent framework" sells is in here,
   * in about forty lines.
   */
  async run(input: string): Promise<string> {
    this.messages.push({ role: "user", content: input });

    for (let step = 1; step <= this.maxSteps; step++) {
      // One LLM turn: the model sees the whole history plus the tool menu.
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: this.messages,
        tools: this.toolDefinitions(),
      });

      const message = response.choices[0]?.message;
      if (!message) throw new Error(`${this.name}: the model returned no choices`);

      // The assistant turn goes into memory verbatim, tool calls included,
      // so the model can see its own past actions on the next turn.
      this.messages.push(message);

      const toolCalls = message.tool_calls ?? [];

      // No tool calls means the model is done: this is the final answer.
      if (toolCalls.length === 0) {
        const answer = message.content ?? "";
        this.log(`answered: ${preview(answer)}`);
        return answer;
      }

      // Otherwise run every requested tool and feed the results back.
      // The API requires one tool message per tool_call id, even on failure,
      // so errors are returned as text for the model to react to.
      for (const call of toolCalls) {
        const result = await this.executeToolCall(call);
        this.messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }

    // Hitting the cap means the model kept calling tools without concluding.
    this.log(`stopped after ${this.maxSteps} steps without a final answer`);
    return "[stopped: max steps reached]";
  }

  private async executeToolCall(call: ToolCall): Promise<string> {
    if (call.type !== "function") {
      return `Error: unsupported tool call type "${call.type}"`;
    }

    const tool = this.tools.find((t) => t.name === call.function.name);
    if (!tool) {
      // Feed the error back instead of throwing: the model can correct itself.
      return `Error: unknown tool "${call.function.name}"`;
    }

    try {
      // Never trust model-generated arguments. Parse the JSON, then validate
      // the shape with zod, before any real code runs.
      const args = tool.parameters.parse(JSON.parse(call.function.arguments || "{}"));
      this.log(`tool ${tool.name}(${preview(JSON.stringify(args))})`);
      return await tool.execute(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`tool ${call.function.name} failed: ${preview(message)}`);
      return `Error: ${message}`;
    }
  }

  /** Convert each tool's zod schema to the JSON Schema wire format the API expects. */
  private toolDefinitions(): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
    if (this.tools.length === 0) return undefined;
    return this.tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: z.toJSONSchema(tool.parameters) as Record<string, unknown>,
      },
    }));
  }

  private log(line: string): void {
    console.log(this.color(`  [${this.name}] ${line}`));
  }
}

/** Trim long strings so the console trace stays readable. */
export function preview(text: string, max = 110): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}...`;
}
