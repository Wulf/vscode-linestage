const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { patchForUnstageNewFile } = require('../out/patch');

function git(cwd, args, input = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `git ${args.join(' ')} failed`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.end(input);
  });
}

test('unstages selected lines from a fully staged new file', async () => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'linestage-test-')
  );

  try {
    await git(repository, ['init', '-q']);
    await git(repository, ['config', 'user.email', 'test@example.com']);
    await git(repository, ['config', 'user.name', 'LineStage Test']);

    const file = path.join(repository, '.gitignore');
    const contents = 'one\ntwo\nthree\n';
    fs.writeFileSync(file, contents);
    await git(repository, ['add', '--', '.gitignore']);

    const patch = await patchForUnstageNewFile(
      repository,
      '.gitignore',
      new Set([2])
    );

    assert.ok(patch);
    await git(repository, ['apply', '--cached', '--whitespace=nowarn', '-'], patch);

    assert.equal(await git(repository, ['show', ':.gitignore']), 'one\nthree\n');
    assert.equal(fs.readFileSync(file, 'utf8'), contents);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
