#!/usr/bin/env node
// 🧬 进化诉求队列（给外部 agent / 主人用）
//
// 用法：
//   node scripts/evolution-queue.js list [status]
//   node scripts/evolution-queue.js show <id>
//   node scripts/evolution-queue.js approve <id> [备注]
//   node scripts/evolution-queue.js reject <id> [原因]
//   node scripts/evolution-queue.js claim <id> [agent 名]
//   node scripts/evolution-queue.js applied <id> [备注]
//   node scripts/evolution-queue.js failed <id> [原因]
//
// 只有 EVOLUTION_MODE=live 时，approve 才会把诉求排进外部队列；shadow 下批准只留记录。

const { EvolutionRequestStore } = require('../src/core/evolutionRequest');

const store = new EvolutionRequestStore();
const [command, id, ...rest] = process.argv.slice(2);
const note = rest.join(' ').trim();

function pad(value, width) {
  const text = String(value === undefined || value === null ? '' : value);
  return text.length >= width ? `${text.slice(0, width - 1)}…` : text.padEnd(width, ' ');
}

function printList(items) {
  if (!items.length) {
    console.log('（没有诉求）');
    return;
  }
  for (const item of items) {
    console.log(`${pad(item.id, 24)} ${pad(item.status, 10)} ${pad(item.scope, 8)} ${item.title}`);
    console.log(`  need: ${item.need}`);
    console.log(`  why : ${item.why}`);
    if (Array.isArray(item.evidence) && item.evidence.length) {
      console.log(`  evidence: ${item.evidence.join(' / ')}`);
    }
    console.log(`  queued=${item.queued === true} createdAt=${new Date(item.createdAt).toLocaleString('zh-CN')}`);
  }
}

function report(result) {
  if (!result || result.success === false) {
    console.error(`失败：${(result && result.error) || '未知错误'}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

switch (command) {
  case 'list': {
    const status = id || '';
    console.log(`EVOLUTION_MODE=${store.mode()}（队列里的条目：${store.queue().length}）`);
    printList(store.list({ status }));
    break;
  }
  case 'show': {
    const record = store.get(id);
    if (!record) {
      console.error('诉求不存在');
      process.exitCode = 1;
      break;
    }
    console.log(JSON.stringify(record, null, 2));
    break;
  }
  case 'approve': {
    if (store.mode() !== 'live') {
      console.log(`提示：当前是 ${store.mode()} 模式，批准只留记录、不会排期。要排期请用 EVOLUTION_MODE=live 再执行。`);
    }
    report(store.approve(id, { by: 'owner', note }));
    break;
  }
  case 'reject':
    report(store.reject(id, { by: 'owner', reason: note }));
    break;
  case 'claim':
    report(store.claim(id, { agent: note || 'external' }));
    break;
  case 'applied':
    report(store.applied(id, { note }));
    break;
  case 'failed':
    report(store.failed(id, { note }));
    break;
  default:
    console.log('用法：node scripts/evolution-queue.js <list|show|approve|reject|claim|applied|failed> [id] [备注]');
    process.exitCode = command ? 2 : 0;
}
