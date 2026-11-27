const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PersonaDistiller, ExpertLibrary, slugify, normalize } = require('../src/core/personaDistill');
const { Roundtable, buildExpertPrompt } = require('../src/core/roundtable');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 假模型：按 system 提示区分「抽取」与「复核」两次调用
function fakeDistillAPI({ extract, screen }) {
  return {
    calls: [],
    async callAPI(messages) {
      const system = String(messages[0].content || '');
      this.calls.push(system);
      const content = system.includes('二次筛查') ? JSON.stringify(screen) : JSON.stringify(extract);
      return { choices: [{ message: { content: '```json\n' + content + '\n```' } }] };
    }
  };
}

const CORPUS_DOC = {
  url: 'https://example.com/interview',
  title: '访谈',
  content: '我叫张三，从 2007 年开始做漏洞研究。安全这件事，本质上是在跟复杂性打交道。'.repeat(20)
};

test('verbatimScreen：语料里找不到的原话必须删掉', () => {
  const distiller = new PersonaDistiller({ search: async () => ({ results: [] }), fetchPage: async () => ({}) });
  const profile = {
    stances: [
      { topic: '复杂性', position: '安全是在跟复杂性打交道', evidence: '安全这件事，本质上是在跟复杂性打交道' },
      { topic: '编的', position: '我拿过三次图灵奖', evidence: '我拿过三次图灵奖' }
    ],
    style: { catchphrases: ['复杂性', '完全不存在的口头禅'] }
  };
  const result = distiller.verbatimScreen(profile, CORPUS_DOC.content);
  assert.equal(profile.stances.length, 1);
  assert.equal(profile.stances[0].topic, '复杂性');
  assert.equal(profile.stances[0].screened, 'verbatim');
  assert.deepEqual(profile.style.catchphrases, ['复杂性']);
  assert.equal(result.dropped, 2);
  assert.ok(result.notes.some((note) => note.includes('图灵奖')));
});

test('distill：检索 → 抽取 → 二次筛查 → 落盘，无依据的机构被撤掉', async () => {
  const dir = tmpDir('expert-lib-');
  const library = new ExpertLibrary({ dir });
  const api = fakeDistillAPI({
    extract: {
      name: '张三',
      aliases: ['zs'],
      field: '网络安全',
      title: '某实验室负责人',
      affiliations: [{ name: '不存在的实验室', role: '负责人', evidence: '' }],
      style: { tone: '直', sentence: '短句', catchphrases: ['复杂性'], habits: '爱举例' },
      stances: [
        { topic: '复杂性', position: '安全就是管复杂性', evidence: '安全这件事，本质上是在跟复杂性打交道', sourceIndex: 1 }
      ],
      heuristics: ['先问边界'],
      taboos: ['炒作'],
      unknowns: ['学历']
    },
    screen: {
      facts: [{ claim: '身份：某实验室负责人', supported: false, why: '语料未提' },
        { claim: '不存在的实验室·负责人', supported: false, why: '语料未提' }],
      quotes: [{ quote: '安全这件事，本质上是在跟复杂性打交道', supported: true }]
    }
  });
  const distiller = new PersonaDistiller({
    search: async () => ({ results: [{ title: '访谈', url: CORPUS_DOC.url }] }),
    fetchPage: async () => ({ success: true, content: CORPUS_DOC.content }),
    unifiedAPI: api,
    library
  });

  const expert = await distiller.distill({ name: '张三', field: '网络安全' });
  assert.equal(expert.name, '张三');
  assert.equal(expert.title, '');
  assert.equal(expert.affiliations.length, 0);
  assert.equal(expert.stances.length, 1);
  assert.equal(expert.sources.length, 1);
  assert.ok(expert.screen.dropped >= 2);
  assert.ok(fs.existsSync(path.join(dir, `${expert.id}.json`)));
  assert.equal(library.list().length, 1);
  assert.equal(api.calls.length, 2);
});

