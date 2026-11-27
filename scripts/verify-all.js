'use strict';

// 🧪 验证夹具（仅测试用）
//
// 覆盖三条链路，均为「多个独立进程 + 重复实验 + 平行执行」：
//   A. 时间位移（scripts/timeshift.js）：起 N 个独立服务进程，控制器反复改偏移，
//      断言各进程看到的「现在」与偏移一致（跨进程比对，不看进程自己报的偏移）。
//   B. 事件簿生命周期：pre 叮嘱 / post 追问 / 结果回写 / 注入 / 去重 / 已了结不再触发。
//      用 stub LLM；跑前备份、跑后还原 data/appointments.json，不污染真实数据。
//   C. 记忆话题聚类：用唯一测试 userId 隔离，跑后删除测试用户记忆文件。
//
// 用法：
//   node scripts/verify-all.js                # 编排器：并行跑 A/B/C 并汇总
//   node scripts/verify-all.js --fixture=b    # 只跑事件簿（可被编排器作为子进程拉起）
//   node scripts/verify-all.js --fixture=c    # 只跑记忆
//   node -r ./scripts/timeshift.js scripts/verify-all.js --fixture=worker   # 时间位移 worker

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const OFFSET_FILE = path.join(ROOT, 'data', '.timeshift-ms');
const APPT_FILE = path.join(ROOT, 'data', 'appointments.json');

const args = new Set(process.argv.slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function emit(fixture, results) {
    for (const r of results) {
        process.stdout.write('RESULT@@' + JSON.stringify({ fixture, ...r }) + '\n');
    }
    const fails = results.filter((r) => !r.ok).length;
    return fails;
}

// ===================== A: 时间位移 worker =====================
// 以 `-r ./scripts/timeshift.js` 启动 → 进程内 Date 已被平移。
// 收到一行 query 就回报此刻的 Date.now()；控制器（未位移）拿自己的真实时间做差比对。
function runWorker() {
    process.stdin.setEncoding('utf8');
    let buf = '';
    process.stdout.write('WORKER_READY\n');
    process.stdin.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const tag = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!tag) continue;
            let offsetShown = 0;
            try { offsetShown = Number(fs.readFileSync(OFFSET_FILE, 'utf8')) || 0; } catch (e) { offsetShown = 0; }
            process.stdout.write('@@' + JSON.stringify({ tag, fakeNow: Date.now(), offsetShown }) + '\n');
        }
    });
}

function spawnWorker() {
    const child = spawn(NODE, ['-r', './scripts/timeshift.js', 'scripts/verify-all.js', '--fixture=worker'], { cwd: ROOT });
    const w = { child, queue: [], buf: '' };
    w.ready = new Promise((res) => { w.readyResolve = res; });
    child.stdout.on('data', (d) => {
        w.buf += d.toString();
        let i;
        while ((i = w.buf.indexOf('\n')) >= 0) {
            const line = w.buf.slice(0, i).trim();
            w.buf = w.buf.slice(i + 1);
            if (line === 'WORKER_READY') { w.readyResolve && w.readyResolve(); continue; }
            if (line.startsWith('@@')) {
                let obj = null;
                try { obj = JSON.parse(line.slice(2)); } catch (e) { obj = null; }
                if (obj && w.queue.length) w.queue.shift()(obj);
            }
        }
    });
    w.ask = (tag) => new Promise((res) => { w.queue.push(res); child.stdin.write(tag + '\n'); });
    return w;
}

async function fixtureA() {
    const results = [];
    const check = (name, ok, detail) => results.push({ fixture: 'a', name, ok: !!ok, detail: detail == null ? '' : String(detail) });

    const N = 4;
    const workers = [];
    for (let i = 0; i < N; i++) workers.push(spawnWorker());
    await Promise.all(workers.map((w) => w.ready));
    check(`A0 拉起 ${N} 个独立服务进程并全部就绪`, workers.length === N, `${workers.length}/${N}`);

    const rounds = [
        { label: '偏移 0（真实时间）', ms: 0 },
        { label: '前进 1 天', ms: 86400000 },
        { label: '后退 2 小时', ms: -7200000 },
        { label: '前进 30 分', ms: 1800000 },
        { label: '归零（回真实）', ms: 0 }
    ];
    const REPEAT = 2; // 重复实验

    for (let r = 0; r < REPEAT; r++) {
        for (const rd of rounds) {
            fs.writeFileSync(OFFSET_FILE, String(rd.ms));
            await sleep(2000); // 等各进程轮询（1s）读到新偏移
            const realNow = Date.now(); // 控制器未位移 = 真实时间
            const resps = await Promise.all(workers.map((w, idx) => w.ask(`r${r + 1}-${rd.ms}-w${idx}`)));
            let okAll = true;
            let detail = '';
            resps.forEach((resp, idx) => {
                const delta = resp.fakeNow - realNow; // 预期 ≈ rd.ms
                const offOk = resp.offsetShown === rd.ms;
                if (Math.abs(delta - rd.ms) > 200 || !offOk) {
                    okAll = false;
                    detail += `[w${idx} 实测Δ=${delta} 期望=${rd.ms} 文件偏移=${resp.offsetShown}] `;
                }
            });
            check(`A 第${r + 1}轮 · ${rd.label} · ${N}进程时钟一致`, okAll, detail || `Δ=${rd.ms}ms`);
        }
    }

    workers.forEach((w) => w.child.kill());
    return results;
}

