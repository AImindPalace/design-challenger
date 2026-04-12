import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { RunConfig } from "./types.js";

export const DEFAULTS = {
  writerModel: "claude-opus-4-6",
  challengerModel: "claude-opus-4-6",
  judgeModel: "claude-haiku-4-5-20251001", // Haiku requires date suffix
  maxRounds: 3,
  budget: 20,
  writerBudgetShare: 0.4,
  challengerBudgetShare: 0.4,
  judgeBudgetShare: 0.1,
  verifierBudgetShare: 0.1,
  outputDir: "docs/superpowers",
  quiet: false,
  contextThresholds: {
    observationMasking: 150_000,
    activeSummarization: 250_000,
    alert: 500_000,
  },
  maxSchemaRetries: 2,
  exitCodes: {
    success: 0,
    aborted: 1,
    error: 2,
    budgetExceeded: 3,
  },
} as const;

export interface ContextThresholds {
  observationMasking: number;
  activeSummarization: number;
  alert: number;
}

// CLI options as parsed by Commander (string values)
export interface CliOptions {
  repo?: string;
  writerModel?: string;
  challengerModel?: string;
  maxRounds?: string;
  budget?: string;
  outputDir?: string;
  quiet?: boolean;
  skipBrainstorm?: boolean;
  spec?: string;
  resume?: string;
}

export function loadConfig(topic: string, options: CliOptions): RunConfig {
  const maxRounds = options.maxRounds
    ? parseInt(options.maxRounds, 10)
    : DEFAULTS.maxRounds;
  const budget = options.budget
    ? parseFloat(options.budget)
    : DEFAULTS.budget;

  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error(`Invalid budget: must be a positive number, got "${options.budget ?? budget}"`);
  }
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new Error(`Invalid maxRounds: must be an integer >= 1, got "${options.maxRounds ?? maxRounds}"`);
  }

  const repoPath = resolve(options.repo ?? process.cwd());

  const outputDir = options.outputDir
    ? resolve(options.outputDir)
    : resolve(repoPath, DEFAULTS.outputDir);

  const writerBudget = budget * DEFAULTS.writerBudgetShare;
  const challengerBudget = budget * DEFAULTS.challengerBudgetShare;
  const judgeBudget = budget * DEFAULTS.judgeBudgetShare;
  const verifierBudget = budget * DEFAULTS.verifierBudgetShare;

  return {
    topic,
    repoPath,
    writerModel: options.writerModel ?? DEFAULTS.writerModel,
    challengerModel: options.challengerModel ?? DEFAULTS.challengerModel,
    judgeModel: DEFAULTS.judgeModel,
    maxRounds,
    budget,
    writerBudget,
    challengerBudget,
    judgeBudget,
    verifierBudget,
    outputDir,
    quiet: options.quiet ?? DEFAULTS.quiet,
    skipBrainstorm: options.skipBrainstorm ?? false,
    existingSpecPath: options.spec,
    resumeRunId: options.resume,
  };
}

export function generateRunId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const suffix = randomBytes(3).toString("hex");
  return `${date}-${suffix}`;
}

// Model pricing for cost estimation (USD per 1M tokens)
export const MODEL_PRICING: Record<
  string,
  { input: number; output: number }
> = {
  "claude-opus-4-6": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4 },
};

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING["claude-opus-4-6"];
  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output
  );
}
