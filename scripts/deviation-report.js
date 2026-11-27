'use strict';

// 🧭 稳定偏移·观测汇总（只读）
//
// 用途：跑几天之后回答「这套判据到底判出了什么」——每轴的判定分布、盲区比例、判据成立了几条。
// 只读 data/deviation-shadow/*.jsonl，不改档、不写回、不触碰提示词。
//
// 用法：
//   node scripts/deviation-report.js                      # 最近 30 天，人类可读
//   node scripts/deviation-report.js --days 7 --user u1   # 指定窗口与用户
//   node scripts/deviation-report.js --json               # 机器可读
//   node scripts/deviation-report.js --dir <目录>          # 指定观测目录（自测/迁移用）
const deviation = require('../src/core/deviation');
const shadow = require('../src/core/deviationShadow');

const DAY_MS = 24 * 60 * 60 * 1000;
const READ_LIMIT = 2000;

// 只认白名单参数，避免脚本被误当成通用工具乱跑
function parseArgs(argv = []) {
    const args = { days: 30, user: null, dir: null, json: false };
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        if (flag === '--json') {
            args.json = true;
        } else if (flag === '--days') {
            const value = Number(argv[++i]);
            if (Number.isFinite(value) && value > 0) args.days = value;
        } else if (flag === '--user') {
            const value = String(argv[++i] || '').trim();
            if (value) args.user = value;
        } else if (flag === '--dir') {
            const value = String(argv[++i] || '').trim();
            if (value) args.dir = value;
        }
    }
    return args;
}

// 判据分布：五种判定各多少条轴（按当前窗口重算，不看历史 verdict 记录）
function countVerdicts(report) {
    const counts = {};
    deviation.DEVIATION_VERDICTS.forEach(verdict => { counts[verdict] = 0; });
    (Array.isArray(report) ? report : []).forEach(item => {
        if (!item || !item.verdict) return;
        counts[item.verdict] = (counts[item.verdict] || 0) + 1;
    });
    return counts;
}

// 汇总：当前窗口的轴报告 + 历史判据记录条数 + 盲区总量
function buildReport({ samples = [], verdicts = [], now = Date.now(), days = 30 } = {}) {
    const windowMs = deviation.DEVIATION_DEFAULTS.windowMs;
    const report = deviation.detectStableDeviations(samples, { now, windowMs });
    const blindOccurrences = report.reduce((sum, item) => sum + (item.blind ? item.blind.occurrences : 0), 0);
    const blindGaveIn = report.reduce((sum, item) => sum + (item.blind ? item.blind.gaveIn : 0), 0);
    return {
        days,
        samples: samples.length,
        verdictRecords: (Array.isArray(verdicts) ? verdicts : []).length,
        counts: countVerdicts(report),
        blind: { occurrences: blindOccurrences, gaveIn: blindGaveIn },
        report
    };
}

function formatReport(summary) {
    const lines = [];
    const counts = summary.counts || {};
    const distribution = deviation.DEVIATION_VERDICTS
        .map(verdict => `${verdict} ${counts[verdict] || 0}`)
        .join(' / ');
    lines.push(`稳定偏移观测报告（最近 ${summary.days} 天 · 样本 ${summary.samples} 条 · 判据记录 ${summary.verdictRecords} 条）`);
    lines.push(`判定分布：${distribution}`);
    lines.push(`盲区核对：滑回 ${summary.blind.gaveIn}/${summary.blind.occurrences} 次（这些轮次尺子没亮给她看）`);
    if (!summary.report || summary.report.length === 0) {
        lines.push('（窗口内没有可判的轴：样本还没攒够，继续跑）');
        return lines.join('\n');
    }
    summary.report.forEach(item => {
        lines.push(`- ${deviation.summarizeDeviation(item)}`);
    });
    return lines.join('\n');
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const now = Date.now();
    const since = now - args.days * DAY_MS;
    const base = { since, limit: READ_LIMIT };
    if (args.dir) base.dir = args.dir;
    if (args.user) base.userId = args.user;
    const samples = shadow.readDeviationSamples({ ...base, kind: 'sample' });
    const verdicts = shadow.readDeviationSamples({ ...base, kind: 'verdict' });
    const summary = buildReport({ samples, verdicts, now, days: args.days });
    if (args.json) {
        console.log(JSON.stringify(summary, null, 2));
    } else {
        console.log(formatReport(summary));
    }
}

if (require.main === module) {
    main();
}

module.exports = { parseArgs, countVerdicts, buildReport, formatReport };
