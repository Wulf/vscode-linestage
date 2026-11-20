const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const registeredCommands = new Map();
const errors = [];
const infoMessages = [];
const vscode = {
  Uri: {
    file(fsPath) {
      return { scheme: 'file', fsPath };
    }
  },
  workspace: {
    workspaceFolders: [],
    getWorkspaceFolder(uri) {
      return this.workspaceFolders.find((folder) =>
        uri.fsPath === folder.uri.fsPath ||
        uri.fsPath.startsWith(`${folder.uri.fsPath}${path.sep}`)
      );
    }
  },
  window: {
    activeTextEditor: undefined,
    showErrorMessage(message) {
      errors.push(message);
    },
    showInformationMessage(message) {
      infoMessages.push(message);
    }
  },
  commands: {
    registerCommand(name, callback) {
      registeredCommands.set(name, callback);
      return { dispose() {} };
    },
    async executeCommand() {}
  }
};

const originalModuleLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalModuleLoad.call(this, request, parent, isMain);
};
const { activate } = require('../out/extension');
Module._load = originalModuleLoad;
activate({ subscriptions: [] });

const fileName = 'sample.txt';
const baseContents = 'one\ntwo\nthree\n';
const changedLineTwo = 'one\nTWO\nthree\n';
const changedLineThree = 'one\ntwo\nTHREE\n';
const partiallyStagedContents = 'one\nTWO\nTHREE\n';
let testLock = Promise.resolve();

async function withTestLock(callback) {
  const previous = testLock;
  let release;
  testLock = new Promise((resolve) => { release = resolve; });
  await previous;

  try {
    return await callback();
  } finally {
    release();
  }
}

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

async function setupRepository(stageType) {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'linestage-matrix-')
  );
  const file = path.join(repository, fileName);

  await git(repository, ['init', '-q']);
  await git(repository, ['config', 'user.email', 'test@example.com']);
  await git(repository, ['config', 'user.name', 'LineStage Test']);

  if (stageType === 'untracked file') {
    fs.writeFileSync(file, baseContents);
    return { repository, file };
  }

  fs.writeFileSync(file, baseContents);
  await git(repository, ['add', '--', fileName]);
  await git(repository, ['commit', '-qm', 'base']);

  if (stageType === 'fully staged file') {
    fs.writeFileSync(file, changedLineTwo);
    await git(repository, ['add', '--', fileName]);
  } else if (stageType === 'partially staged file') {
    fs.writeFileSync(file, changedLineTwo);
    await git(repository, ['add', '--', fileName]);
    fs.writeFileSync(file, partiallyStagedContents);
  } else if (stageType === 'unstaged changes') {
    fs.writeFileSync(file, changedLineTwo);
  }

  return { repository, file };
}

async function indexContents(repository, name = fileName) {
  try {
    return await git(repository, ['show', `:${name}`]);
  } catch {
    return null;
  }
}

async function status(repository, name = fileName) {
  return git(repository, ['status', '--porcelain=v1', '--', name]);
}

async function invoke(command, repository, file, selectedLines = [2]) {
  vscode.workspace.workspaceFolders = [{
    uri: { scheme: 'file', fsPath: repository }
  }];
  vscode.window.activeTextEditor = {
    document: {
      uri: {
        scheme: 'file',
        fsPath: file
      }
    },
    selections: selectedLines.map((line) => ({
      start: { line: line - 1 },
      end: { line: line - 1 },
      isEmpty: true
    }))
  };

  errors.length = 0;
  infoMessages.length = 0;
  const callback = registeredCommands.get(command);
  assert.ok(callback, `command ${command} was not registered`);
  await callback({ scheme: 'file', fsPath: file });
}

async function setupFullyStagedNewFile(contents) {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'linestage-new-file-')
  );
  const name = '.gitignore';
  const file = path.join(repository, name);

  await git(repository, ['init', '-q']);
  await git(repository, ['config', 'user.email', 'test@example.com']);
  await git(repository, ['config', 'user.name', 'LineStage Test']);
  fs.writeFileSync(file, contents);
  await git(repository, ['add', '--', name]);

  return { repository, file, name };
}

async function setupDeletedFile() {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'linestage-deleted-file-')
  );
  const file = path.join(repository, fileName);

  await git(repository, ['init', '-q']);
  await git(repository, ['config', 'user.email', 'test@example.com']);
  await git(repository, ['config', 'user.name', 'LineStage Test']);
  fs.writeFileSync(file, baseContents);
  await git(repository, ['add', '--', fileName]);
  await git(repository, ['commit', '-qm', 'base']);
  fs.unlinkSync(file);

  return { repository, file };
}

