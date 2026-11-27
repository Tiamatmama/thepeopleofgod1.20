'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const parsing = require('../src/core/outputParsing');

test('P1：好感度 JSON 支持围栏 / 嵌套 / 夹在正文中间，且从正文里剔除', () => {
    const fenced = '```json\n{"affection_change": 2, "thinking": "被打动"}\n```\n这句话我记着了。';
    const a = parsing.parseAffectionChange(fenced);
    assert.equal(a.affectionChange, 2);
    assert.equal(a.thinking, '被打动');
    assert.equal(a.dialogueText, '这句话我记着了。');

    const nested = '{"affection_change": -9, "meta": {"note": "含 } 的字符串"}, "thinking": "越界"}';
    const b = parsing.parseAffectionChange(nested);
    assert.equal(b.affectionChange, -9);
    assert.equal(b.dialogueText, '……');
});

test('P2：好感度数值归一：字符串数字、取整、夹取 -10~10、非法值 null', () => {
    assert.equal(parsing.normalizeAffectionChange('3'), 3);
    assert.equal(parsing.normalizeAffectionChange('4.6'), 5);
    assert.equal(parsing.normalizeAffectionChange(99), 10);
    assert.equal(parsing.normalizeAffectionChange(-99), -10);
    assert.equal(parsing.normalizeAffectionChange('abc'), null);
    assert.equal(parsing.normalizeAffectionChange(null), null);
});

test('P3：未闭合 JSON 从首个左括号起丢弃，围栏残片不留正文', () => {
    assert.equal(parsing.stripJsonBlocks('正文好好的\n{"affection_change": 1'), '正文好好的');
    assert.equal(parsing.stripJsonBlocks('```json\n{"a":1}\n```\n正文'), '正文');
});

test('P4：段位标记无论抄几个都剥掉，且不误伤正常方括号', () => {
    assert.equal(parsing.stripTierMark('[在场] [在场] 正文').trim(), '正文');
    assert.equal(parsing.stripTierMark('[在场]正文[余温]').trim(), '正文');
    assert.equal(parsing.stripTierMark('[备注] 正文'), '[备注] 正文');
    assert.equal(parsing.stripTierMark(null), 'null');
});

test('P5：含英文的括号夹注剥掉，纯中文括号保留', () => {
    assert.equal(parsing.stripMetaNotes('走吧（Actually, need a final line.）').trim(), '走吧');
    assert.equal(parsing.stripMetaNotes('走吧 (keep it short)').trim(), '走吧');
    assert.equal(parsing.stripMetaNotes('走吧（笑）'), '走吧（笑）');
});

test('P6：排版归一：压空行、去句读行、去行尾空白', () => {
    assert.equal(parsing.normalizeDialogueFormat('第一句\n\n\n第二句'), '第一句\n第二句');
    assert.equal(parsing.normalizeDialogueFormat('第一句 \n。\n第二句'), '第一句\n第二句');
    assert.equal(parsing.normalizeDialogueFormat('\r\n好\r\n'), '好');
});

test('P7：情绪归一：neutral 与缺失值都归 calm', () => {
    assert.equal(parsing.normalizeEmotion('neutral'), 'calm');
    assert.equal(parsing.normalizeEmotion(''), 'calm');
    assert.equal(parsing.normalizeEmotion(undefined), 'calm');
    assert.equal(parsing.normalizeEmotion('happy'), 'happy');
});

test('P8：正文形式的工具调用能还原，装饰标记与未知工具名处理正确', () => {
    const decorated = '<\uff5c\uff5c\uff5cDSML\uff5c\uff5c\uff5cinvoke name="record_affection">'
        + '<\uff5c\uff5c\uff5cDSML\uff5c\uff5c\uff5cparameter name="affection_change">3</\uff5c\uff5c\uff5cDSML\uff5c\uff5c\uff5cparameter>'
        + '</\uff5c\uff5c\uff5cDSML\uff5c\uff5c\uff5cinvoke>';
    const parsed = parsing.parseTextToolCalls(decorated, ['record_affection']);
    assert.equal(parsed.calls.length, 1);
    assert.deepEqual(parsed.calls[0], { name: 'record_affection', args: { affection_change: 3 } });
    assert.equal(parsed.cleaned, '');

    // 工具名本身当标签的写法，整段从正文里剔除
    const named = '<record_affection><parameter name="affection_change">-2</parameter></record_affection>正文';
    const b = parsing.parseTextToolCalls(named, ['record_affection']);
    assert.deepEqual(b.calls[0].args, { affection_change: -2 });
    assert.equal(b.cleaned, '正文');

    // 未知工具名不还原
    assert.equal(parsing.parseTextToolCalls(named, ['other_tool']), null);
});

test('P9：非法输入一律兜底不抛', () => {
    assert.equal(parsing.parseAffectionChange(null).dialogueText, '……');
    assert.equal(parsing.parseAffectionChange(12345).dialogueText, '……');
    assert.equal(parsing.stripJsonBlocks(''), '');
    assert.equal(parsing.parseTextToolCalls('', ['x']), null);
    assert.equal(parsing.parseTextToolCalls(null, ['x']), null);
});