// ===================== B: 事件簿生命周期 =====================
function pad(n) { return String(n).padStart(2, '0'); }
function fmtLocal(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function fixtureB() {
    const results = [];
    const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });

    const OFFSET = Number(process.env.TIME_SHIFT_MS) || 0;
    const shifted = typeof global.__timeshiftRealNow === 'function';
    // 用「真实时间」参照：若带 -r 预加载，Date.now() 已被平移
    const realNow = shifted ? global.__timeshiftRealNow() : Date.now();
    check(`B0 时间位移在同一进程内生效（偏移 ${OFFSET}ms）`, Math.abs((Date.now() - realNow) - OFFSET) < 200,
        `实测Δ=${Date.now() - realNow}`);

    const AppointmentBook = require('../src/core/appointmentBook');

    // 备份真实数据 → 空表开跑
    const bak = APPT_FILE + '.verifybak';
    const hadFile = fs.existsSync(APPT_FILE);
    if (hadFile) fs.copyFileSync(APPT_FILE, bak);
    fs.writeFileSync(APPT_FILE, JSON.stringify({ appointments: [] }, null, 2));

    let extractReply = { has: false };
    let resolveReply = { hit: false, results: [] };
    const stub = {
        callAPI: async (msgs) => {
            const p = (msgs && msgs[0] && msgs[0].content) || '';
            const reply = p.includes('判断这句话是否交代') ? resolveReply : extractReply;
            return { choices: [{ message: { content: JSON.stringify(reply) } }] };
        }
    };

    try {
        const book = new AppointmentBook({ unifiedAPI: stub });
        const UID = '__verify_appt_' + process.pid;

        // B1 提取 + 记账（未来 2 天）
        extractReply = { has: true, event: '考试', time: fmtLocal(new Date(Date.now() + 2 * 86400000)), care: true };
        const ok1 = await book.observe(UID, '后天我要考试了');
        check('B1 从聊天里提取并记下一条约定', ok1 === true && book.appointments.length === 1, `len=${book.appointments.length}`);

        // B2 去重
        const ok2 = await book.observe(UID, '后天我要考试了');
        check('B2 同一件事不重复记账（去重）', ok2 === false && book.appointments.length === 1, `len=${book.appointments.length}`);

        const apptA = book.appointments[0];
        const due = apptA.dueAt;

        // B3 pre 叮嘱（到点前 30 分钟）
        let dueList = book.takeDueForSpeech(due - 30 * 60000);
        const pre = dueList.find((x) => x.appointment.id === apptA.id);
        check('B3 到点前 1 小时内触发叮嘱(pre)', pre && pre.kind === 'pre', JSON.stringify(dueList.map((x) => x.kind)));

        // B4 叮嘱不重复
        book.markSpoken(apptA, 'pre');
        dueList = book.takeDueForSpeech(due - 30 * 60000);
        check('B4 叮嘱过的不再重复触发', !dueList.some((x) => x.appointment.id === apptA.id), JSON.stringify(dueList.map((x) => x.kind)));

        // B5 刚过点不追问
        dueList = book.takeDueForSpeech(due + 30 * 60000);
        check('B5 刚过点 30 分内不追问（避免太急）', !dueList.some((x) => x.appointment.id === apptA.id), JSON.stringify(dueList.map((x) => x.kind)));

        // B6 post 追问（过点 90 分钟）
        dueList = book.takeDueForSpeech(due + 90 * 60000);
        const post = dueList.find((x) => x.appointment.id === apptA.id);
        check('B6 过点 1~24 小时内触发追问(post)', post && post.kind === 'post', JSON.stringify(dueList.map((x) => x.kind)));
        book.markSpoken(apptA, 'post');

        // B7 结果回写
        const pastDue = Date.now() - 2 * 3600000;
        book.addAppointment({ userId: UID, event: '体检', dueAt: pastDue, raw: '今天去体检' });
        resolveReply = { hit: true, results: [{ index: 1, result: '体检没问题' }] };
        const resolved = await book.resolveFrom(UID, '体检结果出来了，一切正常');
        const apptB = book.appointments.find((a) => a.event === '体检');
        check('B7 用户交代结局 → 回写 status=resolved / result',
            resolved === true && apptB && apptB.status === 'resolved' && apptB.result === '体检没问题',
            `status=${apptB && apptB.status} result=${apptB && apptB.result}`);

        // B8 已了结不再叮嘱/追问
        dueList = book.takeDueForSpeech(pastDue + 90 * 60000);
        check('B8 已了结的事不再叮嘱/追问', !dueList.some((x) => x.appointment.id === apptB.id), JSON.stringify(dueList.map((x) => x.kind)));

        // B9/B10 提示词注入
        const text = book.getPendingText(UID);
        check('B9 注入【你记着对方的事】（待办）', text.includes('【你记着对方的事】') && text.includes('考试'), text.slice(0, 80));
        check('B10 注入【对方已经告诉过你的结果】（结论）',
            text.includes('【对方已经告诉过你的结果】') && text.includes('体检没问题'), text.slice(0, 80));

        // B11 observe 前置解析：新一句话交代另一件到期事的结局
        const freshDue = Date.now() - 3 * 3600000;
        book.addAppointment({ userId: UID, event: '取快递', dueAt: freshDue, raw: '今天有快递' });
        resolveReply = { hit: true, results: [{ index: 1, result: '快递已取回' }] };
        extractReply = { has: false };
        await book.observe(UID, '快递我取回来了');
        const apptC = book.appointments.find((a) => a.event === '取快递');
        check('B11 observe 会先尝试回写结局再提取新约定',
            apptC && apptC.status === 'resolved' && apptC.result === '快递已取回',
            `status=${apptC && apptC.status} result=${apptC && apptC.result}`);
    } finally {
        // 还原真实数据
        try {
            if (hadFile) fs.copyFileSync(bak, APPT_FILE);
            else fs.unlinkSync(APPT_FILE);
        } catch (e) { results.push({ name: 'B-restore', ok: false, detail: e.message }); }
        try { fs.unlinkSync(bak); } catch (e) { /* ignore */ }
    }

    return results;
}

