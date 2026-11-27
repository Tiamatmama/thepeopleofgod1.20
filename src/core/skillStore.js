'use strict';

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const SkillLibrary = require('./skills');
const { writeFileAtomicSync } = require('../storage/atomicWrite');

// 本地技能市场：在 SkillLibrary（只读：扫描 / 读取）之上补齐「写」的能力。
//   - 新建 / 覆盖技能（原子写 SKILL.md）
//   - 删除技能目录（realpath 校验，只允许删 skills/ 下一级）
//   - 导出 / 导入 .skill.zip（逐条校验，防 zip-slip / 符号链接 / 解压炸弹）
// 对外统一用 Error.code 表达失败原因，路由层据此映射 HTTP 状态码。

const SKILL_FILE = 'SKILL.md';
const NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;
const MAX_ENTRIES = 200;
const MAX_UNZIPPED_BYTES = 5 * 1024 * 1024;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// 目录树的文件数与总字节数（用于列表里的体积展示）
function statTree(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (abs) => {
    let items;
    try {
      items = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(abs, item.name);
      if (item.isDirectory()) {
        walk(full);
      } else if (item.isFile()) {
        files += 1;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          // 拿不到大小就按 0 计，不影响列表
        }
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

// zip 条目是否带符号链接的 unix mode（zip 里没有真链接，只有高 16 位标记）
function isSymlinkEntry(entry) {
  const attr = Number(entry && entry.attr) || 0;
  const mode = (attr >>> 16) & 0xFFFF;
  return (mode & 0xF000) === 0xA000;
}

class SkillStore extends SkillLibrary {
  validateName(name) {
    const value = String(name == null ? '' : name).trim();
    if (!NAME_PATTERN.test(value)) {
      throw fail('INVALID_NAME', '技能名只能是小写字母/数字开头，且只含小写字母、数字、- 和 _，长度 1-64');
    }
    return value;
  }

  // 在 skills 根内拼路径，并做一次词法层面的越界检查
  resolveInside(...segments) {
    const root = path.resolve(this.dir);
    const target = path.resolve(root, ...segments);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw fail('FORBIDDEN', '路径越出 skills 目录');
    }
    return target;
  }

  // 合并 SkillLibrary 的扫描结果，补上文件数 / 体积 / 更新时间
  list() {
    return this.scan()
      .map((skill) => {
        const dir = path.join(this.dir, skill.dirName);
        const { files, bytes } = statTree(dir);
        let updatedAt = null;
        try {
          updatedAt = fs.statSync(skill.file).mtime.toISOString();
        } catch {
          // 文件刚被删除时忽略
        }
        return {
          name: skill.name,
          description: skill.description,
          files,
          bytes,
          updatedAt
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  }

  detail(name) {
    const skill = this.find(name);
    if (!skill) return null;
    let body;
    try {
      body = this.parseFrontmatter(fs.readFileSync(skill.file, 'utf8')).body;
    } catch {
      return null;
    }
    const base = path.dirname(skill.file);
    const resources = [];
    const walk = (abs, relDir) => {
      let items;
      try {
        items = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        const rel = relDir ? `${relDir}/${item.name}` : item.name;
        const full = path.join(abs, item.name);
        if (item.isDirectory()) {
          walk(full, rel);
        } else if (item.isFile() && rel !== SKILL_FILE) {
          let bytes = 0;
          try {
            bytes = fs.statSync(full).size;
          } catch {
            // 忽略单文件大小读取失败
          }
          resources.push({ path: rel, bytes });
        }
      }
    };
    walk(base, '');
    resources.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    return {
      name: skill.name,
      description: skill.description,
      body,
      resources
    };
  }

  serialize(name, description, body) {
    // frontmatter 是一行一条的 key: value，值里的换行必须压平，否则正文会被截断
    const desc = String(description == null ? '' : description)
      .replace(/\s*[\r\n]+\s*/g, ' ')
      .trim();
    const text = String(body == null ? '' : body).replace(/\r\n/g, '\n').trim();
    return `---\nname: ${name}\ndescription: ${desc}\n---\n\n${text}\n`;
  }

  // 新建或覆盖技能：只写 SKILL.md，保留已有附加资源
  save({ name, description = '', body = '' } = {}, options = {}) {
    const skillName = this.validateName(name);
    const skillDir = this.resolveInside(skillName);
    const file = path.join(skillDir, SKILL_FILE);
    const exists = fs.existsSync(skillDir);
    if (exists && !options.overwrite) {
      throw fail('EXISTS', `技能已存在: ${skillName}`);
    }
    fs.mkdirSync(skillDir, { recursive: true });
    writeFileAtomicSync(file, this.serialize(skillName, description, body));
    return this.detail(skillName);
  }

  remove(name) {
    const skillName = this.validateName(name);
    const target = this.resolveInside(skillName);
    if (!fs.existsSync(target)) return false;
    let rootReal;
    let targetReal;
    try {
      rootReal = fs.realpathSync(path.resolve(this.dir));
      targetReal = fs.realpathSync(target);
    } catch {
      throw fail('FORBIDDEN', '无法解析技能目录的真实路径');
    }
    if (targetReal === rootReal || !targetReal.startsWith(rootReal + path.sep)) {
      throw fail('FORBIDDEN', '路径越出 skills 目录');
    }
    fs.rmSync(targetReal, { recursive: true, force: true });
    return true;
  }

  exportZip(name) {
    const skill = this.find(name);
    if (!skill) throw fail('NOT_FOUND', `没有这个技能: ${name}`);
    const base = path.dirname(skill.file);
    // zip 内根目录用校验过的名字；frontmatter 名字不合规时退回目录名
    const rootName = NAME_PATTERN.test(skill.name) ? skill.name : skill.dirName;
    const zip = new AdmZip();
    const walk = (abs, relDir) => {
      let items;
      try {
        items = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        const full = path.join(abs, item.name);
        const rel = relDir ? `${relDir}/${item.name}` : item.name;
        if (item.isDirectory()) {
          walk(full, rel);
        } else if (item.isFile()) {
          zip.addFile(`${rootName}/${rel}`, fs.readFileSync(full));
        }
      }
    };
    walk(base, '');
    return zip.toBuffer();
  }

  importZip(buffer, options = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw fail('INVALID_ZIP', 'zip 内容为空');
    }
    let entries;
    try {
      const zip = new AdmZip(buffer);
      entries = zip.getEntries();
    } catch {
      throw fail('INVALID_ZIP', '不是有效的 zip 文件');
    }
    if (!entries.length) throw fail('INVALID_ZIP', 'zip 里没有任何文件');
    if (entries.length > MAX_ENTRIES) {
      throw fail('TOO_MANY_ENTRIES', `zip 条目过多（上限 ${MAX_ENTRIES}）`);
    }

    const files = [];
    let totalBytes = 0;
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const raw = String(entry.entryName || '');
      const normalized = raw.replace(/\\/g, '/');
      if (!raw || raw.includes('\0')) {
        throw fail('UNSAFE_ENTRY', '条目名非法');
      }
      if (isSymlinkEntry(entry)) {
        throw fail('UNSAFE_ENTRY', `含符号链接条目: ${raw}`);
      }
      if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
        throw fail('UNSAFE_ENTRY', `条目使用了绝对路径: ${raw}`);
      }
      const segments = normalized.split('/').filter((segment) => segment && segment !== '.');
      if (segments.some((segment) => segment === '..')) {
        throw fail('UNSAFE_ENTRY', `条目包含 .. 路径: ${raw}`);
      }
      if (!segments.length) continue;
      totalBytes += Number(entry.header && entry.header.size) || 0;
      if (totalBytes > MAX_UNZIPPED_BYTES) {
        throw fail('TOO_LARGE', '解压后总大小超过 5MB 上限');
      }
      files.push({ entry, segments });
    }

    // 找最浅的 SKILL.md 作为技能入口
    const skillEntries = files
      .filter((file) => file.segments[file.segments.length - 1] === SKILL_FILE)
      .sort((a, b) => a.segments.length - b.segments.length);
    if (!skillEntries.length) {
      throw fail('NO_SKILL_FILE', 'zip 里必须包含 SKILL.md');
    }
    const entryPoint = skillEntries[0];
    const prefix = entryPoint.segments.slice(0, -1);

    let meta;
    try {
      meta = this.parseFrontmatter(entryPoint.entry.getData().toString('utf8')).meta;
    } catch {
      throw fail('INVALID_ZIP', 'SKILL.md 无法读取');
    }
    // 名字优先取 frontmatter，其次 zip 顶层目录名
    const candidate = String(meta.name || (prefix.length ? prefix[0] : '')).trim().toLowerCase();
    const skillName = this.validateName(candidate);

    const rootSegments = prefix;
    const planned = [];
    for (const file of files) {
      const inside = rootSegments.every((segment, i) => file.segments[i] === segment);
      if (!inside) {
        throw fail('UNSAFE_ENTRY', `条目不在技能目录内: ${file.entry.entryName}`);
      }
      const rel = file.segments.slice(rootSegments.length).join('/');
      if (!rel) continue;
      // 逐层校验最终落盘位置必须在 skills 根内
      planned.push({ entry: file.entry, dest: this.resolveInside(skillName, ...rel.split('/')) });
    }

    const targetDir = this.resolveInside(skillName);
    const existed = fs.existsSync(targetDir);
    if (existed && !options.overwrite) {
      throw fail('EXISTS', `技能已存在: ${skillName}`);
    }
    if (existed) {
      const rootReal = fs.realpathSync(path.resolve(this.dir));
      const targetReal = fs.realpathSync(targetDir);
      if (targetReal === rootReal || !targetReal.startsWith(rootReal + path.sep)) {
        throw fail('FORBIDDEN', '路径越出 skills 目录');
      }
      fs.rmSync(targetReal, { recursive: true, force: true });
    }

    fs.mkdirSync(targetDir, { recursive: true });
    for (const item of planned) {
      fs.mkdirSync(path.dirname(item.dest), { recursive: true });
      fs.writeFileSync(item.dest, item.entry.getData());
    }
    return { name: skillName, files: planned.length };
  }
}

module.exports = SkillStore;
