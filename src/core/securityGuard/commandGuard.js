/**
 * 危险命令闸门（纯函数，无副作用）
 *
 * 定位：只拦经过我们工具层的命令（run_command / run_python / run_node）。
 * 系统里别的程序直接执行同样的命令，这里管不到——真正的执行边界仍是沙箱与审批。
 *
 * 分级：
 *   block   —— 不可逆的数据/系统破坏、刷固件、超频改电压这类「一步就救不回来」的
 *   confirm —— 可恢复但破坏性大，交给上层审批（本层只标记，不替用户做决定）
 *   ok      —— 放行
 */

// 全小写、压缩空白后再匹配，避免大小写和多余空格绕过
function normalize(command) {
  return String(command || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

const BLOCK_RULES = [
  {
    id: 'disk-partition',
    name: '磁盘分区/格式化',
    pattern: /\b(diskpart|wipefs|blkdiscard)\b|\bformat\s+[a-z]:|\bmkfs(\.\w+)?\b|\b(fdisk|parted|gdisk)\b.*\b(mklabel|rm|delete)\b/,
    reason: '会直接清空分区或分区表'
  },
  {
    id: 'raw-disk-write',
    name: '裸设备写入',
    pattern: /\bdd\b[^\n]*\bof=\/dev\/|\bdd\b[^\n]*\bof=\\\\\.\\physicaldrive/,
    reason: '直接写裸设备会毁掉分区与数据'
  },
  {
    id: 'boot-config',
    name: '引导配置破坏',
    pattern: /\bbcdedit\b|\bbootrec\b[^\n]*\/fixmbr/,
    reason: '改引导配置可能导致系统无法启动'
  },
  {
    id: 'shadow-copy',
    name: '删除卷影副本',
    pattern: /\bvssadmin\b[^\n]*\bdelete\b/,
    reason: '删掉卷影副本会失去系统还原点'
  },
  {
    id: 'root-delete',
    name: '删根目录',
    pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|~|\$home)(\s|$)|\b(del|erase)\s+(\/[a-z]\s+)+[a-z]:\\?\s*$|\brd\s+(\/[a-z]\s+)+[a-z]:\\?\s*$/,
    reason: '递归删除根目录不可恢复'
  },
  {
    id: 'wipe',
    name: '数据擦除工具',
    pattern: /\bsdelete\b|\bcipher\s+\/w\b|\bshred\b/,
    reason: '擦除类工具会不可逆地销毁数据'
  },
  {
    id: 'firmware-flash',
    name: '刷写固件/BIOS',
    pattern: /\b(nvflash|amiflash|afuwin|afudos|flashrom|winflash)\b/,
    reason: '刷写固件失败会让设备变砖'
  },
  {
    id: 'hardware-tune',
    name: '超频/改电压',
    pattern: /\b(msi ?afterburner|afterburner|intel ?xtu|throttlestop|nvflash)\b|\bnvidia-smi\s+[^\n]*-lgc\b/,
    reason: '错误的电压/频率设置可能损坏硬件'
  },
  {
    id: 'registry-system',
    name: '删除系统注册表',
    pattern: /\breg\s+delete\s+(hklm|hkey_local_machine)\\(system|software|sam|security)\b/,
    reason: '删系统注册表键会直接破坏系统'
  },
  {
    id: 'fork-bomb',
    name: '进程炸弹',
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: '会瞬间耗尽进程/内存资源'
  }
];

const CONFIRM_RULES = [
  {
    id: 'power',
    name: '关机/重启',
    pattern: /\bshutdown\b[^\n]*(\/s|\/r|\/p)\b|\breboot\b|\bhalt\b/,
    reason: '会中断当前所有任务'
  },
  {
    id: 'registry-delete',
    name: '删除注册表项',
    pattern: /\breg\s+delete\b/,
    reason: '注册表删除影响面大'
  },
  {
    id: 'encoded-shell',
    name: '编码后的脚本',
    pattern: /\bpowershell\b[^\n]*\s-(enc|encodedcommand)\b|\bpwsh\b[^\n]*\s-(enc|encodedcommand)\b/,
    reason: '编码命令无法人工核对内容'
  },
  {
    id: 'pipe-to-shell',
    name: '下载后直接执行',
    pattern: /\b(curl|wget|irm|invoke-webrequest)\b[^\n]*\|\s*(sh|bash|zsh|powershell|iex|node|python)\b/,
    reason: '远程内容未经审查就执行，是投毒常用手法'
  },
  {
    id: 'force-push',
    name: '强制推送',
    pattern: /\bgit\s+push\b[^\n]*\s(--force|-f)\b/,
    reason: '会覆盖远端历史'
  },
  {
    id: 'chown-root',
    name: '全盘改权限',
    pattern: /\b(chmod|chown)\b\s+-r\b[^\n]*\s(\/|\/etc|\/usr|\/var)(\s|$)/,
    reason: '全盘改权限会让系统服务失效'
  }
];

function matchRules(command, rules, level) {
  const hits = [];
  for (const rule of rules) {
    if (rule.pattern.test(command)) {
      hits.push({ id: rule.id, name: rule.name, reason: rule.reason, level });
    }
  }
  return hits;
}

/**
 * @param {string} command 原始命令
 * @returns {{ level: 'ok'|'confirm'|'block', allowed: boolean, reason?: string, hits: Array }}
 */
function check(command) {
  const normalized = normalize(command);
  if (!normalized) return { level: 'ok', allowed: true, hits: [] };

  const blocked = matchRules(normalized, BLOCK_RULES, 'block');
  if (blocked.length) {
    return {
      level: 'block',
      allowed: false,
      reason: blocked.map((item) => `${item.name}：${item.reason}`).join('；'),
      hits: blocked
    };
  }

  const confirm = matchRules(normalized, CONFIRM_RULES, 'confirm');
  if (confirm.length) {
    return {
      level: 'confirm',
      allowed: true,
      reason: confirm.map((item) => `${item.name}：${item.reason}`).join('；'),
      hits: confirm
    };
  }

  return { level: 'ok', allowed: true, hits: [] };
}

module.exports = { check, normalize, BLOCK_RULES, CONFIRM_RULES };
