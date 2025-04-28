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
    description: 'Enable cleanup of remote branches on origin',
    default: false
  })
  .option('stale', { // Renamed from 'days'
    alias: 's', // Changed alias
    type: 'number',
    description: 'Additionally, cleanup branches (local and, if -r, remote) inactive for this many days.',
    default: 0 // Default 0 means no stale check
  })
  .usage('Usage: $0 [-b <branch>] [-r] [-s <days>]')
  .help()
  .alias('help', 'h')
  .argv;

const baseBranch = argv.base;
const deleteRemote = argv.remote;
const staleDays = argv.stale; // Renamed variable
const remoteName = 'origin'; // Hardcoding origin for now

console.log(`Using base branch: ${baseBranch}`);
if (deleteRemote) {
  console.log(`Remote cleanup enabled for '${remoteName}'.`);
}
if (staleDays > 0) {
    console.log(`Stale branch cleanup enabled: Branches inactive for > ${staleDays} days will be considered.`);
}


// --- Helper Functions ---
function runCommand(command, ignoreError = false) {
  // console.log(`> ${command}`); // Optional: Log commands being run
  try {
    // Increase maxBuffer size if needed for large command outputs
    return execSync(command, { stdio: 'pipe', maxBuffer: 1024 * 1024 * 5 }).toString().trim();
  } catch (error) {
    if (ignoreError) return ''; // Return empty string if error is ignored

    console.error(`Error running command: ${command}`);
    const stderr = error.stderr ? error.stderr.toString().trim() : '';
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
    // Don't warn here, handled later if needed
    return 0; // Return 0 to indicate failure
  }
}

async function confirmAndDelete(branches, type, reason, deleteFn, forceLocal = false) {
  if (!branches || branches.length === 0) {
    return { deleted: 0, failed: 0 };
  }

  // Ensure branches is always an array
  const branchList = Array.from(branches);
  if (branchList.length === 0) {
     return { deleted: 0, failed: 0 };
  }

  let listType = type === 'local' ? 'Local' : `Remote ('${remoteName}')`;
  console.log(`\nFound ${branchList.length} ${type} branch(es) candidates for deletion (${reason}):`);
  branchList.forEach(branch => console.log(`- ${branch}`));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => {
    console.log('\nOperation cancelled by user (SIGINT).');
    rl.close();
    process.exit(0);
  });

  let promptAction = type === 'local' ? 'locally' : `from remote '${remoteName}'`;
  let warning = '';
  if (forceLocal) {
      promptAction = 'locally (using force delete -D)';
      warning = ' WARNING: This will delete local branches even if unmerged.';
  }
  const question = `\nPress ENTER to delete these ${branchList.length} ${type} branch(es) ${promptAction}, or any other key + ENTER to cancel.${warning}: ` ;

  let deletedCount = 0;
  let failedCount = 0;

  const answer = await new Promise((resolve) => {
      rl.question(question, answer => {
          resolve(answer);
      });
  });

  rl.close();

  if (answer === '') {
    console.log(`\nDeleting ${type} branches (${reason})...`);
    for (const branch of branchList) {
      try {
        const command = await deleteFn(branch); // Get the command string
        runCommand(command); // Execute the command
        console.log(`- Deleted ${type} ${branch}`);
        deletedCount++;
      } catch (deleteError) {
        console.error(`- Failed to delete ${type} ${branch}`);
        failedCount++;
      }
    }
  } else {
    console.log(`\n${listType} deletion cancelled (${reason}).`);
  }
  return { deleted: deletedCount, failed: failedCount };
}

