import { Command } from 'commander';
import { loadConfig } from '../config/config.js';
import { offerRunnerInstall, printRunnerStatus, runInitWizardFlow } from './setup.js';
import { createChat } from '../llm/client.js';
import { detectRunner } from '../runners/detect.js';
import { runPhaseTui } from '../tui/PhaseTui.js';
import { isInteractive, runHeadlessDev } from '../tui/nonInteractive.js';

export const devCommand = new Command('dev')
  .description('Start the 4-phase interactive TDD loop for a feature')
  .argument('<feature>', 'feature description')
  .action(async (feature: string) => {
    let { config } = loadConfig();
    const interactive = isInteractive();

    if (!config && interactive) {
      console.log('  No RedGreen config found - starting first-run setup\n');
      config = await runInitWizardFlow();
      if (config) printRunnerStatus();
    }
    if (!config) {
      console.error('No RedGreen config found. Run: npx redgreen init');
      process.exit(1);
    }

    let runner = detectRunner();
    if (!runner && interactive) {
      const installed = await offerRunnerInstall();
      if (installed) runner = detectRunner();
    }
    if (!runner) {
      console.error('No test runner detected (vitest, jest, mocha, or node:test).');
      console.error('Install one: npm i -D vitest   (or add `"test": "node --test"` to package.json)');
      process.exit(1);
    }

    let chat;
    try {
      chat = createChat(config);
    } catch (err) {
      console.error(String(err instanceof Error ? err.message : err));
      process.exit(1);
    }
    if (interactive) {
      runPhaseTui({ feature, runner, chat, provider: config.provider, stubComments: config.stubComments });
    } else {
      await runHeadlessDev({ feature, runner, chat, stubComments: config.stubComments });
    }
  });
