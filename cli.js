#!/usr/bin/env node

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { execSync } = require('child_process');
const readline = require('readline');
const inquirer = require('inquirer'); // <-- Add inquirer

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
    alias: 's',
    description: 'Flag branches with no commits in the specified number of days as stale for potential deletion. Use -s without a number to use the default.',
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
let actualStaleDays = argv.stale !== undefined ? parseInt(argv.stale, 10) : 120; // Parse and apply default manually
if (isNaN(actualStaleDays)) {
    console.warn(`WARN: Invalid value provided for --stale: '${argv.stale}'. Using default 120 days.`);
    actualStaleDays = 120;
}
const dryRun = argv['dry-run']; // Get dry-run value
const remoteName = 'origin'; // Hardcoding origin for now

console.log(`Using base branch: ${baseBranch}`);
if (deleteRemote) {
  console.log(`Remote cleanup enabled for '${remoteName}'.`);
}
if (argv.stale !== undefined) { // Check if the -s flag was passed by the user
    console.log(`Stale branch cleanup enabled: Branches inactive for >= ${actualStaleDays} days will be considered.`);
} else {
    // If -s was not passed, the default 120 is implicitly active, but we might not need to log it explicitly.
    // console.log(`Stale branch cleanup enabled: Using default >= 120 days threshold.`); 
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

// Interactive prompt to select branches for deletion
async function selectBranchesToDelete(branches, type, reason, isDryRun = false) {
  if (!branches || branches.size === 0) {
    return []; // Return empty array if no candidates
  }

  const branchList = Array.from(branches);
  const message = isDryRun
      ? `[Dry Run] Select ${type.toUpperCase()} branches (${reason}) to mark for deletion (use arrows, space to toggle, enter to confirm):`
      : `Select ${type.toUpperCase()} branches (${reason}) to delete (use arrows, space to toggle, enter to confirm):`;

  const { selectedBranches } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'selectedBranches',
      message: message,
      choices: branchList.map(branch => ({ name: branch, checked: true })), // Default to selected
      pageSize: 10, // Adjust as needed
      loop: false,
    },
  ]);

  return selectedBranches; // Return the array of selected branch names
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
    if (argv.stale !== undefined) { 
        console.log(`\nStep 2b: Checking LOCAL branches inactive for >= ${actualStaleDays} days...`);
        const staleThreshold = (Date.now() / 1000) - (actualStaleDays * 24 * 60 * 60); // In seconds

        try {
            const allLocalBranchesOutput = runCommand('git branch --format="%(refname:short)"');
            const allLocalBranches = allLocalBranchesOutput.split('\n')
                .map(l => l.trim())
                .filter(Boolean);

            for (const branch of allLocalBranches) {
                // Skip if already handled as merged OR if it's the base branch
                if (branch === baseBranch || handledLocalBranches.has(branch)) {
                    continue;
                }

                const commitTimestamp = getBranchCommitTimestamp(branch);
                if (commitTimestamp > 0) {
                    const isStale = commitTimestamp <= staleThreshold; // Use <= for comparison

                    if (isStale) {
                        // Only add to stale list if NOT already marked as merged
                        if (isStale && !localMergedToDelete.has(branch)) {
                            const inactiveDate = new Date(commitTimestamp * 1000).toLocaleDateString();
                            // Apply dry-run prefix and color codes correctly
                            const branchDisplayName = `\x1b[1;32m${branch}\x1b[0m`;
                            const logMsg = ` - Found stale local branch: ${branchDisplayName} (inactive since ${inactiveDate})`;
                            if (dryRun) {
                                console.log(`[Dry Run]${logMsg}`);
                            } else {
                                console.log(logMsg);
                            }
                            localStaleToDelete.add(branch);
                            handledLocalBranches.add(branch); // Mark as handled
                        }
                    }
                } else if (commitTimestamp === 0) {
                    console.warn(` - Could not get timestamp for local branch ${branch}. Skipping stale check for it.`);
                }
            }
        } catch (error) {
            console.warn(`Skipping local stale check: Could not get local branches. Error: ${error.message}`);
        }
    }

    // --- 2c. Perform LOCAL Deletions ---
    if (dryRun) {
        if (localMergedToDelete.size > 0) {
            console.log(`\n[Dry Run] Found ${localMergedToDelete.size} LOCAL branch(es) candidates for deletion (merged):`);
            localMergedToDelete.forEach(branch => console.log(`  - \x1b[1;32m${branch}\x1b[0m`)); // Bold Green branch name
            // No actual deletion or further action in dry run for this section
        } else {
            console.log("\n[Dry Run] No local merged branches identified for deletion.");
        }
        // Skip interactive selection and deletion loop in dry run
    } else {
        // Normal Run: Interactive Selection and Deletion
        const localMergedSelected = await selectBranchesToDelete(localMergedToDelete, 'local', 'merged', dryRun);
        let localMergedDeletedCount = 0;
        let localMergedFailedCount = 0;
        if (localMergedSelected.length > 0) {
            console.log(`Attempting deletion of ${localMergedSelected.length} selected local merged branch(es):`);
            for (const branch of localMergedSelected) {
                handledLocalBranches.add(branch); // Mark as handled
                try {
                    runCommand(await localMergedDeleteFn(branch));
                    console.log(`  - Deleted local merged branch: ${branch}`);
                    localMergedDeletedCount++;
                } catch (error) {
                    console.error(`  - FAILED to delete local merged branch: ${branch}. Error: ${error.message}`);
                    localMergedFailedCount++;
                }
            }
        } else {
            console.log("No local merged branches selected for deletion.");
        }
        totalLocalDeleted += localMergedDeletedCount;
        totalLocalFailed += localMergedFailedCount;
    }

    if (dryRun) {
        if (localStaleToDelete.size > 0) {
            console.log(`\n[Dry Run] Found ${localStaleToDelete.size} LOCAL branch(es) candidates for deletion (stale >= ${actualStaleDays} days):`);
            localStaleToDelete.forEach(branch => console.log(`  - \x1b[1;32m${branch}\x1b[0m`)); // Bold Green branch name
        } else {
            console.log(`\n[Dry Run] No local stale branches identified for deletion.`);
        }
        // Skip interactive selection and deletion loop in dry run
    } else {
        // Normal Run: Interactive Selection and Deletion
        const localStaleSelected = await selectBranchesToDelete(localStaleToDelete, 'local', `stale (>= ${actualStaleDays} days)`, dryRun);
        let localStaleDeletedCount = 0;
        let localStaleFailedCount = 0;
        if (localStaleSelected.length > 0) {
            console.log(`Attempting deletion of ${localStaleSelected.length} selected local stale branch(es):`);
            for (const branch of localStaleSelected) {
                // Stale branches might already be handled if also merged, but deletion is idempotent (force delete)
                try {
                    runCommand(await localStaleDeleteFn(branch));
                    console.log(`  - Deleted local stale branch: ${branch}`);
                    localStaleDeletedCount++;
                } catch (error) {
                    console.error(`  - FAILED to delete local stale branch: ${branch}. Error: ${error.message}`);
                    localStaleFailedCount++;
                }
            }
        } else {
            console.log("No local stale branches selected for deletion.");
        }
        totalLocalDeleted += localStaleDeletedCount;
        totalLocalFailed += localStaleFailedCount;
    }

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
        if (argv.stale !== undefined && deleteRemote) { // Check if the -s flag was passed and remote is enabled
            console.log(`\nStep 3b: Checking REMOTE branches inactive for >= ${actualStaleDays} days...`);
            const staleThreshold = (Date.now() / 1000) - (actualStaleDays * 24 * 60 * 60); // In seconds

            try {
                 const remoteBaseBranchRef = `refs/remotes/${remoteName}/${baseBranch}`;
                // Get all remote branches, excluding the base branch pointer
                const allRemoteBranchesOutput = runCommand(`git branch -r`);
                const allRemoteBranches = allRemoteBranchesOutput.split('\n')
                    .map(line => line.trim())
                    .filter(branch => branch && branch.startsWith(`${remoteName}/`) && branch !== remoteBaseBranchRef);

                for (const fullBranchName of allRemoteBranches) {
                     const shortBranchName = fullBranchName.substring(remoteName.length + 1);
                    // Skip if already handled as merged OR if it's the base branch
                    if (shortBranchName === baseBranch || handledRemoteBranches.has(shortBranchName)) {
                        continue;
                    }

                    const commitTimestamp = getBranchCommitTimestamp(fullBranchName); // Use full name for timestamp
                    if (commitTimestamp > 0) {

                        const isStale = commitTimestamp <= staleThreshold; // Use <= for comparison

                        // Only add to stale list if NOT already marked as merged
                        if (isStale && !remoteMergedToDelete.has(shortBranchName)) {
                            const inactiveDate = new Date(commitTimestamp * 1000).toLocaleDateString();
                            // Apply dry-run prefix and color codes correctly
                            const branchDisplayName = `\x1b[1;32m${fullBranchName}\x1b[0m`; // Use full name for display
                            const logMsg = ` - Found stale remote branch: ${branchDisplayName} (inactive since ${inactiveDate})`;
                            if (dryRun) {
                                console.log(`[Dry Run]${logMsg}`);
                            } else {
                                console.log(logMsg);
                            }
                            remoteStaleToDelete.add(shortBranchName); // Add the short name for deletion
                            handledRemoteBranches.add(shortBranchName); // Mark as handled
                        }
                    } else if (commitTimestamp === 0) {
                        console.warn(` - Could not get timestamp for remote branch ${shortBranchName}. Skipping stale check for it.`);
                    }
                 }
            } catch(error){
                 console.warn(`Skipping remote stale check: Could not get remote branches. Error: ${error.message}`);
            }
        }

        // --- 3c. Perform REMOTE Deletions ---
        if (dryRun) {
            if (remoteMergedToDelete.size > 0) {
                console.log(`\n[Dry Run] Found ${remoteMergedToDelete.size} REMOTE branch(es) candidates for deletion (merged):`);
                remoteMergedToDelete.forEach(branch => console.log(`  - \x1b[1;32m${remoteName}/${branch}\x1b[0m`)); // Bold Green branch name
            } else {
                console.log(`\n[Dry Run] No remote merged branches identified for deletion.`);
            }
            // Skip interactive selection and deletion loop in dry run
        } else {
            // Normal Run: Interactive Selection and Deletion
            const remoteMergedSelected = await selectBranchesToDelete(remoteMergedToDelete, 'remote', 'merged', dryRun);
            let remoteMergedDeletedCount = 0;
            let remoteMergedFailedCount = 0;
            if (remoteMergedSelected.length > 0) {
                console.log(`Attempting deletion of ${remoteMergedSelected.length} selected remote merged branch(es):`);
                for (const branch of remoteMergedSelected) {
                    handledRemoteBranches.add(branch); // Mark as handled
                    try {
                        runCommand(await remoteDeleteFn(branch));
                        console.log(`  - Deleted remote merged branch: ${remoteName}/${branch}`);
                        remoteMergedDeletedCount++;
                    } catch (error) {
                        console.error(`  - FAILED to delete remote merged branch: ${remoteName}/${branch}. Error: ${error.message}`);
                        remoteMergedFailedCount++;
                    }
                }
            } else {
                console.log("No remote merged branches selected for deletion.");
            }
            totalRemoteDeleted += remoteMergedDeletedCount;
            totalRemoteFailed += remoteMergedFailedCount;
        }

        if (dryRun) {
             if (remoteStaleToDelete.size > 0) {
                 console.log(`\n[Dry Run] Found ${remoteStaleToDelete.size} REMOTE branch(es) candidates for deletion (stale >= ${actualStaleDays} days):`);
                 remoteStaleToDelete.forEach(branch => console.log(`  - \x1b[1;32m${remoteName}/${branch}\x1b[0m`)); // Bold Green branch name
             } else {
                 console.log(`\n[Dry Run] No remote stale branches identified for deletion.`);
             }
             // Skip interactive selection and deletion loop in dry run
        } else {
            // Normal Run: Interactive Selection and Deletion
            const remoteStaleSelected = await selectBranchesToDelete(remoteStaleToDelete, 'remote', `stale (>= ${actualStaleDays} days)`, dryRun);
            let remoteStaleDeletedCount = 0;
            let remoteStaleFailedCount = 0;
            if (remoteStaleSelected.length > 0) {
                console.log(`Attempting deletion of ${remoteStaleSelected.length} selected remote stale branch(es):`);
                for (const branch of remoteStaleSelected) {
                    try {
                        runCommand(await remoteDeleteFn(branch));
                        console.log(`  - Deleted remote stale branch: ${remoteName}/${branch}`);
                        remoteStaleDeletedCount++;
                    } catch (error) {
                        console.error(`  - FAILED to delete remote stale branch: ${remoteName}/${branch}. Error: ${error.message}`);
                        remoteStaleFailedCount++;
                    }
                }
            } else {
                 console.log("No remote stale branches selected for deletion.");
            }
            totalRemoteDeleted += remoteStaleDeletedCount;
            totalRemoteFailed += remoteStaleFailedCount;
        }

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