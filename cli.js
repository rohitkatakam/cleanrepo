#!/usr/bin/env node

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { execSync } = require('child_process');
const readline = require('readline');

// --- Argument Parsing ---
const argv = yargs(hideBin(process.argv))
  .option('base', {
    alias: 'b',
    type: 'string',
    description: 'Base branch for comparison (local and remote)',
    default: 'main'
  })
  .option('remote', {
    alias: 'r',
    type: 'boolean',
    description: 'Enable deletion of remote branches on origin',
    default: false
  })
  .option('days', { // Add days flag
    alias: 'd',
    type: 'number',
    description: 'Only delete remote branches inactive for this many days',
    default: 0 // Default 0 means no age filtering
  })
  .usage('Usage: $0 [-b <branch>] [-r] [-d <days>]')
  .help()
  .alias('help', 'h')
  .argv;

const baseBranch = argv.base;
const deleteRemote = argv.remote;
const inactiveDays = argv.days;
const remoteName = 'origin'; // Hardcoding origin for now

console.log(`Using base branch: ${baseBranch}`);
if (deleteRemote) {
  console.log(`Remote deletion enabled for '${remoteName}'.`);
  if (inactiveDays > 0) {
    console.log(`Applying age filter: Only remote branches inactive for > ${inactiveDays} days will be considered.`);
  }
}

// --- Helper Functions ---
function runCommand(command) {
  // console.log(`> ${command}`); // Optional: Log commands being run
  try {
    // Increase maxBuffer size if needed for large command outputs
    return execSync(command, { maxBuffer: 1024 * 1024 * 5 }).toString().trim();
  } catch (error) {
    console.error(`Error running command: ${command}`);
    const stderr = error.stderr ? error.stderr.toString().trim() : '';
    // Avoid printing the full error message if it's just about a non-zero exit code
    // and stderr already contains the relevant git message.
    if (stderr) {
        console.error(stderr);
    } else {
        console.error(error.message);
    }
    throw error; // Re-throw to be caught by main try-catch
  }
}

function getBranchCommitTimestamp(branchName) {
  try {
    // Use %ct for committer timestamp (Unix seconds)
    // Use --no-pager to prevent potential hanging on some systems
    const timestampStr = runCommand(`git --no-pager log -1 --format=%ct ${branchName}`);
    return parseInt(timestampStr, 10);
  } catch (error) {
    console.warn(`Could not get commit timestamp for ${branchName}`);
    return 0; // Return 0 to handle downstream
  }
}

async function confirmAndDelete(branches, type, deleteFn) {
  if (branches.length === 0) {
    // No need to prompt if there are no candidates
    return { deleted: 0, failed: 0 };
  }

  let listType = type === 'local' ? 'Local' : `Remote ('${remoteName}')`;
  console.log(`\nFound ${branches.length} ${type} candidate(s) for deletion:`);
  branches.forEach(branch => console.log(`- ${branch}`));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Explicitly handle closing on Ctrl+C
  rl.on('SIGINT', () => {
    console.log('\nOperation cancelled by user (SIGINT).');
    rl.close();
    process.exit(0);
  });

  const question = `\nPress ENTER to delete these ${branches.length} ${type} branch(es), or any other key + ENTER to cancel: ` ;

  let deletedCount = 0;
  let failedCount = 0;

  // Wrap readline question in a promise
  const answer = await new Promise((resolve) => {
      rl.question(question, answer => {
          resolve(answer);
      });
  });

  rl.close(); // Close the interface *after* getting the answer

  if (answer === '') {
    console.log(`\nDeleting ${type} branches...`);
    for (const branch of branches) {
      try {
        // No need to await runCommand if it uses execSync
        runCommand(await deleteFn(branch)); // Pass branch to deleteFn
        console.log(`- Deleted ${type} ${branch}`);
        deletedCount++;
      } catch (deleteError) {
        // Error message is printed within runCommand helper
        console.error(`- Failed to delete ${type} ${branch}`);
        failedCount++;
      }
    }
  } else {
    console.log(`\n${listType} deletion cancelled.`);
  }
  return { deleted: deletedCount, failed: failedCount };
}

