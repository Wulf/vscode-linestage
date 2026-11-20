const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vscode = require('vscode');
const {
  patchForUnstageNewFile,
  patchForUnstageTrackedFile
} = require('./patch');
export {};

const workspaceRoots = new Map();
let noWorkspaceRoot;

function runGit(args, cwd, input = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    if (input) child.stdin.end(input);
    else child.stdin.end();
  }) as Promise<{ code: number; stdout: string; stderr: string }>;
}

async function gitOrThrow(args, cwd, input = undefined) {
  const result = await runGit(args, cwd, input);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout;
}

function editorFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    throw new Error('Open a file in the editor first.');
  }
  const { uri } = editor.document;
  if (uri.scheme !== 'file' && uri.scheme !== 'git') {
    throw new Error('Open a file in the editor first.');
  }
  return uri.fsPath;
}

function commandFile(uri) {
  if (uri && uri.scheme === 'file') return uri.fsPath;
  return editorFile();
}

async function repositoryInfo(file) {
  const workspaceFolder = vscode.workspace?.getWorkspaceFolder?.(
    vscode.Uri.file(file)
  );
  const workspacePath = workspaceFolder?.uri.fsPath;
  const root = workspacePath
    ? await workspaceRepositoryRoot(workspacePath)
    : await noWorkspaceRepositoryRoot(file);

  if (!root) {
    throw new Error('The workspace folder is not a Git repository.');
  }

  const relative = path.relative(root, file).split(path.sep).join('/');
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error('The file is outside the workspace Git repository.');
  }
  return { root, relative };
}

function noWorkspaceRepositoryRoot(file) {
  if (!noWorkspaceRoot) {
    noWorkspaceRoot = gitOrThrow(
      ['rev-parse', '--show-toplevel'],
      path.dirname(file)
    )
      .then((root) => root.trim())
      .catch((error) => {
        noWorkspaceRoot = undefined;
        throw error;
      });
  }
  return noWorkspaceRoot;
}

function workspaceRepositoryRoot(workspacePath) {
  if (!workspaceRoots.has(workspacePath)) {
    const check = gitOrThrow(
      ['rev-parse', '--show-toplevel'],
      workspacePath
    )
      .then((root) => root.trim())
      .catch(() => undefined);
    workspaceRoots.set(workspacePath, check);
  }
  return workspaceRoots.get(workspacePath);
}

function selectedLines(editor) {
  const result = new Set();

  for (const selection of editor.selections) {
    const start = selection.start.line + 1;
    let end = selection.end.line + 1;

    if (!selection.isEmpty && selection.end.character === 0 && end > start) {
      end -= 1;
    }

    if (selection.isEmpty) {
      result.add(start);
      continue;
    }

    for (let line = start; line <= end; line += 1) result.add(line);
  }

  return result;
}

function hunkHeader(oldStart, oldCount, newStart, newCount) {
  const oldPart = oldCount === 1 ? `${oldStart}` : `${oldStart},${oldCount}`;
  const newPart = newCount === 1 ? `${newStart}` : `${newStart},${newCount}`;
  return `@@ -${oldPart} +${newPart} @@`;
}

