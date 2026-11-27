'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');

const SkillStore = require('../src/core/skillStore');

function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-store-'));
  return { root, store: new SkillStore(root) };
}

// 直接改 entry.entryName 绕过 adm-zip 的路径归一化，用来构造恶意条目
function zipWith(entries) {
  const zip = new AdmZip();
  for (const item of entries) {
    const entry = zip.addFile(item.name, Buffer.from(item.content == null ? 'x' : item.content));
    entry.entryName = item.name;
  }
  return zip.toBuffer();
}

test('新建 → list → detail 往返', () => {
  const { root, store } = makeStore();
  try {
    const created = store.save({ name: 'demo-skill', description: '测试技能: 带冒号', body: '# 正文\n\nstep 1' });
    assert.equal(created.name, 'demo-skill');
    assert.equal(created.description, '测试技能: 带冒号');
    assert.match(created.body, /step 1/);

    const raw = fs.readFileSync(path.join(root, 'skills', 'demo-skill', 'SKILL.md'), 'utf8');
    assert.match(raw, /^---\nname: demo-skill\ndescription: 测试技能: 带冒号\n---\n/);

    const skills = store.list();
    assert.equal(skills.length, 1);
    assert.deepEqual(Object.keys(skills[0]).sort(), ['bytes', 'description', 'files', 'name', 'updatedAt']);
    assert.equal(skills[0].name, 'demo-skill');
    assert.equal(skills[0].files, 1);
    assert.ok(skills[0].bytes > 0);
    assert.equal(skills[0].updatedAt, new Date(skills[0].updatedAt).toISOString());

    const detail = store.detail('demo-skill');
    assert.deepEqual(detail, {
      name: 'demo-skill',
      description: '测试技能: 带冒号',
      body: '# 正文\n\nstep 1',
      resources: []
    });

    // 额外资源也要出现在 list 与 detail 里
    fs.writeFileSync(path.join(root, 'skills', 'demo-skill', 'notes.txt'), 'hello');
    assert.equal(store.list()[0].files, 2);
    assert.deepEqual(store.detail('demo-skill').resources, [{ path: 'notes.txt', bytes: 5 }]);
    assert.equal(store.detail('missing'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('exportZip → importZip 到另一个临时根，内容一致', () => {
  const source = makeStore();
  const target = makeStore();
  try {
    source.store.save({ name: 'alpha', description: 'A 技能', body: 'alpha body' });
    fs.mkdirSync(path.join(source.root, 'skills', 'alpha', 'ref'));
    fs.writeFileSync(path.join(source.root, 'skills', 'alpha', 'notes.txt'), 'hello');
    fs.writeFileSync(path.join(source.root, 'skills', 'alpha', 'ref', 'guide.md'), 'guide');

    const buffer = source.store.exportZip('alpha');
    assert.ok(Buffer.isBuffer(buffer));
    const names = new AdmZip(buffer).getEntries().map((entry) => entry.entryName).sort();
    assert.deepEqual(names, ['alpha/SKILL.md', 'alpha/notes.txt', 'alpha/ref/guide.md']);

    const result = target.store.importZip(buffer, {});
    assert.deepEqual(result, { name: 'alpha', files: 3 });

    const detail = target.store.detail('alpha');
    assert.equal(detail.name, 'alpha');
    assert.equal(detail.description, 'A 技能');
    assert.equal(detail.body, 'alpha body');
    assert.deepEqual(
      detail.resources.map((item) => item.path),
      ['notes.txt', 'ref/guide.md']
    );
    assert.equal(fs.readFileSync(path.join(target.root, 'skills', 'alpha', 'ref', 'guide.md'), 'utf8'), 'guide');
  } finally {
    fs.rmSync(source.root, { recursive: true, force: true });
    fs.rmSync(target.root, { recursive: true, force: true });
  }
});

test('非法名拒绝；恶意 zip 条目拒绝且不落盘', () => {
  const { root, store } = makeStore();
  try {
    for (const bad of ['Bad', 'has space', '../escape', 'a/b', '', '-lead', 'with$dollar']) {
      assert.throws(() => store.validateName(bad), /技能名/, `应拒绝: ${bad}`);
    }
    assert.throws(() => store.save({ name: '../escape', body: 'x' }), (error) => error.code === 'INVALID_NAME');

    const dotdot = zipWith([
      { name: '../evil.txt', content: 'pwn' },
      { name: '../pkg/SKILL.md', content: '---\nname: pkg\n---\nbody' }
    ]);
    assert.throws(() => store.importZip(dotdot, {}), (error) => error.code === 'UNSAFE_ENTRY');

    const absolute = zipWith([
      { name: '/abs/evil.txt', content: 'pwn' },
      { name: '/abs/SKILL.md', content: '---\nname: abs\n---\nbody' }
    ]);
    assert.throws(() => store.importZip(absolute, {}), (error) => error.code === 'UNSAFE_ENTRY');

    const symlink = new AdmZip();
    const linkEntry = symlink.addFile('link/SKILL.md', Buffer.from('---\nname: link\n---\nbody'));
    linkEntry.attr = (0xA1FF << 16) >>> 0;
    assert.throws(() => store.importZip(symlink.toBuffer(), {}), (error) => error.code === 'UNSAFE_ENTRY');

    assert.equal(fs.existsSync(path.join(root, 'skills', 'pkg')), false);
    assert.equal(fs.existsSync(path.join(root, 'evil.txt')), false);
    assert.equal(fs.existsSync(path.join(root, 'abs')), false);

    const noSkill = zipWith([{ name: 'pkg/readme.txt', content: 'x' }]);
    assert.throws(() => store.importZip(noSkill, {}), (error) => error.code === 'NO_SKILL_FILE');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('已存在未 overwrite 报 EXISTS，overwrite 成功（save 与 import 同规则）', () => {
  const { root, store } = makeStore();
  const other = makeStore();
  try {
    store.save({ name: 'dup', description: 'v1', body: 'one' });
    assert.throws(() => store.save({ name: 'dup', description: 'v2', body: 'two' }), (error) => error.code === 'EXISTS');
    assert.equal(store.detail('dup').body, 'one');

    const updated = store.save({ name: 'dup', description: 'v2', body: 'two' }, { overwrite: true });
    assert.equal(updated.body, 'two');
    assert.equal(updated.description, 'v2');

    const buffer = store.exportZip('dup');
    other.store.importZip(buffer, {});
    assert.throws(() => other.store.importZip(buffer, {}), (error) => error.code === 'EXISTS');
    assert.equal(other.store.detail('dup').body, 'two');
    const again = other.store.importZip(buffer, { overwrite: true });
    assert.equal(again.name, 'dup');
    assert.equal(other.store.detail('dup').body, 'two');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(other.root, { recursive: true, force: true });
  }
});

test('remove 只删 skills 根内的技能目录', () => {
  const { root, store } = makeStore();
  try {
    store.save({ name: 'gone', body: 'x' });
    assert.equal(store.remove('gone'), true);
    assert.deepEqual(store.list(), []);
    assert.equal(store.remove('gone'), false);
    assert.throws(() => store.remove('../escape'), (error) => error.code === 'INVALID_NAME');
    assert.equal(fs.existsSync(path.join(root, 'skills')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
