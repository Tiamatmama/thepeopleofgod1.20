'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ToolRegistry } = require('../src/core/toolRegistry');

// 造一个最小工作区：不启动 CodingCenter，只把 codeSearch 依赖的三个方法顶掉
function makeRegistry(dir, runId = '') {
  const registry = Object.create(ToolRegistry.prototype);
  registry.activeContext = { userId: 'u', runId };
  registry.coding = {
    taskDir: () => dir,
    recordFileChange: () => {},
    resolveInWorkspace: (userId, taskId, p) => ({
      success: true, taskId, base: dir, rel: String(p), path: path.resolve(dir, p)
    })
  };
  return registry;
}

function makeWorkspace(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-search-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

test('code_search：默认不区分大小写，返回文件/行号/整行', async () => {
  const dir = makeWorkspace({ 'src/a.js': 'const Foo = 1;\nconst bar = 2;\n' });
  const res = await makeRegistry(dir).codeSearch({ taskId: 't', pattern: 'foo' });
  assert.equal(res.success, true);
  assert.equal(res.matchCount, 1);
  assert.equal(res.results[0].path, 'src/a.js');
  assert.equal(res.results[0].line, 1);
  assert.equal(res.results[0].text, 'const Foo = 1;');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code_search：caseSensitive=true 只命中精确大小写', async () => {
  const dir = makeWorkspace({ 'a.txt': 'Foo\nfoo\n' });
  const res = await makeRegistry(dir).codeSearch({ taskId: 't', pattern: 'Foo', caseSensitive: true });
  assert.equal(res.matchCount, 1);
  assert.equal(res.results[0].line, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code_search：glob 只搜指定文件', async () => {
  const dir = makeWorkspace({ 'src/a.js': 'needle\n', 'src/b.json': 'needle\n', 'src/deep/c.js': 'needle\n' });
  const res = await makeRegistry(dir).codeSearch({ taskId: 't', pattern: 'needle', glob: 'src/**/*.js' });
  assert.deepEqual(res.results.map(r => r.path), ['src/a.js', 'src/deep/c.js']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code_search：context 带前后行，行号正确', async () => {
  const dir = makeWorkspace({ 'a.txt': 'l1\nl2\nhit\nl4\nl5\n' });
  const res = await makeRegistry(dir).codeSearch({ taskId: 't', pattern: 'hit', context: 1 });
  const item = res.results[0];
  assert.deepEqual(item.contextBefore, [{ line: 2, text: 'l2' }]);
  assert.deepEqual(item.contextAfter, [{ line: 4, text: 'l4' }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code_search：遵守 .gitignore，忽略目录不进去', async () => {
  const dir = makeWorkspace({ '.gitignore': 'build/\n*.log\n', 'src/a.js': 'needle\n', 'build/out.js': 'needle\n', 'x.log': 'needle\n' });
  const res = await makeRegistry(dir).codeSearch({ taskId: 't', pattern: 'needle' });
  assert.deepEqual(res.results.map(r => r.path), ['src/a.js']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code_search：二进制文件（含 NUL）跳过', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-search-'));
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'needle\n', 'utf8');
  const res = await makeRegistry(dir).codeSearch({ taskId: 't', pattern: 'needle' });
  assert.deepEqual(res.results.map(r => r.path), ['a.txt']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code_search：超过 8MB 的文件跳过', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-search-'));
  const big = Buffer.alloc(9 * 1024 * 1024, 0x61);
  fs.writeFileSync(path.join(dir, 'big.txt'), big);
  const res = await makeRegistry(dir).codeSearch({ taskId: 't', pattern: 'needle' });
  assert.equal(res.matchCount, 0);
  assert.equal(res.filesScanned, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code_search：maxResults 截断并标记 truncated', async () => {
  const dir = makeWorkspace({ 'a.txt': 'needle\nneedle\nneedle\n' });
  const res = await makeRegistry(dir).codeSearch({ taskId: 't', pattern: 'needle', maxResults: 2 });
  assert.equal(res.matchCount, 2);
  assert.equal(res.truncated, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code_search：非法正则按字面量处理，不抛错', async () => {
  const dir = makeWorkspace({ 'a.txt': 'a(b\naxb\n' });
  const res = await makeRegistry(dir).codeSearch({ taskId: 't', pattern: 'a(b' });
  assert.equal(res.matchCount, 1);
  assert.equal(res.results[0].text, 'a(b');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code_search：超长行只返回前 300 字', async () => {
  const dir = makeWorkspace({ 'a.txt': 'needle' + 'x'.repeat(600) + '\n' });
  const res = await makeRegistry(dir).codeSearch({ taskId: 't', pattern: 'needle' });
  assert.equal(res.results[0].text.length, 300);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code_search：返回覆盖度字段，扫描完整时 complete=true 且无 warning', async () => {
  const dir = makeWorkspace({ 'a.txt': 'needle\n' });
  const res = await makeRegistry(dir).codeSearch({ taskId: 't', pattern: 'needle' });
  assert.equal(res.complete, true);
  assert.equal(res.warning, undefined);
  assert.equal(res.filesTotal, res.filesScanned);
  fs.rmSync(dir, { recursive: true, force: true });
});

function numberedLines(n) {
  return Array.from({ length: n }, (_, i) => `l${i + 1}`).join('\n');
}

test('code_read_range：返回 nextStart，同 run 重复读同一区间被拒绝', () => {
  const dir = makeWorkspace({ 'a.txt': numberedLines(40) });
  const reg = makeRegistry(dir, 'run1');
  const first = reg.codeReadRange({ taskId: 't', path: 'a.txt', startLine: 1, endLine: 10 });
  assert.equal(first.success, true);
  assert.equal(first.nextStart, 11);
  const again = reg.codeReadRange({ taskId: 't', path: 'a.txt', startLine: 1, endLine: 10 });
  assert.equal(again.success, false);
  assert.equal(again.repeated, true);
  assert.equal(again.nextStart, 11);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code_read_range：部分重叠只提示，不整段拒绝', () => {
  const dir = makeWorkspace({ 'a.txt': numberedLines(40) });
  const reg = makeRegistry(dir, 'run1');
  reg.codeReadRange({ taskId: 't', path: 'a.txt', startLine: 1, endLine: 20 });
  const second = reg.codeReadRange({ taskId: 't', path: 'a.txt', startLine: 11, endLine: 30 });
  assert.equal(second.success, true);
  assert.equal(second.alreadyReadLines, 10);
  assert.match(second.note, /nextStart=31/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code_search：output_mode=files 只回路径', async () => {
  const dir = makeWorkspace({ 'a.js': 'needle\n', 'b.js': 'needle\nneedle\n', 'c.txt': 'x' });
  const res = await makeRegistry(dir).codeSearch({ taskId: 't', pattern: 'needle', output_mode: 'files' });
  assert.equal(res.outputMode, 'files');
  assert.deepEqual(res.files, ['a.js', 'b.js']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code_search：output_mode=count 回每文件命中数', async () => {
  const dir = makeWorkspace({ 'a.js': 'needle\nneedle\n', 'b.js': 'needle\n' });
  const res = await makeRegistry(dir).codeSearch({ taskId: 't', pattern: 'needle', output_mode: 'count' });
  assert.deepEqual(res.counts, [{ path: 'a.js', count: 2 }, { path: 'b.js', count: 1 }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code_search：offset 分页', async () => {
  const dir = makeWorkspace({ 'a.txt': 'needle\nneedle\nneedle\n' });
  const res = await makeRegistry(dir).codeSearch({ taskId: 't', pattern: 'needle', maxResults: 1, offset: 2 });
  assert.equal(res.matchCount, 1);
  assert.equal(res.results[0].line, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code_apply_patch：读后被外部改过就拒绝，重读后可改', () => {
  const dir = makeWorkspace({ 'a.txt': 'hello\n' });
  const reg = makeRegistry(dir, 'run1');
  reg.codeReadRange({ taskId: 't', path: 'a.txt', startLine: 1, endLine: 10 });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello world\n', 'utf8');
  const blocked = reg.codeApplyPatch({
    taskId: 't', path: 'a.txt', edits: [{ oldText: 'hello', newText: 'hi' }]
  });
  assert.equal(blocked.success, false);
  assert.equal(blocked.stale, true);
  // 重读最新内容后即可正常改
  reg.codeReadRange({ taskId: 't', path: 'a.txt', startLine: 1, endLine: 5 });
  const ok = reg.codeApplyPatch({
    taskId: 't', path: 'a.txt', edits: [{ oldText: 'hello world', newText: 'hi world' }]
  });
  assert.equal(ok.success, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code_outline：Markdown 返回标题层级与行号，忽略代码块里的 #', async () => {
  const dir = makeWorkspace({
    'doc.md': '# A\ntext\n## B\n```\n# not a heading\n```\n### C\n'
  });
  const res = await makeRegistry(dir, 'run1').codeOutline({ taskId: 't', path: 'doc.md' });
  assert.equal(res.success, true);
  assert.equal(res.kind, 'markdown');
  assert.deepEqual(res.items.map(i => [i.line, i.level, i.title]), [
    [1, 1, 'A'],
    [3, 2, 'B'],
    [7, 3, 'C']
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code_outline：不支持的文件类型明确报错，不瞎猜', async () => {
  const dir = makeWorkspace({ 'a.bin': 'hello\n' });
  const res = await makeRegistry(dir, 'run1').codeOutline({ taskId: 't', path: 'a.bin' });
  assert.equal(res.success, false);
  assert.match(res.error, /不支持的文件类型/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('code_read_range：没有 runId 时不拦截（面板手动重读）', () => {
  const dir = makeWorkspace({ 'a.txt': numberedLines(30) });
  const reg = makeRegistry(dir, '');
  assert.equal(reg.codeReadRange({ taskId: 't', path: 'a.txt', startLine: 1, endLine: 10 }).success, true);
  const again = reg.codeReadRange({ taskId: 't', path: 'a.txt', startLine: 1, endLine: 10 });
  assert.equal(again.success, true);
  assert.equal(again.nextStart, 11);
  fs.rmSync(dir, { recursive: true, force: true });
});
