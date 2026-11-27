const fs = require('fs');
const path = require('path');

// 技能库（可插拔技能包）😀
// 借鉴 Claude Agent Skills 的三级渐进披露：
//   Level 1 = 常驻元数据（name + description），只用来判断「该不该触发」，很省 token；
//   Level 2 = SKILL.md 正文指令，触发时用 load() 才读进上下文；
//   Level 3 = 技能目录里的附加资源（模板 / 参考 / 脚本），用 readResource() 按需读。
// 目录约定：skills/<技能名>/SKILL.md，文件头是 --- 包起来的 YAML frontmatter（name / description）。

const SKILL_FILE = 'SKILL.md';

class SkillLibrary {
  constructor(projectRoot, dirName = 'skills') {
    this.projectRoot = projectRoot;
    this.dir = path.join(projectRoot, dirName);
  }

  // 解析文件头的 frontmatter：失败就原样返回正文，不抛错
  parseFrontmatter(text = '') {
    const src = String(text);
    const match = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/.exec(src);
    if (!match) {
      return { meta: {}, body: src.trim() };
    }
    const meta = {};
    match[1].split(/\r?\n/).forEach((line) => {
      const idx = line.indexOf(':');
      if (idx <= 0) return;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      // 去掉两端引号，方便 description 里写冒号
      value = value.replace(/^["']|["']$/g, '');
      if (key) meta[key] = value;
    });
    return { meta, body: src.slice(match[0].length).trim() };
  }

  // 扫 skills/ 下所有含 SKILL.md 的子目录，返回完整技能列表（含 Level 1 元数据）
  scan() {
    let entries = [];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch (error) {
      return []; // 没有 skills/ 目录就是空库，不报错
    }
    const skills = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(this.dir, entry.name, SKILL_FILE);
      if (!fs.existsSync(file)) continue;
      let meta = {};
      let parseError = '';
      try {
        meta = this.parseFrontmatter(fs.readFileSync(file, 'utf8')).meta;
      } catch (error) {
        parseError = error.message;
      }
      skills.push({
        name: String(meta.name || entry.name).trim(),
        dirName: entry.name,
        description: String(meta.description || '').trim(),
        file,
        parseError
      });
    }
    skills.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    return skills;
  }

  // Level 1：只给 name + description，供系统提示里常驻触发判断
  list() {
    return this.scan().map(s => ({ name: s.name, dirName: s.dirName, description: s.description, parseError: s.parseError }));
  }

  // 供系统提示注入的技能清单文本（Level 1）
  catalogText() {
    const items = this.list().filter(s => s.description);
    if (!items.length) return '';
    return items.map(s => `  - ${s.name}：${s.description}`).join('\n');
  }

  find(name) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return null;
    return this.scan().find(s => s.name.toLowerCase() === key || s.dirName.toLowerCase() === key) || null;
  }

  // Level 2：触发后读入完整正文指令
  load(name) {
    const skill = this.find(name);
    if (!skill) {
      return { success: false, error: `没有这个技能: ${name}；可用：${this.list().map(s => s.name).join('、') || '（空）'}` };
    }
    let body = '';
    try {
      body = this.parseFrontmatter(fs.readFileSync(skill.file, 'utf8')).body;
    } catch (error) {
      return { success: false, error: `技能读取失败: ${error.message}` };
    }
    return { success: true, name: skill.name, description: skill.description, instructions: body };
  }

  // Level 3：列出技能目录下除 SKILL.md 外的附加资源（相对路径）
  resources(name) {
    const skill = this.find(name);
    if (!skill) return { success: false, error: `没有这个技能: ${name}` };
    const base = path.dirname(skill.file);
    const files = [];
    const walk = (absDir, relDir) => {
      let items = [];
      try {
        items = fs.readdirSync(absDir, { withFileTypes: true });
      } catch (error) {
        return;
      }
      for (const item of items) {
        const rel = relDir ? path.join(relDir, item.name) : item.name;
        if (item.isDirectory()) walk(path.join(absDir, item.name), rel);
        else if (rel !== SKILL_FILE) files.push(rel.split(path.sep).join('/'));
      }
    };
    walk(base, '');
    return { success: true, name: skill.name, files };
  }

  // Level 3：按需读某个资源文件（限制在技能目录内，防路径穿越）
  readResource(name, relPath) {
    const skill = this.find(name);
    if (!skill) return { success: false, error: `没有这个技能: ${name}` };
    const base = path.dirname(skill.file);
    const target = path.resolve(base, String(relPath || ''));
    if (!target.startsWith(path.resolve(base)) || !fs.existsSync(target)) {
      return { success: false, error: `资源不存在或越界: ${relPath}` };
    }
    try {
      return { success: true, name: skill.name, path: relPath, content: fs.readFileSync(target, 'utf8') };
    } catch (error) {
      return { success: false, error: `资源读取失败: ${error.message}` };
    }
  }
}

module.exports = SkillLibrary;
