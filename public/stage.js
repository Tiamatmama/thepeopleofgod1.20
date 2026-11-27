/* 🎭 舞台：把她的新台词送进满屏一句的舞台
 *
 * 只消费「她的台词」，不接管聊天流：
 *   - 满屏一句，按字数自动停留；点击 / 空格 / 滚轮可前进后退
 *   - 上方留上一句残影，右下角是双方最近几条字幕
 *   - ESC 临时收起（她下一条话会再出现）；右上开关永久切回普通聊天
 *   - 默认开启，偏好存 localStorage；减少动效 / 后台标签页都自动降级
 *
 * 对外只有 PogStage.herLine / meLine / setEmotion / toggle。
 */
(function () {
  'use strict';

  const MAX_SLIDE_CHARS = 60;      // 一屏最多几个字，超了切成下一屏
  const MAX_HISTORY = 40;          // 舞台内最多回看多少句
  const MAX_SUBTITLES = 4;
  const MIN_DWELL = 2400;
  const MAX_DWELL = 9000;
  const PREF_KEY = 'pog.stage.enabled';

  const EMOTION_COLORS = {
    happy: '#ffb35c',
    shy: '#ff9ec2',
    sad: '#7aa2ff',
    anxious: '#b49bff',
    angry: '#ff6b5e',
    jealous: '#c08bff',
    dependent: '#ffa8c8',
    calm: '#f6a08a'
  };

  const state = {
    enabled: readEnabled(),
    slides: [],
    index: -1,
    timer: null,
    auto: false,
    name: '',
    emotion: null,
    subtitles: [],
    dom: null,
    wheelAcc: 0
  };

  function readEnabled() {
    try {
      const raw = localStorage.getItem(PREF_KEY);
      return raw === null ? true : raw !== '0';
    } catch {
      return true;
    }
  }

  function saveEnabled() {
    try {
      localStorage.setItem(PREF_KEY, state.enabled ? '1' : '0');
    } catch {
      // 隐私模式下写不了就算了，本次会话仍然生效
    }
  }

  function clock() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // 按换行 + 句末标点切成一屏一句；单句过长就硬切
  function splitSlides(raw) {
    const text = String(raw == null ? '' : raw).replace(/\r/g, '').trim();
    if (!text) return [];
    const out = [];
    for (const block of text.split(/\n+/)) {
      const line = block.trim();
      if (!line) continue;
      const segs = line.match(/[^。！？!?；;…~～]+[。！？!?；;…~～]*/g) || [line];
      let buf = '';
      const flush = () => {
        if (buf.trim()) out.push(buf.trim());
        buf = '';
      };
      for (const seg of segs) {
        if ((buf + seg).length <= MAX_SLIDE_CHARS) {
          buf += seg;
          continue;
        }
        flush();
        if (seg.length <= MAX_SLIDE_CHARS) {
          buf = seg;
          continue;
        }
        for (let i = 0; i < seg.length; i += MAX_SLIDE_CHARS) {
          out.push(seg.slice(i, i + MAX_SLIDE_CHARS));
        }
      }
      flush();
    }
    return out;
  }

  function dwellFor(text) {
    const len = String(text || '').length;
    return Math.min(MAX_DWELL, Math.max(MIN_DWELL, 1200 + len * 80));
  }

  // ---------- DOM ----------

  function ensureDom() {
    if (state.dom) return state.dom;
    if (!document.body) return null;

    const root = document.createElement('div');
    root.id = 'pog-stage';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = [
      '<div class="pog-stage-aura"></div>',
      '<div class="pog-stage-rings"><i></i><i></i></div>',
      '<div class="pog-stage-content">',
      '<div class="pog-stage-echo"></div>',
      '<div class="pog-stage-ghost"></div>',
      '<div class="pog-stage-name"></div>',
      '<div class="pog-stage-line"></div>',
      '<div class="pog-stage-meta"></div>',
      '<div class="pog-stage-waiting">她在想…</div>',
      '<div class="pog-stage-progress"><i></i></div>',
      '</div>',
      '<div class="pog-stage-dots"></div>',
      '<div class="pog-stage-subtitles"></div>',
      '<div class="pog-stage-compose">',
      '<input type="text" placeholder="和她说点什么…" aria-label="输入消息">',
      '<button type="button">发送</button>',
      '</div>',
      '<div class="pog-stage-hint">点击 / 空格 下一句 · 滚轮回看 · ESC 收起</div>',
      '<button class="pog-stage-exit" type="button" aria-label="收起舞台">✕</button>'
    ].join('');

    document.body.appendChild(root);

    state.dom = {
      root,
      echo: root.querySelector('.pog-stage-echo'),
      ghost: root.querySelector('.pog-stage-ghost'),
      name: root.querySelector('.pog-stage-name'),
      line: root.querySelector('.pog-stage-line'),
      meta: root.querySelector('.pog-stage-meta'),
      progress: root.querySelector('.pog-stage-progress i'),
      dots: root.querySelector('.pog-stage-dots'),
      subtitles: root.querySelector('.pog-stage-subtitles'),
      input: root.querySelector('.pog-stage-compose input'),
      waiting: root.querySelector('.pog-stage-waiting')
    };

    // 台上直接说话：写回主输入框并走原来的发送函数。
    // 舞台不退出——留在这里等她的下一句，否则一说话就掉回旧界面。
    const sendFromStage = () => {
      const input = state.dom && state.dom.input;
      if (!input) return;
      const text = input.value.trim();
      if (!text) return;
      const main = document.getElementById('user-message-input');
      if (!main) return;
      main.value = text;
      // 走她平时用的那个发送按钮，行为和手动点发送完全一致
      const sendButton = document.querySelector('.chat-send-btn');
      if (sendButton) {
        sendButton.click();
      } else if (typeof window.sendUserMessage === 'function') {
        window.sendUserMessage();
      } else {
        state.dom.echo.textContent = '没找到发送入口，先按 ESC 回聊天页发';
        return;
      }
      input.value = '';
      showEcho(text);
      clearTimer();
      showWaiting(true);
      console.log('[舞台] 已发送：', text.slice(0, 40));
    };

    const composeButton = root.querySelector('.pog-stage-compose button');
    if (composeButton) composeButton.addEventListener('click', sendFromStage);
    if (state.dom.input) {
      state.dom.input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          sendFromStage();
        }
      });
      // 开始打字就别让句子自己往前跑
      state.dom.input.addEventListener('focus', () => clearTimer());
    }

    root.addEventListener('click', (event) => {
      if (event.target.closest('.pog-stage-exit')) {
        hide();
        return;
      }
      if (event.target.closest('.pog-stage-compose')) return;
      if (event.target.closest('.pog-stage-subtitles')) return;
      next();
    });

    root.addEventListener('wheel', (event) => {
      event.preventDefault();
      state.wheelAcc += event.deltaY;
      if (Math.abs(state.wheelAcc) < 36) return;
      const dir = state.wheelAcc > 0 ? 1 : -1;
      state.wheelAcc = 0;
      if (dir > 0) next();
      else prev();
    }, { passive: false });

    return state.dom;
  }

  function mountToggle() {
    const shell = document.querySelector('.chat-shell');
    if (!shell || shell.querySelector('.pog-stage-toggle')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pog-stage-toggle';
    button.addEventListener('click', () => toggle());
    shell.appendChild(button);
    state.toggleButton = button;
    paintToggle();
  }

  function paintToggle() {
    const button = state.toggleButton;
    if (!button) return;
    button.textContent = state.enabled ? '舞台 · 开' : '舞台 · 关';
    button.classList.toggle('on', state.enabled);
    button.title = state.enabled ? '切回普通对话流' : '打开满屏舞台';
  }

  // ---------- 渲染 ----------

  // 舞台大字逐字入场：中文按字、英文按词，长句自动压缩间隔
  function escapeStageText(text) {
    return String(text).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  function renderStageTokens(text) {
    const tokens = String(text || '').match(/[\u4e00-\u9fff\u3040-\u30ff]|[A-Za-z0-9_'’-]+|\s+|[^\s]/g) || [];
    if (!tokens.length) return '&nbsp;';
    const step = Math.min(30, Math.max(6, 1100 / tokens.length));
    let cursor = 0;
    return tokens.map((token) => {
      if (/^\s+$/.test(token)) return ' ';
      const delay = Math.min(1200, cursor * step);
      cursor += 1;
      return `<span class="pog-token" style="--d:${Math.round(delay)}ms">${escapeStageText(token)}</span>`;
    }).join('');
  }

  function render() {
    const dom = ensureDom();
    if (!dom || state.index < 0 || !state.slides[state.index]) return;

    const current = state.slides[state.index];

    // 上一句已经在右下角的对话记录里了，这里不再叠一行半透明残影，否则同一句会出现两遍
    dom.ghost.textContent = '';
    dom.name.textContent = state.name || '';
    // 不整体淡入，拆成逐字 span，各自带延迟入场
    dom.line.innerHTML = renderStageTokens(current.text);
    dom.meta.textContent = `${clock()} · ${state.index + 1} / ${state.slides.length}`;

    renderDots();
    renderSubtitles();
  }

  function renderDots() {
    const dom = state.dom;
    if (!dom) return;
    const total = Math.min(state.slides.length, 12);
    const from = Math.max(0, state.slides.length - total);
    dom.dots.innerHTML = '';
    for (let i = from; i < state.slides.length; i += 1) {
      const dot = document.createElement('i');
      if (i === state.index) dot.className = 'on';
      dom.dots.appendChild(dot);
    }
  }

  function renderSubtitles() {
    const dom = state.dom;
    if (!dom) return;
    dom.subtitles.innerHTML = '';
    for (const item of state.subtitles) {
      const span = document.createElement('span');
      span.className = item.who === 'me' ? 'me' : 'her';
      span.textContent = `${item.who === 'me' ? '你' : (state.name || '她')}：${item.text}`;
      dom.subtitles.appendChild(span);
    }
  }

  function clearTimer() {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.dom) {
      state.dom.progress.classList.remove('is-running');
      state.dom.progress.style.animationDuration = '';
    }
  }

  function play(auto) {
    render();
    clearTimer();
    state.auto = auto === true;
    if (!state.auto || document.hidden) return;
    const dom = state.dom;
    if (!dom) return;
    const current = state.slides[state.index];
    if (!current) return;
    if (state.index >= state.slides.length - 1) return; // 最后一句就停住，不循环

    const dwell = dwellFor(current.text);
    dom.progress.style.animationDuration = `${dwell}ms`;
    void dom.progress.offsetWidth;
    dom.progress.classList.add('is-running');
    state.timer = setTimeout(() => {
      state.timer = null;
      if (state.index < state.slides.length - 1) {
        state.index += 1;
        play(true);
      }
    }, dwell);
  }

  function open() {
    const dom = ensureDom();
    if (!dom) return;
    dom.root.classList.add('is-open');
    dom.root.setAttribute('aria-hidden', 'false');
  }

  function hide() {
    clearTimer();
    showWaiting(false);
    showEcho('');
    if (state.dom) {
      state.dom.root.classList.remove('is-open');
      state.dom.root.setAttribute('aria-hidden', 'true');
    }
    // 只是收起当前这一幕；她下一条话进来会重新打开
  }

  // 舞台上的回声：刚说完的话先挂一行，等她的回复到了再撤掉
  function showEcho(text) {
    if (!state.dom || !state.dom.echo) return;
    state.dom.echo.textContent = text ? `你：${String(text).slice(0, 60)}` : '';
    state.dom.echo.classList.toggle('on', !!text);
  }

  // 「她在想…」：用户刚说完、回复还没到时的等待提示
  function showWaiting(on) {
    if (!state.dom || !state.dom.waiting) return;
    state.dom.waiting.classList.toggle('on', !!on);
    if (state.waitingTimer) {
      clearTimeout(state.waitingTimer);
      state.waitingTimer = null;
    }
    if (on) {
      // 万一回复没来（断线），45 秒后自己收起，别一直挂着
      state.waitingTimer = setTimeout(() => showWaiting(false), 45000);
    }
  }

  function next() {
    if (state.index < state.slides.length - 1) {
      state.index += 1;
      play(true);
    } else {
      clearTimer();
    }
  }

  function prev() {
    if (state.index > 0) {
      state.index -= 1;
      play(false);
    }
  }

  function applyEmotion() {
    const dom = ensureDom();
    if (!dom) return;
    const emotion = state.emotion;
    const type = emotion && typeof emotion === 'object' ? String(emotion.type || '') : '';
    const color = EMOTION_COLORS[type] || EMOTION_COLORS.calm;
    const intensity = Math.max(0, Math.min(1, Number(emotion && emotion.intensity) || 0.4));
    dom.root.style.setProperty('--emotion', color);
    dom.root.style.setProperty('--emotion-soft', hexToRgba(color, 0.1 + intensity * 0.2));
  }

  function hexToRgba(hex, alpha) {
    const value = String(hex).replace('#', '');
    if (value.length !== 6) return `rgba(157, 176, 255, ${alpha})`;
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  // ---------- 对外的三个入口 ----------

  function herLine(text, name) {
    const body = String(text == null ? '' : text).trim();
    if (!body) return;

    // 同一条台词可能从两条路进来（WS 直呼 + 聊天流监听），三秒内只上一次
    const now = Date.now();
    if (state.lastFullText === body && now - (state.lastFullAt || 0) < 3000) return;
    state.lastFullText = body;
    state.lastFullAt = now;

    state.name = name || state.name || '她';
    pushSubtitle('her', body);
    showWaiting(false);
    showEcho('');
    console.log('[舞台] 收到她的台词：', body.slice(0, 40));

    if (!state.enabled) return;

    const parts = splitSlides(body);
    if (!parts.length) return;

    const firstNew = state.slides.length;
    for (const part of parts) state.slides.push({ text: part });
    if (state.slides.length > MAX_HISTORY) {
      const drop = state.slides.length - MAX_HISTORY;
      state.slides.splice(0, drop);
      state.index = Math.max(0, firstNew - drop);
    } else {
      state.index = firstNew;
    }

    applyEmotion();
    open();
    play(true);
  }

  function meLine(text) {
    const body = String(text == null ? '' : text).trim();
    if (!body) return;
    pushSubtitle('me', body);
  }

  function pushSubtitle(who, text) {
    state.subtitles.push({ who, text: text.replace(/\s+/g, ' ').slice(0, 40) });
    if (state.subtitles.length > MAX_SUBTITLES) state.subtitles.shift();
    renderSubtitles();
  }

  function setEmotion(emotion) {
    if (!emotion || typeof emotion !== 'object') return;
    state.emotion = emotion;
    applyEmotion();
  }

  function toggle() {
    state.enabled = !state.enabled;
    saveEnabled();
    paintToggle();
    if (state.enabled) {
      if (state.slides.length) {
        state.index = state.slides.length - 1;
        open();
        play(false);
      }
    } else {
      hide();
    }
  }

  function bindGlobal() {
    window.addEventListener('keydown', (event) => {
      if (!state.dom || !state.dom.root.classList.contains('is-open')) return;
      // 在台上打字时，空格属于输入框，不拿来翻页
      const typing = event.target && /^(INPUT|TEXTAREA)$/.test(event.target.tagName);
      if (event.key === 'Escape') {
        hide();
      } else if (typing) {
        return;
      } else if (event.key === ' ' || event.key === 'ArrowRight') {
        event.preventDefault();
        next();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        prev();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (!state.dom || !state.dom.root.classList.contains('is-open')) return;
      if (document.hidden) {
        clearTimer();
      } else if (state.auto) {
        play(true);
      }
    });
  }

  // 刷新页面后聊天记录是静态回放的，不会触发 WS；
  // 主动把最近一条「她的话」送上舞台，否则开关显示开着却什么都没有。
  function bootstrapLatest() {
    if (!state.enabled || state.slides.length) return;
    const log = document.getElementById('user-chat-messages');
    if (!log) return;
    const blocks = log.querySelectorAll('.chat-msg');
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      // 历史回放用的是 chat-line-static，实时消息才是 chat-line，两种都要认
      const lines = blocks[i].querySelectorAll('.chat-line, .chat-line-static');
      if (!lines.length) continue;
      const first = lines[0];
      if (first.classList.contains('user') || first.classList.contains('system')) continue;
      const nameEl = first.querySelector('.chat-name');
      const name = nameEl ? nameEl.textContent.replace(/[:：]\s*$/, '') : '';
      const text = Array.from(lines)
        .map((line) => {
          const body = line.querySelector('.chat-text');
          return body ? body.textContent : '';
        })
        .join('\n')
        .trim();
      if (!text) continue;
      herLine(text, name || '她');
      return;
    }
  }

  // 直接盯着聊天流：只要她的新台词被渲染进来，就送上舞台。
  // 这样不依赖 WS 分支、也不怕别的渲染路径，主界面怎么画，舞台就怎么跟。
  function observeChatLog() {
    const log = document.getElementById('user-chat-messages');
    if (!log) return false;
    if (typeof MutationObserver !== 'function') return true;

    let pending = null;
    let timer = null;
    const flush = () => {
      timer = null;
      const block = pending;
      pending = null;
      if (!block || !block.isConnected) return;
      const lines = Array.from(block.querySelectorAll('.chat-line, .chat-line-static'))
        .filter((line) => !line.classList.contains('user') && !line.classList.contains('system'));
      if (!lines.length) return;
      const nameEl = lines[0].querySelector('.chat-name');
      const text = lines
        .map((line) => {
          const body = line.querySelector('.chat-text');
          return body ? body.textContent : '';
        })
        .join('\n')
        .trim();
      if (!text) return;
      herLine(text, nameEl ? nameEl.textContent.replace(/[:：]\s*$/, '') : '她');
    };

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!node || node.nodeType !== 1) continue;
          const lines = node.matches && node.matches('.chat-line, .chat-line-static')
            ? [node]
            : (node.querySelectorAll ? Array.from(node.querySelectorAll('.chat-line, .chat-line-static')) : []);
          // 你的话和系统旁白不上台
          const hasHerLine = lines.some((line) => !line.classList.contains('user')
            && !line.classList.contains('system'));
          if (!hasHerLine) continue;
          // 记住整个消息块，多行台词要一起送上舞台，不能只取最后一行
          pending = node.closest ? (node.closest('.chat-msg') || node) : node;
        }
      }
      if (pending && !timer) timer = setTimeout(flush, 120);
    });
    observer.observe(log, { childList: true });
    console.log('[舞台] 已盯住聊天流');
    return true;
  }

  function init() {
    ensureDom();
    applyEmotion();
    mountToggle();
    bindGlobal();
    // 聊天容器可能比脚本晚出现，等它一下
    let obsTries = 0;
    const obsTimer = setInterval(() => {
      obsTries += 1;
      if (observeChatLog() || obsTries > 40) clearInterval(obsTimer);
    }, 500);
    // 历史是异步加载的：先等它出现，最多等 10 秒；期间她若开口就不用补了
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      bootstrapLatest();
      if (state.slides.length || tries > 20) clearInterval(timer);
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.PogStage = {
    herLine,
    meLine,
    setEmotion,
    toggle,
    show: open,
    hide,
    splitSlides
  };
})();
