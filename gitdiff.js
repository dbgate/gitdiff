#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ------------------------------
// Helper: Run a git command in a given directory
// ------------------------------
function runGitCommand(repoPath, cmd) {
  try {
    return execSync(`git -C "${repoPath}" ${cmd}`, { encoding: 'utf8' });
  } catch (err) {
    console.error(`Error running git command in ${repoPath}: ${cmd}\n`, err.message);
    return '';
  }
}

// ------------------------------
// Check usage
// ------------------------------
if (process.argv.length < 3) {
  console.error('Usage: gitdiff <state-repo-path>');
  process.exit(1);
}

const stateRepoPath = path.resolve(process.argv[2]);

// ------------------------------
// Load configuration from config.json (in the state repository)
// ------------------------------
const configPath = path.join(stateRepoPath, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error(`Missing configuration file: ${configPath}`);
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error('Error parsing config.json:', err);
  process.exit(1);
}

const branches = config.branches; // e.g. ["master", "develop"]
const reposConfig = config.repos;  // e.g. { "repo1": "url1", "repo2": "url2", "repo3": "url3" }

// Define local paths for each repo (as subdirectories of the state repo)
const repoPaths = {};
for (const repoName in reposConfig) {
  repoPaths[repoName] = path.join(stateRepoPath, repoName);
}

// ------------------------------
// Clone repositories if they don't exist
// ------------------------------
for (const repoName in reposConfig) {
  const repoUrl = reposConfig[repoName];
  const localPath = repoPaths[repoName];
  if (!fs.existsSync(localPath)) {
    console.log(`Cloning ${repoName} from ${repoUrl} into ${localPath}`);
    try {
      runGitCommand(stateRepoPath, `clone ${repoUrl} ${repoName}`);
    } catch (err) {
      console.error(`Failed to clone ${repoName}:`, err);
      process.exit(1);
    }
  } else {
    console.log(`Repository ${repoName} already exists at ${localPath}`);
  }
}

// ------------------------------
// State tracking
// ------------------------------
const stateFilePath = path.join(stateRepoPath, 'state.json');