// --- Main Logic ---
(async () => {
  let totalLocalDeleted = 0;
  let totalLocalFailed = 0;
  let totalRemoteDeleted = 0;
  let totalRemoteFailed = 0;

  // Keep track of branches already handled to avoid double-processing
  const handledLocalBranches = new Set();
  const handledRemoteBranches = new Set(); // Store short names

  try {
    // 1. Initial Prune
    console.log('\nStep 1: Pruning remote-tracking branches...');
    runCommand(`git fetch ${remoteName} --prune`);

    // --- Define Deletion Functions ---
    const localMergedDeleteFn = async (branch) => `git branch -d ${branch}`;
    const localStaleDeleteFn = async (branch) => `git branch -D ${branch}`; // Force delete
    const remoteDeleteFn = async (branch) => `git push ${remoteName} --delete ${branch}`;

    // --- 2. Process LOCAL Merged Branches ---
    console.log(`\nStep 2a: Checking LOCAL branches merged into local '${baseBranch}'...`);
    let localMergedToDelete = new Set();
    try {
      runCommand(`git show-ref --verify --quiet refs/heads/${baseBranch}`);
      const localBranchesOutput = runCommand('git branch');
      let currentBranch = localBranchesOutput.split('\n').find(line => line.startsWith('*'))?.substring(1).trim() || '';
      const localBranchSet = new Set(localBranchesOutput.split('\n').map(l => l.trim().replace(/^\*\s*/, '')).filter(Boolean));
      console.log(`Current local branch: ${currentBranch}`);

      const mergedBranchesOutput = runCommand(`git branch --merged ${baseBranch}`);
      mergedBranchesOutput.split('\n')
        .map(line => line.trim().replace(/^\*\s*/, ''))
        .filter(Boolean)
        .forEach(branch => {
          if (localBranchSet.has(branch) && branch !== baseBranch && branch !== currentBranch) {
            localMergedToDelete.add(branch);
          }
        });
    } catch (error) {
        console.warn(`Skipping local merged check: Could not verify local base branch '${baseBranch}' or get branches.`);
    }

    const localMergedResult = await confirmAndDelete(localMergedToDelete, 'local', 'merged', localMergedDeleteFn);
    totalLocalDeleted += localMergedResult.deleted;
    totalLocalFailed += localMergedResult.failed;
    localMergedToDelete.forEach(b => handledLocalBranches.add(b)); // Mark as handled

    // --- 3. Process LOCAL Stale Branches (if requested) ---
    let localStaleToDelete = new Set();
    if (staleDays > 0) {
        console.log(`\nStep 2b: Checking LOCAL branches inactive for > ${staleDays} days...`);
        try {
            const localBranchesOutput = runCommand('git branch');
            let currentBranch = localBranchesOutput.split('\n').find(line => line.startsWith('*'))?.substring(1).trim() || '';
            const allLocalBranches = localBranchesOutput.split('\n')
                .map(l => l.trim().replace(/^\*\s*/, ''))
                .filter(Boolean);

            const cutoffTimestamp = Math.floor(Date.now() / 1000) - (staleDays * 24 * 60 * 60);

            for (const branch of allLocalBranches) {
                // Allow checking the current branch for staleness
                if (branch === baseBranch || handledLocalBranches.has(branch)) {
                    continue; // Skip base and already handled branches
                }
                const commitTimestamp = getBranchCommitTimestamp(branch);
                if (commitTimestamp > 0 && commitTimestamp < cutoffTimestamp) {
                    console.log(` - Found stale local branch: ${branch} (inactive since ${new Date(commitTimestamp * 1000).toLocaleDateString()})`);
                    localStaleToDelete.add(branch);
                } else if (commitTimestamp === 0) {
                    console.warn(` - Could not get timestamp for local branch ${branch}. Skipping stale check for it.`);
                }
            }
        } catch (error) {
            console.warn(`Could not get local branches for stale check.`);
        }

        // Confirm and delete stale local branches (using force)
        const localStaleResult = await confirmAndDelete(localStaleToDelete, 'local', 'stale', localStaleDeleteFn, true); // forceLocal = true
        totalLocalDeleted += localStaleResult.deleted;
        totalLocalFailed += localStaleResult.failed;
        // No need to add to handledLocalBranches again, as they are deleted
    }


    // --- 4. Process REMOTE Merged Branches (if requested) ---
    let remoteMergedToDelete = new Set(); // Store short names
    if (deleteRemote) {
        const remoteBaseBranch = `${remoteName}/${baseBranch}`;
        console.log(`\nStep 3a: Checking REMOTE branches merged into '${remoteBaseBranch}'...`);
        try {
            runCommand(`git show-ref --verify --quiet refs/remotes/${remoteBaseBranch}`);
            const mergedRemoteOutput = runCommand(`git branch -r --merged ${remoteBaseBranch}`);
            mergedRemoteOutput.split('\n')
                .map(line => line.trim())
                .filter(branch => branch && branch.startsWith(`${remoteName}/`) && branch !== remoteBaseBranch)
                .forEach(fullBranchName => {
                    remoteMergedToDelete.add(fullBranchName.substring(remoteName.length + 1)); // Add short name
                });
        } catch (error) {
            console.warn(`Skipping remote merged check: Could not verify remote base branch '${remoteBaseBranch}' or get branches.`);
        }

        const remoteMergedResult = await confirmAndDelete(remoteMergedToDelete, 'remote', 'merged', remoteDeleteFn);
        totalRemoteDeleted += remoteMergedResult.deleted;
        totalRemoteFailed += remoteMergedResult.failed;
        remoteMergedToDelete.forEach(b => handledRemoteBranches.add(b)); // Mark as handled

        // --- 5. Process REMOTE Stale Branches (if requested and stale check enabled) ---
        let remoteStaleToDelete = new Set(); // Store short names
        if (staleDays > 0) {
            console.log(`\nStep 3b: Checking REMOTE branches inactive for > ${staleDays} days...`);
             try {
                const remoteBaseBranchRef = `refs/remotes/${remoteName}/${baseBranch}`;
                 // Get all remote branches, excluding the base branch pointer
                const allRemoteBranchesOutput = runCommand(`git branch -r`);
                const allRemoteBranches = allRemoteBranchesOutput.split('\n')
                    .map(line => line.trim())
                    .filter(branch => branch && branch.startsWith(`${remoteName}/`) && branch !== remoteBaseBranchRef);

                const cutoffTimestamp = Math.floor(Date.now() / 1000) - (staleDays * 24 * 60 * 60);

                for (const fullBranchName of allRemoteBranches) {
                     const shortBranchName = fullBranchName.substring(remoteName.length + 1);
                    // Skip if already handled as merged
                    if (handledRemoteBranches.has(shortBranchName)) {
                        continue;
                    }

                    const commitTimestamp = getBranchCommitTimestamp(fullBranchName);
                    if (commitTimestamp > 0 && commitTimestamp < cutoffTimestamp) {
                         console.log(` - Found stale remote branch: ${shortBranchName} (inactive since ${new Date(commitTimestamp * 1000).toLocaleDateString()})`);
                        remoteStaleToDelete.add(shortBranchName);
                    } else if (commitTimestamp === 0) {
                        console.warn(` - Could not get timestamp for remote branch ${shortBranchName}. Skipping stale check for it.`);
                    }
                 }
            } catch(error){
                 console.warn(`Could not get remote branches for stale check.`);
            }

            // Confirm and delete stale remote branches
            const remoteStaleResult = await confirmAndDelete(remoteStaleToDelete, 'remote', 'stale', remoteDeleteFn);
            totalRemoteDeleted += remoteStaleResult.deleted;
            totalRemoteFailed += remoteStaleResult.failed;
            // No need to add to handledRemoteBranches again
        }

        // --- 6. Final Prune (if remote deletions occurred) ---
        if (totalRemoteDeleted > 0) {
            console.log('\nStep 4: Pruning remote-tracking branches after remote deletions...');
            runCommand(`git fetch ${remoteName} --prune`);
        } else {
             console.log('\nStep 4: No remote branches deleted, skipping final prune.');
        }
    } else {
         console.log("\nSteps 3 & 4: Remote cleanup skipped as --remote flag was not provided.");
    }


    // --- 7. Summary ---
    console.log('\n--- Summary ---');
    console.log(`Local branches: ${totalLocalDeleted} deleted, ${totalLocalFailed} failed.`);
    if (deleteRemote) {
      console.log(`Remote branches ('${remoteName}'): ${totalRemoteDeleted} deleted, ${totalRemoteFailed} failed.`);
    } else {
      console.log('Remote branch cleanup was not enabled (--remote).');
    }
    console.log('\nCleanup complete.');

  } catch (error) {
    console.error('\nAn unrecoverable error occurred during execution. Exiting.');
    process.exit(1);
  }
})(); // End async IIFE