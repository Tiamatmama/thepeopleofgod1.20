'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const OutputModule = require('../src/core/output');
const outputParsing = require('../src/core/outputParsing');
const SystemNarrator = require('../src/core/narrator');

// parseAffectionChange / parseSpeech 都是纯字符串处理，不碰盘、不依赖实例字段。
// 解析侧已下沉到 outputParsing，直接调纯函数；叙述侧仍是原型方法。
function makeNarrator() {
    return Object.create(SystemNarrator.prototype);
}

const stripInternalBlocks = OutputModule.stripInternalBlocks;

// 真实事故样本：漏进正文的 <commentary> 块（见 session_1790353206173_2vsnium65 第 75 行）
const LEAKED = '<commentary>\n（本轮由我起话头）他还没出声，就换一件事说，不追着刚才那半句不放。\n</commentary>\n\n你要真想坐到天暗下来，我也不赶你——坐得住的，总比来去匆匆的多几分真。';
const LEAKED_TAIL = '你要真想坐到天暗下来，我也不赶你——坐得住的，总比来去匆匆的多几分真。';

test('A1：两条正文化链路都剥掉 <commentary> 块，只留正文', () => {
    const out = outputParsing.parseAffectionChange(LEAKED);
    assert.equal(out.dialogueText, LEAKED_TAIL);

    const nar = makeNarrator().parseSpeech(LEAKED);
    assert.equal(nar.text, LEAKED_TAIL);
});

test('A2：大小写变体一律剥掉（<Commentary> / <COMMENTARY>）', () => {
    const upper = '<Commentary>（自说自话）</COMMENTARY>\n正文在这';
    assert.equal(outputParsing.parseAffectionChange(upper).dialogueText, '正文在这');
    assert.equal(makeNarrator().parseSpeech(upper).text, '正文在这');
});

test('A3：未闭合的内部标签从标签起截断（被截断的响应不能把内心戏漏出去）', () => {
    const unclosed = '正文在这\n<commentary>\n（后面全是内心戏';
    assert.equal(outputParsing.parseAffectionChange(unclosed).dialogueText, '正文在这');
    assert.equal(makeNarrator().parseSpeech(unclosed).text, '正文在这');
});

test('A4：<thinking> 同样在剥离之列', () => {
    const s = '<thinking>先想一下</thinking>那半句歌我今天不硬凑了。';
    assert.equal(outputParsing.parseAffectionChange(s).dialogueText, '那半句歌我今天不硬凑了。');
    assert.equal(makeNarrator().parseSpeech(s).text, '那半句歌我今天不硬凑了。');
});

test('A5：绝不误伤正常文本（<3 / 颜文字 / 落单尖括号）', () => {
    for (const s of ['我买了个 <3 送你', '>_< 别闹', 'a < b 你信不信', '〈书名〉在书架上']) {
        assert.equal(stripInternalBlocks(s), s);
        assert.equal(outputParsing.parseAffectionChange(s).dialogueText, s.trim());
        assert.equal(makeNarrator().parseSpeech(s).text, s.trim());
    }
});

test('A6：null / 空串不抛；剥完为空时两条链各自按既有约定收场', () => {
    assert.equal(stripInternalBlocks(null), '');
    assert.equal(stripInternalBlocks(''), '');
    // 全靠内心戏、没有正文：主链兜「……」，自主发言链静默不发（text 为空，speak 会在早返处掐掉）
    const onlyInternal = '<commentary>整段都是内心戏</commentary>';
    assert.equal(outputParsing.parseAffectionChange(onlyInternal).dialogueText, '……');
    assert.equal(makeNarrator().parseSpeech(onlyInternal).text, '');
});

test('A7：剥内部块后仍与既有 JSON / 围栏剥离共存（不抢道）', () => {
    const s = '{"affection_change":1,"thinking":"ok"}\n<commentary>内心戏</commentary>\n正文在这';
    const out = outputParsing.parseAffectionChange(s);
    assert.equal(out.affectionChange, 1);
    assert.equal(out.dialogueText, '正文在这');
});
