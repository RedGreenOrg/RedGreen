#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { devCommand } from './commands/dev.js';
import { loginCommand } from './commands/login.js';

const program = new Command();

program
  .name('redgreen')
  .description('Reclaim your coding flow state with Type-First Ping-Pong TDD')
  .version('0.1.0');

program.addCommand(initCommand);
program.addCommand(devCommand);
program.addCommand(loginCommand);

await program.parseAsync(process.argv);