// ===================== C: 记忆话题聚类 =====================
async function fixtureC() {
    const results = [];
    const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });

    const MemoryModule = require('../src/core/memory');
    const m = new MemoryModule();

    const uid = '__verify_mem_' + process.pid;
    const key = m.normalizeScopeKey(uid);
    const file = path.join(ROOT, 'data', 'user_memories', `${key}.json`);
    try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
    delete m.userMemories[key];
    m.createUserMemoryStore(uid);

    const store = (t) => m.storeMemory({ value: 0, scene: t }, uid, t);
    // 把已写入的这条「变旧」，跨过 10 分钟承接窗口，逼出「按字面重合聚类」的分支
    const age = (mem, ms) => { mem.timestamp = Date.now() - ms; };

    try {
        // —— 路径 1：10 分钟内承接上文（连续对话应直接同话题）——
        const e1 = store('明天要交周报给主管');
        const e2 = store('周报记得写一下这周的项目进度');
        check('C1a [承接上文] 10 分钟内连续两条归入同一话题',
            !!e1.topicId && e1.topicId === e2.topicId, `${e1.topicId} / ${e2.topicId}`);

        // —— 路径 2：措辞几乎重复（字面高度重合应同话题）——
        // 先把 e 组调旧、切断「承接上文」，让 f1 真正去走「字面重合」这条路（组间隔离）
        age(e1, 30 * 60000); age(e2, 30 * 60000);
        const f1 = store('下周要去参加公司的年度总结会议'); // 应新开话题
        age(f1, 30 * 60000);
        const f2 = store('下周要参加公司的年度总结会议');   // 靠字面重合继承 f1
        check('C1b [字面高度重合] 近乎重复的措辞归入同一话题',
            !!f1.topicId && f1.topicId === f2.topicId, `${f1.topicId} / ${f2.topicId}`);

        // —— 路径 3：同一件事但换种说法（只共享关键词，应同话题）——
        age(f2, 30 * 60000);                                 // 切断承接，让 a 真正去走「关键词兜底」
        const a = store('明天上午九点要去医院做体检');       // 应新开话题
        age(a, 30 * 60000);
        const b = store('体检要空腹，早上不能吃东西');        // 靠关键词「体检」继承 a
        age(b, 30 * 60000);
        const c = store('记得带上身份证和体检单');            // 靠关键词「体检」继承 a
        age(c, 30 * 60000);
        const d = store('周末想去看那部新出的电影');

        check('C1c [同事项换措辞] 同一件事的多条记忆归入同一话题',
            !!a.topicId && a.topicId === b.topicId && b.topicId === c.topicId,
            `${a.topicId} / ${b.topicId} / ${c.topicId}`);
        check('C2 无关内容另起一个话题', !!d.topicId && d.topicId !== a.topicId, `${d.topicId} vs ${a.topicId}`);
        check('C7 [不误并] 不同事项不会因泛用片段被强行并成一个话题',
            a.topicId !== f1.topicId && a.topicId !== e1.topicId && d.topicId !== f1.topicId,
            `体检=${a.topicId} 会议=${f1.topicId} 周报=${e1.topicId} 电影=${d.topicId}`);
        check('C3 每条记忆都打上了话题标识', !!(a.topicId && b.topicId && c.topicId && d.topicId), '');

        const recalled = m.getRelevantMemories(uid, '体检需要注意什么', 2);
        const examHits = recalled.filter((x) => x.includes('体检')).length;
        check('C4 按查询召回命中体检相关记忆', examHits >= 1, recalled.join(' | ').slice(0, 160));
        check('C5 话题聚合把同系列兄弟记忆一并带出（≥3 条）', examHits >= 3, `命中 ${examHits} 条: ` + recalled.join(' | ').slice(0, 160));
        check('C6 无关内容不混入召回', !recalled.some((x) => x.includes('电影')), recalled.join(' | ').slice(0, 160));
    } finally {
        try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
    }

    return results;
}

