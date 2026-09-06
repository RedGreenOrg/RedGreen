#!/usr/bin/env node
import { Command } from 'commander';
import { createRequire } from 'node:module';
import { initCommand } from './commands/init.js';
import { devCommand } from './commands/dev.js';
import { tutorialCommand } from './commands/tutorial.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const program = new Command();

program
  .name('redgreen')
  .description('Interactive test-first ping-pong TDD with an AI partner')
  .version(pkg.version);

program.addCommand(initCommand);
program.addCommand(devCommand);
program.addCommand(tutorialCommand);

await program.parseAsync(process.argv);