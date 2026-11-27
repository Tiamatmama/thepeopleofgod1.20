/**
 * 沙箱进化闸（Evolution Gate）
 *
 * 一句话：只有「登记在白名单 + 已钉过基线」的模块才允许自己进化；
 * 提案先在一个隔离副本里跑一遍该模块的 benchmark，
 * 结果跟基线比「不劣化」才放行——参数档自动生效（可回滚），工具档落待审等人拍板。
 *
 * 为什么判据是「不劣化」而不是「变好」：情感 / 记忆类模块没有客观 assert，
 * 凭空判好坏等于判据悬空；跟一条已钉死的基线比，才是有物理意义的闸门。
 *
 * 三铁律的落点：
 *   ① 白名单 + 必须有基线 → 没量过的模块一律拒；
 *   ② 参数 / 工具分档     → 工具永不动手，只落 pending；
 *   ③ 默认关 + 副本隔离   → gate.json.enabled 默认 false，评估跑在独立 run 目录。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { writeJsonAtomicSync } = require('../storage/atomicWrite');
const { instance: evolutionParams } = require('./evolutionParams');

// 允许自动进化的模块白名单。没登记 = 退回人拍板。
// metrics 里的指标规格：path 从评估报告里取数，direction 指明「越大越好 / 越小越好」，
// tolerance 是不劣化容差（跑分本就有噪声，不给容差会天天误判）。
const MODULES = {
    emotion: {
        label: '情绪状态层',
        params: ['internalFilterGain', 'internalIntensityCap'],
        bench: 'benchmark-internal-signal-real.js',
        outDir: 'data/benchmark-internal-signal',
        timeoutMs: 45 * 60 * 1000,
        metrics: [
            { key: '快层最大偏离_mean', path: 'aggregate.快层最大偏离_mean', direction: 'down', tolerance: 0.03 },
            { key: '慢层最大偏离_mean', path: 'aggregate.慢层最大偏离_mean', direction: 'down', tolerance: 0.03 },
            { key: '方向一致性_happy', path: 'aggregate.方向一致性.happy正', format: 'ratio', direction: 'up', tolerance: 0.1 },
            { key: '方向一致性_sad', path: 'aggregate.方向一致性.sad正', format: 'ratio', direction: 'up', tolerance: 0.1 },
            { key: '方向一致性_calm', path: 'aggregate.方向一致性.calm负', format: 'ratio', direction: 'up', tolerance: 0.1 }
        ]
    }
};

// 从报告对象里按「点分路径」取数
function readPath(obj, dotted) {
    return String(dotted).split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

// 把报告里的原始值折算成可比数字；ratio 格式形如 "3/4"
function toNumber(value, format) {
    if (format === 'ratio') {
        if (typeof value !== 'string') return NaN;
        const m = value.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
        if (!m) return NaN;
        const den = Number(m[2]);
        if (!den) return NaN;
        return Number(m[1]) / den;
    }
    const num = Number(value);
    return Number.isFinite(num) ? num : NaN;
}

// 按指标规格从报告里抽出一组可比数字；读不到的记为 NaN
function extractMetrics(report, specs) {
    const out = {};
    (specs || []).forEach((spec) => {
        out[spec.key] = toNumber(readPath(report, spec.path), spec.format);
    });
    return out;
}

function makeId(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// 读目录里 mtime 最新的一个 json（评估脚本写死的输出目录没法指定文件名，只能认最新）
function readNewestJson(dir) {
    let names;
    try {
        names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json'));
    } catch {
        return null;
    }
    if (!names.length) return null;
    let newest = null;
    let newestAt = -1;
    names.forEach((name) => {
        const full = path.join(dir, name);
        try {
            const at = fs.statSync(full).mtimeMs;
            if (at > newestAt) {
                newestAt = at;
                newest = full;
            }
        } catch {
            // 单个文件读不到就跳过，不影响整体
        }
    });
    if (!newest) return null;
    try {
        return JSON.parse(fs.readFileSync(newest, 'utf8'));
    } catch {
        return null;
    }
}

class EvolutionGate {
    constructor(options = {}) {
        const opts = options || {};
        this.root = opts.root || path.join(__dirname, '..', '..');
        this.dir = path.join(this.root, 'data', 'evolution');
        this.params = opts.params || evolutionParams;
        // runner 可注入：默认真跑 benchmark 脚本，测试里注入假 runner（不碰 LLM）
        this.runner = opts.runner || null;
        this.state = this.readJson(this.gateFile(), { enabled: false });
        if (typeof this.state.enabled !== 'boolean') this.state.enabled = false;
    }

    gateFile() {
        return path.join(this.dir, 'gate.json');
    }

    baselineFile(moduleId) {
        return path.join(this.dir, 'baseline', `${moduleId}.json`);
    }

    proposalsFile() {
        return path.join(this.dir, 'proposals.json');
    }

    readJson(file, fallback) {
        try {
            if (!fs.existsSync(file)) return fallback;
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (error) {
            console.error(`[进化闸] 读取失败 ${path.basename(file)}:`, error.message);
            return fallback;
        }
    }

    writeJson(file, data) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writeJsonAtomicSync(file, data);
    }

    // 审计留痕：一切放行 / 拒绝 / 回滚都写一行，append-only
    audit(entry) {
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
            fs.appendFileSync(path.join(this.dir, 'log.jsonl'), `${line}\n`);
        } catch (error) {
            console.error('[进化闸] 审计写入失败:', error.message);
        }
    }

    isEnabled() {
        return this.state.enabled === true;
    }

    setEnabled(flag) {
        this.state.enabled = !!flag;
        this.writeJson(this.gateFile(), this.state);
        this.audit({ event: 'toggle', enabled: this.state.enabled });
        return this.state.enabled;
    }

    // 对外：白名单模块 + 当前参数 + 是否已钉基线
    listModules() {
        return Object.keys(MODULES).map((id) => {
            const spec = MODULES[id];
            return {
                id,
                label: spec.label,
                bench: spec.bench,
                params: spec.params.slice(),
                metrics: spec.metrics.map((m) => m.key),
                hasBaseline: !!this.getBaseline(id)
            };
        });
    }

    // 钉基线：从一份评估报告里抽指标存起来，作为之后「不劣化」的参照
    setBaseline(moduleId, report, meta = {}) {
        const spec = MODULES[moduleId];
        if (!spec) return { success: false, error: `未登记模块 ${moduleId}` };
        const metrics = extractMetrics(report, spec.metrics);
        const missing = spec.metrics.filter((m) => !Number.isFinite(metrics[m.key])).map((m) => m.key);
        if (missing.length === spec.metrics.length) {
            return { success: false, error: '报告里没有可用的指标，无法作为基线', missing };
        }
        const data = {
            module: moduleId,
            metrics,
            missing,
            bench: spec.bench,
            source: meta.source || '',
            at: new Date().toISOString()
        };
        this.writeJson(this.baselineFile(moduleId), data);
        this.audit({ event: 'set-baseline', module: moduleId, missing });
        return { success: true, baseline: data };
    }

    getBaseline(moduleId) {
        const data = this.readJson(this.baselineFile(moduleId), null);
        return data && data.metrics ? data : null;
    }

    listProposals() {
        const data = this.readJson(this.proposalsFile(), { proposals: [] });
        return Array.isArray(data.proposals) ? data.proposals : [];
    }

    saveProposals(proposals) {
        this.writeJson(this.proposalsFile(), { proposals });
    }

    getProposal(id) {
        return this.listProposals().find((p) => p.id === id) || null;
    }

    updateProposal(id, patch) {
        const proposals = this.listProposals();
        const idx = proposals.findIndex((p) => p.id === id);
        if (idx < 0) return null;
        proposals[idx] = { ...proposals[idx], ...patch };
        this.saveProposals(proposals);
        return proposals[idx];
    }

    // 提案：登记在白名单里的模块才能提；参数必须属于该模块自己的登记项
    propose(input = {}) {
        const kind = input.kind;
        if (kind !== 'param' && kind !== 'tool') {
            return { success: false, error: 'kind 只能是 param 或 tool' };
        }
        const spec = MODULES[input.module];
        if (!spec) {
            return { success: false, error: `未登记模块 ${input.module}，不允许提自动进化提案` };
        }
        const changes = Array.isArray(input.changes) ? input.changes : [];
        if (kind === 'param') {
            if (!changes.length) return { success: false, error: '参数提案必须带 changes' };
            const bad = changes.find((c) => !c || !spec.params.includes(c.name));
            if (bad) {
                return { success: false, error: `参数 ${bad && bad.name} 不属于模块 ${input.module}` };
            }
        }
        const proposal = {
            id: makeId('prop'),
            kind,
            module: input.module,
            title: String(input.title || '').slice(0, 200),
            reason: String(input.reason || '').slice(0, 2000),
            changes,
            createdBy: String(input.createdBy || 'system'),
            status: 'open',
            verdict: '',
            runId: '',
            at: new Date().toISOString()
        };
        const proposals = this.listProposals();
        proposals.push(proposal);
        this.saveProposals(proposals);
        this.audit({ event: 'propose', id: proposal.id, kind, module: proposal.module });
        return { success: true, proposal };
    }

    // 不劣化判定：全部指标都过 → pass；有一条明确不过 → fail；有指标读不到 → inconclusive（不放行）
    judge(candidate, baseline, specs) {
        const failures = [];
        const missing = [];
        (specs || []).forEach((spec) => {
            const c = candidate[spec.key];
            const b = baseline[spec.key];
            if (!Number.isFinite(c) || !Number.isFinite(b)) {
                missing.push(spec.key);
                return;
            }
            const tol = Number.isFinite(spec.tolerance) ? spec.tolerance : 0;
            const ok = spec.direction === 'up' ? c >= b - tol : c <= b + tol;
            if (!ok) {
                failures.push({
                    key: spec.key,
                    direction: spec.direction,
                    tolerance: tol,
                    baseline: b,
                    candidate: c
                });
            }
        });
        let verdict = 'pass';
        if (failures.length) verdict = 'fail';
        else if (missing.length) verdict = 'inconclusive';
        return { verdict, failures, missing };
    }

    // 默认 runner：真跑该模块的 benchmark 脚本，跑完读它最新产出的报告
    defaultRunner({ spec, root }) {
        const script = path.join(root, 'scripts', spec.bench);
        if (!fs.existsSync(script)) {
            return { ok: false, error: `评估脚本不存在: ${spec.bench}` };
        }
        try {
            execFileSync(process.execPath, [script], {
                cwd: root,
                timeout: spec.timeoutMs || 30 * 60 * 1000,
                maxBuffer: 16 * 1024 * 1024,
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (error) {
            return { ok: false, error: `评估脚本执行失败: ${error.message}` };
        }
        const report = readNewestJson(path.join(root, spec.outDir));
        if (!report) return { ok: false, error: '评估跑完但没找到输出报告' };
        return { ok: true, report };
    }

    // 评估：隔离 run 目录 + 跑 benchmark + 抽指标 + 判定，全流程留痕
    async evaluate(id, options = {}) {
        const proposal = this.getProposal(id);
        if (!proposal) return { success: false, error: '提案不存在' };
        const spec = MODULES[proposal.module];
        if (!spec) return { success: false, error: `未登记模块 ${proposal.module}，不允许自动评估` };
        const baseline = this.getBaseline(proposal.module);
        if (!baseline) {
            return { success: false, error: `模块 ${proposal.module} 还没钉基线，先量基线再谈评估` };
        }

        const runner = options.runner || this.runner || this.defaultRunner.bind(this);
        const runId = makeId('run');
        fs.mkdirSync(path.join(this.dir, 'runs', runId), { recursive: true });

        let result;
        try {
            result = await runner({ module: proposal.module, proposal, spec, runId, root: this.root, params: this.params, gate: this });
        } catch (error) {
            result = { ok: false, error: error.message };
        }
        if (!result || !result.ok || !result.report) {
            const message = (result && result.error) || '评估失败';
            this.updateProposal(id, { status: 'error', error: message, runId });
            this.audit({ event: 'evaluate-error', id, runId, error: message });
            return { success: false, error: message, runId };
        }

        const candidate = extractMetrics(result.report, spec.metrics);
        const judged = this.judge(candidate, baseline.metrics, spec.metrics);
        const record = {
            runId,
            at: new Date().toISOString(),
            module: proposal.module,
            metrics: candidate,
            baseline: baseline.metrics,
            verdict: judged.verdict,
            failures: judged.failures,
            missing: judged.missing
        };
        this.writeJson(path.join(this.dir, 'runs', `${runId}.json`), record);
        this.updateProposal(id, {
            status: 'evaluated',
            verdict: judged.verdict,
            runId,
            metrics: candidate,
            failures: judged.failures,
            missing: judged.missing
        });
        this.audit({ event: 'evaluate', id, module: proposal.module, runId, verdict: judged.verdict });
        return {
            success: true,
            runId,
            verdict: judged.verdict,
            metrics: candidate,
            baseline: baseline.metrics,
            failures: judged.failures,
            missing: judged.missing
        };
    }

    // 生效：参数档过闸自动生效（先存回滚点）；工具档过闸也只落 pending 等人拍板
    promote(id) {
        const proposal = this.getProposal(id);
        if (!proposal) return { success: false, error: '提案不存在' };
        if (proposal.verdict !== 'pass') {
            return { success: false, error: `未通过评估（${proposal.verdict || '未评估'}），不予生效` };
        }
        const spec = MODULES[proposal.module];
        if (!spec) return { success: false, error: `未登记模块 ${proposal.module}，不予自动生效` };

        if (proposal.kind === 'tool') {
            const file = path.join(this.dir, 'pending', `${proposal.id}.json`);
            this.writeJson(file, { ...proposal, pendingAt: new Date().toISOString() });
            this.updateProposal(id, { status: 'pending-human' });
            this.audit({ event: 'promote-pending-human', id, module: proposal.module });
            return { success: true, pending: true, file };
        }

        const rollback = this.params.snapshot();
        const applied = [];
        const changes = Array.isArray(proposal.changes) ? proposal.changes : [];
        changes.forEach((change) => {
            if (!change || !spec.params.includes(change.name)) return;
            const value = this.params.set(change.name, change.to);
            if (value === null) return;
            applied.push({ name: change.name, from: change.from, to: value });
        });
        const patch = { status: 'promoted', applied, rollback, promotedAt: new Date().toISOString() };
        this.updateProposal(id, patch);
        this.audit({ event: 'promote-param', id, module: proposal.module, applied });
        return { success: true, applied, rollback };
    }

    // 回滚：把参数覆盖恢复到该提案生效前的快照
    rollback(id) {
        const proposal = this.getProposal(id);
        if (!proposal) return { success: false, error: '提案不存在' };
        if (!proposal.rollback) return { success: false, error: '该提案没有可回滚的快照' };
        this.params.restore(proposal.rollback);
        this.updateProposal(id, { status: 'rolled-back', rolledBackAt: new Date().toISOString() });
        this.audit({ event: 'rollback', id, module: proposal.module });
        return { success: true, params: this.params.list() };
    }

    // 状态总览：给面板/API 一口气看完
    status() {
        const proposals = this.listProposals();
        const byStatus = {};
        proposals.forEach((p) => {
            byStatus[p.status] = (byStatus[p.status] || 0) + 1;
        });
        return {
            enabled: this.isEnabled(),
            modules: this.listModules(),
            proposals: { total: proposals.length, byStatus },
            params: this.params.list()
        };
    }
}

module.exports = { EvolutionGate, MODULES, extractMetrics };
