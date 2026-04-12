import { query } from "@anthropic-ai/claude-agent-sdk";
import type { RunConfig } from "../types.js";
import type { ChallengerOutput } from "./types.js";
import { validateMessage, ValidationError, challengerOutputSchema } from "./schemas.js";
import type { TerminalUI } from "../ui/terminal.js";

export class ChallengerAgent {
  private sessionId?: string;
  private tokenUsage = { input: 0, output: 0 };
  private systemPrompt: string;

  constructor(
    private config: RunConfig,
    private ui: TerminalUI,
    systemPrompt: string,
  ) {
    this.systemPrompt = systemPrompt;
  }

  async send(prompt: string): Promise<ChallengerOutput> {
    const options: Record<string, unknown> = {
      cwd: this.config.repoPath,
      model: this.config.challengerModel,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      disallowedTools: ["Write", "Edit", "NotebookEdit", "Bash"],
      maxBudgetUsd: this.config.challengerBudget,
      systemPrompt: this.systemPrompt,
      settingSources: ["project"] as const,
      outputFormat: {
        type: "json_schema" as const,
        schema: challengerOutputSchema as Record<string, unknown>,
      },
    };

    if (this.sessionId) {
      options.resume = this.sessionId;
    }

    const gen = query({ prompt, options: options as any });
    return this.consumeAndParse(gen);
  }

  getSessionId(): string | undefined { return this.sessionId; }
  getTokenUsage() { return { ...this.tokenUsage }; }

  private async consumeAndParse(gen: AsyncGenerator<any>): Promise<ChallengerOutput> {
    let structuredOutput: unknown;
    let rawResult = "";
    for await (const msg of gen) {
      if (msg.type === "assistant" && typeof msg.content === "string") {
        this.ui.streamChallenger(msg.content);
      }
      if (msg.type === "result") {
        if (msg.session_id) this.sessionId = msg.session_id;
        if (msg.subtype === "success") {
          structuredOutput = msg.structured_output;
          rawResult = msg.result ?? "";
          if (msg.usage) {
            this.tokenUsage.input += msg.usage.input_tokens ?? 0;
            this.tokenUsage.output += msg.usage.output_tokens ?? 0;
          }
        }
      }
    }

    // Primary: use structured_output from SDK
    if (structuredOutput) {
      return validateMessage<ChallengerOutput>("challenger_output", structuredOutput);
    }

    // Fallback: extract JSON from raw text
    return this.extractAndValidate(rawResult);
  }

  private extractAndValidate(text: string): ChallengerOutput {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Challenger output contained no JSON. Raw output: " + text.slice(0, 500));
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return validateMessage<ChallengerOutput>("challenger_output", parsed);
  }
}
