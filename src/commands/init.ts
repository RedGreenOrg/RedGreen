import { Command } from 'commander';
import { LLM_PROVIDERS, PROVIDER_MODELS, saveConfig } from '../config/config.js';
import type { LlmProvider, RedGreenConfig } from '../config/config.js';
import { isInteractive } from '../tui/nonInteractive.js';
import { printRunnerStatus, runInitWizardFlow } from './setup.js';

interface InitOptions {
  provider?: string;
  apiKey?: string;
  model?: string;
  yes?: boolean;
}

function saveAndSummarize(config: RedGreenConfig): void {
  const { path } = saveConfig(config);
  console.log(`  Config saved to ${path}`);
  printRunnerStatus();
}

export const initCommand = new Command('init')
  .description('Initialize RedGreen: configure BYOK keys and detect test runner')
  .option('-p, --provider <provider>', `LLM provider: ${LLM_PROVIDERS.join(' | ')}`)
  .option('-k, --api-key <key>', 'API key (env vars take precedence, e.g. OPENAI_API_KEY)')
  .option('-m, --model <model>', 'default model for the provider')
  .option('-y, --yes', 'accept defaults non-interactively')
  .action(async (options: InitOptions) => {
    if (options.provider || options.yes) {
      const provider = (options.provider as LlmProvider) ?? 'openai';
      if (!(LLM_PROVIDERS as readonly string[]).includes(provider)) {
        console.error(`Unknown provider "${provider}". Choose: ${LLM_PROVIDERS.join(' | ')}`);
        process.exit(1);
      }
      saveAndSummarize({
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

    const config = await runInitWizardFlow();
    if (config) printRunnerStatus();
  });