// ===================== 编排器 =====================
function runChild(fixture, extraEnv, useMock) {
    return new Promise((resolve) => {
        const base = ['scripts/verify-all.js', '--fixture=' + fixture];
        const argv = useMock ? ['-r', './scripts/timeshift.js', ...base] : base;
        const child = spawn(NODE, argv, { cwd: ROOT, env: { ...process.env, ...extraEnv } });
        let out = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { out += d.toString(); });
        child.on('close', (code) => {
            const results = out.split('\n').filter((l) => l.startsWith('RESULT@@'))
                .map((l) => { try { return JSON.parse(l.slice(8)); } catch (e) { return null; } })
                .filter(Boolean);
            resolve({ fixture, code, results, raw: out });
        });
    });
}

async function orchestrate() {
    // 多个独立进程、平行执行；事件簿(B)会读写同一份 appointments.json，故两次 B 串行（且两次结果都要收）
    const runBSequence = async () => {
        const b1 = await runChild('b', { TIME_SHIFT_MS: '0' }, true);
        const b2 = await runChild('b', { TIME_SHIFT_MS: '3600000' }, true);
        return { fixture: 'b', results: [...b1.results, ...b2.results] };
    };

    const tasks = [
        fixtureA(),
        runChild('c', { TIME_SHIFT_MS: '0' }, false),
        runChild('c', { TIME_SHIFT_MS: '0' }, false),
        runBSequence()
    ];

    const settled = await Promise.all(tasks);
    let all = [];
    for (const s of settled) all = all.concat(Array.isArray(s) ? s : s.results);

    // 复位偏移文件，避免影响后续真实运行
    try { fs.writeFileSync(OFFSET_FILE, '0'); } catch (e) { /* ignore */ }

    const total = all.length;
    const failed = all.filter((r) => !r.ok);
    console.log('\n================ 验证汇总 ================');
    for (const r of all) console.log(`${r.ok ? '✅' : '❌'} [${r.fixture}] ${r.name}${r.detail ? '  → ' + r.detail : ''}`);
    console.log(`\n合计 ${total} 项，通过 ${total - failed.length}，失败 ${failed.length}`);
    if (failed.length) console.log('失败项:\n' + failed.map((f) => ` - [${f.fixture}] ${f.name} → ${f.detail}`).join('\n'));

    process.exitCode = failed.length ? 1 : 0;
}

// ===================== 入口分发 =====================
if (args.has('--fixture=worker')) {
    runWorker();
} else if (args.has('--fixture=b')) {
    fixtureB().then((r) => { process.exitCode = emit('b', r) ? 1 : 0; })
        .catch((e) => { process.stdout.write('RESULT@@' + JSON.stringify({ fixture: 'b', name: 'B 崩溃', ok: false, detail: e.message }) + '\n'); process.exitCode = 1; });
} else if (args.has('--fixture=c')) {
    fixtureC().then((r) => { process.exitCode = emit('c', r) ? 1 : 0; })
        .catch((e) => { process.stdout.write('RESULT@@' + JSON.stringify({ fixture: 'c', name: 'C 崩溃', ok: false, detail: e.message }) + '\n'); process.exitCode = 1; });
} else {
    orchestrate().catch((e) => { console.error('编排器异常:', e); process.exitCode = 1; });
}
