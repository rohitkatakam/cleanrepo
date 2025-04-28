# CleanRepo: Interactive Git Branch Cleanup Tool

`cleanrepo` is a command-line utility designed to help you clean up your local and remote Git repositories by identifying and interactively deleting merged or stale branches.

## Features

*   Identifies local and remote branches merged into a specified base branch.
*   Optionally identifies branches that haven't seen commits for a configurable number of days (stale branches).
*   Provides an interactive checklist interface (`inquirer`) to select which branches to delete.
*   Supports dry runs to preview branches that would be deleted without making changes.
*   Safely handles the current branch and the base branch.

## Installation

To use `cleanrepo` from anywhere on your system, install it globally using npm:

```bash
npm install -g .
```

*(Run this command from within the `cleanrepo` project directory after cloning or downloading it).*

Alternatively, for development or local use, you can run it directly using `node`:

```bash
node cli.js [options]
```

Make sure you have Node.js and npm installed.

## Usage

```bash
cleanrepo [options]
```

## Options

| Option        | Alias | Type    | Default | Description                                                                                                |
|---------------|-------|---------|---------|------------------------------------------------------------------------------------------------------------|
| `--base`      | `-b`  | string  | `main`  | The base branch to compare against for identifying merged branches (both locally and on the remote).         |
| `--remote`    | `-r`  | boolean | `false` | Enable checking and deleting remote branches on `origin`. Requires `git fetch --prune` beforehand.         |
| `--stale`     | `-s`  | number  | `120`   | Check for branches (local and, if `-r`, remote) with no commits older than this many days. Activates stale check. |
| `--dry-run`   | `-D`  | boolean | `false` | Show which branches *would* be deleted based on the criteria, but don't actually delete anything.        |

**Notes on `--stale`:**
*   Providing `-s` or `--stale` without a number uses the default value (120 days).
*   Providing `-s <days>` or `--stale <days>` uses the specified number of days.
*   If the `--stale` flag is *not* provided at all, stale branches are *not* checked or deleted.
*   Staleness is based on the *author date* of the last commit on the branch.

## Interactive Mode

When running *without* `--dry-run`, `cleanrepo` will present you with interactive prompts for each category of branches identified for deletion (e.g., local merged, remote stale):

1.  A checklist will appear, showing the candidate branches.
2.  All branches are selected by default.
3.  Use the **Arrow Keys** (Up/Down) to navigate the list.
4.  Press the **Spacebar** to toggle the selection status (checked/unchecked) of the highlighted branch.
5.  Press **'a'** to toggle the selection for *all* branches.
6.  Press **'i'** to invert the current selection.
7.  Press **Enter** to confirm your selection.

Only the branches you leave **checked** when you press Enter will be deleted.

## Examples

**1. Dry Run: See local and remote branches merged into `main` or stale for 120+ days:**

```bash
cleanrepo -r -D -s
# Or using the default stale value:
cleanrepo -r -D --stale
```
*(This will list candidates but not delete anything. Branch names will be highlighted.)*

**2. Interactively delete local branches merged into `develop`:**

```bash
cleanrepo -b develop
```
*(You will be prompted to select which merged local branches to delete.)*

**3. Interactively delete local and remote branches merged into `main` OR stale for 30+ days:**

```bash
cleanrepo -r -s 30
```
*(You will get separate prompts for local merged, local stale, remote merged, and remote stale branches if candidates are found in each category.)*

**4. Delete ONLY local branches stale for more than 180 days (compared to `main`):**

```bash
cleanrepo -s 180
```
*(This will only find and prompt for local stale branches.)*
