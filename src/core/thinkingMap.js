// 思考（推理）模式字段映射：不同后端对「思考/思维链」的字段名与语义各不相同，
// 集中到这个小函数里，doubao / deepseek / qwen 三通道按各自规则产出 payload 片段。
// - deepseek：认 `thinking: { type: 'enabled' | 'disabled' }`，可开可关
// - qwen：always-on CoT，没有开关；`preserve_thinking: true` 让多轮之间保持推理链
//         （对 callWithTools 的自主循环至关重要，否则跨轮丢思考上下文）
// - 其他（比如豆包）：不认任何 thinking 字段，收到会直接 400，所以一律返回 null

function buildThinkingPayload(currentAPI, options = {}) {
    if (currentAPI === 'deepseek') {
        const mode = options.thinking;
        if (mode === 'enabled' || mode === 'disabled') {
            return { thinking: { type: mode } };
        }
        return null;
    }
    if (currentAPI === 'qwen') {
        // Qwen3.6-Plus 的推理链默认常开；显式要求保留时打开 preserve_thinking
        if (options.preserveThinking === true || options.thinking === 'enabled') {
            return { preserve_thinking: true };
        }
        return null;
    }
    return null;
}

module.exports = { buildThinkingPayload };