function filterPatch(diff, selected) {
  const lines = diff.split('\n');
  const output = [];
  let foundHunk = false;

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const match = line.match(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/
    );

    if (!match) {
      if (index < lines.length - 1 || line.length > 0) output.push(line);
      index += 1;
      continue;
    }

    const oldStart = Number(match[1]);
    const oldCount = Number(match[2] || 1);
    const newStart = Number(match[3]);
    const rawBody = [];
    const body = [];
    let newLine = newStart;
    let selectedAddition = false;
    let selectedDeletion = false;

    index += 1;
    while (index < lines.length && !lines[index].startsWith('@@ ')) {
      const bodyLine = lines[index];
      if (bodyLine.startsWith('+')) {
        rawBody.push({ type: 'addition', line: bodyLine, newLine });
        newLine += 1;
      } else if (bodyLine.startsWith('-')) {
        rawBody.push({ type: 'deletion', line: bodyLine, newLine });
      } else if (bodyLine.startsWith(' ')) {
        rawBody.push({ type: 'context', line: bodyLine, newLine });
        newLine += 1;
      } else if (bodyLine.startsWith('\\')) {
        rawBody.push({ type: 'marker', line: bodyLine });
      } else {
        break;
      }
      index += 1;
    }

    for (let bodyIndex = 0; bodyIndex < rawBody.length;) {
      if (rawBody[bodyIndex].type === 'context' || rawBody[bodyIndex].type === 'marker') {
        if (rawBody[bodyIndex].type === 'context' || body.length > 0) {
          body.push(rawBody[bodyIndex].line);
        }
        bodyIndex += 1;
        continue;
      }

      const run = [];
      while (
        bodyIndex < rawBody.length &&
        rawBody[bodyIndex].type !== 'context' &&
        rawBody[bodyIndex].type !== 'marker'
      ) {
        run.push(rawBody[bodyIndex]);
        bodyIndex += 1;
      }

      const additions = run.filter((item) => item.type === 'addition');
      const deletions = run.filter((item) => item.type === 'deletion');
      const runAtHunkEnd = bodyIndex === rawBody.length;

      for (let changeIndex = 0; changeIndex < Math.max(deletions.length, additions.length); changeIndex += 1) {
        const deletion = deletions[changeIndex];
        const addition = additions[changeIndex];

        if (deletion && addition) {
          if (selected.has(addition.newLine)) {
            body.push(deletion.line, addition.line);
            selectedDeletion = true;
            selectedAddition = true;
          } else {
            body.push(` ${deletion.line.slice(1)}`);
          }
          continue;
        }

        if (deletion) {
          const deletionSelected =
            selected.has(deletion.newLine) ||
            (runAtHunkEnd &&
              selected.has(Math.max(1, deletion.newLine - 1)));
          if (deletionSelected) {
            body.push(deletion.line);
            selectedDeletion = true;
          } else {
            body.push(` ${deletion.line.slice(1)}`);
          }
        } else if (selected.has(addition.newLine)) {
          body.push(addition.line);
          selectedAddition = true;
        }
      }
    }

    if (!selectedAddition && !selectedDeletion) continue;

    const keptOldCount = body.filter((item) => item.startsWith(' ') || item.startsWith('-')).length;
    const keptNewCount = body.filter((item) => item.startsWith(' ') || item.startsWith('+')).length;
    const patchNewStart = oldCount === 0 && oldStart === 0 ? 1 : newStart;

    output.push(hunkHeader(oldStart, keptOldCount, patchNewStart, keptNewCount) + match[5]);
    output.push(...body);
    foundHunk = true;
  }

  return foundHunk ? `${output.join('\n')}\n` : null;
}

function unapplySelectedChanges(indexContent, diff, selected) {
  const lines = diff.split('\n');
  const operations = [];

  for (let index = 0; index < lines.length;) {
    const match = lines[index].match(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/
    );
    if (!match) {
      index += 1;
      continue;
    }

    const rawBody = [];
    let newLine = Number(match[3]);
    index += 1;

    while (index < lines.length && !lines[index].startsWith('@@ ')) {
      const line = lines[index];
      if (line.startsWith('+')) {
        rawBody.push({ type: 'addition', line, newLine });
        newLine += 1;
      } else if (line.startsWith('-')) {
        rawBody.push({ type: 'deletion', line, newLine });
      } else if (line.startsWith(' ')) {
        rawBody.push({ type: 'context', line, newLine });
        newLine += 1;
      } else if (line.startsWith('\\')) {
        rawBody.push({ type: 'marker', line });
      } else {
        break;
      }
      index += 1;
    }

    for (let bodyIndex = 0; bodyIndex < rawBody.length;) {
      if (
        rawBody[bodyIndex].type === 'context' ||
        rawBody[bodyIndex].type === 'marker'
      ) {
        bodyIndex += 1;
        continue;
      }

      const run = [];
      while (
        bodyIndex < rawBody.length &&
        rawBody[bodyIndex].type !== 'context' &&
        rawBody[bodyIndex].type !== 'marker'
      ) {
        run.push(rawBody[bodyIndex]);
        bodyIndex += 1;
      }

      const additions = run.filter((item) => item.type === 'addition');
      const deletions = run.filter((item) => item.type === 'deletion');
      const runAtHunkEnd =
        bodyIndex === rawBody.length ||
        rawBody[bodyIndex].type === 'marker';

      for (let changeIndex = 0; changeIndex < Math.max(deletions.length, additions.length); changeIndex += 1) {
        const deletion = deletions[changeIndex];
        const addition = additions[changeIndex];

        if (addition && selected.has(addition.newLine)) {
          if (deletion) {
            operations.push({
              type: 'replace',
              line: addition.newLine - 1,
              value: deletion.line.slice(1)
            });
          } else {
            operations.push({
              type: 'remove',
              line: addition.newLine - 1
            });
          }
        } else if (
          deletion &&
          !addition &&
          (
            selected.has(deletion.newLine) ||
            (runAtHunkEnd &&
              selected.has(Math.max(1, deletion.newLine - 1)))
          )
        ) {
          operations.push({
            type: 'insert',
            line: deletion.newLine - 1,
            value: deletion.line.slice(1)
          });
        }
      }
    }
  }

  const result = indexContent.split('\n');
  operations
    .sort((left, right) => right.line - left.line)
    .forEach((operation) => {
      if (operation.type === 'remove') {
        result.splice(operation.line, 1);
      } else if (operation.type === 'replace') {
        result[operation.line] = operation.value;
      } else {
        result.splice(operation.line, 0, operation.value);
      }
    });

  return result.join('\n');
}

