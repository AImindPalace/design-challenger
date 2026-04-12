#!/usr/bin/env node

import { Command } from "commander";
import { loadConfig, DEFAULTS } from "./config.js";
import { Orchestrator } from "./orchestrator.js";

const program = new Command();

program
  .name("design-challenger")
  .description(
    "Orchestrates adversarial AI agents to stress-test design specs before implementation"
  )
  .version("0.1.0")
  .argument("[topic]", "Design topic to explore")
  .option("--repo <path>", "Target repository", process.cwd())
  .option("--writer-model <name>", "Writer model", DEFAULTS.writerModel)
  .option("--challenger-model <name>", "Challenger model", DEFAULTS.challengerModel)
  .option("--max-rounds <n>", "Max review rounds per stage", String(DEFAULTS.maxRounds))
  .option("--budget <usd>", "Max spend in USD", String(DEFAULTS.budget))
  .option("--output-dir <path>", "Output directory for specs/plans")
  .option("--quiet", "Only show gates and errors")
  .option("--skip-brainstorm", "Skip brainstorming stage")
  .option("--spec <path>", "Existing spec, skip to plan writing")
  .option("--resume <run-id>", "Resume an interrupted run")
  .action(async (topic: string | undefined, options) => {
    if (!topic && !options.resume) {
      program.help();
      return;
    }

    try {
      const config = loadConfig(topic ?? "", options);
      const orchestrator = new Orchestrator(config);

      if (config.resumeRunId) {
        await orchestrator.resume(config.resumeRunId);
      } else {
        await orchestrator.run();
      }

      process.exit(DEFAULTS.exitCodes.success);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes("aborted")) {
        console.error(`\nAborted: ${message}`);
        process.exit(DEFAULTS.exitCodes.aborted);
      }

      if (message.includes("budget")) {
        console.error(`\nBudget exceeded: ${message}`);
        console.error("Use --budget <amount> to increase the limit, or --resume <run-id> to continue.");
        process.exit(DEFAULTS.exitCodes.budgetExceeded);
      }

      console.error(`\nError: ${message}`);
      if (error instanceof Error && error.stack) {
        console.error(error.stack);
      }
      process.exit(DEFAULTS.exitCodes.error);
    }
  });

program.parse();
