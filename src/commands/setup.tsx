import { execSync } from 'node:child_process';
import React from 'react';
import { Box, Text, render } from 'ink';
import { ConfirmInput } from '@inkjs/ui';
import { saveConfig } from '../config/config.js';
import type { RedGreenConfig } from '../config/config.js';
import {
  detectPackageManager,
  detectRunner,
  installArgs,
} from '../runners/detect.js';
import { InitWizard } from '../tui/InitWizard.js';

/**
 * Renders the interactive init wizard and saves the resulting config.
 * Resolves null when the user bails out (Ctrl+C).
 */
export async function runInitWizardFlow(): Promise<RedGreenConfig | null> {
  let result: RedGreenConfig | null = null;
  const instance = render(
    React.createElement(InitWizard, {
      onDone: (config: RedGreenConfig) => {
        result = config;
        instance.unmount();
      },
    }),
    { exitOnCtrlC: true },
  );
  await instance.waitUntilExit();
  if (!result) return null;
  const { path } = saveConfig(result);
  console.log(`\n  Config saved to ${path}`);
  return result;
}

export function printRunnerStatus(): void {
  const runner = detectRunner();
  if (runner) {
    console.log(`  Detected ${runner} runner in package.json`);
  } else {
    console.log('  No test runner detected - install vitest/jest/mocha or add "node --test" first');
  }
}

function InstallRunnerPrompt(props: {
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>No test runner detected</Text>
      <Text dimColor>RedGreen drives the loop through your test runner (vitest, jest, mocha, node:test).</Text>
      <Box marginTop={1}>
        <ConfirmInput onConfirm={props.onConfirm} onCancel={props.onCancel} />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>y/Enter installs vitest as a dev dependency</Text>
      </Box>
    </Box>
  );
}

/**
 * Asks the user to install vitest, then runs the package manager detected
 * from the lockfile. Returns true when an install was attempted successfully.
 */
export async function offerRunnerInstall(cwd?: string): Promise<boolean> {
  let confirmed: boolean | null = null;
  const instance = render(
    React.createElement(InstallRunnerPrompt, {
      onConfirm: () => {
        confirmed = true;
        instance.unmount();
      },
      onCancel: () => {
        confirmed = false;
        instance.unmount();
      },
    }),
    { exitOnCtrlC: true },
  );
  await instance.waitUntilExit();
  if (confirmed !== true) return false;

  const projectDir = cwd ?? process.cwd();
  const pm = detectPackageManager(projectDir);
  const [cmd, ...args] = installArgs(pm, ['vitest']);
  console.log(`\n  $ ${[cmd, ...args].join(' ')}`);
  try {
    execSync([cmd, ...args].join(' '), { stdio: 'inherit', cwd: projectDir });
    return true;
  } catch {
    console.error('  Install failed - run it manually and retry.');
    return false;
  }
}
