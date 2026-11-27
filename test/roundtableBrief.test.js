const test = require('node:test');
const assert = require('node:assert');
const { buildExpertPrompt, renderContext } = require('../src/core/roundtable');

test('对象 brief 会拼进人设最前面，且字段完整', () => {
  const prompt = buildExpertPrompt(
    { name: '张三', title: '安全研究员' },
    {
      goal: '做一个本地优先的协议层',
      why: 'NapCat 停更，通道随时会断',
      user: '自己',
      pain: '插件不受控',
      success: '断供后仍能收发',
      constraints: ['单机'],
      nonGoals: ['不自造帧格式']
    }
  );
  assert.match(prompt, /本场共同前提（需求方给定，不可更改/);
  assert.match(prompt, /目标：做一个本地优先的协议层/);
  assert.match(prompt, /为什么做：NapCat 停更，通道随时会断/);
  assert.match(prompt, /明确不做：不自造帧格式/);
  assert.ok(prompt.indexOf('本场共同前提') < prompt.indexOf('你是「张三」'), 'brief 必须在人设之前');
});

test('没有 brief 时不出现共同前提', () => {
  const prompt = buildExpertPrompt({ name: '李四' });
  assert.doesNotMatch(prompt, /本场共同前提/);
  assert.match(prompt, /你是「李四」/);
});

test('字符串 brief 原样注入并截断到 2000 字', () => {
  const prompt = buildExpertPrompt({ name: '王五' }, '只做只读影子模式');
  assert.match(prompt, /只做只读影子模式/);
  const long = buildExpertPrompt({ name: '王五' }, 'x'.repeat(3000));
  assert.ok(long.length < 2600, '长 brief 必须被截断');
});

test('项目现状单独渲染并截断到 6000 字', () => {
  assert.strictEqual(renderContext(''), '');
  assert.strictEqual(renderContext(null), '');
  assert.strictEqual(renderContext('src/adapters 有 base/napcat/snowluma'), 'src/adapters 有 base/napcat/snowluma');
  assert.ok(renderContext('x'.repeat(9000)).length <= 6000);
});

test('空对象或非法 brief 不注入', () => {
  assert.doesNotMatch(buildExpertPrompt({ name: '赵六' }, {}), /本场共同前提/);
  assert.doesNotMatch(buildExpertPrompt({ name: '赵六' }, ['a']), /本场共同前提/);
  assert.doesNotMatch(buildExpertPrompt({ name: '赵六' }, 123), /本场共同前提/);
});
