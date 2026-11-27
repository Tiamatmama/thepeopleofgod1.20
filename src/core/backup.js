const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');

const deflateRaw = promisify(zlib.deflateRaw);

// 备份：把数据目录原样打包成 zip，不设密码，任何解压工具都能直接读
const DATA_DIR = path.join(__dirname, '../../data');
const BACKUP_DIR = path.join(__dirname, '../../backups');

// 保留最近多少份，超出的删最旧的
const KEEP_COUNT = 5;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

// zip 头里用的是 1980 起的 DOS 时间，秒只占 5 位（2 秒精度）
function dosDateTime(date) {
  return {
    time: ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff,
    date: (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff
  };
}

function listFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listFiles(full, base, out);
    } else if (entry.isFile()) {
      out.push({ full, name: path.relative(base, full).split(path.sep).join('/') });
    }
  }
  return out;
}

function timestampName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

// 手写 zip（store/deflate + 中央目录 + EOCD），避免为一个备份功能引入第三方打包库
async function writeZip(files, target) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const raw = fs.readFileSync(file.full);
    const compressed = await deflateRaw(raw);
    const nameBuffer = Buffer.from(file.name, 'utf8');
    const { time, date } = dosDateTime(fs.statSync(file.full).mtime);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // 文件名按 UTF-8 存，中文作品名才不会乱码
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuffer, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBuffer.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0x20, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuffer);

    offset += local.length + nameBuffer.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(target, Buffer.concat([...chunks, centralBuffer, eocd]));
  return { rawBytes: files.reduce((sum, file) => sum + fs.statSync(file.full).size, 0) };
}

class BackupManager {
  constructor(options = {}) {
    this.sourceDir = options.sourceDir || DATA_DIR;
    this.backupDir = options.backupDir || BACKUP_DIR;
    this.keep = options.keep || KEEP_COUNT;
  }

  // 只认自己产的备份名，免得把用户放进来的别的 zip 一起删了
  list() {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs
      .readdirSync(this.backupDir)
      .filter((name) => /^backup-\d{8}-\d{6}\.zip$/.test(name))
      .map((name) => {
        const stat = fs.statSync(path.join(this.backupDir, name));
        return { name, size: stat.size, createdAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  prune() {
    const removed = [];
    this.list()
      .slice(this.keep)
      .forEach((item) => {
        fs.unlinkSync(path.join(this.backupDir, item.name));
        removed.push(item.name);
      });
    return removed;
  }

  async create() {
    if (!fs.existsSync(this.sourceDir)) {
      throw new Error(`数据目录不存在：${this.sourceDir}`);
    }
    const files = listFiles(this.sourceDir);
    if (files.length === 0) {
      throw new Error('数据目录是空的，没有可备份的内容');
    }

    fs.mkdirSync(this.backupDir, { recursive: true });
    const name = `backup-${timestampName()}.zip`;
    const target = path.join(this.backupDir, name);
    const { rawBytes } = await writeZip(files, target);

    return {
      name,
      size: fs.statSync(target).size,
      rawBytes,
      fileCount: files.length,
      removed: this.prune()
    };
  }

  describe() {
    return { dir: this.backupDir, source: this.sourceDir, keep: this.keep, list: this.list() };
  }
}

module.exports = BackupManager;