function loadState() {
  try {
    if (fs.existsSync(stateFilePath)) {
      return JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading state:', err);
  }
  // Structure: { repo1: { branchName: [commitHash, ...] }, repo2: {...}, repo3: {...} }
  return { repo1: {}, repo2: {}, repo3: {} };
}

function saveState(state) {
  try {
    fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving state:', err);
  }
}

function isCommitProcessed(state, repo, branch, commitHash) {
  return state[repo] &&
         state[repo][branch] &&
         state[repo][branch].includes(commitHash);
}

function markCommitProcessed(state, repo, branch, commitHash) {
  if (!state[repo]) {
    state[repo] = {};
  }
  if (!state[repo][branch]) {
    state[repo][branch] = [];
  }
  state[repo][branch].push(commitHash);
  saveState(state);
}

// ------------------------------
// Git diff and file operations
// ------------------------------
function getCommits(repoPath, branch) {
  const log = runGitCommand(repoPath, `log ${branch} --pretty=format:"%H"`);
  return log.split('\n').filter(Boolean);
}

function getDiffForCommit(repoPath, commitHash) {
  const diffOutput = runGitCommand(repoPath, `show ${commitHash} --name-status`);
  const changes = [];
  diffOutput.split('\n').forEach(line => {
    if (!line.trim()) return;
    // Expected format: "A<TAB>path/to/file", "D<TAB>path/to/file", etc.
    const [action, ...fileParts] = line.split('\t');
    const file = fileParts.join('\t').trim();
    if (file) {
      changes.push({ action: action.trim(), file });
    }
  });
  return changes;
}

function fileExists(repoPath, file) {
  return fs.existsSync(path.join(repoPath, file));
}

function copyFile(srcRepo, destRepo, file) {
  const srcPath = path.join(srcRepo, file);
  const destPath = path.join(destRepo, file);
  if (!fs.existsSync(srcPath)) {
    console.warn(`Source file does not exist: ${srcPath}`);
    return;
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
  console.log(`Copied ${file} from ${srcRepo} to ${destRepo}`);
}

function removeFile(repoPath, file) {
  const filePath = path.join(repoPath, file);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    console.log(`Removed ${file} from ${repoPath}`);
  }
}

// ------------------------------
// Processing functions per repository type
// ------------------------------

// For repo1 (base):
// - Add: copy to repo3 if not present in repo2
// - Remove: remove from repo3 if not in repo2
// - Modify: update repo3 if not in repo2
function processRepo1Commit(commitHash, branch, state) {
  console.log(`Processing repo1 commit: ${commitHash} on branch ${branch}`);
  const changes = getDiffForCommit(repoPaths.repo1, commitHash);
  changes.forEach(change => {
    if (change.action === 'A') {
      if (!fileExists(repoPaths.repo2, change.file)) {
        copyFile(repoPaths.repo1, repoPaths.repo3, change.file);
      }
    } else if (change.action === 'D') {
      if (!fileExists(repoPaths.repo2, change.file)) {
        removeFile(repoPaths.repo3, change.file);
      }
    } else if (change.action === 'M') {
      if (!fileExists(repoPaths.repo2, change.file)) {
        copyFile(repoPaths.repo1, repoPaths.repo3, change.file);
      }
    }
  });
  markCommitProcessed(state, 'repo1', branch, commitHash);
}

// For repo2 (diff):
// - Add: add/overwrite in repo3
// - Remove: remove from repo3 if not in repo1
// - Modify: update repo3 (overwrite)
function processRepo2Commit(commitHash, branch, state) {
  console.log(`Processing repo2 commit: ${commitHash} on branch ${branch}`);
  const changes = getDiffForCommit(repoPaths.repo2, commitHash);
  changes.forEach(change => {
    if (change.action === 'A') {
      copyFile(repoPaths.repo2, repoPaths.repo3, change.file);
    } else if (change.action === 'D') {
      if (!fileExists(repoPaths.repo1, change.file)) {
        removeFile(repoPaths.repo3, change.file);
      }
    } else if (change.action === 'M') {
      copyFile(repoPaths.repo2, repoPaths.repo3, change.file);
    }
  });
  markCommitProcessed(state, 'repo2', branch, commitHash);
}

// For repo3 (merged):
// - Add: copy to repo2
// - Remove: remove from repo1 and repo2
// - Modify: if exists in repo2 then update repo2, else update repo1
function processRepo3Commit(commitHash, branch, state) {
  console.log(`Processing repo3 commit: ${commitHash} on branch ${branch}`);
  const changes = getDiffForCommit(repoPaths.repo3, commitHash);
  changes.forEach(change => {
    if (change.action === 'A') {
      copyFile(repoPaths.repo3, repoPaths.repo2, change.file);
    } else if (change.action === 'D') {
      removeFile(repoPaths.repo1, change.file);
      removeFile(repoPaths.repo2, change.file);
    } else if (change.action === 'M') {
      if (fileExists(repoPaths.repo2, change.file)) {
        copyFile(repoPaths.repo3, repoPaths.repo2, change.file);
      } else {
        copyFile(repoPaths.repo3, repoPaths.repo1, change.file);
      }
    }
  });
  markCommitProcessed(state, 'repo3', branch, commitHash);
}

// ------------------------------
// Helper to checkout a branch in a repo (creating it if needed)
// ------------------------------
function checkoutBranch(repoPath, branch) {
  // Fetch the latest from remote.
  runGitCommand(repoPath, 'fetch');
  try {
    // Try checking out the branch directly.
    runGitCommand(repoPath, `checkout ${branch}`);
  } catch (err) {
    // If checkout fails, try creating a new branch tracking the remote.
    console.log(`Branch ${branch} not found locally in ${repoPath}, creating it.`);
    runGitCommand(repoPath, `checkout -b ${branch} origin/${branch}`);
  }
  // Pull latest changes.
  runGitCommand(repoPath, 'pull');
}

// ------------------------------
// Helper to commit & push changes in a repository
// ------------------------------
function commitAndPush(repoPath, commitMessage) {
  const status = runGitCommand(repoPath, 'status --porcelain');
  if (!status.trim()) {
    console.log(`No changes to commit in ${repoPath}`);
    return;
  }
  runGitCommand(repoPath, 'add -A');
  try {
    runGitCommand(repoPath, `commit -m "${commitMessage}"`);
    // runGitCommand(repoPath, 'push');
    console.log(`Committed and pushed changes in ${repoPath}`);
  } catch (err) {
    console.error(`Error committing changes in ${repoPath}:`, err);
  }
}

// ------------------------------
// Main processing loop
// ------------------------------
const state = loadState();

// For each branch in the configuration, checkout that branch in each repository,
// process commits from each repo, and then commit & push changes.
branches.forEach(branch => {
  console.log(`\n=== Processing branch: ${branch} ===\n`);

  // For each repository, checkout the branch.
  for (const repoName in repoPaths) {
    const repoPath = repoPaths[repoName];
    console.log(`Checking out branch ${branch} in ${repoName}`);
    checkoutBranch(repoPath, branch);
  }

  // Process commits for each repository.
  // Note: The processing functions assume that the repo's working copy is on the branch being processed.
  // Process repo1 (base) commits.
  const repo1Commits = getCommits(repoPaths.repo1, branch);
  repo1Commits.forEach(commitHash => {
    if (!isCommitProcessed(state, 'repo1', branch, commitHash)) {
      processRepo1Commit(commitHash, branch, state);
    } else {
      console.log(`Skipping already processed repo1 commit: ${commitHash}`);
    }
  });

  // Process repo2 (diff) commits.
  const repo2Commits = getCommits(repoPaths.repo2, branch);
  repo2Commits.forEach(commitHash => {
    if (!isCommitProcessed(state, 'repo2', branch, commitHash)) {
      processRepo2Commit(commitHash, branch, state);
    } else {
      console.log(`Skipping already processed repo2 commit: ${commitHash}`);
    }
  });

  // Process repo3 (merged) commits.
  const repo3Commits = getCommits(repoPaths.repo3, branch);
  repo3Commits.forEach(commitHash => {
    if (!isCommitProcessed(state, 'repo3', branch, commitHash)) {
      processRepo3Commit(commitHash, branch, state);
    } else {
      console.log(`Skipping already processed repo3 commit: ${commitHash}`);
    }
  });

  // After processing the branch, commit & push changes for each repository.
  for (const repoName in repoPaths) {
    const repoPath = repoPaths[repoName];
    commitAndPush(
      repoPath,
      `CI: Auto commit changes in ${repoName} for branch ${branch}`
    );
  }
});

// Finally, commit and push state repository changes (which include state.json and config.json).
checkoutBranch(stateRepoPath, branches[0]); // Ensure we are on one of the branches (or adjust as needed)
commitAndPush(stateRepoPath, "CI: Auto commit state.json and config.json updates");

console.log("Processing complete.");
