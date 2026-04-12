export interface NotificationAdapter {
  notifyGate(stage: string, summary: string): Promise<void>;
  notifyAlert(message: string): Promise<void>;
}

export class TerminalNotifier implements NotificationAdapter {
  async notifyGate(stage: string, summary: string): Promise<void> {
    // For now, just log to terminal. Future: Telegram/Slack adapters.
    console.log(`\n[GATE] ${stage}: ${summary}`);
  }

  async notifyAlert(message: string): Promise<void> {
    console.log(`\n[ALERT] ${message}`);
  }
}
