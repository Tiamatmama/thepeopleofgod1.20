/**
 * 安全护栏入口：命令分级拦截 + 父本账本
 *
 * 明确边界：这里拦的是「经过本系统工具层」的动作；系统里别的程序不受控，
 * 内核层劫持更不在视野内。它是事后追溯和低级事故的筛子，不是沙箱边界。
 */

const { check, normalize, BLOCK_RULES, CONFIRM_RULES } = require('./commandGuard');
const { ProvenanceLedger } = require('./provenance');

const ledger = new ProvenanceLedger();

module.exports = {
  guardCommand: check,
  normalizeCommand: normalize,
  ledger,
  ProvenanceLedger,
  rules: { block: BLOCK_RULES, confirm: CONFIRM_RULES }
};
