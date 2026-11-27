'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CodingCenter = require('../src/core/coding');

// 本机 git 可用才跑真仓库用例（CI 无 git 时自动跳过，不让护栏本身挂掉）
let HAS_GIT = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  HAS_GIT = false;
}

function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `coding-git-${tag}-`));
}

// ---- git() 参数走 execFileSync，不经 shell ----

test('git：工作区不存在时返回失败，不抛异常', () => {
  const center = new CodingCenter(tmpRoot('nogit'));
  const r = center.git('u1', 'no_such_task', ['status']);
  assert.equal(r.success, false);
  assert.match(r.error, /工作区不存在/);
});

test('git：提交信息含空格/引号/shell 元字符时原样落库，且不产生注入副作用', { skip: !HAS_GIT }, () => {
  const root = tmpRoot('msg');
  const center = new CodingCenter(root);
  const created = center.createWorkspace('u1', 't1');
  assert.equal(created.success, true);

  // 造一个变更，再带着「危险」信息提交
  fs.writeFileSync(path.join(created.dir, 'a.txt'), 'hello', 'utf8');
  center.git('u1', 't1', ['add', '-A']);

  const message = 'feat: say "hi" & bye ; touch INJECTED_MARKER';
  const commit = center.gitCommit('u1', 't1', message);
  assert.equal(commit.success, true);

  // 信息原样读回（不被 shell 吃掉引号、不被 ; 截断）
  const log = center.git('u1', 't1', ['log', '-1', '--pretty=%B']);
  assert.equal(log.success, true);
  assert.equal(log.output.trim(), message);

  // 没有任何 shell 元字符被执行：工作区里不应出现 INJECTED_MARKER
  assert.equal(fs.existsSync(path.join(created.dir, 'INJECTED_MARKER')), false);
  assert.equal(fs.existsSync(path.join(root, 'INJECTED_MARKER')), false);
});

test('git：ref 参数里的 shell 元字符不执行', { skip: !HAS_GIT }, () => {
  const root = tmpRoot('ref');
  const center = new CodingCenter(root);
  const created = center.createWorkspace('u1', 't1');
  assert.equal(created.success, true);

  const badRef = 'HEAD; touch INJECTED_REF';
  const r = center.git('u1', 't1', ['show', badRef, '--stat']);
  // 整串作为一个参数传给 git → git 报未知 revision，命令失败；不会有命令注入
  assert.equal(r.success, false);
  assert.equal(fs.existsSync(path.join(created.dir, 'INJECTED_REF')), false);
});
