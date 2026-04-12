import { query } from "@anthropic-ai/claude-agent-sdk";
import type { RunConfig } from "../types.js";
import type { OrchestratorToJudge, JudgeOutput } from "./types.js";
import { validateMessage, judgeOutputSchema } from "./schemas.js";
import type { TerminalUI } from "../ui/terminal.js";

export class JudgeAgent {
  private systemPrompt: string;

  constructor(
    private config: RunConfig,
    private ui: TerminalUI,
    systemPrompt: string,
  ) {
    this.systemPrompt = systemPrompt;
  }

  // Ephemeral -- no session persistence
  async evaluate(input: OrchestratorToJudge): Promise<JudgeOutput> {
    const gen: AsyncGenerator<any> = query({
      prompt: JSON.stringify(input),
      options: {
        model: this.config.judgeModel,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxBudgetUsd: this.config.judgeBudget,
        systemPrompt: this.systemPrompt,
        outputFormat: {
          type: "json_schema" as const,
          schema: judgeOutputSchema as Record<string, unknown>,
        },
      } as any,
    });

    let structuredOutput: unknown;
    let rawResult = "";
    for await (const msg of gen) {
      if (msg.type === "assistant" && typeof msg.content === "string") {
        this.ui.streamJudge(msg.content);
      }
      if (msg.type === "result" && msg.subtype === "success") {
        structuredOutput = msg.structured_output;
        rawResult = msg.result ?? "";
      }
    }

    if (structuredOutput) {
      return validateMessage<JudgeOutput>("judge_output", structuredOutput);
    }

    // Fallback
    const jsonMatch = rawResult.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Judge output contained no JSON");
    return validateMessage<JudgeOutput>("judge_output", JSON.parse(jsonMatch[0]));
  }
}
