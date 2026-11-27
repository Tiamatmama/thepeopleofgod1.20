/**
 * GLM-TTS 文本转语音模块
 * 支持多种音色、语速、音量调节、音色复刻
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');
const { exec } = require('child_process');
const util = require('util');
const globalConfig = require('./globalConfig');
const execPromise = util.promisify(exec);

class TTSModule {
    // 密钥走全局服务配置（.env 兜底），用时实时读取，网页上改完立即生效
    getApiKey() {
        return globalConfig.getTTS().apiKey || '';
    }

    constructor() {
        this.apiUrl = 'open.bigmodel.cn';
        this.apiPath = '/api/paas/v4/audio/speech';
        this.fileUploadPath = '/api/paas/v4/files';
        this.voiceClonePath = '/api/paas/v4/voice/clone';
        this.voiceListPath = '/api/paas/v4/voice/list';
        
        // 预置音色列表
        this.voices = {
            'persona': { name: '小助手', gender: 'female', description: '软萌萝莉·小助手（默认）' },
            'chuichui': { name: '吹吹', gender: 'female', description: '日系幼萝莉基底' },
            'tongtong': { name: '童童', gender: 'female', description: '萝莉声线' },
            'xiaochen': { name: '小晨', gender: 'female', description: '女声' },
            'kazi': { name: '卡子', gender: 'female', description: '女声' },
            'jam': { name: 'Jam', gender: 'male', description: '男声' },
            'douji': { name: '豆姬', gender: 'male', description: '男声' },
            'luodo': { name: '罗多', gender: 'male', description: '男声' }
        };
        
        // 自定义音色缓存（从API获取）
        this.customVoices = {};
        
        // 小助手专属参数（固定值，无法通过前端修改）
        // 声线特征：日系雌小鬼·软萌萝莉，高音调、轻微鼻音、语速略快、句尾上扬带挑逗感
        // 参考斋藤千和式腹黑萝莉声线：甜而不腻、活泼跳跃的高音、幼齿软糯气声
        // 声线来源：示例占位音色（voice_name: persona_ogg01）
        // 注意：合成时必须传 UUID，传 voice_name 会报 400
        this.personaVoice = {
            voice: '00000000-0000-0000-0000-000000000000',
            speed: 1.15,      // 稍快语速，贴合角色跳脱灵动的说话节奏
            volume: 5         // 中等偏低音量，更柔和不刺耳
        };
        
        // 默认参数
        this.defaultParams = {
            model: 'glm-tts',
            voice: 'chuichui',
            speed: 1.15,
            volume: 5,
            responseFormat: 'wav'
        };
        
        // 音频输出目录
        this.outputDir = path.join(__dirname, '../data/tts_output');
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
        
        // 初始化时加载自定义音色
        this.loadCustomVoices();
    }
    
    /**
     * 获取可用音色列表（包含自定义音色）
     */
    getVoiceList() {
        const presetVoices = Object.entries(this.voices).map(([id, info]) => ({
            id,
            name: info.name,
            gender: info.gender,
            description: info.description,
            type: 'preset'
        }));
        
        const customVoiceList = Object.entries(this.customVoices).map(([id, info]) => ({
            // 合成用真实 voice id（UUID），展示用 voice_name
            id: info.id || id,
            name: info.name || id,
            gender: 'female',
            description: `自定义音色: ${info.name || id}`,
            type: 'custom'
        }));
        
        return [...presetVoices, ...customVoiceList];
    }
    
    /**
     * 加载自定义音色列表
     */
    async loadCustomVoices() {
        try {
            const result = await this.callJSONAPI(this.voiceListPath, {}, 'GET');
            // 接口实际返回 { voice_list: [...] }，每项含 voice(即UUID)/voice_name/voice_type
            const list = (result && result.voice_list) || (result && result.data) || [];
            if (Array.isArray(list)) {
                this.customVoices = {};
                // 只收私有音色，避免与预置音色重复
                list.filter(v => v.voice_type !== 'OFFICIAL').forEach(voice => {
                    this.customVoices[voice.voice_name] = {
                        id: voice.voice || voice.voice_id,
                        name: voice.voice_name,
                        voiceType: voice.voice_type,
                        created_at: voice.create_time
                    };
                });
                console.log('[TTS] 已加载自定义音色:', Object.keys(this.customVoices));
            }
        } catch (error) {
            console.error('[TTS] 加载自定义音色失败:', error.message);
        }
    }
    
    /**
     * 将音频文件转换为WAV格式
     */
    async convertToWav(inputPath) {
        const ext = path.extname(inputPath).toLowerCase();
        
        // 如果已经是WAV格式，直接返回
        if (ext === '.wav') {
            console.log('[TTS] 文件已是WAV格式，无需转换');
            return inputPath;
        }
        
        const outputPath = inputPath.replace(ext, '.wav');
        console.log('[TTS] 正在转换音频格式:', { input: inputPath, output: outputPath });
        
        try {
            // 使用ffmpeg转换
            const command = `ffmpeg -y -i "${inputPath}" -ar 16000 -ac 1 -acodec pcm_s16le "${outputPath}"`;
            console.log('[TTS] 执行命令:', command);
            
            const { stdout, stderr } = await execPromise(command);
            
            if (fs.existsSync(outputPath)) {
                console.log('[TTS] 转换成功:', outputPath);
                return outputPath;
            } else {
                throw new Error('转换后文件不存在');
            }
        } catch (error) {
            console.error('[TTS] 音频转换失败:', error.message);
            // 如果ffmpeg不可用，尝试直接使用原文件
            console.log('[TTS] 尝试直接使用原文件');
            return inputPath;
        }
    }
    
    /**
     * 上传音频文件到智谱AI文件接口（使用axios）
     */
    async uploadAudioFile(filePath) {
        if (!fs.existsSync(filePath)) {
            return { success: false, message: '文件不存在' };
        }
        
        let uploadPath = filePath;
        const wavPath = filePath.replace(/\.[^.]+$/, '.wav');
        if (fs.existsSync(wavPath)) {
            uploadPath = wavPath;
            console.log('[TTS] 使用已转换的WAV文件:', uploadPath);
        }
        
        const filename = path.basename(uploadPath);
        console.log('[TTS] 准备上传文件:', { filename, path: uploadPath });
        
        try {
            const formData = new FormData();
            formData.append('file', fs.createReadStream(uploadPath));
            formData.append('purpose', 'voice-clone-input');
            
            const response = await axios.post(`https://${this.apiUrl}/api/paas/v4/files`, formData, {
                headers: {
                    'Authorization': `Bearer ${this.getApiKey()}`,
                    ...formData.getHeaders()
                }
            });
            
            console.log('[TTS] 上传响应:', JSON.stringify(response.data));
            
            if (response.data && response.data.id) {
                console.log('[TTS] 上传成功, file_id:', response.data.id);
                return { success: true, fileId: response.data.id };
            } else if (response.data && response.data.code === 0 && response.data.data && response.data.data.file_id) {
                console.log('[TTS] 上传成功:', response.data.data.file_id);
                return { success: true, fileId: response.data.data.file_id };
            } else {
                return { success: false, message: response.data.message || '上传失败' };
            }
        } catch (error) {
            console.error('[TTS] 上传失败:', error.response ? JSON.stringify(error.response.data) : error.message);
            return { success: false, message: error.response ? error.response.data.message : error.message };
        }
    }
    
    /**
     * 音色复刻
     */
    async cloneVoice(fileId, voiceName, text = '') {
        const params = {
            model: 'glm-tts-clone',
            voice_name: voiceName,
            input: text || '你好，我是小助手，最喜欢捉弄人了呢',
            file_id: fileId,
            text: text
        };
        
        try {
            const result = await this.callJSONAPI(this.voiceClonePath, params);
            if (result && result.code === 0) {
                await this.loadCustomVoices();
                return { success: true, voiceName: voiceName };
            } else {
                return { success: false, message: result.message || '音色复刻失败' };
            }
        } catch (error) {
            return { success: false, message: error.message };
        }
    }
    
    /**
     * 使用本地音频文件进行音色复刻
     */
    async cloneVoiceFromFile(filePath, voiceName, text = '') {
        console.log('[TTS] 开始音色复刻:', { filePath, voiceName, text });
        
        // 优先使用已转换的WAV文件
        let uploadPath = filePath;
        const wavPath = filePath.replace(/\.[^.]+$/, '.wav');
        if (fs.existsSync(wavPath)) {
            uploadPath = wavPath;
            console.log('[TTS] 使用已转换的WAV文件:', uploadPath);
        }
        
        // 1. 上传文件
        const uploadResult = await this.uploadAudioFile(uploadPath);
        if (!uploadResult.success) {
            return uploadResult;
        }
        
        // 2. 发起音色复刻
        const cloneResult = await this.cloneVoice(uploadResult.fileId, voiceName, text);
        
        if (cloneResult.success) {
            // 合成必须传 UUID，不能用 voice_name
            const resolvedId = (this.customVoices[voiceName] && this.customVoices[voiceName].id) || voiceName;
            // 更新小助手为自定义音色
            this.personaVoice = {
                voice: resolvedId,
                speed: 1.15,
                volume: 5
            };
            this.defaultParams.voice = resolvedId;
            
            console.log('[TTS] 音色复刻成功！小助手已使用自定义音色:', resolvedId);
        }
        
        return cloneResult;
    }
    
    /**
     * 调用JSON API（返回JSON响应）
     */
    async callJSONAPI(apiPath, params, method = 'POST') {
        return new Promise((resolve, reject) => {
            const postData = method === 'POST' ? JSON.stringify(params) : '';
            
            const options = {
                hostname: this.apiUrl,
                port: 443,
                path: apiPath,
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getApiKey()}`,
                    'Content-Length': Buffer.byteLength(postData)
                }
            };
            
            const req = https.request(options, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    try {
                        const result = JSON.parse(buffer.toString());
                        resolve(result);
                    } catch (e) {
                        reject(new Error('解析JSON失败'));
                    }
                });
            });
            
            req.on('error', reject);
            if (method === 'POST') {
                req.write(postData);
            }
            req.end();
        });
    }
    
    /**
     * 文本转语音
     * @param {string} text - 要转换的文本
     * @param {object} options - 可选参数
     * @param {string} options.voice - 音色ID
     * @param {number} options.speed - 语速 0.5-2
     * @param {number} options.volume - 音量 0-10
     * @param {string} options.responseFormat - 音频格式 wav/pcm
     * @returns {Promise<{success: boolean, audioPath?: string, message?: string}>}
     */
    async synthesize(text, options = {}) {
        // 参数验证
        if (!text || text.trim().length === 0) {
            return { success: false, message: '文本内容不能为空' };
        }
        
        if (text.length > 1024) {
            return { success: false, message: '文本长度超过限制（最大1024字符）' };
        }
        
        // 小助手专属模式：固定参数，复刻雌小鬼软娇傲娇声线
        const isPersona = options.voice === 'persona' || options.voice === '小助手';
        const voiceConfig = isPersona ? this.personaVoice : null;
        
        // 合并参数
        const params = {
            model: 'glm-tts',
            input: text,
            voice: voiceConfig ? voiceConfig.voice : (options.voice || this.defaultParams.voice),
            speed: voiceConfig ? voiceConfig.speed : Math.max(0.5, Math.min(2, options.speed || this.defaultParams.speed)),
            volume: voiceConfig ? voiceConfig.volume : Math.max(0.1, Math.min(10, options.volume || this.defaultParams.volume)),
            response_format: options.responseFormat || this.defaultParams.responseFormat
        };
        
        // 获取实际使用的音色名称
        const actualVoiceId = params.voice;
        const voiceName = this.voices[actualVoiceId]?.name || actualVoiceId;
        const displayName = isPersona ? '小助手' : voiceName;
        
        console.log('[TTS] 开始合成语音:', {
            text: text.substring(0, 50) + (text.length > 50 ? '...' : ''),
            voice: displayName,
            speed: params.speed,
            volume: params.volume,
            mode: isPersona ? '小助手专属模式' : '普通模式'
        });
        
        try {
            const audioBuffer = await this.callAPI(params);
            
            // 生成文件名
            const timestamp = Date.now();
            const filename = `tts_${timestamp}_${params.voice}.wav`;
            const audioPath = path.join(this.outputDir, filename);
            
            // 保存音频文件
            fs.writeFileSync(audioPath, audioBuffer);
            
            console.log('[TTS] 语音合成成功:', audioPath);
            
            return {
                success: true,
                audioPath: audioPath,
                filename: filename,
                voice: actualVoiceId,
                voiceName: displayName,
                isPersona: isPersona,
                duration: this.estimateDuration(text, params.speed)
            };
        } catch (error) {
            console.error('[TTS] 语音合成失败:', error);
            return { success: false, message: error.message };
        }
    }
    
    /**
     * 调用GLM-TTS API
     */
    async callAPI(params) {
        return new Promise((resolve, reject) => {
            const postData = JSON.stringify(params);
            
            const options = {
                hostname: this.apiUrl,
                port: 443,
                path: this.apiPath,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.getApiKey()}`,
                    'Content-Length': Buffer.byteLength(postData)
                }
            };
            
            const req = https.request(options, (res) => {
                const chunks = [];
                
                res.on('data', (chunk) => {
                    chunks.push(chunk);
                });
                
                res.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    
                    if (res.statusCode === 200) {
                        resolve(buffer);
                    } else {
                        // 尝试解析错误信息
                        try {
                            const errorInfo = JSON.parse(buffer.toString());
                            reject(new Error(errorInfo.message || `API错误: ${res.statusCode}`));
                        } catch (e) {
                            reject(new Error(`API错误: ${res.statusCode}`));
                        }
                    }
                });
            });
            
            req.on('error', (error) => {
                reject(error);
            });
            
            req.write(postData);
            req.end();
        });
    }
    
    /**
     * 估算音频时长（秒）
     */
    estimateDuration(text, speed) {
        // 中文平均语速约 4字/秒，英文约 2.5词/秒
        const charCount = text.length;
        const baseDuration = charCount / 4; // 假设中文
        return Math.ceil(baseDuration / speed);
    }
    
    /**
     * 获取音频文件
     */
    getAudioFile(filename) {
        const sanitized = filename.replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').replace(/\.{2,}/g, '.');
        const audioPath = path.join(this.outputDir, sanitized);
        
        if (audioPath.startsWith(this.outputDir) && fs.existsSync(audioPath)) {
            return audioPath;
        }
        return null;
    }
    
    /**
     * 删除音频文件
     */
    deleteAudioFile(filename) {
        const sanitized = filename.replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').replace(/\.{2,}/g, '.');
        const audioPath = path.join(this.outputDir, sanitized);
        
        if (audioPath.startsWith(this.outputDir) && fs.existsSync(audioPath)) {
            fs.unlinkSync(audioPath);
            return true;
        }
        return false;
    }
    
    /**
     * 清理过期音频文件（超过1小时）
     */
    cleanupOldFiles() {
        const files = fs.readdirSync(this.outputDir);
        const now = Date.now();
        const maxAge = 60 * 60 * 1000; // 1小时
        
        files.forEach(file => {
            const filePath = path.join(this.outputDir, file);
            const stat = fs.statSync(filePath);
            
            if (now - stat.mtimeMs > maxAge) {
                fs.unlinkSync(filePath);
                console.log('[TTS] 清理过期文件:', file);
            }
        });
    }
}

module.exports = TTSModule;
