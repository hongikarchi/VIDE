#!/usr/bin/env node
// `vide` entry point (PLAN-52 T-315): the installed `bin\vide.cmd` runs this file with the bundled
// Node (`runtime\node.exe`); in the repository `node src/cli/vide.ts …` does the same.
import { runCli } from './cli.ts';

process.exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
