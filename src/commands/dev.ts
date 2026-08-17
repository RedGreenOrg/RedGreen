import { Command } from 'commander';
import { loadConfig } from '../config/config.js';
import { createChat } from '../llm/client.js';
import { detectRunner } from '../runners/detect.js';
import { runPhaseTui } from '../tui/PhaseTui.js';
import { isInteractive, runHeadlessDev } from '../tui/nonInteractive.js';

export const devCommand = new Command('dev')
  .description('Start the 4-phase interactive TDD loop for a feature')
  .argument('<feature>', 'feature description')
  .action(async (feature: string) => {
    const { config } = loadConfig();
    if (!config) {
      console.error('No RedGreen config found. Run: npx redgreen init');
      process.exit(1);
    }
    const runner = detectRunner();
    if (!runner) {
      console.error('No test runner detected (vitest or jest). Install one: npm i -D vitest');
      process.exit(1);
    }
    let chat;
    try {
      chat = createChat(config);
    } catch (err) {
      console.error(String(err instanceof Error ? err.message : err));
      process.exit(1);
    }
    if (isInteractive()) {
      runPhaseTui({ feature, runner, chat, provider: config.provider });
    } else {
      await runHeadlessDev({ feature, runner, chat });
    }
  });