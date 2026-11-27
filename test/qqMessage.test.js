'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    idText, readMention, readReplyId, messagePlainText, buildReplySegments,
    QQ_PROFILE_FIELDS, QQ_PROFILE_LABELS, parseAdminCommand, resolveQQTarget,
    parseProfileFields, adminCommandHelp, looksLikeDistillRequest, buildDistillPrompt,
    buildQQIntentPrompt, extractJsonObject, intentToCommand
} = require('../src/core/qqMessage');

test('idText 把空值归一成空串，其余转字符串并去空白', () => {
    assert.equal(idText(undefined), '');
    assert.equal(idText(null), '');
    assert.equal(idText('  123  '), '123');
    assert.equal(idText(456), '456');
});

test('readMention 拆出被 @ 的人与正文', () => {
    const segments = [
        { type: 'at', data: { qq: '10001' } },
        { type: 'text', data: { text: ' 你好 ' } },
        { type: 'at', data: { qq: '10002' } }
    ];
    const r = readMention(segments, '10001');
    assert.deepEqual(r.ats, ['10001', '10002']);
    assert.equal(r.mentionsSelf, true);
    assert.equal(r.mentionsAll, false);
    assert.equal(r.text, '你好');
});

test('readMention 识别 @全体，并在非数组输入下安全返回', () => {
    assert.equal(readMention([{ type: 'at', data: { qq: 'all' } }], '10001').mentionsAll, true);
    const empty = readMention(null, '10001');
    assert.deepEqual(empty.ats, []);
    assert.equal(empty.text, '');
});

test('readReplyId 抠出被引用消息 id，无引用返回空串', () => {
    assert.equal(readReplyId([{ type: 'reply', data: { id: 998 } }]), '998');
    assert.equal(readReplyId([{ type: 'text', data: { text: 'hi' } }]), '');
    assert.equal(readReplyId(null), '');
});

test('messagePlainText 只保留文字段', () => {
    const segments = [
        { type: 'at', data: { qq: '1' } },
        { type: 'text', data: { text: 'a' } },
        { type: 'image', data: { file: 'x.png' } },
        { type: 'text', data: { text: 'b' } }
    ];
    assert.equal(messagePlainText(segments), 'ab');
});

test('buildReplySegments 纯文字原样成段', () => {
    assert.deepEqual(buildReplySegments('你好'), [{ type: 'text', data: { text: '你好' } }]);
});

test('buildReplySegments 支持 atQQ 前缀', () => {
    assert.deepEqual(
        buildReplySegments('在', { atQQ: '10001' }),
        [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: '在' } }]
    );
});

test('buildReplySegments 把 CQ 码与口语图片标记转成 image 段', () => {
    assert.deepEqual(
        buildReplySegments('看图[CQ:image,file=http://a/b.png]哈'),
        [
            { type: 'text', data: { text: '看图' } },
            { type: 'image', data: { file: 'http://a/b.png' } },
            { type: 'text', data: { text: '哈' } }
        ]
    );
    assert.deepEqual(
        buildReplySegments('[图片: ./local.png]'),
        [{ type: 'image', data: { file: './local.png' } }]
    );
});

test('buildReplySegments 空输入也保证至少一个 text 段', () => {
    assert.deepEqual(buildReplySegments(''), [{ type: 'text', data: { text: '' } }]);
});

test('parseAdminCommand 识别各类指令词', () => {
    assert.deepEqual(parseAdminCommand('切换角色 小助手'), { action: 'switchRole', value: '小助手' });
    assert.deepEqual(parseAdminCommand('/换人设 小雨'), { action: 'switchRole', value: '小雨' });
    assert.deepEqual(parseAdminCommand('改人设 性格=冷淡'), { action: 'editProfile', value: '性格=冷淡' });
    assert.deepEqual(parseAdminCommand('记一下 她喜欢猫'), { action: 'editMemory', value: '她喜欢猫' });
    assert.deepEqual(parseAdminCommand('换头像 http://a/b.png'), { action: 'setAvatar', value: 'http://a/b.png' });
    assert.deepEqual(parseAdminCommand('发空间 今天天气不错'), { action: 'postQzone', value: '今天天气不错' });
    assert.deepEqual(parseAdminCommand('解除禁言'), { action: 'unban', value: '' });
    assert.deepEqual(parseAdminCommand('全员禁言 开'), { action: 'wholeBan', value: '开' });
    assert.deepEqual(parseAdminCommand('禁言 5'), { action: 'ban', value: '5' });
    assert.deepEqual(parseAdminCommand('改名片 新昵称'), { action: 'setGroupCard', value: '新昵称' });
    assert.deepEqual(parseAdminCommand('发图 http://a/b.png'), { action: 'sendImage', value: 'http://a/b.png' });
    assert.deepEqual(parseAdminCommand('help'), { action: 'help' });
    assert.deepEqual(parseAdminCommand('管理员'), { action: 'help' });
});

