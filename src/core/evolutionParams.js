/**
 * 进化参数外置层（沙箱进化闸 · 参数档）
 *
 * 背景：原本「可进化参数」全是写死在 src 里的 const（如 emotion.js 的
 * INTERNAL_FILTER_GAIN）。若闸门直接改这些常量，等于自动改源码。
 * 因此照抄 globalConfig.js 的既有模式，把参数抽成一层 data 覆盖层：
 *   默认值仍留在代码里（PARAM_SPECS[].default），运行时先查
 *   data/evolution/params.json，有覆盖就用覆盖值。
 *
 * 于是「参数过闸自动生效」= 写一个 data JSON，一个字的源码都不用动；
 * 「回滚」= 删掉覆盖项，回到代码默认值。
 *
 * 只认登记在 PARAM_SPECS 里的名字；未登记的一律忽略——杜绝瞎改。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync } = require('../storage/atomicWrite');

// 参数登记表：name → { module, default, min, max, label, description }
// module 用于面板分组与闸门白名单；default 必须与源码常量保持一致。
const PARAM_SPECS = {
    internalFilterGain: {
        module: 'emotion',
        default: 0.08,
        min: 0.01,
        max: 0.4,
        label: '内部信号滤波步长',
        description: '角色自身行为回流给情绪带来的涟漪强度，越大越敏感'
    },
    internalIntensityCap: {
        module: 'emotion',
        default: 0.35,
        min: 0.05,
        max: 1,
        label: '内部信号强度上限',
        description: '单次内部信号能推动情绪的最大强度'
    }
};

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

class EvolutionParams {
    constructor(options = {}) {
        const root = (options && options.root) || path.join(__dirname, '..', '..');
        this.file = path.join(root, 'data', 'evolution', 'params.json');
        this.overrides = this.loadOverrides();
    }

    // 读覆盖层：越界值夹到边界，非法值/未登记名字一律丢弃
    loadOverrides() {
        try {
            if (!fs.existsSync(this.file)) return {};
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            const values = (raw && raw.params) || {};
            const clean = {};
            Object.keys(values).forEach((name) => {
                const spec = PARAM_SPECS[name];
                if (!spec) return;
                const num = Number(values[name]);
                if (!Number.isFinite(num)) return;
                clean[name] = clamp(num, spec.min, spec.max);
            });
            return clean;
        } catch (error) {
            console.error('[进化参数] 读取失败，改用代码默认值:', error.message);
            return {};
        }
    }

    // 取当前生效值：登记在册才认，未登记返回 null
    get(name) {
        const spec = PARAM_SPECS[name];
        if (!spec) return null;
        if (Object.prototype.hasOwnProperty.call(this.overrides, name)) {
            return this.overrides[name];
        }
        return spec.default;
    }

    has(name) {
        return !!PARAM_SPECS[name];
    }

    // 写覆盖值：越界夹到边界；未登记或非法值返回 null（不写）
    set(name, value) {
        const spec = PARAM_SPECS[name];
        if (!spec) return null;
        const num = Number(value);
        if (!Number.isFinite(num)) return null;
        this.overrides[name] = clamp(num, spec.min, spec.max);
        this.persist();
        return this.overrides[name];
    }

    // 抹掉某个参数（或全部）的覆盖，回到代码默认值
    reset(name) {
        if (name) {
            delete this.overrides[name];
        } else {
            this.overrides = {};
        }
        this.persist();
        return this.list();
    }

    // 快照 / 回滚：给闸门做「改坏了能退回去」用
    snapshot() {
        return { params: { ...this.overrides } };
    }

    restore(snapshot) {
        const incoming = (snapshot && snapshot.params) || {};
        this.overrides = {};
        Object.keys(incoming).forEach((name) => {
            const spec = PARAM_SPECS[name];
            const num = Number(incoming[name]);
            if (!spec || !Number.isFinite(num)) return;
            this.overrides[name] = clamp(num, spec.min, spec.max);
        });
        this.persist();
        return this.list();
    }

    // 对外清单：当前值 / 默认值 / 边界 / 是否被覆盖，供面板与闸门展示
    list() {
        return Object.keys(PARAM_SPECS).map((name) => {
            const spec = PARAM_SPECS[name];
            const overridden = Object.prototype.hasOwnProperty.call(this.overrides, name);
            return {
                name,
                module: spec.module,
                label: spec.label,
                description: spec.description,
                min: spec.min,
                max: spec.max,
                default: spec.default,
                value: overridden ? this.overrides[name] : spec.default,
                overridden
            };
        });
    }

    persist() {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            writeJsonAtomicSync(this.file, { params: { ...this.overrides } });
        } catch (error) {
            console.error('[进化参数] 保存失败:', error.message);
        }
    }
}

// 进程内单例：消费点（如 emotion.js）与闸门共用同一个实例，
// 于是闸门 promote 后消费点立刻读到新值（跨进程需重启，见定稿 §7）。
const instance = new EvolutionParams();

module.exports = { EvolutionParams, PARAM_SPECS, instance };