async function setupTrackedVariant(base, staged, working) {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'linestage-boundary-')
  );
  const file = path.join(repository, fileName);

  await git(repository, ['init', '-q']);
  await git(repository, ['config', 'user.email', 'test@example.com']);
  await git(repository, ['config', 'user.name', 'LineStage Test']);
  fs.writeFileSync(file, base);
  await git(repository, ['add', '--', fileName]);
  await git(repository, ['commit', '-qm', 'base']);

  if (staged !== null) {
    fs.writeFileSync(file, staged);
    await git(repository, ['add', '--', fileName]);
  }
  fs.writeFileSync(file, working);

  return { repository, file };
}

test('stageLines stages a deleted file from its read-only Git editor', async () =>
  withTestLock(async () => {
    const { repository, file } = await setupDeletedFile();

    try {
      vscode.workspace.workspaceFolders = [{
        uri: { scheme: 'file', fsPath: repository }
      }];
      vscode.window.activeTextEditor = {
        document: {
          uri: {
            scheme: 'git',
            fsPath: file
          }
        },
        selections: [{
          start: { line: 0 },
          end: { line: 0 },
          isEmpty: true
        }]
      };

      errors.length = 0;
      infoMessages.length = 0;
      await registeredCommands.get('linestage.stageLines')();

      assert.equal(await indexContents(repository), null);
      assert.equal((await status(repository)).trim(), 'D  sample.txt');
      assert.equal(errors.length, 0);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }));

const stageTypes = [
  'untracked file',
  'fully staged file',
  'partially staged file',
  'unstaged changes'
];

const commands = [
  {
    name: 'linestage.stageLines',
    expectedIndex(stageType) {
      return {
        'untracked file': 'two\n',
        'fully staged file': changedLineTwo,
        'partially staged file': changedLineTwo,
        'unstaged changes': changedLineTwo
      }[stageType];
    }
  },
  {
    name: 'linestage.unstageLines',
    expectedIndex(stageType) {
      return {
        'untracked file': null,
        'fully staged file': baseContents,
        'partially staged file': baseContents,
        'unstaged changes': baseContents
      }[stageType];
    }
  },
  {
    name: 'linestage.stageFile',
    expectedIndex(stageType) {
      return {
        'untracked file': baseContents,
        'fully staged file': changedLineTwo,
        'partially staged file': partiallyStagedContents,
        'unstaged changes': changedLineTwo
      }[stageType];
    }
  },
  {
    name: 'linestage.unstageFile',
    expectedIndex(stageType) {
      return {
        'untracked file': null,
        'fully staged file': baseContents,
        'partially staged file': baseContents,
        'unstaged changes': baseContents
      }[stageType];
    }
  }
];

for (const command of commands) {
  for (const stageType of stageTypes) {
    test(`${command.name} × ${stageType}`, async () => withTestLock(async () => {
      const { repository, file } = await setupRepository(stageType);

      try {
        await invoke(command.name, repository, file);

        assert.equal(await indexContents(repository), command.expectedIndex(stageType));
        assert.equal(fs.readFileSync(file, 'utf8'), {
          'untracked file': baseContents,
          'fully staged file': changedLineTwo,
          'partially staged file': partiallyStagedContents,
          'unstaged changes': changedLineTwo
        }[stageType]);

        assert.equal(errors.length, 0);
      } finally {
        fs.rmSync(repository, { recursive: true, force: true });
      }
    }));
  }
}

const newFileUnstageCases = [
  {
    name: 'first line',
    contents: 'one\ntwo\nthree\n',
    selected: [1],
    expected: 'two\nthree\n'
  },
  {
    name: 'middle line',
    contents: 'one\ntwo\nthree\n',
    selected: [2],
    expected: 'one\nthree\n'
  },
  {
    name: 'last line',
    contents: 'one\ntwo\nthree\n',
    selected: [3],
    expected: 'one\ntwo\n'
  },
  {
    name: 'non-contiguous lines',
    contents: 'one\ntwo\nthree\nfour\n',
    selected: [1, 3],
    expected: 'two\nfour\n'
  },
  {
    name: 'file without a final newline',
    contents: 'one\ntwo\nthree',
    selected: [2],
    expected: 'one\nthree'
  }
];

for (const testCase of newFileUnstageCases) {
  test(
    `linestage.unstageLines × fully staged new file × ${testCase.name}`,
    async () => withTestLock(async () => {
      const { repository, file, name } = await setupFullyStagedNewFile(
        testCase.contents
      );

      try {
        await invoke('linestage.unstageLines', repository, file, testCase.selected);

        assert.equal(
          await indexContents(repository, name),
          testCase.expected
        );
        assert.equal(fs.readFileSync(file, 'utf8'), testCase.contents);
        assert.equal(errors.length, 0);
      } finally {
        fs.rmSync(repository, { recursive: true, force: true });
      }
    })
  );
}

const boundaryCases = [
  {
    name: 'stage only the start line of an adjacent change',
    command: 'linestage.stageLines',
    base: 'one\ntwo\nthree\nfour\nfive\n',
    staged: null,
    working: 'one\nTWO\nTHREE\nfour\nfive\n',
    selected: [2],
    expected: 'one\nTWO\nthree\nfour\nfive\n'
  },
  {
    name: 'stage only the end line of an adjacent change',
    command: 'linestage.stageLines',
    base: 'one\ntwo\nthree\nfour\nfive\n',
    staged: null,
    working: 'one\nTWO\nTHREE\nfour\nfive\n',
    selected: [3],
    expected: 'one\ntwo\nTHREE\nfour\nfive\n'
  },
  {
    name: 'unstage only the start line of an adjacent change',
    command: 'linestage.unstageLines',
    base: 'one\ntwo\nthree\nfour\nfive\n',
    staged: 'one\nTWO\nTHREE\nfour\nfive\n',
    working: 'one\nTWO\nTHREE\nfour\nfive\n',
    selected: [2],
    expected: 'one\ntwo\nTHREE\nfour\nfive\n'
  },
  {
    name: 'unstage only the end line of an adjacent change',
    command: 'linestage.unstageLines',
    base: 'one\ntwo\nthree\nfour\nfive\n',
    staged: 'one\nTWO\nTHREE\nfour\nfive\n',
    working: 'one\nTWO\nTHREE\nfour\nfive\n',
    selected: [3],
    expected: 'one\nTWO\nthree\nfour\nfive\n'
  },
  {
    name: 'stage an overlapping unstaged edit',
    command: 'linestage.stageLines',
    base: 'one\ntwo\nthree\n',
    staged: 'one\nTWO\nthree\n',
    working: 'one\nTWO-again\nthree\n',
    selected: [2],
    expected: 'one\nTWO-again\nthree\n'
  },
  {
    name: 'unstage an overlapping staged edit',
    command: 'linestage.unstageLines',
    base: 'one\ntwo\nthree\n',
    staged: 'one\nTWO\nthree\n',
    working: 'one\nTWO-again\nthree\n',
    selected: [2],
    expected: 'one\ntwo\nthree\n'
  },
  {
    name: 'stage insertion at the beginning',
    command: 'linestage.stageLines',
    base: 'two\nthree\n',
    staged: null,
    working: 'one\ntwo\nthree\n',
    selected: [1],
    expected: 'one\ntwo\nthree\n'
  },
  {
    name: 'stage insertion at the end',
    command: 'linestage.stageLines',
    base: 'one\ntwo\n',
    staged: null,
    working: 'one\ntwo\nthree\n',
    selected: [3],
    expected: 'one\ntwo\nthree\n'
  },
  {
    name: 'stage deletion at the beginning',
    command: 'linestage.stageLines',
    base: 'one\ntwo\nthree\n',
    staged: null,
    working: 'two\nthree\n',
    selected: [1],
    expected: 'two\nthree\n'
  },
  {
    name: 'stage deletion at the end',
    command: 'linestage.stageLines',
    base: 'one\ntwo\nthree\n',
    staged: null,
    working: 'one\ntwo\n',
    selected: [2],
    expected: 'one\ntwo\n'
  },
  {
    name: 'unstage insertion at the beginning',
    command: 'linestage.unstageLines',
    base: 'two\nthree\n',
    staged: 'one\ntwo\nthree\n',
    working: 'one\ntwo\nthree\n',
    selected: [1],
    expected: 'two\nthree\n'
  },
  {
    name: 'unstage insertion at the end',
    command: 'linestage.unstageLines',
    base: 'one\ntwo\n',
    staged: 'one\ntwo\nthree\n',
    working: 'one\ntwo\nthree\n',
    selected: [3],
    expected: 'one\ntwo\n'
  },
  {
    name: 'unstage deletion at the beginning',
    command: 'linestage.unstageLines',
    base: 'one\ntwo\nthree\n',
    staged: 'two\nthree\n',
    working: 'two\nthree\n',
    selected: [1],
    expected: 'one\ntwo\nthree\n'
  },
  {
    name: 'unstage deletion at the end',
    command: 'linestage.unstageLines',
    base: 'one\ntwo\nthree\n',
    staged: 'one\ntwo\n',
    working: 'one\ntwo\n',
    selected: [2],
    expected: 'one\ntwo\nthree\n'
  },
  {
    name: 'stage content into an empty tracked file',
    command: 'linestage.stageLines',
    base: '',
    staged: null,
    working: 'one\n',
    selected: [1],
    expected: 'one\n'
  },
  {
    name: 'unstage content from an empty tracked file',
    command: 'linestage.unstageLines',
    base: '',
    staged: 'one\n',
    working: 'one\n',
    selected: [1],
    expected: ''
  }
];

for (const testCase of boundaryCases) {
  test(
    testCase.name,
    async () => withTestLock(async () => {
      const { repository, file } = await setupTrackedVariant(
        testCase.base,
        testCase.staged,
        testCase.working
      );

      try {
        await invoke(
          testCase.command,
          repository,
          file,
          testCase.selected
        );

        assert.equal(await indexContents(repository), testCase.expected);
        assert.equal(fs.readFileSync(file, 'utf8'), testCase.working);
        assert.equal(errors.length, 0);
      } finally {
        fs.rmSync(repository, { recursive: true, force: true });
      }
    })
  );
}

test('stageFile stages an empty untracked file', async () => withTestLock(async () => {
  const { repository, file, name } = await setupFullyStagedNewFile('');
  await git(repository, ['reset', '-q', '--', name]);

  try {
    await invoke('linestage.stageFile', repository, file);
    assert.equal(await indexContents(repository, name), '');
    assert.equal(fs.readFileSync(file, 'utf8'), '');
    assert.equal(errors.length, 0);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
}));

test('unstageFile removes an empty staged new file', async () => withTestLock(async () => {
  const { repository, file, name } = await setupFullyStagedNewFile('');

  try {
    await invoke('linestage.unstageFile', repository, file);
    assert.equal(await indexContents(repository, name), null);
    assert.equal(fs.readFileSync(file, 'utf8'), '');
    assert.equal(errors.length, 0);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
}));

test('unstageLines fully unstages an intent-to-add file', async () => withTestLock(async () => {
  const { repository, file } = await setupRepository('untracked file');
  const name = fileName;
  const contents = fs.readFileSync(file, 'utf8');

  try {
    await invoke('linestage.stageLines', repository, file, [1, 2, 3]);
    assert.equal(await status(repository, name), `A  ${name}\n`);

    await invoke('linestage.unstageLines', repository, file, [1, 2, 3]);

    assert.equal(await indexContents(repository, name), null);
    assert.equal(await status(repository, name), `?? ${name}\n`);
    assert.equal(fs.readFileSync(file, 'utf8'), contents);
    assert.equal(errors.length, 0);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
}));

test('unstageLines preserves later staged lines in a partially staged new file', async () => withTestLock(async () => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'linestage-new-file-regression-')
  );
  const name = 'playbook.yml';
  const file = path.join(repository, name);
  const contents = [
    '---',
    '- name: Bootstrap the first control-plane node',
    '  hosts: control_plane[0]',
    '  become: true',
    '  gather_facts: true',
    '  serial: 1',
    '  roles:',
    '    - k3s',
    '',
    '- name: Join remaining control-plane nodes',
    '  hosts: control_plane[1:]',
    '  become: true',
    '  gather_facts: true',
    '  serial: 1',
    '  roles:',
    '    - k3s',
    '  post_tasks:',
    '    - name: Wait for the joined control-plane node to become Ready',
    '      ansible.builtin.command: kubectl get node {{ inventory_hostname }} --no-headers',
    '      delegate_to: "{{ groups[\'control_plane\'][0] }}"',
    '      changed_when: false',
    '      register: joined_node',
    '      until: joined_node.rc == 0 and \' Ready \' in joined_node.stdout',
    '      retries: 30',
    '      delay: 10',
    '',
    '- name: Join agents',
    '  hosts: worker:database:monitor',
    '  become: true',
    '  gather_facts: true',
    '  serial: 1',
    '  roles:',
    '    - k3s',
    ''
  ].join('\n');

  await git(repository, ['init', '-q']);
  await git(repository, ['config', 'user.email', 'test@example.com']);
  await git(repository, ['config', 'user.name', 'LineStage Test']);
  fs.writeFileSync(file, contents);

  try {
    await invoke('linestage.stageLines', repository, file, [3]);
    await invoke(
      'linestage.stageLines',
      repository,
      file,
      [5, 6, 7, 8, 9, 10, 11, ...Array.from({ length: 9 }, (_, index) => index + 26)]
    );
    await invoke('linestage.unstageLines', repository, file, [9, 10]);

    const expected = contents
      .split('\n')
      .filter((_, index) => [3, 5, 6, 7, 8, 11, ...Array.from({ length: 9 }, (_, offset) => offset + 26)]
        .includes(index + 1))
      .join('\n');
    assert.equal(await indexContents(repository, name), expected);
    assert.equal(fs.readFileSync(file, 'utf8'), contents);
    assert.equal(errors.length, 0);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
}));
