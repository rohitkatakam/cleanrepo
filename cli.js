#!/usr/bin/env node

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { exec } = require('child_process');

const argv = yargs(hideBin(process.argv))
  .option('base', {
    alias: 'b',
    type: 'string',
    description: 'Specify the base branch to compare against',
    default: 'main'
  })
  .usage('Usage: $0 [-b|--base BRANCH]')
  .help()
  .alias('help', 'h')
  .argv;

const baseBranch = argv.base;

console.log(`Selected base branch: ${baseBranch}`);

// You can add back the git logic here later, possibly using baseBranch