test('distill：一篇正文都抓不到时要明确报错，不能凭空造人', async () => {
  const distiller = new PersonaDistiller({
    search: async () => ({ results: [{ title: '空页', url: 'https://example.com/empty' }] }),
    fetchPage: async () => ({ success: true, content: '太短' }),
    unifiedAPI: fakeDistillAPI({ extract: {}, screen: {} }),
    library: new ExpertLibrary({ dir: tmpDir('expert-lib-') })
  });
  await assert.rejects(() => distiller.distill({ name: '李四' }), /没抓到/);
});

test('distill：同名不同人要当场停手，不往库里塞空壳', async () => {
  const dir = tmpDir('expert-lib-');
  const library = new ExpertLibrary({ dir });
  const distiller = new PersonaDistiller({
    search: async () => ({ results: [{ title: '三角函数', url: 'https://example.com/cosine' }] }),
    // 页面够长、也满篇「余弦」，但讲的是数学；模型看完语料判定 relevant=false
    fetchPage: async () => ({ success: true, content: '余弦是三角函数的一种，定义为邻边比斜边。'.repeat(30) }),
    unifiedAPI: fakeDistillAPI({ extract: { relevant: false, name: '余弦' }, screen: {} }),
    library
  });
  await assert.rejects(() => distiller.distill({ name: '余弦' }), /对不上/);
  assert.equal(library.list().length, 0);
});

test('中文名字的 slug 稳定且可复现', () => {
  assert.equal(slugify('于旸'), slugify('于旸'));
  assert.notEqual(slugify('于旸'), slugify('余弦'));
  assert.equal(normalize('安全，这件事！'), '安全这件事');
});

test('roundtable：两人一轮各说一条，归纳可解析并落盘', async () => {
  const dir = tmpDir('roundtable-');
  const api = {
    calls: 0,
    async callAPI(messages) {
      this.calls += 1;
      const system = String(messages[0].content || '');
      const content = system.includes('圆桌主持人')
        ? JSON.stringify({ disagreements: [{ topic: '要不要', positions: [{ name: 'A', stance: '要' }] }], strongest: ['A 的证据'], followups: ['然后呢'] })
        : `第 ${this.calls} 次发言`;
      return { choices: [{ message: { content } }] };
    }
  };
  const table = new Roundtable({ unifiedAPI: api, dir });
  const experts = [
    { id: 'a', name: 'A', title: '甲', stances: [{ topic: 't', position: 'p', evidence: 'e' }] },
    { id: 'b', name: 'B', title: '乙' }
  ];
  const turns = [];
  const result = await table.run({ topic: '要不要', experts, rounds: 1, onTurn: (turn) => turns.push(turn.name) });

  assert.deepEqual(turns, ['A', 'B']);
  assert.equal(result.transcript.length, 2);
  assert.equal(result.synthesis.disagreements.length, 1);
  assert.ok(fs.existsSync(path.join(dir, `${result.id}.json`)));
  assert.equal(table.list().length, 1);
});

test('roundtable：人数不足或没有话题要拒绝', async () => {
  const table = new Roundtable({ unifiedAPI: { async callAPI() { return { choices: [{ message: { content: '' } }] }; } }, dir: tmpDir('roundtable-') });
  await assert.rejects(() => table.run({ topic: 'x', experts: [{ name: 'A' }] }), /至少/);
  await assert.rejects(() => table.run({ topic: '', experts: [{ name: 'A' }, { name: 'B' }] }), /话题/);
});

test('buildExpertPrompt：带上观点出处，并禁止编造履历', () => {
  const prompt = buildExpertPrompt({
    name: '张三',
    title: '研究者',
    style: { tone: '直' },
    stances: [{ topic: '复杂性', position: '安全是管理复杂性', evidence: '本质上是在跟复杂性打交道' }],
    unknowns: ['学历']
  });
  assert.ok(prompt.includes('「本质上是在跟复杂性打交道」'));
  assert.ok(prompt.includes('不要编履历'));
  assert.ok(prompt.includes('承认不知道'));
});
