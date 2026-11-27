const fs = require('fs');
const path = require('path');

// 🎭 群聊印象影子层
// 只回答一个问题：在这个群里，A 眼里的 B 是什么样。
//
// 边界（与记忆中枢的划界，和表情投影层同源）：
// - 只写 data/social_plaza/shadow/，不 require 任何记忆模块，不碰 user_memories
// - 不自动升级：正式对话的 RAG 永远读不到这里，只有被正式对话自然提及才可能升级（未实现）
// - 容量靠丢弃封顶，不靠压缩，避免长期膨胀
const STORAGE_DIR = path.join(__dirname, '../../data/social_plaza/shadow');

const MAX_NOTES_PER_SUBJECT = 12;   // 单个「我对他」的印条上限
const MAX_NOTE_CHARS = 60;          // 单条印象硬上限
const PROMPT_NOTES_PER_SUBJECT = 2; // 进提示词的条数
const PROMPT_MAX_CHARS = 420;       // 印象段总长上限

function safeName(sessionId) {
    return String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function bare(text) {
    return String(text || '').replace(/[\s，。！？、；：…~～\-—"'“”‘’（）()【】「」『』]/g, '');
}

function clip(text) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > MAX_NOTE_CHARS ? `${s.slice(0, MAX_NOTE_CHARS)}…` : s;
}

class ImpressionStore {
    constructor({ dir } = {}) {
        this.dir = dir || STORAGE_DIR;
        this.cache = new Map();
    }

    fileFor(observerId) {
        return path.join(this.dir, `${safeName(observerId)}.json`);
    }

    // 每个观察者一个文件：{ observer, subjects: { [subjectId]: { name, notes: [{text, at}] } } }
    read(observerId) {
        if (this.cache.has(observerId)) return this.cache.get(observerId);
        let data = { observer: observerId, subjects: {} };
        try {
            const file = this.fileFor(observerId);
            if (fs.existsSync(file)) {
                const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (parsed && parsed.subjects && typeof parsed.subjects === 'object') {
                    data = { observer: observerId, subjects: parsed.subjects };
                }
            }
        } catch (error) {
            console.error('[群聊印象] 读取失败，按空印象启动:', error.message);
        }
        this.cache.set(observerId, data);
        return data;
    }

    write(observerId, data) {
        try {
            if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
            fs.writeFileSync(this.fileFor(observerId), JSON.stringify(data, null, 2), 'utf8');
        } catch (error) {
            console.error('[群聊印象] 保存失败:', error.message);
        }
    }

    // 记一条：observer 听到 subject 说了 text。复述/重复不构成新印象。
    observe({ observer, subject, subjectName, text, at }) {
        if (!observer || !subject || observer === subject) return null;
        const note = clip(text);
        if (!note) return null;
        const data = this.read(observer);
        const bucket = data.subjects[subject] || { name: subjectName || subject, notes: [] };
        if (subjectName) bucket.name = subjectName;
        const target = bare(note);
        const dup = bucket.notes.some((n) => {
            const other = bare(n.text);
            return other === target || (target.length >= 8 && other.includes(target));
        });
        data.subjects[subject] = bucket;
        if (dup) return null;
        bucket.notes.push({ text: note, at: Number(at) || Date.now() });
        if (bucket.notes.length > MAX_NOTES_PER_SUBJECT) {
            bucket.notes = bucket.notes.slice(-MAX_NOTES_PER_SUBJECT);
        }
        this.write(observer, data);
        return bucket.notes[bucket.notes.length - 1];
    }

    recall(observer, subject, limit = PROMPT_NOTES_PER_SUBJECT) {
        const bucket = this.read(observer).subjects[subject];
        if (!bucket || !Array.isArray(bucket.notes)) return [];
        return bucket.notes.slice(-Math.max(0, limit));
    }

    // 只渲染「我对在场其他人」的印象；不在场的人不进提示词
    renderForPrompt(observerId, participants = []) {
        const data = this.read(observerId);
        const lines = [];
        participants.forEach((p) => {
            if (!p || !p.sessionId || p.sessionId === observerId) return;
            const bucket = data.subjects[p.sessionId];
            if (!bucket || !Array.isArray(bucket.notes) || bucket.notes.length === 0) return;
            const notes = bucket.notes.slice(-PROMPT_NOTES_PER_SUBJECT).map((n) => n.text).join(' / ');
            lines.push(`- ${bucket.name || p.name}：${notes}`);
        });
        if (lines.length === 0) return '';
        let body = `\n\n【你对他们已有的印象】\n以下是你在群里听他们说过的话留下的印象，可能过时，仅供参考，不要当成事实复述：\n${lines.join('\n')}`;
        if (body.length > PROMPT_MAX_CHARS) body = `${body.slice(0, PROMPT_MAX_CHARS)}…`;
        return body;
    }

    clearRoom() {
        this.cache.clear();
        try {
            if (!fs.existsSync(this.dir)) return;
            fs.readdirSync(this.dir).forEach((name) => {
                if (!name.endsWith('.json')) return;
                try {
                    fs.unlinkSync(path.join(this.dir, name));
                } catch (error) {
                    // 单个删除失败不影响整体清空
                }
            });
        } catch (error) {
            console.error('[群聊印象] 清空失败:', error.message);
        }
    }
}

module.exports = {
    ImpressionStore,
    STORAGE_DIR,
    MAX_NOTES_PER_SUBJECT,
    PROMPT_NOTES_PER_SUBJECT
};
