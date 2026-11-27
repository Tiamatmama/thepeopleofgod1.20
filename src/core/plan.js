'use strict';

// 计划（DAG / 里程碑 / 子任务）
// 背景：只有一个 goal 时，长跑只能「整轮通过才提交」，轮数耗尽就全部作废。
// 这里把 goal 拆成有依赖的子任务节点：每个节点独立验收、通过即提交检查点，
// 一个 run 没跑完的节点由下一次 run 接着推进（进度在 append-only JSONL 里）。
// 本模块只做纯函数：归一化、拓扑排序、进度判定、提示词渲染。
// 具体的判据归一化（webCheck/healthCheck/deploy/stages）由调用方注入，避免与 codingLoop 循环依赖。

const MAX_NODES = 50;
const MAX_REQUIRES = 50;
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_TITLE = 200;
const MAX_DETAIL = 2000;

function clip(value, max) {
    return String(value == null ? '' : value)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .slice(0, max);
}

// fail-closed：结构、id、依赖关系、环全部校验，非法声明直接抛。
// options.normalizeAcceptance(raw, where) 负责把节点自带的判据归一化（可为空）。
function normalizePlan(value, options = {}) {
    if (value == null) return null;
    const src = (typeof value === 'object' && !Array.isArray(value)) ? value : { nodes: value };
    const rawNodes = src.nodes;
    if (!Array.isArray(rawNodes)) throw new Error('plan 必须是子任务数组或含 nodes 数组的对象');
    if (!rawNodes.length) throw new Error('plan.nodes 不能为空');
    if (rawNodes.length > MAX_NODES) throw new Error(`plan 最多 ${MAX_NODES} 个节点`);
    const normalizeAcceptance = typeof options.normalizeAcceptance === 'function'
        ? options.normalizeAcceptance
        : null;

    const nodes = [];
    const seen = new Set();
    rawNodes.forEach((raw, i) => {
        const where = `plan.nodes[${i}]`;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where} 必须是对象`);
        const id = String(raw.id || '').trim();
        if (!NODE_ID_RE.test(id)) throw new Error(`${where}.id 只能包含字母、数字、下划线和连字符，且不超过 64 字符`);
        if (seen.has(id)) throw new Error(`${where}.id 重复: ${id}`);
        seen.add(id);
        const title = String(raw.title || '').trim();
        if (!title) throw new Error(`${where}.title 不能为空`);
        if (title.length > MAX_TITLE) throw new Error(`${where}.title 最多 ${MAX_TITLE} 字符`);
        const detail = String(raw.detail || '').trim();
        if (detail.length > MAX_DETAIL) throw new Error(`${where}.detail 最多 ${MAX_DETAIL} 字符`);
        let requires = [];
        if (raw.requires != null) {
            if (!Array.isArray(raw.requires)) throw new Error(`${where}.requires 必须是数组`);
            if (raw.requires.length > MAX_REQUIRES) throw new Error(`${where}.requires 最多 ${MAX_REQUIRES} 个`);
            requires = raw.requires.map((dep, j) => {
                const text = String(dep == null ? '' : dep).trim();
                if (!text) throw new Error(`${where}.requires[${j}] 不能为空`);
                return text;
            });
        }
        let acceptance = null;
        if (raw.acceptance != null) {
            if (!normalizeAcceptance) throw new Error(`${where}.acceptance 需要由闭环归一化`);
            acceptance = normalizeAcceptance(raw.acceptance, where);
            if (!acceptance || !Object.keys(acceptance).length) {
                throw new Error(`${where}.acceptance 至少要声明一个判据`);
            }
        }
        nodes.push({ id, title, detail, requires, acceptance });
    });

    const byId = new Map(nodes.map(node => [node.id, node]));
    nodes.forEach(node => {
        node.requires.forEach(dep => {
            if (dep === node.id) throw new Error(`子任务 ${node.id} 不能依赖自己`);
            if (!byId.has(dep)) throw new Error(`子任务 ${node.id} 依赖了不存在的子任务: ${dep}`);
        });
    });
    // Kahn 拓扑排序：排不完即有环
    const indegree = new Map(nodes.map(node => [node.id, node.requires.length]));
    const dependents = new Map(nodes.map(node => [node.id, []]));
    nodes.forEach(node => node.requires.forEach(dep => dependents.get(dep).push(node.id)));
    const queue = nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id);
    let visited = 0;
    while (queue.length) {
        const id = queue.shift();
        visited++;
        dependents.get(id).forEach(next => {
            indegree.set(next, indegree.get(next) - 1);
            if (indegree.get(next) === 0) queue.push(next);
        });
    }
    if (visited !== nodes.length) throw new Error('plan 存在循环依赖');

    return { nodes };
}

// 稳定拓扑序：同层保持声明顺序（依赖已就绪的节点按声明顺序依次取）。
function orderPlanNodes(plan) {
    const list = Array.isArray(plan) ? plan : ((plan && Array.isArray(plan.nodes)) ? plan.nodes : []);
    const done = new Set();
    const ordered = [];
    while (ordered.length < list.length) {
        let progressed = false;
        for (const node of list) {
            if (done.has(node.id)) continue;
            if (!node.requires.every(dep => done.has(dep))) continue;
            ordered.push(node);
            done.add(node.id);
            progressed = true;
        }
        // normalizePlan 已排除环；这里只是防御性兜底，避免异常输入造成死循环。
        if (!progressed) break;
    }
    return ordered;
}

// 进度判定：done / ready / blocked / next / complete。
function planState(plan, doneIds = []) {
    const nodes = orderPlanNodes(plan);
    const done = new Set((Array.isArray(doneIds) ? doneIds : []).map(id => String(id || '')).filter(Boolean));
    const ready = [];
    const blocked = [];
    nodes.forEach(node => {
        if (done.has(node.id)) return;
        if (node.requires.every(dep => done.has(dep))) ready.push(node.id);
        else blocked.push(node.id);
    });
    const doneList = nodes.filter(node => done.has(node.id)).map(node => node.id);
    return {
        done: doneList,
        ready,
        blocked,
        next: nodes.find(node => node.id === ready[0]) || null,
        complete: nodes.length > 0 && doneList.length === nodes.length
    };
}

function selectNextNode(plan, doneIds = []) {
    return planState(plan, doneIds).next;
}

// 提示词里的只读路线图。已完成的打 [x]，当前子任务打 [>]。
function describePlan(plan, doneIds = [], activeId = '') {
    const nodes = orderPlanNodes(plan);
    const done = new Set((Array.isArray(doneIds) ? doneIds : []).map(id => String(id || '')).filter(Boolean));
    return nodes.map((node, i) => {
        const mark = done.has(node.id) ? 'x' : (node.id === activeId ? '>' : ' ');
        const deps = node.requires.length
            ? `（需先完成：${node.requires.map(dep => clip(dep, 64)).join('、')}）`
            : '';
        const acceptance = node.acceptance ? '〔独立验收〕' : '';
        return `- [${mark}] ${i + 1}. [${clip(node.id, 64)}] ${clip(node.title, MAX_TITLE)}${deps}${acceptance}`;
    }).join('\n');
}

// 节点的有效判据：节点自己声明了就用节点的，没声明就继承 run 级（逐字段继承）。
function effectiveCriteria(ctx, node) {
    const src = (ctx && typeof ctx === 'object') ? ctx : {};
    const acc = (node && node.acceptance) || {};
    return {
        passCommand: acc.passCommand != null ? acc.passCommand : String(src.passCommand || ''),
        webCheck: acc.webCheck != null ? acc.webCheck : (src.webCheck || null),
        healthCheck: acc.healthCheck != null ? acc.healthCheck : (src.healthCheck || null),
        deploy: acc.deploy != null ? acc.deploy : (src.deploy || null),
        stages: acc.stages != null ? acc.stages : (Array.isArray(src.stages) ? src.stages : [])
    };
}

module.exports = {
    MAX_NODES,
    NODE_ID_RE,
    normalizePlan,
    orderPlanNodes,
    planState,
    selectNextNode,
    describePlan,
    effectiveCriteria
};
