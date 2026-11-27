const fs = require('fs');
const path = require('path');
const { UnifiedAPI } = require('./api');
const { writeJsonAtomicSync } = require('../storage/atomicWrite');

// 📅 事件簿：把聊天里出现的「约定 / 日程 / 会发生的事」挑出来单独记账，
// 到点前叮嘱一句、过点后追问一句，并且随时把待发生的事喂给她的上下文，
// 让她像个真人一样惦记着这些事，而不是聊完就忘。
//
// 提取是异步 best-effort：正则先筛时间词，命中才花一次 LLM 调用做结构化提取，
// 失败/解析不出全部静默跳过，绝不影响正式回复。

const DATA_PATH = path.join(__dirname, '..', '..', 'data', 'appointments.json');

// 触发窗口
const PRE_WINDOW_MIN = 60;           // 到点前 1 小时内可以开口叮嘱
const POST_DELAY_MIN = 60;           // 过点 1 小时后才能追问结果（别事情刚到点就急着问）
const POST_WINDOW_MIN = 24 * 60;     // 过点 24 小时内追问有效，再晚就不问了
// 记账上限与有效期
const MAX_KEEP_DAYS = 30;            // 过期条目最多留 30 天就清掉
const DEDUP_MIN = 30;                // 同一用户 + 同一事件 + 时间接近算重复，不重复记
const MAX_PER_USER = 50;             // 单用户事件数上限，防爆表

// 正则预筛：命中才调 LLM，没命中零开销。从宽（宁可白筛一次，不能漏掉约定）
const EXTRACT_TRIGGER_RE = /(明天|后天|大后天|今晚|今早|明早|下周|这周|周末|周[一二三四五六日天末]|星期[一二三四五六日天]|\d{1,2}[点日号]|月底|月初|\d{1,2}月\d{1,2}[日号]|考试|面试|体检|看病|生日|还钱|到货|快递|出门|回家|到家|下班|下课|开学|放假|截止|约)/;

// 待发生事件注入提示词的取件范围：只看未来 7 天内、最多 5 条
const PROMPT_WINDOW_DAYS = 7;
const PROMPT_MAX_ITEMS = 5;

// 状态回写：事情到点后，把用户后续交代的结局回填到这条约定上
const STATUS_PENDING = 'pending';       // 待发生 / 未了结
const STATUS_RESOLVED = 'resolved';     // 已了结（拿到结果）
const RESOLVE_WINDOW_MIN = 7 * 24 * 60; // 到期后 7 天内才接受结果回写（更久远的旧事不追）
const RESOLVE_MATCH_MAX = 5;            // 一次最多判定 5 条到期事件，防提示词过长
const RESOLVED_KEEP_DAYS = 14;          // 已了结的结果保留多久仍注入提示词（让她记得住结论）

