const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');
export {};

function runGit(args, cwd, input = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));

    child.stdin.end(input);
  }) as Promise<{ code: number; stdout: string; stderr: string }>;
}

async function patchForUnstageNewFile(root, relative, selected) {
  const staged = await gitOrThrow(['show', `:${relative}`], root);
  const working = await fs.readFile(path.join(root, relative), 'utf8');
  const stagedLines = staged.split('\n');
  const workingLines = working.split('\n');
  const remaining = [];
  let workingIndex = 0;

  for (let stagedIndex = 0; stagedIndex < stagedLines.length; stagedIndex += 1) {
    const stagedLine = stagedLines[stagedIndex];

    // The final empty item represents the file's trailing newline, not a
    // selectable line.
    if (
      stagedIndex === stagedLines.length - 1 &&
      stagedLine === '' &&
      workingLines[workingLines.length - 1] === ''
    ) {
      remaining.push(stagedLine);
      continue;
    }

    while (
      workingIndex < workingLines.length &&
      workingLines[workingIndex] !== stagedLine
    ) {
      workingIndex += 1;
    }

    if (
      workingIndex >= workingLines.length ||
      !selected.has(workingIndex + 1)
    ) {
      remaining.push(stagedLine);
    }
    workingIndex += 1;
  }

  if (remaining.length === stagedLines.length) return null;

  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'linestage-')
  );
  const oldFile = path.join(temporaryDirectory, 'old');
  const newFile = path.join(temporaryDirectory, 'new');

  try {
    await fs.writeFile(oldFile, staged);
    await fs.writeFile(newFile, remaining.join('\n'));

    const result = await runGit(
      [
        'diff',
        '--no-index',
        '--full-index',
        '--no-color',
        '--unified=1',
        '--',
        oldFile,
        newFile
      ],
      root
    );
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(result.stderr.trim() || 'Unable to create an unstaging patch');
    }

    return result.stdout
      .replace(`diff --git a${oldFile} b${newFile}`, `diff --git a/${relative} b/${relative}`)
      .replace(`--- a${oldFile}`, `--- a/${relative}`)
      .replace(`+++ b${newFile}`, `+++ b/${relative}`);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function patchForUnstageTrackedFile(root, relative, desiredContent) {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'linestage-')
  );
  const currentIndexFile = path.join(temporaryDirectory, 'index');
  const desiredIndexFile = path.join(temporaryDirectory, 'desired');

  try {
    await fs.writeFile(
      currentIndexFile,
      await gitOrThrow(['show', `:${relative}`], root)
    );
    await fs.writeFile(desiredIndexFile, desiredContent);

    const result = await runGit(
      [
        'diff',
        '--no-index',
        '--full-index',
        '--no-color',
        '--unified=1',
        '--',
        currentIndexFile,
        desiredIndexFile
      ],
      root
    );
    if (result.code !== 0 && result.code !== 1) {
      throw new Error(result.stderr.trim() || 'Unable to create an unstaging patch');
    }

    return result.stdout
      .replace(
        `diff --git a${currentIndexFile} b${desiredIndexFile}`,
        `diff --git a/${relative} b/${relative}`
      )
      .replace(`--- a${currentIndexFile}`, `--- a/${relative}`)
      .replace(`+++ b${desiredIndexFile}`, `+++ b/${relative}`);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function gitOrThrow(args, cwd) {
  const result = await runGit(args, cwd);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout;
}

module.exports = {
  patchForUnstageNewFile,
  patchForUnstageTrackedFile
};
