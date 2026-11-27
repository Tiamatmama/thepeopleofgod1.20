// 🎲 陪她玩：三种可判定的桌面游戏（骰子比大小 / 猜拳 / 猜数字）。
//
// 输赢全在服务端按确定规则算：骰子是这里掷的，猜拳是这里判的，猜数字的目标是这里存的。
// 交给她「自己说赢就赢」会放水、会自相矛盾，所以必须是可复核的。
//
// 但输赢本身不换好感：掷骰子掷赢了就加分，等于让运气替她表态，还能靠反复开局刷分。
// 这里只记「今天是否已经陪她玩过一局」，由路由决定那一次加多少。
//
// 只存内存：一局 30 分钟没人动就丢弃，不落盘。游戏态不是记忆，重启丢了无所谓；
// 每日加成同样只在内存，重启后当天可能多记一次，代价可以接受。

const ROUND_TTL_MS = 30 * 60 * 1000;
const GUESS_LIMIT = 7; // 1-100 七次足够（二分最多 7 次）
const GAMES = ['dice', 'rps', 'guess'];

const RPS_BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
const RPS_LABELS = { rock: '石头', paper: '布', scissors: '剪刀' };

const GAME_LABELS = { dice: '骰子比大小', rps: '猜拳', guess: '猜数字' };

function pick(list, random) {
  return list[Math.floor(random() * list.length) % list.length];
}

class GameTable {
  constructor({ random = Math.random, now = Date.now } = {}) {
    this.random = random;
    this.now = now;
    // key: sessionId|userId，一人一局，互不干扰
    this.rounds = new Map();
    // key: sessionId|userId → 已记过加成的日期，一天只记一次
    this.dailyBonus = new Map();
  }

  buildKey(sessionId, userId) {
    return `${String(sessionId || '')}|${String(userId || '')}`;
  }

  dayKey(now) {
    const d = new Date(now);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // 今天第一次玩完一局返回 true，之后同一天都返回 false
  takeDailyBonus(sessionId, userId, now = this.now()) {
    const key = this.buildKey(sessionId, userId);
    const day = this.dayKey(now);
    if (this.dailyBonus.get(key) === day) return false;
    this.dailyBonus.set(key, day);
    return true;
  }

  gameLabel(game) {
    return GAME_LABELS[game] || game;
  }

  // 每局都带一个目标数，猜数字靠它；骰子/猜拳用不到，但保留同一份结构便于前端显示
  start({ sessionId, userId, game }) {
    if (!GAMES.includes(game)) return { error: '不支持的玩法' };

    const now = this.now();
    this.purge(now);

    const round = {
      game,
      sessionId: String(sessionId || ''),
      userId: String(userId || ''),
      startedAt: now,
      updatedAt: now,
      step: 0,
      target: game === 'guess' ? 1 + Math.floor(this.random() * 100) : 0
    };
    this.rounds.set(this.buildKey(sessionId, userId), round);

    return {
      state: {
        game,
        gameLabel: this.gameLabel(game),
        step: 0,
        limit: game === 'guess' ? GUESS_LIMIT : 1,
        prompt: this.openingPrompt(game)
      }
    };
  }

  openingPrompt(game) {
    if (game === 'dice') return '你掷两颗，我掷两颗，加起来比大小。';
    if (game === 'rps') return '三局两胜太麻烦，就一把定输赢。';
    return `我心里想了个 1 到 100 的数，你猜，最多 ${GUESS_LIMIT} 次。`;
  }

  // 返回 { result: 'win'|'lose'|'draw'|'continue', finished, detail }
  // 没有对局 / 对局过期 / 参数非法时返回 { error }
  move({ sessionId, userId, move }) {
    const key = this.buildKey(sessionId, userId);
    const round = this.rounds.get(key);
    if (!round) return { error: '没有进行中的游戏' };

    const now = this.now();
    if (now - round.updatedAt > ROUND_TTL_MS) {
      this.rounds.delete(key);
      return { error: '这局放太久，已经散了' };
    }
    round.updatedAt = now;

    const outcome = this.judge(round, move);
    if (outcome.error) return outcome;

    round.step += 1;
    outcome.state = {
      game: round.game,
      gameLabel: this.gameLabel(round.game),
      step: round.step,
      limit: round.game === 'guess' ? GUESS_LIMIT : 1
    };

    if (outcome.finished) this.rounds.delete(key);
    return outcome;
  }

  judge(round, move) {
    if (round.game === 'dice') return this.judgeDice();
    if (round.game === 'rps') return this.judgeRps(move);
    return this.judgeGuess(round, move);
  }

  judgeDice() {
    const yours = [1 + Math.floor(this.random() * 6), 1 + Math.floor(this.random() * 6)];
    const hers = [1 + Math.floor(this.random() * 6), 1 + Math.floor(this.random() * 6)];
    const yoursTotal = yours[0] + yours[1];
    const hersTotal = hers[0] + hers[1];
    const result = yoursTotal > hersTotal ? 'win' : yoursTotal < hersTotal ? 'lose' : 'draw';
    return {
      result,
      finished: true,
      detail: { yours, yoursTotal, hers, hersTotal }
    };
  }

  judgeRps(move) {
    const yours = String(move || '').trim();
    if (!RPS_LABELS[yours]) return { error: '出石头、剪刀或布' };
    const hers = pick(['rock', 'paper', 'scissors'], this.random);
    const result = yours === hers ? 'draw' : RPS_BEATS[yours] === hers ? 'win' : 'lose';
    return {
      result,
      finished: true,
      detail: {
        yours,
        yoursLabel: RPS_LABELS[yours],
        hers,
        hersLabel: RPS_LABELS[hers]
      }
    };
  }

  judgeGuess(round, move) {
    const guess = Number(move);
    if (!Number.isInteger(guess) || guess < 1 || guess > 100) return { error: '给个 1 到 100 的整数' };

    const detail = { guess, answer: 0, hint: '', triesLeft: 0 };
    if (guess === round.target) {
      detail.answer = round.target;
      return { result: 'win', finished: true, detail };
    }

    const triesLeft = GUESS_LIMIT - (round.step + 1);
    detail.hint = guess > round.target ? '大了' : '小了';
    detail.triesLeft = triesLeft;
    if (triesLeft <= 0) {
      detail.answer = round.target;
      return { result: 'lose', finished: true, detail };
    }
    return { result: 'continue', finished: false, detail };
  }

  // 认输：主动认输直接算输，并给出答案，免得她憋着一个数不放
  quit({ sessionId, userId }) {
    const key = this.buildKey(sessionId, userId);
    const round = this.rounds.get(key);
    if (!round) return { error: '没有进行中的游戏' };
    this.rounds.delete(key);
    return {
      result: 'lose',
      finished: true,
      quit: true,
      state: {
        game: round.game,
        gameLabel: this.gameLabel(round.game),
        step: round.step,
        limit: round.game === 'guess' ? GUESS_LIMIT : 1
      },
      detail: { answer: round.target || 0 }
    };
  }

  // 顺手清掉过期对局，避免 Map 长期膨胀
  purge(now = this.now()) {
    for (const [key, round] of this.rounds) {
      if (now - round.updatedAt > ROUND_TTL_MS) this.rounds.delete(key);
    }
  }

  hasRound(sessionId, userId) {
    return this.rounds.has(this.buildKey(sessionId, userId));
  }
}

module.exports = { GameTable, GAMES, GUESS_LIMIT, GAME_LABELS };
