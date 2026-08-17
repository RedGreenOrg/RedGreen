import React from 'react';
import { Command } from 'commander';
import { render } from 'ink';
import { LLM_PROVIDERS, PROVIDER_MODELS, saveConfig } from '../config/config.js';
import type { LlmProvider, RedGreenConfig } from '../config/config.js';
import { detectRunner } from '../runners/detect.js';
import { InitWizard } from '../tui/InitWizard.js';
import { isInteractive } from '../tui/nonInteractive.js';

interface InitOptions {
  provider?: string;
  apiKey?: string;
  model?: string;
  yes?: boolean;
}

function summarize(config: RedGreenConfig): void {
  const { path } = saveConfig(config);
  console.log(`  Config saved to ${path}`);
  const runner = detectRunner();
  if (runner) {
    console.log(`  Detected ${runner} runner in package.json`);
  } else {
    console.log('  No test runner detected - install vitest or jest first');
  }
}

export const initCommand = new Command('init')
  .description('Initialize RedGreen: configure BYOK keys and detect test runner')
  .option('-p, --provider <provider>', `LLM provider: ${LLM_PROVIDERS.join(' | ')}`)
  .option('-k, --api-key <key>', 'API key (env vars take precedence, e.g. OPENAI_API_KEY)')
  .option('-m, --model <model>', 'default model for the provider')
  .option('-y, --yes', 'accept defaults non-interactively')
  .action((options: InitOptions) => {
    if (options.provider || options.yes) {
      const provider = (options.provider as LlmProvider) ?? 'openai';
      if (!(LLM_PROVIDERS as readonly string[]).includes(provider)) {
        console.error(`Unknown provider "${provider}". Choose: ${LLM_PROVIDERS.join(' | ')}`);
        process.exit(1);
      }
      summarize({
        provider,
        model: options.model ?? PROVIDER_MODELS[provider],
        apiKey: options.apiKey,
      });
      return;
    }

    if (!isInteractive()) {
      console.error('Non-interactive init requires flags. Example:');
      console.error('  npx redgreen init -p openai -k <key> -m gpt-4o');
      console.error(`  Providers: ${LLM_PROVIDERS.join(' | ')}`);
      process.exit(1);
    }

    const instance = render(
      React.createElement(InitWizard, {
        onDone: (config: RedGreenConfig) => {
          instance.unmount();
          summarize(config);
          process.exit(0);
        },
      }),
      { exitOnCtrlC: true },
    );
  });