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
  .option('dry-run', { // Add dry-run flag
    alias: 'D',
    type: 'boolean',
    description: 'Show which branches would be deleted without actually deleting them.',
    default: false
  })
  .usage('Usage: $0 [-b <branch>] [-r] [-s <days>] [-D]')
  .help()
  .alias('help', 'h')
  .argv;

const baseBranch = argv.base;
const deleteRemote = argv.remote;
const staleDays = argv.stale; // Renamed variable
const dryRun = argv['dry-run']; // Get dry-run value
const remoteName = 'origin'; // Hardcoding origin for now

console.log(`Using base branch: ${baseBranch}`);
if (deleteRemote) {
  console.log(`Remote cleanup enabled for '${remoteName}'.`);
}
if (staleDays > 0) {
    console.log(`Stale branch cleanup enabled: Branches inactive for > ${staleDays} days will be considered.`);
}
if (dryRun) {
    console.log('*** DRY RUN MODE ENABLED *** No changes will be made.');
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

// Helper function to get a map of branch names to their tip commit hashes
function getBranchTipMap(remote = false) {
    const branchMap = new Map();
    // Ensure remoteName is accessible or passed if needed
    const effectiveRemoteName = remote ? (typeof remoteName !== 'undefined' ? remoteName : 'origin') : '';
    const command = `git branch ${remote ? '-r ' : ''}--format='%(refname:short) %(objectname)'`;
    const output = runCommand(command, true); // Ignore errors initially
    if (output === null || output === '') {
        console.warn(`Could not retrieve ${remote ? 'remote' : 'local'} branches.`);
        return branchMap; // Return empty map on failure
    }

    output.split('\n').forEach(line => {
        const parts = line.trim().split(' ');
        if (parts.length === 2) {
            let branchName = parts[0];
            const commitHash = parts[1];
            // Strip remote prefix for remote branches if needed
            if (remote && branchName.startsWith(effectiveRemoteName + '/')) {
                branchName = branchName.substring(effectiveRemoteName.length + 1);
            }
            // Avoid adding HEAD pointers etc.
            if (branchName && !branchName.includes('->')) {
               branchMap.set(branchName, commitHash);
            }
        }
    });
    return branchMap;
}

// Helper function to find the commit hashes that were merged into a base branch
function getDirectlyMergedCommitHashes(base, remote = false) {
    const mergedHashes = new Set();
    // Ensure remoteName is accessible or passed if needed
    const effectiveRemoteName = remote ? (typeof remoteName !== 'undefined' ? remoteName : 'origin') : '';
    const fullBase = remote ? `${effectiveRemoteName}/${base}` : base;
    // Use --first-parent to follow only the main line of the base branch
    const command = `git log ${fullBase} --merges --first-parent --pretty=format:"%P"`;
    const output = runCommand(command, true); // Ignore errors initially
    if (output === null || output === '') return mergedHashes; // Return empty set on failure or empty output

    output.split('\n').filter(line => line.trim()).forEach(line => {
        const parents = line.trim().split(' ');
        if (parents.length > 1) { // Ensure there's a second parent
          mergedHashes.add(parents[1]); // Add the second parent hash
        }
    });
    return mergedHashes;
}

async function confirmAndDelete(branches, type, reason, deleteFn, forceLocal = false, isDryRun = false) {
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

  if (isDryRun) {
      console.log(`[Dry Run] Would attempt to delete these ${type} branches.`);
      return { deleted: 0, failed: 0 }; // Exit early in dry run mode
  }

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

    // --- 2. Process LOCAL Branches ---
    console.log("\n--- Processing LOCAL Branches ---");
    let localMergedToDelete = new Set();
    let localStaleToDelete = new Set();

    // --- 2a. Check LOCAL branches MERGED into local base ---
    console.log(`\nStep 2a: Checking LOCAL branches merged into local '${baseBranch}'...`);
    let currentBranch = '';
    try {
      runCommand(`git show-ref --verify --quiet refs/heads/${baseBranch}`);
      currentBranch = runCommand('git symbolic-ref --short HEAD', true) || '';
      console.log(`Current local branch: ${currentBranch}`);

      // New logic: Find branches whose tips match merged commits
      const localBranchTips = getBranchTipMap(false);
      const directlyMergedHashes = getDirectlyMergedCommitHashes(baseBranch, false);

      localBranchTips.forEach((commitHash, branchName) => {
          // Check if hash exists, not the base branch, not current branch
          if (directlyMergedHashes.has(commitHash) && branchName !== baseBranch && branchName !== currentBranch) {
              localMergedToDelete.add(branchName);
          }
      });
    } catch (error) {
        console.warn(`Skipping local merged check: Could not verify local base branch '${baseBranch}' or get branches. Error: ${error.message}`);
    }

    // --- 2b. Check LOCAL branches STALE (if requested) ---
    if (staleDays > 0) {
        console.log(`\nStep 2b: Checking LOCAL branches inactive for > ${staleDays} days...`);
        try {
            const localBranchesOutput = runCommand('git branch');
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
            console.warn(`Skipping local stale check: Could not get local branches. Error: ${error.message}`);
        }
    }

    // --- 2c. Perform LOCAL Deletions ---
    const localMergedResult = await confirmAndDelete(localMergedToDelete, 'local', 'merged', localMergedDeleteFn, false, dryRun);
    totalLocalDeleted += localMergedResult.deleted;
    totalLocalFailed += localMergedResult.failed;
    localMergedToDelete.forEach(b => handledLocalBranches.add(b)); // Mark merged as handled

    const localStaleResult = await confirmAndDelete(localStaleToDelete, 'local', `stale (> ${staleDays} days)`, localStaleDeleteFn, true, dryRun);
    totalLocalDeleted += localStaleResult.deleted;
    totalLocalFailed += localStaleResult.failed;
    // No need to add stale to handledLocalBranches, they are deleted

    // --- 3. Process REMOTE Branches (if requested) ---
    let remoteMergedToDelete = new Set(); // Store short names
    let remoteStaleToDelete = new Set(); // Store short names
    let handledRemoteBranches = new Set();
    let remoteBranchTips = new Map(); // Initialize here

    if (deleteRemote) {
        console.log("\n--- Processing REMOTE Branches ---");
        const remoteBaseBranch = `${remoteName}/${baseBranch}`;

        // --- 3a. Check REMOTE branches MERGED into remote base ---
        console.log(`\nStep 3a: Checking REMOTE branches merged into '${remoteBaseBranch}'...`);
        remoteBranchTips = getBranchTipMap(true); // Get remote tips map
        try {
            runCommand(`git show-ref --verify --quiet refs/remotes/${remoteBaseBranch}`); // Verify remote base exists

            // New logic: Find branches whose tips match merged commits
            const directlyMergedHashesRemote = getDirectlyMergedCommitHashes(baseBranch, true);
            remoteBranchTips.forEach((commitHash, branchName) => {
                 // Check hash exists, not the base branch itself
                 if (directlyMergedHashesRemote.has(commitHash) && branchName !== baseBranch) {
                     remoteMergedToDelete.add(branchName);
                 }
             });
        } catch (error) {
            console.warn(`Skipping remote merged check: Could not verify remote base branch '${remoteBaseBranch}' or get branches. Error: ${error.message}`);
        }

        // --- 3b. Check REMOTE branches STALE (if requested) ---
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
                 console.warn(`Skipping remote stale check: Could not get remote branches. Error: ${error.message}`);
            }
        }

        // --- 3c. Perform REMOTE Deletions ---
        const remoteMergedResult = await confirmAndDelete(remoteMergedToDelete, 'remote', 'merged', remoteDeleteFn, false, dryRun);
        totalRemoteDeleted += remoteMergedResult.deleted;
        totalRemoteFailed += remoteMergedResult.failed;
        remoteMergedToDelete.forEach(b => handledRemoteBranches.add(b)); // Mark merged as handled

        const remoteStaleResult = await confirmAndDelete(remoteStaleToDelete, 'remote', `stale (> ${staleDays} days)`, remoteDeleteFn, false, dryRun);
        totalRemoteDeleted += remoteStaleResult.deleted;
        totalRemoteFailed += remoteStaleResult.failed;
        // No need to add stale to handledRemoteBranches

        // --- 4. Final Prune (if remote deletions occurred) ---
        if (!dryRun && (totalRemoteDeleted > 0 || totalRemoteFailed > 0)) { // Prune if deletes happened or failed attempts might leave refs
            console.log('\nStep 4: Pruning remote-tracking branches after remote operations...');
            runCommand(`git fetch ${remoteName} --prune`);
        } else {
            console.log('\nStep 4: No remote branches deleted or deletion attempts made, skipping final prune.');
        }
    } else {
        console.log("\nSteps 3 & 4: Remote cleanup skipped as --remote flag was not provided.");
    }

    // --- 7. Summary ---
    console.log('\n--- Summary ---');
    if (dryRun) {
        console.log('*** Dry run complete. No branches were deleted. ***');
    }
    console.log(`Local branches: ${totalLocalDeleted} deleted, ${totalLocalFailed} failed.`);
    if (deleteRemote) {
      console.log(`Remote branches ('${remoteName}'): ${totalRemoteDeleted} deleted, ${totalRemoteFailed} failed.`);
    } else {
      console.log('Remote branch cleanup was not enabled (--remote).');
    }
    console.log('\nCleanup complete.');

  } catch (error) {
    console.error('\nAn unrecoverable error occurred during execution:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
})(); // End async IIFE