// --- Main Logic ---
(async () => { // Use async IIFE to allow await for readline
  let totalLocalDeleted = 0;
  let totalLocalFailed = 0;
  let totalRemoteDeleted = 0;
  let totalRemoteFailed = 0;

  try {
    // 1. Initial Prune
    console.log('\nStep 1: Pruning remote-tracking branches...');
    runCommand(`git fetch ${remoteName} --prune`);

    // 2. Process Local Branches
    console.log(`\nStep 2: Checking local branches merged into local '${baseBranch}'...`);
    let localBranchesToDelete = [];
    try {
      // Verify local base exists
      runCommand(`git show-ref --verify --quiet refs/heads/${baseBranch}`);

      const localBranchesOutput = runCommand('git branch');
      let currentBranch = '';
      const localBranches = localBranchesOutput.split('\n').map(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('*')) {
          currentBranch = trimmed.substring(1).trim();
          return currentBranch;
        }
        return trimmed;
      }).filter(Boolean); // Filter out empty strings
      const localBranchSet = new Set(localBranches);
      console.log(`Current local branch: ${currentBranch}`);


      const mergedBranchesOutput = runCommand(`git branch --merged ${baseBranch}`);
      const mergedBranches = mergedBranchesOutput.split('\n')
        .map(line => line.trim().replace(/^\*\s*/, '')) // Trim and remove '*' prefix
        .filter(Boolean); // Filter out empty strings

      localBranchesToDelete = mergedBranches.filter(branch =>
        localBranchSet.has(branch) &&
        branch !== baseBranch &&
        branch !== currentBranch
      );

    } catch (error) {
        console.warn(`Skipping local branch check: Could not verify local base branch '${baseBranch}' or get local branches.`);
        // Error details are logged by runCommand helper
    }

    // Define the deletion function for local branches
    const localDeleteFn = async (branch) => `git branch -d ${branch}`;
    const localResult = await confirmAndDelete(localBranchesToDelete, 'local', localDeleteFn);
    totalLocalDeleted = localResult.deleted;
    totalLocalFailed = localResult.failed;

    // 3. Process Remote Branches (if requested)
    if (deleteRemote) {
      const remoteBaseBranch = `${remoteName}/${baseBranch}`;
      console.log(`\nStep 3: Checking remote branches on '${remoteName}' merged into '${remoteBaseBranch}'...`);
      let remoteMergedCandidates = []; // Store full names like 'origin/feature/A'
      let remoteBranchesToDelete = []; // Store short names like 'feature/A'

      try {
        const remoteBaseBranchRef = `refs/remotes/${remoteBaseBranch}`;
        runCommand(`git show-ref --verify --quiet ${remoteBaseBranchRef}`);

        const mergedRemoteOutput = runCommand(`git branch -r --merged ${remoteBaseBranch}`);
         remoteMergedCandidates = mergedRemoteOutput.split('\n')
            .map(line => line.trim())
            // Ensure it's from the target remote and not the remote base itself
            .filter(branch => branch && branch.startsWith(`${remoteName}/`) && branch !== remoteBaseBranch);


        if (remoteMergedCandidates.length > 0) {
            if (inactiveDays > 0) {
                console.log(`Applying age filter (${inactiveDays} days)...`);
                const cutoffTimestamp = Math.floor(Date.now() / 1000) - (inactiveDays * 24 * 60 * 60);
                const filteredRemoteBranches = [];

                for (const fullBranchName of remoteMergedCandidates) {
                    const shortBranchName = fullBranchName.substring(remoteName.length + 1);
                    const commitTimestamp = getBranchCommitTimestamp(fullBranchName);
                    if (commitTimestamp > 0 && commitTimestamp < cutoffTimestamp) {
                        filteredRemoteBranches.push(shortBranchName); // Store short name for deletion list
                        console.log(` - Queuing ${shortBranchName} (inactive since ${new Date(commitTimestamp * 1000).toLocaleDateString()})`);
                    } else if (commitTimestamp === 0) {
                        console.log(` - Skipping age check for ${shortBranchName} (could not get timestamp)`);
                    } else {
                        console.log(` - Keeping ${shortBranchName} (active since ${new Date(commitTimestamp * 1000).toLocaleDateString()})`);
                    }
                }
                remoteBranchesToDelete = filteredRemoteBranches;
            } else {
                // No age filter, use all potential candidates
                remoteBranchesToDelete = remoteMergedCandidates.map(b => b.substring(remoteName.length + 1));
            }
        } else {
            console.log(`No remote branches found merged into ${remoteBaseBranch}.`);
        }

      } catch (error) {
        console.warn(`Skipping remote branch check: Could not verify remote base branch '${remoteBaseBranch}' or get remote branches.`);
        // Error details logged by runCommand
      }

      // Define the deletion function for remote branches
      const remoteDeleteFn = async (branch) => `git push ${remoteName} --delete ${branch}`;
      const remoteResult = await confirmAndDelete(remoteBranchesToDelete, 'remote', remoteDeleteFn);
      totalRemoteDeleted = remoteResult.deleted;
      totalRemoteFailed = remoteResult.failed;

      // 4. Final Prune after remote deletes
      if (totalRemoteDeleted > 0) {
          console.log('\nStep 4: Pruning remote-tracking branches after remote deletions...');
          runCommand(`git fetch ${remoteName} --prune`);
      } else {
          console.log('\nStep 4: No remote branches deleted, skipping final prune.');
      }
    }

    // 5. Summary
    console.log('\n--- Summary ---');
    console.log(`Local branches: ${totalLocalDeleted} deleted, ${totalLocalFailed} failed.`);
    if (deleteRemote) {
      console.log(`Remote branches ('${remoteName}'): ${totalRemoteDeleted} deleted, ${totalRemoteFailed} failed.`);
    } else {
      console.log('Remote branch cleanup was not enabled (--remote).');
    }
    console.log('Cleanup complete.');

  } catch (error) {
    // Catch errors re-thrown from runCommand helpers
    console.error('\nAn unrecoverable error occurred during execution. Exiting.');
    process.exit(1);
  }
})(); // End async IIFE