class AppointmentBook {
    constructor({ unifiedAPI = null, dataPath = DATA_PATH, timeline = null, timelineScope = null } = {}) {
        // 复用全局 API 配置（DeepSeek），不单独维护密钥
        this.unifiedAPI = unifiedAPI || new UnifiedAPI();
        // 🕰️ 时间线：约定记进同一条日志；可注入（测试用独立实例），缺省不记。
        // scope 由上层给的函数规范化（记忆键的分档语义不在本模块里复制一遍）
        this.timeline = timeline;
        this.timelineScope = typeof timelineScope === 'function' ? timelineScope : null;
        // 落盘路径可注入：测试必须走临时文件，不能读写真实的 data/appointments.json
        this.dataPath = dataPath;
        this.appointments = [];
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.dataPath)) {
                const raw = JSON.parse(fs.readFileSync(this.dataPath, 'utf8'));
                this.appointments = Array.isArray(raw.appointments) ? raw.appointments : [];
                // 老数据没有 status 字段，按「未了结」补齐；已有的保持原样
                this.appointments.forEach((a) => {
                    if (!a.status) a.status = STATUS_PENDING;
                });
            }
        } catch (error) {
            console.error('[事件簿] 读取失败，从空表开始:', error.message);
            this.appointments = [];
        }
        this.cleanup();
    }

    save() {
        try {
            writeJsonAtomicSync(this.dataPath, { appointments: this.appointments });
        } catch (error) {
            console.error('[事件簿] 保存失败:', error.message);
        }
    }

    cleanup() {
        const cutoff = Date.now() - MAX_KEEP_DAYS * 24 * 60 * 60 * 1000;
        const before = this.appointments.length;
        this.appointments = this.appointments.filter((a) => (a.createdAt || 0) > cutoff);
        if (this.appointments.length !== before) {
            console.log(`[事件簿] 清理过期条目 ${before - this.appointments.length} 条`);
        }
    }

    // 正则预筛：这段话里有没有可能藏着约定
    maybeExtract(text) {
        return typeof text === 'string' && text.length >= 4 && EXTRACT_TRIGGER_RE.test(text);
    }

    // LLM 结构化提取。返回 {userId, event, dueAt, raw} 或 null（无约定 / 无时间点 / 任何失败）
    async extractFrom(userId, text) {
        if (!this.maybeExtract(text)) return null;

        const now = new Date();
        const weekday = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
        const p = (n) => String(n).padStart(2, '0');
        const clock = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;

        const prompt = `现在的真实时间：${clock}，星期${weekday}（Asia/Shanghai）。
用户对角色说了一句话：「${String(text).slice(0, 500)}」

判断这句话里是否包含「未来会发生、且有明确时间点的事」。约定、日程、计划、提醒都算：考试、面试、看病、出门、回家、生日、快递到货、还钱、约好一起做事等。

只输出一行 JSON，不要任何其他内容：
{"has": true或false, "event": "事件简述10字内", "time": "YYYY-MM-DD HH:mm"或null, "care": true或false}

规则：
1. 只能从这句话推断，不许脑补；「明天」「周三」这类相对时间按真实时间换算成绝对日期
2. 话里没有明确时间点（比如只说"改天""以后"）→ time 写 null
3. 已经发生过的事 → has 写 false
4. care 表示这件事是否值得角色记着并在合适时候关心一句（默认 true，纯闲聊性提及才 false）`;

        try {
            const result = await this.unifiedAPI.callAPI([{ role: 'user', content: prompt }], null, { callSite: 'appointmentExtract' });
            const raw = result?.choices?.[0]?.message?.content || '';
            const match = raw.match(/\{[\s\S]*\}/);
            if (!match) return null;
            const parsed = JSON.parse(match[0]);
            if (!parsed || parsed.has !== true || !parsed.time || parsed.care === false) return null;

            // "YYYY-MM-DD HH:mm" → 本地时间戳
            const m = String(parsed.time).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
            if (!m) return null;
            const dueAt = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
            if (!Number.isFinite(dueAt)) return null;

            const offsetMin = (dueAt - Date.now()) / 60000;
            // 过去超过 1 小时的不记（多半是闲聊提旧事），太远（>90 天）的也不记
            if (offsetMin < -60 || offsetMin > 90 * 24 * 60) return null;

            const event = String(parsed.event || '').slice(0, 40) || '一件说好的事';
            return { userId: String(userId), event, dueAt, raw: text.slice(0, 200) };
        } catch (error) {
            console.warn('[事件簿] 提取失败（不影响回复）:', error.message);
            return null;
        }
    }

    // 记账（带去重）。返回是否真的记了一条
    addAppointment({ userId, event, dueAt, raw }) {
        if (!userId || !event || !Number.isFinite(dueAt)) return false;
        const dup = this.appointments.find(
            (a) =>
                a.userId === String(userId) &&
                a.event === event &&
                Math.abs((a.dueAt || 0) - dueAt) < DEDUP_MIN * 60000
        );
        if (dup) return false;

        const userCount = this.appointments.filter((a) => a.userId === String(userId)).length;
        if (userCount >= MAX_PER_USER) {
            // 满了优先挤掉已了结的旧事，其次挤掉已追问过的，全是待办的就不记新的
            let idx = this.appointments.findIndex((a) => a.userId === String(userId) && a.status === STATUS_RESOLVED);
            if (idx === -1) idx = this.appointments.findIndex((a) => a.userId === String(userId) && a.followedUpAt);
            if (idx === -1) return false;
            this.appointments.splice(idx, 1);
        }

        this.appointments.push({
            id: `appt_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            userId: String(userId),
            event,
            dueAt,
            raw: raw || '',
            createdAt: Date.now(),
            remindedAt: 0,   // 到点前叮嘱的时间
            followedUpAt: 0, // 过点后追问的时间
            status: STATUS_PENDING, // 待发生 / 未了结；拿到结果后变 resolved
            result: '',             // 事情结局（用户后续交代的）
            resolvedAt: 0           // 回写结果的时间
        });
        this.save();
        // 🕰️ 时间线：真的记下一条约定后才写（去重返回 false 时不写，日志只认实际发生的事）
        if (this.timeline) {
            const scope = this.timelineScope ? this.timelineScope(String(userId)) : `${String(userId)}__role`;
            this.timeline.append(scope, 'appointment.scheduled', {
                id: this.appointments[this.appointments.length - 1].id,
                at: dueAt,
                text: event.slice(0, 200)
            });
        }
        console.log(`[事件簿] 记下约定：「${event}」→ ${new Date(dueAt).toLocaleString('zh-CN')}（${userId}）`);
        return true;
    }

    // 结果回写：用户这句话有没有交代某件「已到期但未了结」的事的结局？
    // 命中就给对应事件写上 status=resolved / result / resolvedAt，让约定型记忆也有状态流转。
    // 只在确实有到期候选时才花一次 LLM 判定，没有候选零开销。
    async resolveFrom(userId, text) {
        if (typeof text !== 'string' || text.trim().length < 2) return false;

        const now = Date.now();
        const windowStart = now - RESOLVE_WINDOW_MIN * 60000;
        const candidates = this.appointments
            .filter(
                (a) =>
                    a.userId === String(userId) &&
                    a.status !== STATUS_RESOLVED &&
                    a.dueAt <= now &&
                    a.dueAt >= windowStart
            )
            .sort((a, b) => b.dueAt - a.dueAt)
            .slice(0, RESOLVE_MATCH_MAX);
        if (candidates.length === 0) return false;

        const list = candidates
            .map((a, i) => {
                const d = new Date(a.dueAt);
                const stamp = `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
                return `${i + 1}. ${a.event}（原定 ${stamp}）`;
            })
            .join('\n');

        const prompt = `用户刚说了一句话：「${String(text).slice(0, 500)}」

之前记着这几件已经到期、还不知道结果的事：
${list}

判断这句话是否交代了其中某件（或多件）事的结局（例如"考完了""面试过了""没去成""顺利到家了"）。只输出一行 JSON，不要任何其他内容：
{"hit": true或false, "results": [{"index": 序号, "result": "结局简述20字内"}]}

规则：
1. 只能依据这句话判断，不许脑补；只是闲聊提到、没交代结局的不算
2. 没交代任何一件 → hit 写 false，results 写 []
3. index 必须是上面清单里的序号`;

        try {
            const result = await this.unifiedAPI.callAPI([{ role: 'user', content: prompt }], null, { callSite: 'appointmentMatch' });
            const raw = result?.choices?.[0]?.message?.content || '';
            const match = raw.match(/\{[\s\S]*\}/);
            if (!match) return false;
            const parsed = JSON.parse(match[0]);
            if (!parsed || parsed.hit !== true || !Array.isArray(parsed.results)) return false;

            let updated = 0;
            for (const item of parsed.results) {
                const target = candidates[Number(item && item.index) - 1];
                if (!target) continue;
                const resultText = String((item && item.result) || '').slice(0, 60).trim();
                target.status = STATUS_RESOLVED;
                target.result = resultText || '已了结';
                target.resolvedAt = Date.now();
                updated++;
            }
            if (updated > 0) {
                this.save();
                console.log(`[事件簿] 回写 ${updated} 条约定结果（${userId}）`);
            }
            return updated > 0;
        } catch (error) {
            console.warn('[事件簿] 结果回写失败（不影响回复）:', error.message);
            return false;
        }
    }

    // 异步提取 + 记账一条龙（供正式回复链路 fire-and-forget 调用）
    // 先尝试把这句话当成「到期事件的结果」回写，再照常做新约定的提取
    async observe(userId, text) {
        await this.resolveFrom(userId, text).catch(() => false);
        if (!this.maybeExtract(text)) return false;
        const found = await this.extractFrom(userId, text);
        if (!found) return false;
        return this.addAppointment(found);
    }

    // 某用户待发生的事（未来 7 天内）+ 最近了结的事，编成提示词片段；都没有就返回空串
    getPendingText(userId) {
        const now = Date.now();
        const horizon = now + PROMPT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
        const mine = this.appointments.filter(
            (a) => a.userId === String(userId) && a.status !== STATUS_RESOLVED
        );
        const pending = mine
            .filter((a) => a.dueAt > now && a.dueAt < horizon)
            .sort((a, b) => a.dueAt - b.dueAt)
            .slice(0, PROMPT_MAX_ITEMS);

        // 已经过点、还没拿到结果的事：从过点那一刻到「追问窗口」之间原本是个空白，
        // 事情可能正在进行，提示词里却什么都没有——她只能当没这回事，或者一小时后补问一遍。
        const overdueStart = now - RESOLVE_WINDOW_MIN * 60 * 1000;
        const overdue = mine
            .filter((a) => a.dueAt <= now && a.dueAt >= overdueStart)
            .sort((a, b) => b.dueAt - a.dueAt)
            .slice(0, PROMPT_MAX_ITEMS);

        // 最近了结的事：把结论也喂回上下文，别追问完就把结果忘了
        const resolvedCutoff = now - RESOLVED_KEEP_DAYS * 24 * 60 * 60 * 1000;
        const resolved = this.appointments
            .filter(
                (a) =>
                    a.userId === String(userId) &&
                    a.status === STATUS_RESOLVED &&
                    (a.resolvedAt || 0) >= resolvedCutoff
            )
            .sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0))
            .slice(0, PROMPT_MAX_ITEMS);

        if (pending.length === 0 && overdue.length === 0 && resolved.length === 0) return '';

        let out = '';
        if (pending.length > 0) {
            const lines = pending.map((a) => {
                const d = new Date(a.dueAt);
                const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
                return `- ${a.event}：${p(d.getMonth() + 1)}月${p(d.getDate())}日（周${week}）${p(d.getHours())}:${p(d.getMinutes())}（${relativeHint(a.dueAt, now)}）`;
            });
            out += `\n【你记着对方的事】这些事你知道但还没发生，聊天时可以自然地关心、叮嘱或追问，像真人惦记着一样，但别生硬背日程表：\n${lines.join('\n')}\n`;
        }
        if (overdue.length > 0) {
            const lines = overdue.map((a) => {
                const d = new Date(a.dueAt);
                const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
                return `- ${a.event}：${p(d.getMonth() + 1)}月${p(d.getDate())}日（周${week}）${p(d.getHours())}:${p(d.getMinutes())}（${relativeHint(a.dueAt, now)}，可能还没结束）`;
            });
            out += `\n【时间已经过了、你还没等到回音的事】这些事的时间点已经过去，对方可能还在做，也可能已经结束了；别把它当成还没发生的事，也别把对方刚在对话里说过的结果再问一遍：\n${lines.join('\n')}\n`;
        }
        if (resolved.length > 0) {
            const lines = resolved.map((a) => `- ${a.event}：${a.result}`);
            out += `\n【对方已经告诉过你的结果】这些事你之前惦记过，对方后面交代了结局，你记得住结论，别再当没发生过：\n${lines.join('\n')}\n`;
        }
        return out;
    }

    // 当前该开口的事件：[{appointment, kind:'pre'|'post', minutesAway}]
    // 每条事件「叮嘱」和「追问」各只触发一次
    takeDueForSpeech(now = Date.now()) {
        const due = [];
        for (const a of this.appointments) {
            if (a.status === STATUS_RESOLVED) continue; // 已拿到结局的不再叮嘱/追问
            const minsTo = (a.dueAt - now) / 60000;
            if (!a.remindedAt && minsTo > 0 && minsTo <= PRE_WINDOW_MIN) {
                due.push({ appointment: a, kind: 'pre', minutesAway: Math.round(minsTo) });
            } else if (!a.followedUpAt) {
                const minsPast = -minsTo;
                if (minsPast >= POST_DELAY_MIN && minsPast <= POST_WINDOW_MIN) {
                    due.push({ appointment: a, kind: 'post', minutesAway: Math.round(minsPast) });
                }
            }
        }
        return due;
    }

    // 发言成功后才记账（失败不标，下一轮 tick 还能重试，直到窗口滑过去）
    markSpoken(appointment, kind) {
        if (kind === 'pre') appointment.remindedAt = Date.now();
        else appointment.followedUpAt = Date.now();
        this.save();
    }
}

// 提示词里格式化日期用的 pad（getPendingText 里用）
function p(n) {
    return String(n).padStart(2, '0');
}

// 相对现在的时间标注：只给绝对日期时，模型得拿提示词末尾的时间层反算，
// 一旦算错就会把明天的事当今天、把刚过的事当还没发生。
function relativeHint(dueAt, now) {
    const diffMin = Math.round((dueAt - now) / 60000);
    const abs = Math.abs(diffMin);
    const span =
        abs < 60
            ? `${abs} 分钟`
            : abs < 24 * 60
              ? `${Math.round(abs / 60)} 小时`
              : `${Math.round(abs / (24 * 60))} 天`;
    return diffMin >= 0 ? `还有约 ${span}` : `已过约 ${span}`;
}

module.exports = AppointmentBook;
