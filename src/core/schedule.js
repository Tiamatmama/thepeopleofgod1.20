const fs = require('fs');
const path = require('path');

// 角色时间表：到点由角色自己主动开口，落在 data/schedule.json
const DEFAULT_FILE = path.join(__dirname, '../../data/schedule.json');

// 到点后允许的补发窗口：调度轮询是 30 秒一次，超出这个窗口说明服务当时没在跑，就不再补发
const FIRE_WINDOW_MINUTES = 10;
const MAX_TASKS = 50;

function normalizeTime(value) {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// days 为空数组表示每天；否则是 0-6 的星期（周日为 0）
function normalizeDays(value) {
  if (!Array.isArray(value)) return [];
  const days = Array.from(new Set(value.map((item) => parseInt(item, 10)).filter((day) => day >= 0 && day <= 6)));
  return days.length >= 7 ? [] : days.sort((a, b) => a - b);
}

function dateKey(now) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

class ScheduleStore {
  constructor(options = {}) {
    this.file = options.file || DEFAULT_FILE;
    this.data = { version: 1, enabled: false, tasks: [] };
    this.load();
  }

  normalizeTask(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const time = normalizeTime(raw.time);
    if (!time) return null;
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 40) : `t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      time,
      days: normalizeDays(raw.days),
      // 备注就是“到点要提的那件事”，留空表示到点由角色自己决定说什么
      note: typeof raw.note === 'string' ? raw.note.trim().slice(0, 200) : '',
      enabled: raw.enabled !== false,
      lastFiredDate: typeof raw.lastFiredDate === 'string' ? raw.lastFiredDate : null
    };
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = {
        version: 1,
        enabled: saved.enabled === true,
        tasks: (Array.isArray(saved.tasks) ? saved.tasks : [])
          .map((task) => this.normalizeTask(task))
          .filter(Boolean)
          .slice(0, MAX_TASKS)
      };
    } catch (error) {
      console.error('[定时任务] 读取时间表失败，按空表处理:', error.message);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
      return true;
    } catch (error) {
      console.error('[定时任务] 保存时间表失败:', error.message);
      return false;
    }
  }

  isEnabled() {
    return this.data.enabled === true;
  }

  setEnabled(enabled) {
    this.data.enabled = !!enabled;
    this.save();
    return this.data.enabled;
  }

  // 整表替换：前端编辑完一次性提交，后端只做校验与截断
  replaceTasks(tasks) {
    this.data.tasks = (Array.isArray(tasks) ? tasks : [])
      .map((task) => this.normalizeTask(task))
      .filter(Boolean)
      .slice(0, MAX_TASKS);
    this.save();
    return this.data.tasks;
  }

  describe() {
    return {
      enabled: this.isEnabled(),
      maxTasks: MAX_TASKS,
      tasks: this.data.tasks.map((task) => ({
        id: task.id,
        time: task.time,
        days: task.days.slice(),
        note: task.note,
        enabled: task.enabled,
        lastFiredDate: task.lastFiredDate
      }))
    };
  }

  // 找出此刻到点且今天还没发过的任务，并立刻记上今天已发，避免同一分钟被重复触发
  takeDue(now = new Date()) {
    if (!this.isEnabled()) return [];
    const today = dateKey(now);
    const minutesNow = now.getHours() * 60 + now.getMinutes();
    const due = [];

    this.data.tasks.forEach((task) => {
      if (!task.enabled) return;
      if (task.lastFiredDate === today) return;
      if (task.days.length > 0 && !task.days.includes(now.getDay())) return;

      const [hour, minute] = task.time.split(':').map((part) => parseInt(part, 10));
      const delta = minutesNow - (hour * 60 + minute);
      if (delta < 0 || delta > FIRE_WINDOW_MINUTES) return;

      task.lastFiredDate = today;
      due.push(task);
    });

    if (due.length > 0) this.save();
    return due;
  }
}

module.exports = ScheduleStore;
