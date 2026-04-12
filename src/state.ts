import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RunState, Stage } from "./types.js";

interface SavedMessage {
  stage: Stage;
  round: number;
  timestamp: string;
  data: unknown;
}

export class StateManager {
  private runDir: string;

  constructor(runId: string, repoPath: string) {
    this.runDir = join(repoPath, ".design-challenger", "runs", runId);
  }

  getRunDir(): string { return this.runDir; }

  async initialize(): Promise<void> {
    await mkdir(join(this.runDir, "messages"), { recursive: true });
    await mkdir(join(this.runDir, "artifacts"), { recursive: true });
    await mkdir(join(this.runDir, "transcripts"), { recursive: true });
  }

  async checkpoint(state: RunState): Promise<void> {
    state.lastCheckpoint = new Date().toISOString();
    await writeFile(join(this.runDir, "state.json"), JSON.stringify(state, null, 2));
  }

  async saveMessage(stage: Stage, round: number, message: unknown): Promise<void> {
    const filename = `${stage}-round${round}-${Date.now()}.json`;
    const saved: SavedMessage = { stage, round, timestamp: new Date().toISOString(), data: message };
    await writeFile(join(this.runDir, "messages", filename), JSON.stringify(saved, null, 2));
  }

  async saveArtifact(name: string, content: string): Promise<void> {
    await writeFile(join(this.runDir, "artifacts", name), content);
  }

  async archiveTranscript(agent: string, transcript: string): Promise<void> {
    const filename = `${agent}-${Date.now()}.txt`;
    await writeFile(join(this.runDir, "transcripts", filename), transcript);
  }

  async loadState(): Promise<RunState | null> {
    try {
      const data = await readFile(join(this.runDir, "state.json"), "utf-8");
      return JSON.parse(data) as RunState;
    } catch {
      return null;
    }
  }

  async getMessages(stage?: Stage): Promise<SavedMessage[]> {
    const dir = join(this.runDir, "messages");
    try {
      const files = await readdir(dir);
      const messages: SavedMessage[] = [];
      for (const file of files.filter(f => f.endsWith(".json"))) {
        if (stage && !file.startsWith(stage)) continue;
        const data = JSON.parse(await readFile(join(dir, file), "utf-8"));
        messages.push(data);
      }
      return messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    } catch {
      return [];
    }
  }

  static async findRun(runId: string, repoPath: string): Promise<StateManager | null> {
    const mgr = new StateManager(runId, repoPath);
    const state = await mgr.loadState();
    return state ? mgr : null;
  }
}
