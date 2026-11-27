'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseBingRss, extractMainContent, ToolRegistry, isProtectedTestPath } = require('../src/core/toolRegistry');

// 造一段 Bing format=rss 的结构化输出（含 channel 级 link、CDATA、HTML 实体、缺字段等边界）
const RSS = [
    '<?xml version="1.0" encoding="utf-8" ?>',
    '<rss version="2.0"><channel>',
    '<title>必应：test</title>',
    '<link>http://www.bing.com:80/search?q=test</link>',
    '<description>搜索结果</description>',
    '<item><title>T1 &amp; Co</title><link>https://a.com/?a=1&amp;b=2</link>',
    '<description>desc <b>1</b></description></item>',
    '<item><title><![CDATA[T2]]></title><link>https://b.com</link></item>',
    '<item><title>无链接</title><description>x</description></item>',
    '</channel></rss>'
].join('');

test('parseBingRss：解析 item 的标题/链接/摘要，解实体、去 CDATA、剥 HTML', () => {
    const results = parseBingRss(RSS, 10);
    assert.equal(results.length, 2);
    assert.deepEqual(results[0], { title: 'T1 & Co', url: 'https://a.com/?a=1&b=2', content: 'desc 1' });
    assert.deepEqual(results[1], { title: 'T2', url: 'https://b.com', content: '' });
});

test('parseBingRss：只取 <item>，忽略 channel 级 title/link/description', () => {
    const results = parseBingRss(RSS, 10);
    assert.ok(results.every(item => !item.url.includes('bing.com')));
});

test('parseBingRss：遵循 max 上限', () => {
    assert.equal(parseBingRss(RSS, 1).length, 1);
});

test('parseBingRss：空/异常输入返回空数组', () => {
    assert.deepEqual(parseBingRss('', 5), []);
    assert.deepEqual(parseBingRss(null, 5), []);
    assert.deepEqual(parseBingRss('<rss><channel></channel></rss>', 5), []);
});

test('extractMainContent：剥掉 nav/footer/aside/form，只留 article 正文', () => {
    const html = [
        '<html><head><style>.x{color:red}</style></head><body>',
        '<nav>菜单 首页 关于</nav>',
        '<aside>侧边推荐</aside>',
        '<article><h1>正文标题</h1><p>核心内容</p></article>',
        '<form>搜索框</form>',
        '<footer>版权所有</footer>',
        '</body></html>'
    ].join('');
    const out = extractMainContent(html);
    assert.ok(out.includes('核心内容'));
    assert.ok(out.includes('正文标题'));
    assert.ok(!out.includes('菜单') && !out.includes('侧边推荐') && !out.includes('版权所有') && !out.includes('搜索框'));
});

test('extractMainContent：多个 article/main 时取最长的那个', () => {
    const out = extractMainContent('<main>短</main><article>这是一个明显更长的正文区块内容</article>');
    assert.ok(out.startsWith('<article>') && out.includes('更长的正文区块'));
    assert.ok(!out.includes('短'));
});

test('extractMainContent：没有 article/main 时退回整页（但仍去噪声）', () => {
    const out = extractMainContent('<div><nav>导航</nav><p>裸正文</p></div>');
    assert.ok(out.includes('裸正文'));
    assert.ok(!out.includes('导航'));
});

test('extractMainContent：空/异常输入不抛错', () => {
    assert.equal(extractMainContent(''), '');
    assert.equal(extractMainContent(null), '');
});

// ---- 工人不许改测试：按「路径段」判定，不做子串匹配 ----

test('isProtectedTestPath：test 目录的各种写法都拦，只有名字里带 test 的正常文件放行', () => {
    for (const p of ['test/x.js', './test/x.js', 'Test/X.JS', 'test\\x.js', 'src/test/a.js', 'test', 'TEST']) {
        assert.equal(isProtectedTestPath(p), true, `应拦：${p}`);
    }
    for (const p of ['src/test-helper.js', 'src/a.js', 'contest/x.js', 'latest/x.js', '', null, undefined]) {
        assert.equal(isProtectedTestPath(p), false, `应放行：${p}`);
    }
    // 多候选：原始请求路径与解析后的相对路径任一命中就拦（test/../src/a.js 解析后是 src/a.js）
    assert.equal(isProtectedTestPath('test/../src/a.js', 'src/a.js'), true);
});

test('codeApplyPatch：拒绝写 test/ 下的文件，磁盘无变化', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-patch-'));
    const file = path.join(dir, 'test', 'a.test.js');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'assert(true);\n', 'utf8');

    const registry = Object.create(ToolRegistry.prototype);
    registry.coding = {
        resolveInWorkspace: () => ({ success: true, taskId: 't', base: dir, path: file, rel: 'test/a.test.js' })
    };
    registry.activeContext = { userId: 'u' };

    const res = registry.codeApplyPatch({ taskId: 't', path: 'test/a.test.js', edits: [{ oldText: 'true', newText: 'false' }] });
    assert.equal(res.success, false);
    assert.match(res.error, /测试目录/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'assert(true);\n');

    fs.rmSync(dir, { recursive: true, force: true });
});

test('codeWriteFile：同样拒绝写 test/ 下的文件', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-write-'));
    const file = path.join(dir, 'test', 'a.test.js');

    const registry = Object.create(ToolRegistry.prototype);
    registry.coding = {
        resolveInWorkspace: () => ({ success: true, taskId: 't', base: dir, path: file, rel: 'test/a.test.js' })
    };
    registry.activeContext = { userId: 'u' };

    const res = registry.codeWriteFile({ taskId: 't', path: 'test/a.test.js', content: 'x' });
    assert.equal(res.success, false);
    assert.match(res.error, /测试目录/);
    assert.equal(fs.existsSync(file), false);

    fs.rmSync(dir, { recursive: true, force: true });
});