test('parseAdminCommand 普通聊天与空文本不误判', () => {
    assert.equal(parseAdminCommand('今天吃什么'), null);
    assert.equal(parseAdminCommand(''), null);
    assert.equal(parseAdminCommand('   '), null);
});

test('resolveQQTarget 优先取被 @ 的人并排掉机器人自己和 @全体', () => {
    assert.deepEqual(
        resolveQQTarget({ ats: ['10001', '10002', 'all'], selfId: '10001' }, '5'),
        { targetId: '10002', rest: '5' }
    );
});

test('resolveQQTarget 没有 @ 时认正文开头的 QQ 号', () => {
    assert.deepEqual(
        resolveQQTarget({ ats: [], selfId: '10001' }, '123456 理由'),
        { targetId: '123456', rest: '理由' }
    );
    assert.deepEqual(
        resolveQQTarget({ ats: [], selfId: '10001' }, '没有号码'),
        { targetId: '', rest: '没有号码' }
    );
});

test('parseProfileFields 按「字段=值」解析，支持中英文与全角符号', () => {
    assert.deepEqual(parseProfileFields('性格=冷淡 背景=她是个安静的少女'), {
        personality: '冷淡',
        background: '她是个安静的少女'
    });
    assert.deepEqual(parseProfileFields('name：小雨 age＝17'), { name: '小雨', age: '17' });
});

test('QQ_PROFILE_FIELDS / LABELS 映射齐全', () => {
    assert.equal(QQ_PROFILE_FIELDS['人设'], 'background');
    assert.equal(QQ_PROFILE_LABELS.personality, '性格');
});

test('adminCommandHelp 返回包含全部指令分类的说明', () => {
    const help = adminCommandHelp();
    assert.equal(typeof help, 'string');
    assert.ok(help.includes('切换角色'));
    assert.ok(help.includes('群友蒸馏'));
});

test('looksLikeDistillRequest 只对空文本或含关键词的文本放行', () => {
    assert.equal(looksLikeDistillRequest(''), true);
    assert.equal(looksLikeDistillRequest('   '), true);
    assert.equal(looksLikeDistillRequest('蒸馏一下'), true);
    assert.equal(looksLikeDistillRequest('提取人格'), true);
    assert.equal(looksLikeDistillRequest('今天天气不错'), false);
});

test('buildDistillPrompt / buildQQIntentPrompt 产出可用提示词', () => {
    assert.ok(buildDistillPrompt().includes('只输出一个 JSON 对象'));
    const intent = buildQQIntentPrompt(['小助手', '小雨'], '小助手');
    assert.ok(intent.includes('「小助手」、「小雨」'));
    assert.ok(intent.includes('当前角色：小助手'));
    assert.ok(buildQQIntentPrompt([], '无').includes('（网页端还没有角色）'));
});

test('extractJsonObject 容忍代码块与前后解释', () => {
    assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJsonObject('好的，结果是 {"a":1} 就这样'), { a: 1 });
    assert.equal(extractJsonObject('没有对象'), null);
    assert.equal(extractJsonObject('{不是合法 json'), null);
});

test('intentToCommand 收敛白名单动作，其余一律 null', () => {
    assert.deepEqual(intentToCommand({ action: 'switchRole', roleName: '小助手' }), { action: 'switchRole', value: '小助手' });
    assert.deepEqual(intentToCommand({ action: 'editMemory', content: '记住' }), { action: 'editMemory', value: '记住' });
    assert.deepEqual(intentToCommand({ action: 'help' }), { action: 'help' });
    assert.equal(intentToCommand({ action: 'none' }), null);
    assert.equal(intentToCommand({ action: 'editProfile', value: '性格=冷淡' }), null);
    assert.equal(intentToCommand({ action: 'switchRole' }), null);
    assert.equal(intentToCommand(null), null);
});
