import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import { PasswordInput, TextInput } from '@inkjs/ui';
import { PROVIDER_ENV, PROVIDER_MODELS } from '../config/config.js';
import type { LlmProvider, RedGreenConfig } from '../config/config.js';

const PROVIDER_ITEMS: { label: string; value: LlmProvider }[] = [
  { label: 'OpenAI (gpt-4o)', value: 'openai' },
  { label: 'Anthropic (claude-3-5-sonnet)', value: 'anthropic' },
  { label: 'Gemini (gemini-1.5-pro)', value: 'gemini' },
  { label: 'Ollama (local, no API key)', value: 'ollama' },
];

type Step = 'provider' | 'model' | 'key' | 'confirm';

export interface InitWizardProps {
  onDone: (config: RedGreenConfig) => void;
}

export function InitWizard({ onDone }: InitWizardProps): React.ReactElement {
  const [step, setStep] = useState<Step>('provider');
  const [provider, setProvider] = useState<LlmProvider | null>(null);
  const [model, setModel] = useState('');
  const [key, setKey] = useState('');

  useInput((input) => {
    if (step !== 'confirm' || !provider) return;
    if (input === '\r' || input === '\n') {
      onDone({
        provider,
        model: model || PROVIDER_MODELS[provider],
        apiKey: key.trim() || undefined,
      });
    }
  });

  const keyHint = PROVIDER_ENV[provider ?? 'openai'] || 'none needed (local Ollama)';

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        redgreen init
      </Text>
      <Text dimColor>Bring Your Own Key - secrets stay on this machine (zero-proxy).</Text>

      {step === 'provider' && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Select LLM Provider:</Text>
          <SelectInput
            items={PROVIDER_ITEMS}
            onSelect={(item) => {
              setProvider(item.value);
              setModel(PROVIDER_MODELS[item.value]);
              setStep('model');
            }}
          />
        </Box>
      )}

      {step === 'model' && provider && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            Model [default: <Text color="cyan">{PROVIDER_MODELS[provider]}</Text>]
          </Text>
          <TextInput
            defaultValue={PROVIDER_MODELS[provider]}
            onSubmit={(value) => {
              setModel(value);
              setStep('key');
            }}
          />
          <Text dimColor>Type to edit, Enter to confirm</Text>
        </Box>
      )}

      {step === 'key' && provider && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            API key [or leave empty to use <Text color="cyan">{keyHint}</Text>]:
          </Text>
          <PasswordInput
            placeholder=""
            onSubmit={(value) => {
              setKey(value);
              setStep('confirm');
            }}
          />
          <Text dimColor>Enter to confirm (stored obfuscated locally)</Text>
        </Box>
      )}

      {step === 'confirm' && provider && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Confirm:</Text>
          <Text>
            {'  Provider: '}
            <Text color="cyan">{provider}</Text>
          </Text>
          <Text>
            {'  Model:    '}
            <Text color="cyan">{model || PROVIDER_MODELS[provider]}</Text>
          </Text>
          <Text>
            {'  API key:  '}
            <Text color="cyan">
              {key.trim() ? '****' + key.trim().slice(-4) : `from ${keyHint} (env / none)`}
            </Text>
          </Text>
          <Box marginTop={1}>
            <Text dimColor>Press Enter to save to ~/.config/redgreen/config.json</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}