async function ensureIntentToAdd(root, relative) {
  const status = await runGit(
    ['status', '--porcelain=v1', '--untracked-files=all', '--', relative],
    root
  );
  if (status.code !== 0) throw new Error(status.stderr.trim());

  if (status.stdout.startsWith('??')) {
    await gitOrThrow(['add', '-N', '--', relative], root);
  }
}

async function patchFor(root, relative, cached) {
  const args = [
    'diff',
    '--no-ext-diff',
    '--no-color',
    '--full-index',
    '--unified=1'
  ];
  if (cached) args.push('--cached');
  args.push('--', relative);
  return gitOrThrow(args, root);
}

async function stagedNewFile(root, relative) {
  const output = await gitOrThrow(
    ['diff', '--cached', '--diff-filter=A', '--name-only', '--', relative],
    root
  );
  return output.split(/\r?\n/).some((file) => file === relative);
}

async function changeLines(editor, unstage, uri) {
  const file = commandFile(uri);
  const { root, relative } = await repositoryInfo(file);

  if (!unstage) await ensureIntentToAdd(root, relative);

  const selected = selectedLines(editor);
  const newFileUnstage = unstage && await stagedNewFile(root, relative);
  const diff = await patchFor(root, relative, unstage);
  const filteredPatch = filterPatch(diff, selected);
  const patch = newFileUnstage
    ? await patchForUnstageNewFile(root, relative, selected)
    : unstage
      ? filteredPatch && await patchForUnstageTrackedFile(
        root,
        relative,
        unapplySelectedChanges(
          await gitOrThrow(['show', `:${relative}`], root),
          diff,
          selected
        )
      )
      : filteredPatch;
  if (!patch) {
    vscode.window.showInformationMessage('No changed lines match the current selection.');
    return;
  }

  await gitOrThrow(
    [
      'apply',
      '--cached',
      '--whitespace=nowarn',
      '-'
    ],
    root,
    patch
  );
  if (newFileUnstage && !(await gitOrThrow(['show', `:${relative}`], root))) {
    await gitOrThrow(['reset', '--', relative], root);
  }
}

async function stageFile(uri) {
  const file = commandFile(uri);
  const { root, relative } = await repositoryInfo(file);
  try {
    await gitOrThrow(['add', '--', relative], root);
  } catch (error) {
    if (fs.existsSync(file)) throw error;

    const indexedFile = await runGit(
      ['ls-files', '--stage', '--', relative],
      root
    );
    if (indexedFile.code === 0 && indexedFile.stdout.length === 0) {
      return;
    }
    throw error;
  }
}

async function unstageFile(uri) {
  const file = commandFile(uri);
  const { root, relative } = await repositoryInfo(file);
  await gitOrThrow(['reset', '--', relative], root);
}

function reportError(error) {
  vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
}

function activate(context) {
  for (const folder of vscode.workspace?.workspaceFolders || []) {
    workspaceRepositoryRoot(folder.uri.fsPath);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('linestage.stageLines', (uri) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return vscode.window.showErrorMessage('Open a file in the editor first.');
      return changeLines(editor, false, uri).catch(reportError);
    }),
    vscode.commands.registerCommand('linestage.unstageLines', (uri) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return vscode.window.showErrorMessage('Open a file in the editor first.');
      return changeLines(editor, true, uri).catch(reportError);
    }),
    vscode.commands.registerCommand('linestage.stageFile', (uri) =>
      stageFile(uri).catch(reportError)
    ),
    vscode.commands.registerCommand('linestage.unstageFile', (uri) =>
      unstageFile(uri).catch(reportError)
    )
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
