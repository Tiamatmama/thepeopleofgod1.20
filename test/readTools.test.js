'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createReadTools } = require('../src/core/readTools');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-tools-'));
  fs.writeFileSync(path.join(root, 'alpha.js'), 'const a = 1;\nfunction hello() {}\nconst b = 2;\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'beta.js'), 'module.exports = { hello };\n');
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'const hidden = 1;\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'hello world\n');
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('createReadTools：暴露 read_file / list_files / search_code 三个定义', () => {
  const root = makeRoot();
  try {
    const tools = createReadTools({ root });
    assert.deepEqual(
      tools.definitions.map((d) => d.function.name),
      ['read_file', 'list_files', 'search_code']
    );
    assert.equal(tools.root, path.resolve(root));
  } finally {
    cleanup(root);
  }
});

test('read_file：按行区间返回带行号内容，越界自动夹取', async () => {
  const root = makeRoot();
  try {
    const tools = createReadTools({ root });
    const part = await tools.execute('read_file', { path: 'alpha.js', startLine: 2, endLine: 2 });
    assert.match(part, /^# alpha\.js（第 2-2 行，共 4 行）/);
    assert.match(part, /2\tfunction hello\(\) \{\}/);

    const all = await tools.execute('read_file', { path: 'alpha.js', startLine: 99, endLine: 200 });
    assert.match(all, /第 4-4 行/);
  } finally {
    cleanup(root);
  }
});

test('read_file：越界路径/非文件/大文件一律拒绝', async () => {
  const root = makeRoot();
  try {
    const tools = createReadTools({ root });
    await assert.rejects(() => tools.execute('read_file', { path: '../outside.txt' }), /路径越界/);
    await assert.rejects(() => tools.execute('read_file', { path: 'src' }), /不是文件/);

    fs.writeFileSync(path.join(root, 'huge.js'), 'x'.repeat(401 * 1024));
    await assert.rejects(() => tools.execute('read_file', { path: 'huge.js' }), /文件过大/);
  } finally {
    cleanup(root);
  }
});

test('list_files：跳过 node_modules，限制深度', async () => {
  const root = makeRoot();
  try {
    const tools = createReadTools({ root });
    const shallow = await tools.execute('list_files', { path: '.', depth: 1 });
    assert.match(shallow, /alpha\.js/);
    assert.match(shallow, /src\//);
    assert.doesNotMatch(shallow, /node_modules/);

    const deeper = await tools.execute('list_files', { path: 'src', depth: 2 });
    assert.match(deeper, /src\/beta\.js/);
  } finally {
    cleanup(root);
  }
});

test('search_code：返回「文件:行: 内容」，跳过 node_modules，非法正则报错', async () => {
  const root = makeRoot();
  try {
    const tools = createReadTools({ root });
    const hits = await tools.execute('search_code', { pattern: 'hello' });
    assert.match(hits, /alpha\.js:2:/);
    assert.match(hits, /src\/beta\.js:1:/);
    assert.match(hits, /notes\.txt:1:/);
    assert.doesNotMatch(hits, /node_modules/);

    const none = await tools.execute('search_code', { pattern: 'definitely-not-there' });
    assert.match(none, /未找到匹配/);
    await assert.rejects(() => tools.execute('search_code', { pattern: '[' }), /正则非法/);
    await assert.rejects(() => tools.execute('search_code', {}), /缺少 pattern/);
  } finally {
    cleanup(root);
  }
});

test('execute：未知工具返回提示；onCall 收到调用记录', async () => {
  const root = makeRoot();
  try {
    const calls = [];
    const tools = createReadTools({ root, onCall: (name, args) => calls.push({ name, args }) });
    const out = await tools.execute('nope', {});
    assert.match(out, /未知只读工具/);
    assert.deepEqual(calls, [{ name: 'nope', args: {} }]);
  } finally {
    cleanup(root);
  }
});
