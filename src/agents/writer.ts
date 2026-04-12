import { query } from "@anthropic-ai/claude-agent-sdk";
import type { RunConfig } from "../types.js";
import type { AgentResponse } from "./types.js";
import type { TerminalUI } from "../ui/terminal.js";

export class WriterAgent {
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

  async send(prompt: string): Promise<AgentResponse> {
    const options: Record<string, unknown> = {
      cwd: this.config.repoPath,
      model: this.config.writerModel,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch", "Agent"],
      maxBudgetUsd: this.config.writerBudget,
      systemPrompt: this.systemPrompt,
      settingSources: ["project"] as const,
    };

    if (this.sessionId) {
      options.resume = this.sessionId;
    }

    const gen = query({ prompt, options: options as any });
    return this.consumeStream(gen);
  }

  getSessionId(): string | undefined { return this.sessionId; }
  getTokenUsage() { return { ...this.tokenUsage }; }

  private async consumeStream(gen: AsyncGenerator<any>): Promise<AgentResponse> {
    let result = "";
    for await (const msg of gen) {
      if (msg.type === "assistant" && typeof msg.content === "string") {
        this.ui.streamWriter(msg.content);
      }
      if (msg.type === "result") {
        if (msg.session_id) this.sessionId = msg.session_id;
        if (msg.subtype === "success") {
          result = msg.result ?? "";
          if (msg.usage) {
            this.tokenUsage.input += msg.usage.input_tokens ?? 0;
            this.tokenUsage.output += msg.usage.output_tokens ?? 0;
          }
        }
      }
    }
    return { result, sessionId: this.sessionId ?? "" };
  }
}
