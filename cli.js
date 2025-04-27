#!/usr/bin/env node

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
// Use execSync for simpler sequential command execution
const { execSync } = require('child_process');
// Import readline for user confirmation
const readline = require('readline');

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

console.log(`Using base branch: ${baseBranch}`);

try {
  // 1. Verify base branch exists locally
  try {
    execSync(`git show-ref --verify --quiet refs/heads/${baseBranch}`);
    console.log(`Base branch '${baseBranch}' found locally.`);
  } catch (error) {
    console.error(`Error: Base branch '${baseBranch}' not found locally.`);
    process.exit(1);
  }

  // 2. Fetch updates (optional but recommended)
  console.log('Fetching updates from remote...');
  execSync('git fetch --prune');

  // 3. Get all local branches and current branch
  const localBranchesOutput = execSync('git branch').toString();
  let currentBranch = '';
  const localBranches = localBranchesOutput
    .split('\n')
    .map(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('*')) {
        currentBranch = trimmed.substring(1).trim();
        return currentBranch;
      }
      return trimmed;
    })
    .filter(branch => branch !== ''); // Remove empty lines
  const localBranchSet = new Set(localBranches);
  console.log(`Current branch: ${currentBranch}`);
  // console.log('All local branches:', localBranches);

  // 4. Get all branches merged into the base branch
  console.log(`Finding branches merged into ${baseBranch}...`);
  const mergedBranchesOutput = execSync(`git branch --merged ${baseBranch}`).toString();
  const mergedBranches = mergedBranchesOutput
    .split('\n')
    .map(line => line.trim().replace(/^\*\s*/, '')) // Trim and remove leading '*' if present
    .filter(branch => branch !== ''); // Remove empty lines
  // console.log('All merged identifiers:', mergedBranches);

  // 5. Filter for *local* branches that are merged (excluding base and current)
  const deletableBranches = mergedBranches.filter(branch =>
    localBranchSet.has(branch) && // Must be a local branch
    branch !== baseBranch &&       // Cannot be the base branch
    branch !== currentBranch      // Cannot be the current branch
  );

  // 6. Output results and prompt for deletion
  if (deletableBranches.length > 0) {
    console.log(`\nBranches merged into '${baseBranch}' (excluding base and current):`);
    deletableBranches.forEach(branch => console.log(`- ${branch}`));

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('\nPress ENTER to delete these branches, or any other key + ENTER to cancel: ', (answer) => {
      if (answer === '') {
        console.log('\nDeleting branches...');
        let deletedCount = 0;
        let failedCount = 0;
        deletableBranches.forEach(branch => {
          try {
            execSync(`git branch -d ${branch}`);
            console.log(`- Deleted ${branch}`);
            deletedCount++;
          } catch (deleteError) {
            console.error(`- Failed to delete ${branch}: ${deleteError.stderr || deleteError.message}`);
            failedCount++;
          }
        });
        console.log(`\nFinished: ${deletedCount} deleted, ${failedCount} failed.`);
      } else {
        console.log('\nDeletion cancelled.');
      }
      rl.close();
    });

  } else {
    console.log(`\nNo local branches found that are merged into '${baseBranch}' (excluding base and current).`);
    // No need to prompt if there's nothing to delete, exit normally
  }

} catch (error) {
  console.error('\nAn error occurred while executing git commands:');
  console.error(error.stderr ? error.stderr.toString() : error.message);
  process.exit(1);
}