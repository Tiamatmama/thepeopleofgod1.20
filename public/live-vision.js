'use strict';

// 实时视觉：浏览器端检测 + 结构化上报。
// 页面只做三件事：开摄像头、用本地模型检测（约 10fps）、把归一化坐标批量发给服务端。
// 原图（视频帧）始终留在浏览器里，不上传、不落盘。

(function () {
  const DETECT_INTERVAL_MS = 100;   // 10fps：够描述「走过来 / 走开」，也不至于把 CPU 吃满
  const POSE_INTERVAL_MS = 200;     // 姿态 5fps：挥手/举手够用，再快只是白烧 CPU
  const HAND_INTERVAL_MS = 300;     // 手部 3fps：数手指不需要更密
  const FACE_INTERVAL_MS = 300;     // 表情/视线 3fps：嘴和眼的动作本来就慢
  const UPLOAD_INTERVAL_MS = 120;   // 上报节奏和检测分开，避免每帧一次请求
  const SCORE_THRESHOLD = 0.3;
  const MAX_TRACKS = 10;
  // 挥手的判断窗口：1.2 秒内手腕横向来回至少 2 次
  const WAVE_WINDOW_MS = 1200;

  const el = {
    video: document.getElementById('video'),
    overlay: document.getElementById('overlay'),
    startBtn: document.getElementById('startBtn'),
    stopBtn: document.getElementById('stopBtn'),
    mirrorBtn: document.getElementById('mirrorBtn'),
    status: document.getElementById('status'),
    placeholder: document.getElementById('placeholder'),
    summary: document.getElementById('summary'),
    tracks: document.getElementById('tracks'),
    log: document.getElementById('log'),
    fpsChip: document.getElementById('fpsChip'),
    trackChip: document.getElementById('trackChip'),
    uploadChip: document.getElementById('uploadChip')
  };

  const state = {
    running: false,
    detector: null,
    poseLandmarker: null,
    faceLandmarker: null,
    handLandmarker: null,
    stream: null,
    mirror: true,
    lastDetectAt: 0,
    lastPoseAt: 0,
    lastHandAt: 0,
    lastFaceAt: 0,
    detectTimes: [],
    poseGesture: '',
    poseGestureUntil: 0,
    poseExtras: null,
    poseExtrasUntil: 0,
    handGesture: '',
    handGestureUntil: 0,
    expression: '',
    gaze: '',
    faceDetail: '',
    blinkTimes: [],
    blinkHeld: false,
    faceUntil: 0,
    lastGestureLogged: '',
    wristHistory: [],
    latest: { tracks: [], meta: { fps: 0, width: 0, height: 0 }, changedAt: 0 },
    lastUploadAt: 0,
    uploading: false,
    rafId: 0,
    loopTimer: 0,
    lastSummary: ''
  };

  function setStatus(text, tone) {
    el.status.textContent = text;
    el.status.dataset.tone = tone || '';
  }

  function logLine(text) {
    const line = document.createElement('div');
    line.className = 'log-line';
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    line.textContent = `[${time}] ${text}`;
    el.log.prepend(line);
    while (el.log.childElementCount > 30) el.log.lastElementChild.remove();
  }

  function zoneOf(cx) {
    if (cx < 0.34) return '偏左';
    if (cx > 0.66) return '偏右';
    return '中间';
  }

  function depthOf(h) {
    if (h >= 0.34) return '近处';
    if (h >= 0.18) return '中等距离';
    return '远处';
  }

  // 中文名只用于本页展示；服务端有一份同样的映射，两边各自兜底
  const LABEL_ZH = {
    person: '人', cup: '杯子', bottle: '瓶子', 'wine glass': '酒杯',
    cellphone: '手机', 'cell phone': '手机', laptop: '笔记本电脑', keyboard: '键盘',
    mouse: '鼠标', book: '书', 'potted plant': '盆栽', cat: '猫', dog: '狗',
    chair: '椅子', 'dining table': '桌子', tv: '显示器', remote: '遥控器',
    clock: '闹钟', banana: '香蕉', apple: '苹果', sandwich: '三明治',
    'teddy bear': '玩偶', backpack: '背包', handbag: '手提包', bowl: '碗'
  };

  function zhName(label) {
    return LABEL_ZH[String(label || '').toLowerCase()] || label;
  }

  // ---------- 检测器 ----------

  // 创建模型：显卡不支持时退回 CPU，慢一点但还能跑
  async function createWithFallback(factory, options, label) {
    try {
      return await factory(options);
    } catch (error) {
      logLine(`${label} GPU 初始化失败，改用 CPU：${error.message}`);
      options.baseOptions.delegate = 'CPU';
      return factory(options);
    }
  }

  async function loadModels() {
    setStatus('正在加载本地检测器…');
    const vision = await import('/vendor/mediapipe/vision_bundle.mjs');
    const fileset = await vision.FilesetResolver.forVisionTasks('/vendor/mediapipe');

    const detector = await createWithFallback(
      (opts) => vision.ObjectDetector.createFromOptions(fileset, opts),
      {
        baseOptions: {
          modelAssetPath: '/models/efficientdet_lite0.tflite',
          delegate: 'GPU'
        },
        runningMode: 'VIDEO',
        scoreThreshold: SCORE_THRESHOLD,
        maxResults: MAX_TRACKS
      },
      '物体检测'
    );

    // 姿态是加分项：模型缺失或初始化失败就退回纯物体检测，不影响主流程
    setStatus('正在加载姿态模型…');
    let poseLandmarker = null;
    try {
      poseLandmarker = await createWithFallback(
        (opts) => vision.PoseLandmarker.createFromOptions(fileset, opts),
        {
          baseOptions: {
            modelAssetPath: '/models/pose_landmarker_full.task',
            delegate: 'GPU'
          },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5
        },
        '姿态识别'
      );
    } catch (error) {
      logLine(`姿态模型加载失败，只保留物体检测：${error.message}`);
    }

    // 人脸与手势同样是加分项：任何一个加载失败，其他能力照常工作
    setStatus('正在加载表情与手势模型…');
    let faceLandmarker = null;
    let handLandmarker = null;
    try {
      faceLandmarker = await createWithFallback(
        (opts) => vision.FaceLandmarker.createFromOptions(fileset, opts),
        {
          baseOptions: {
            modelAssetPath: '/models/face_landmarker.task',
            delegate: 'GPU'
          },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true,
          minFaceDetectionConfidence: 0.5,
          minFacePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5
        },
        '表情识别'
      );
    } catch (error) {
      logLine(`表情模型加载失败，只保留其他检测：${error.message}`);
    }
    try {
      handLandmarker = await createWithFallback(
        (opts) => vision.HandLandmarker.createFromOptions(fileset, opts),
        {
          baseOptions: {
            modelAssetPath: '/models/hand_landmarker.task',
            delegate: 'GPU'
          },
          runningMode: 'VIDEO',
          numHands: 1,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5
        },
        '手势识别'
      );
    } catch (error) {
      logLine(`手势模型加载失败，只保留其他检测：${error.message}`);
    }

    return { detector, poseLandmarker, faceLandmarker, handLandmarker };
  }

  // 从姿态关键点再榨一层细节：身体朝向、头部朝向、手臂姿态（叉腰/抱胸/托腮）
  function readPoseExtras(lm) {
    const visible = (point) => point && (point.visibility === undefined || point.visibility > 0.5);
    const nose = lm[0];
    const leftShoulder = lm[11];
    const rightShoulder = lm[12];
    const leftHip = lm[23];
    const rightHip = lm[24];
    const leftWrist = lm[15];
    const rightWrist = lm[16];
    if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return null;

    const shoulderMin = Math.min(leftShoulder.x, rightShoulder.x);
    const shoulderMax = Math.max(leftShoulder.x, rightShoulder.x);
    let body = '背对';
    if (visible(nose)) {
      body = nose.x > shoulderMin - 0.05 && nose.x < shoulderMax + 0.05 ? '面向你' : '侧身';
    }

    let head = '';
    const leftEye = lm[2];
    const rightEye = lm[5];
    if (visible(nose) && leftEye && rightEye) {
      const eyeMidX = (leftEye.x + rightEye.x) / 2;
      const eyeSpan = Math.max(Math.abs(rightEye.x - leftEye.x), 0.02);
      head = Math.abs(nose.x - eyeMidX) / eyeSpan > 0.55 ? '侧着头' : '正对你';
    }

    const near = (a, b, threshold) => Math.hypot(a.x - b.x, a.y - b.y) < threshold;
    const shoulderY = Math.min(leftShoulder.y, rightShoulder.y);
    const hipY = Math.max(leftHip.y, rightHip.y);
    let posture = '';
    if (visible(nose) && ((visible(leftWrist) && near(leftWrist, nose, 0.16))
      || (visible(rightWrist) && near(rightWrist, nose, 0.16)))) {
      posture = '托腮';
    }
    if (!posture && visible(leftWrist) && visible(rightWrist)) {
      const crossed = (leftWrist.x - rightWrist.x) * (leftShoulder.x - rightShoulder.x) < 0;
      const bothInTorso = [leftWrist, rightWrist].every((wrist) => wrist.y > shoulderY - 0.02
        && wrist.y < hipY + 0.05
        && wrist.x > shoulderMin - 0.08
        && wrist.x < shoulderMax + 0.08);
      if (crossed && bothInTorso) posture = '抱胸';
    }
    if (!posture) {
      if ((visible(leftWrist) && near(leftWrist, leftHip, 0.12))
        || (visible(rightWrist) && near(rightWrist, rightHip, 0.12))) {
        posture = '叉腰';
      }
    }

    return { posture, head, body };
  }

  // 手势判断（视角是镜像后的画面也没关系，只看手腕自身的横向运动）：
  //   手抬到肩膀以上 → 举手；1.2 秒内手腕横向来回 ≥2 次 → 挥手
  function detectGesture(now) {
    if (!state.poseLandmarker || el.video.readyState < 2) return '';
    state.lastPoseAt = now;
    let result;
    try {
      result = state.poseLandmarker.detectForVideo(el.video, now);
    } catch {
      return '';
    }
    const lm = result.landmarks && result.landmarks[0];
    if (!lm) {
      state.wristHistory = [];
      return '';
    }
    state.poseExtras = readPoseExtras(lm);
    state.poseExtrasUntil = now + 800;
    const visible = (point) => point && (point.visibility === undefined || point.visibility > 0.5);
    const leftShoulder = lm[11];
    const rightShoulder = lm[12];
    const leftWrist = lm[15];
    const rightWrist = lm[16];
    if (!leftShoulder || !rightShoulder) return '';

    // 两手都抬起来时取更高的那只
    let wrist = null;
    if (visible(leftWrist) && visible(rightWrist)) {
      wrist = leftWrist.y < rightWrist.y ? leftWrist : rightWrist;
    } else if (visible(leftWrist)) {
      wrist = leftWrist;
    } else if (visible(rightWrist)) {
      wrist = rightWrist;
    }

    const shoulderY = Math.min(leftShoulder.y, rightShoulder.y);
    if (!wrist || wrist.y > shoulderY - 0.03) {
      state.wristHistory = [];
      return '';
    }

    const history = state.wristHistory;
    history.push({ x: wrist.x, t: now });
    while (history.length && now - history[0].t > WAVE_WINDOW_MS) history.shift();

    let turns = 0;
    let amplitude = 0;
    for (let i = 2; i < history.length; i += 1) {
      const prev = history[i - 1].x - history[i - 2].x;
      const curr = history[i].x - history[i - 1].x;
      if (prev * curr < 0 && Math.abs(prev) > 0.008 && Math.abs(curr) > 0.008) turns += 1;
      amplitude = Math.max(amplitude, Math.abs(history[i].x - history[0].x));
    }
    if (turns >= 2 || (turns >= 1 && amplitude > 0.12)) return '挥手';
    return '举手';
  }

  // 表情与视线：用 Face Landmarker 的 blendshapes 判个大概，不追求心理学级准确
  function detectFace(now) {
    if (!state.faceLandmarker || el.video.readyState < 2) return null;
    state.lastFaceAt = now;
    let result;
    try {
      result = state.faceLandmarker.detectForVideo(el.video, now);
    } catch {
      return null;
    }
    const shapes = result.faceBlendshapes && result.faceBlendshapes[0];
    if (!shapes || !shapes.categories) return null;
    const scoreOf = (name) => {
      const hit = shapes.categories.find((item) => item.categoryName === name);
      return hit ? Number(hit.score) || 0 : 0;
    };
    const smile = (scoreOf('mouthSmileLeft') + scoreOf('mouthSmileRight')) / 2;
    const jaw = scoreOf('jawOpen');
    const browDown = (scoreOf('browDownLeft') + scoreOf('browDownRight')) / 2;
    const browUp = scoreOf('browInnerUp');

    let expression = '';
    if (smile > 0.55 && jaw > 0.35) expression = '大笑';
    else if (smile > 0.35) expression = '微笑';
    else if (jaw > 0.55 && browUp > 0.4) expression = '惊讶';
    else if (browDown > 0.45) expression = '皱眉';
    else if (jaw > 0.45) expression = '张嘴';

    // 眼球方向细分：左右上下都算，超不过阈值就当在看镜头
    const lookLeft = scoreOf('eyeLookOutLeft') + scoreOf('eyeLookInRight');
    const lookRight = scoreOf('eyeLookInLeft') + scoreOf('eyeLookOutRight');
    const lookUp = scoreOf('eyeLookUpLeft') + scoreOf('eyeLookUpRight');
    const lookDown = scoreOf('eyeLookDownLeft') + scoreOf('eyeLookDownRight');
    const peak = Math.max(lookLeft, lookRight, lookUp, lookDown);
    let gaze = '看你';
    if (peak > 1.0) {
      if (peak === lookLeft) gaze = '看左边';
      else if (peak === lookRight) gaze = '看右边';
      else if (peak === lookUp) gaze = '看上方';
      else gaze = '看下方';
    } else if (lookLeft + lookRight + lookUp + lookDown > 1.0) {
      gaze = '看别处';
    }

    // 眨眼：只统计最近 60 秒，防止累积成误报
    const blink = (scoreOf('eyeBlinkLeft') + scoreOf('eyeBlinkRight')) / 2;
    if (blink > 0.6) {
      if (!state.blinkHeld) {
        state.blinkHeld = true;
        state.blinkTimes.push(now);
      }
    } else {
      state.blinkHeld = false;
    }
    while (state.blinkTimes.length && now - state.blinkTimes[0] > 60000) state.blinkTimes.shift();

    let faceDetail = '';
    if (browUp > 0.5) faceDetail = '挑眉';
    else if (state.blinkTimes.length >= 30) faceDetail = '眨眼频繁';
    else if (Math.abs(scoreOf('mouthSmileLeft') - scoreOf('mouthSmileRight')) > 0.3) {
      faceDetail = '嘴角一边上扬';
    }

    return { expression, gaze, faceDetail };
  }

  // 手部细手势：数手指 + 拇指标志位，够区分 OK / 竖拇指 / 张开手掌 / 数字 1、2
  function detectHand(now) {
    if (!state.handLandmarker || el.video.readyState < 2) return '';
    state.lastHandAt = now;
    let result;
    try {
      result = state.handLandmarker.detectForVideo(el.video, now);
    } catch {
      return '';
    }
    const lm = result.landmarks && result.landmarks[0];
    if (!lm || lm.length < 21) return '';

    const dist = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);
    // 指尖比第二关节更靠上（y 向下）就算伸开
    const up = (tip, pip) => lm[tip].y < lm[pip].y;
    const index = up(8, 6);
    const middle = up(12, 10);
    const ring = up(16, 14);
    const pinky = up(20, 18);
    const extended = [index, middle, ring, pinky].filter(Boolean).length;
    // 拇指：离掌心足够远且指尖朝上
    const thumbOut = dist(4, 17) > 0.09 && lm[4].y < lm[2].y;

    if (dist(4, 8) < 0.07 && middle && ring && pinky) return 'OK';
    if (extended === 0) return thumbOut ? '竖拇指' : '握拳';
    if (extended === 4) return '张开手掌';
    if (extended === 3) return '数字3';
    if (extended === 2) return '数字2';
    if (extended === 1) return index ? '数字1' : '';
    return '';
  }

  function drawBoxes(tracks) {
    const canvas = el.overlay;
    const rect = el.video.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    // 画面镜像时框也跟着镜像，否则人会看到框和脸对不上
    if (state.mirror) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.lineWidth = 2 * dpr;
    ctx.font = `${12 * dpr}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    ctx.textBaseline = 'top';
    tracks.forEach((track) => {
      const x = track.box.x * canvas.width;
      const y = track.box.y * canvas.height;
      const w = track.box.w * canvas.width;
      const h = track.box.h * canvas.height;
      const isPerson = track.label === 'person';
      ctx.strokeStyle = isPerson ? 'rgba(122, 200, 140, .95)' : 'rgba(110, 170, 240, .9)';
      ctx.strokeRect(x, y, w, h);
      const text = `${zhName(track.label)} ${Math.round(track.score * 100)}%`;
      const textWidth = ctx.measureText(text).width + 8 * dpr;
      const labelY = y > 20 * dpr ? y - 18 * dpr : y + h + 2 * dpr;
      ctx.fillStyle = 'rgba(12, 15, 20, .75)';
      ctx.fillRect(x, labelY, textWidth, 16 * dpr);
      ctx.fillStyle = '#dfe7f2';
      ctx.fillText(text, x + 4 * dpr, labelY + 2 * dpr);
    });
    ctx.restore();
  }

  function renderTracks(tracks) {
    el.tracks.innerHTML = '';
    if (!tracks.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '画面里暂时没认出东西';
      el.tracks.appendChild(empty);
      return;
    }
    tracks.forEach((track) => {
      const row = document.createElement('div');
      row.className = 'track';
      const name = document.createElement('span');
      name.className = 'track-name';
      name.textContent = zhName(track.label);
      const where = document.createElement('span');
      where.className = 'track-meta';
      const cx = track.box.x + track.box.w / 2;
      const extras = [track.gesture, track.posture, track.head, track.expression, track.gaze]
        .filter(Boolean).map((item) => ` · ${item}`).join('');
      where.textContent = `${zoneOf(cx)} · ${depthOf(track.box.h)} · ${Math.round(track.score * 100)}%${extras}`;
      row.appendChild(name);
      row.appendChild(where);
      el.tracks.appendChild(row);
    });
  }

  function detect(now) {
    if (!state.detector || el.video.readyState < 2) return;
    if (now - state.lastDetectAt < DETECT_INTERVAL_MS) return;
    state.lastDetectAt = now;

    let result;
    try {
      result = state.detector.detectForVideo(el.video, now);
    } catch (error) {
      logLine(`检测失败：${error.message}`);
      return;
    }

    const vw = el.video.videoWidth || 640;
    const vh = el.video.videoHeight || 480;
    const tracks = (result.detections || [])
      .map((detection) => {
        const category = detection.categories && detection.categories[0];
        const bb = detection.boundingBox;
        if (!category || !bb || !bb.width || !bb.height) return null;
        return {
          label: category.categoryName || category.displayName || 'object',
          score: Number(category.score) || 0,
          box: {
            x: bb.originX / vw,
            y: bb.originY / vh,
            w: bb.width / vw,
            h: bb.height / vh
          }
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_TRACKS);

    // 姿态 / 手势 / 表情各跑各的节流，统一挂到画面里最大的那个人身上。
    // 结果都保留 800ms，避免推理间隔造成的闪断
    const person = tracks.find((track) => track.label === 'person');
    if (person) {
      if (now - state.lastPoseAt >= POSE_INTERVAL_MS) {
        const pose = detectGesture(now);
        if (pose) {
          state.poseGesture = pose;
          state.poseGestureUntil = now + 800;
        } else if (now > state.poseGestureUntil) {
          state.poseGesture = '';
        }
      }
      if (now - state.lastHandAt >= HAND_INTERVAL_MS) {
        const hand = detectHand(now);
        if (hand) {
          state.handGesture = hand;
          state.handGestureUntil = now + 800;
        } else if (now > state.handGestureUntil) {
          state.handGesture = '';
        }
      }
      if (now - state.lastFaceAt >= FACE_INTERVAL_MS) {
        const face = detectFace(now);
        if (face) {
          state.expression = face.expression;
          state.gaze = face.gaze;
          state.faceDetail = face.faceDetail;
          state.faceUntil = now + 1000;
        } else if (now > state.faceUntil) {
          state.expression = '';
          state.gaze = '';
          state.faceDetail = '';
        }
      }

      // 挥手优先级最高（姿态更稳），其次手部细手势，最后才是「举手」
      const gesture = state.poseGesture === '挥手'
        ? '挥手'
        : (state.handGesture || (state.poseGesture === '举手' ? '举手' : ''));
      if (gesture) person.gesture = gesture;
      if (state.expression) person.expression = state.expression;
      if (state.gaze) person.gaze = state.gaze;
      if (state.faceDetail) person.faceDetail = state.faceDetail;
      if (state.poseExtras && now <= state.poseExtrasUntil) {
        if (state.poseExtras.posture) person.posture = state.poseExtras.posture;
        if (state.poseExtras.head) person.head = state.poseExtras.head;
        if (state.poseExtras.body) person.body = state.poseExtras.body;
      }

      if (state.lastGestureLogged !== gesture) {
        state.lastGestureLogged = gesture;
        if (gesture) logLine(`识别到${gesture}`);
      }
    }

    // 滚动帧率：只留最近 20 次，展示用
    state.detectTimes.push(now);
    while (state.detectTimes.length > 20) state.detectTimes.shift();
    const span = state.detectTimes[state.detectTimes.length - 1] - state.detectTimes[0];
    const fps = span > 0 ? Math.round(((state.detectTimes.length - 1) / span) * 1000) : 0;

    state.latest = {
      tracks,
      meta: { fps, width: vw, height: vh },
      changedAt: Date.now()
    };

    drawBoxes(tracks);
    renderTracks(tracks);
    el.fpsChip.textContent = `${fps} fps`;
    el.trackChip.textContent = `${tracks.length} 个目标`;
  }

  async function upload(force) {
    if (!state.running || state.uploading) return;
    const now = Date.now();
    if (!force && now - state.lastUploadAt < UPLOAD_INTERVAL_MS) return;
    state.lastUploadAt = now;
    state.uploading = true;
    try {
      const res = await fetch('/api/vision/tracks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracks: state.latest.tracks, meta: state.latest.meta, active: true })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data && typeof data.summary === 'string') {
        el.summary.textContent = data.summary || '画面里暂时没认出东西。';
      }
      el.uploadChip.textContent = '上报正常';
      el.uploadChip.dataset.tone = 'ok';
    } catch (error) {
      el.uploadChip.textContent = '上报失败';
      el.uploadChip.dataset.tone = 'bad';
      logLine(`上报失败：${error.message}`);
    } finally {
      state.uploading = false;
    }
  }

  function tick(now) {
    if (!state.running) return;
    detect(now);
    state.rafId = requestAnimationFrame(tick);
  }

  async function start() {
    if (state.running) return;
    el.startBtn.disabled = true;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('这个页面不是安全上下文，浏览器不给摄像头权限（换 localhost 或 https 打开）');
      }
      setStatus('等待摄像头授权…');
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false
      });
      el.video.srcObject = state.stream;
      await el.video.play();

      if (!state.detector) {
        const models = await loadModels();
        state.detector = models.detector;
        state.poseLandmarker = models.poseLandmarker;
        state.faceLandmarker = models.faceLandmarker;
        state.handLandmarker = models.handLandmarker;
      }

      state.running = true;
      state.lastDetectAt = 0;
      state.lastPoseAt = 0;
      state.lastHandAt = 0;
      state.lastFaceAt = 0;
      state.poseGesture = '';
      state.poseGestureUntil = 0;
      state.handGesture = '';
      state.handGestureUntil = 0;
      state.expression = '';
      state.gaze = '';
      state.faceUntil = 0;
      state.poseExtras = null;
      state.poseExtrasUntil = 0;
      state.faceDetail = '';
      state.blinkTimes = [];
      state.blinkHeld = false;
      state.lastGestureLogged = '';
      state.wristHistory = [];
      state.detectTimes = [];
      state.latest = { tracks: [], meta: { fps: 0, width: el.video.videoWidth, height: el.video.videoHeight }, changedAt: 0 };
      el.video.classList.toggle('mirror', state.mirror);
      el.placeholder.style.display = 'none';
      el.startBtn.disabled = true;
      el.stopBtn.disabled = false;
      setStatus('正在看', 'ok');
      logLine(`摄像头已开启（${el.video.videoWidth}×${el.video.videoHeight}），检测 10fps`);
      // 上报与检测解耦：检测每帧更新 latest，定时器按节奏发最新一帧
      state.loopTimer = setInterval(() => { upload(false); }, UPLOAD_INTERVAL_MS);
      state.rafId = requestAnimationFrame(tick);
    } catch (error) {
      setStatus('开不起来', 'bad');
      logLine(error.message);
      el.startBtn.disabled = false;
      stopStream();
    }
  }

  function stopStream() {
    if (state.stream) {
      state.stream.getTracks().forEach((track) => track.stop());
      state.stream = null;
    }
    el.video.srcObject = null;
  }

  async function stop(silent) {
    if (!state.running && !state.stream) return;
    state.running = false;
    state.poseGesture = '';
    state.poseGestureUntil = 0;
    state.handGesture = '';
    state.handGestureUntil = 0;
    state.expression = '';
    state.gaze = '';
    state.faceUntil = 0;
    state.poseExtras = null;
    state.poseExtrasUntil = 0;
    state.faceDetail = '';
    state.blinkTimes = [];
    state.blinkHeld = false;
    state.lastGestureLogged = '';
    state.wristHistory = [];
    state.lastPoseAt = 0;
    cancelAnimationFrame(state.rafId);
    clearInterval(state.loopTimer);
    stopStream();
    drawBoxes([]);
    renderTracks([]);
    el.placeholder.style.display = '';
    el.summary.textContent = '等待画面…';
    el.startBtn.disabled = false;
    el.stopBtn.disabled = true;
    setStatus('已停止');
    el.fpsChip.textContent = '0 fps';
    el.trackChip.textContent = '0 个目标';
    try {
      await fetch('/api/vision/off', { method: 'POST' });
    } catch (error) {
      if (!silent) logLine(`清空场景失败：${error.message}`);
    }
    if (!silent) logLine('摄像头已关闭，服务端场景已清空');
  }

  // 页面切到后台就停：没人看的时候不该一直占摄像头和 CPU
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.running) {
      stop(true);
    }
  });
  window.addEventListener('beforeunload', () => {
    // 关页面时尽力清空；sendBeacon 不保证顺序，这里用同步标记即可
    if (state.running) {
      navigator.sendBeacon && navigator.sendBeacon('/api/vision/off');
    }
  });

  el.startBtn.addEventListener('click', start);
  el.stopBtn.addEventListener('click', () => stop(false));
  el.mirrorBtn.addEventListener('click', () => {
    state.mirror = !state.mirror;
    el.video.classList.toggle('mirror', state.mirror);
    el.mirrorBtn.classList.toggle('on', state.mirror);
    if (state.latest.tracks.length) drawBoxes(state.latest.tracks);
  });
  el.mirrorBtn.classList.toggle('on', state.mirror);

  // ===== 对话 =====
  // 不再另开一套聊天：直接复用主界面存在 localStorage 的当前角色与会话，
  // 走同一个 /api/input，历史、记忆、实时画面注入都是同一份。
  (function initChat() {
    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send');
    const logBox = document.getElementById('chat-log');
    const hint = document.getElementById('chatHint');
    if (!input || !sendBtn || !logBox) return;

    let identity = null;
    let sending = false;

    function readIdentity() {
      try {
        const session = JSON.parse(localStorage.getItem('current-session') || 'null');
        const user = JSON.parse(localStorage.getItem('current-user') || 'null');
        if (!session || !session.sessionId || !user || !user.userId) return null;
        return {
          sessionId: session.sessionId,
          userId: user.userId,
          authSessionId: localStorage.getItem('sessionId') || '',
          name: user.name || user.username || '当前角色'
        };
      } catch {
        return null;
      }
    }

    function refreshIdentity() {
      identity = readIdentity();
      if (!identity) {
        hint.textContent = '未找到角色：先在主界面选好角色再回来';
        sendBtn.disabled = true;
        return;
      }
      hint.textContent = `与主界面共用会话 · ${identity.name}`;
      sendBtn.disabled = false;
    }

    function bubble(text, mine) {
      const el = document.createElement('div');
      el.className = mine ? 'msg-user' : 'msg-ai';
      el.textContent = text;
      logBox.appendChild(el);
      logBox.scrollTop = logBox.scrollHeight;
      return el;
    }

    async function send() {
      const text = input.value.trim();
      if (!text || sending) return;
      if (!identity) {
        refreshIdentity();
        if (!identity) return;
      }
      sending = true;
      sendBtn.disabled = true;
      bubble(text, true);
      input.value = '';
      const pending = bubble('…', false);
      try {
        const res = await fetch('/api/input', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'text',
            data: text,
            sessionId: identity.sessionId,
            userId: identity.userId,
            authSessionId: identity.authSessionId,
            source: 'live-vision'
          })
        });
        const result = await res.json();
        const reply = typeof result.data === 'string'
          ? result.data
          : (result.error || '（这次没有收到回应）');
        pending.textContent = reply;
      } catch (error) {
        pending.textContent = `发送失败：${error.message}`;
      } finally {
        sending = false;
        refreshIdentity();
        input.focus();
        logBox.scrollTop = logBox.scrollHeight;
      }
    }

    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) send();
    });

    // 主界面可能先开、后选角色；这里监听 storage，角色一变就跟着换
    window.addEventListener('storage', (event) => {
      if (event.key === 'current-session' || event.key === 'current-user') refreshIdentity();
    });
    refreshIdentity();
  })();

  setStatus('未开启');
})();
