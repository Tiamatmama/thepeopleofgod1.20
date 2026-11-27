const fs = require('fs');

class VectorLearner {
    constructor(storagePath = null) {
        // 必须显式指定落盘路径，避免"忘传参"时静默写到默认文件（历史上默认值与实际使用文件不一致）
        if (!storagePath) {
            throw new Error('VectorLearner 需要显式指定 storagePath');
        }
        this.trainingData = [];
        this.vectorCache = new Map();
        this.storagePath = storagePath;
        this.loadTrainingData();
    }

    loadTrainingData() {
        try {
            if (fs.existsSync(this.storagePath)) {
                const data = fs.readFileSync(this.storagePath, 'utf8');
                this.trainingData = JSON.parse(data);
                console.log(`[VectorLearner] 已加载 ${this.trainingData.length} 条训练数据`);
            }
        } catch (error) {
            console.error('[VectorLearner] 加载训练数据失败:', error);
            this.trainingData = [];
        }
    }

    saveTrainingData() {
        try {
            fs.writeFileSync(this.storagePath, JSON.stringify(this.trainingData, null, 2));
        } catch (error) {
            console.error('[VectorLearner] 保存训练数据失败:', error);
        }
    }

    addTrainingPair(inputText, outputText, emotion, relationship) {
        const pair = {
            input: inputText,
            output: outputText,
            emotion: emotion,
            relationship: relationship,
            timestamp: Date.now()
        };
        this.trainingData.push(pair);
        this.vectorCache.clear();
        
        if (this.trainingData.length > 1000) {
            this.trainingData = this.trainingData.slice(-1000);
        }
        
        this.saveTrainingData();
        console.log(`[VectorLearner] 添加训练数据: ${inputText.substring(0, 30)} -> ${outputText.substring(0, 30)}`);
    }

    tokenize(text) {
        const tokens = text.toLowerCase()
            .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length > 0);
        return tokens;
    }

    calculateVector(text) {
        const cacheKey = text.toLowerCase();
        if (this.vectorCache.has(cacheKey)) {
            return this.vectorCache.get(cacheKey);
        }

        const tokens = this.tokenize(text);
        const vector = {};
        const total = tokens.length || 1;

        tokens.forEach(token => {
            vector[token] = (vector[token] || 0) + 1;
        });

        Object.keys(vector).forEach(key => {
            vector[key] = vector[key] / total;
        });

        this.vectorCache.set(cacheKey, vector);
        return vector;
    }

    cosineSimilarity(vec1, vec2) {
        const keys1 = Object.keys(vec1);
        const keys2 = Object.keys(vec2);
        const commonKeys = keys1.filter(k => keys2.includes(k));

        if (commonKeys.length === 0) return 0;

        let dotProduct = 0;
        let magnitude1 = 0;
        let magnitude2 = 0;

        commonKeys.forEach(key => {
            dotProduct += vec1[key] * vec2[key];
            magnitude1 += vec1[key] * vec1[key];
            magnitude2 += vec2[key] * vec2[key];
        });

        magnitude1 = Math.sqrt(magnitude1);
        magnitude2 = Math.sqrt(magnitude2);

        if (magnitude1 === 0 || magnitude2 === 0) return 0;

        return dotProduct / (magnitude1 * magnitude2);
    }

    findSimilar(inputText, emotion, relationship, topN = 5) {
        const inputVector = this.calculateVector(inputText);
        const candidates = [];

        this.trainingData.forEach((pair, index) => {
            const emotionMatch = !emotion || pair.emotion === emotion;
            const relationshipMatch = !relationship || pair.relationship === relationship;

            if (emotionMatch && relationshipMatch) {
                const similarity = this.cosineSimilarity(inputVector, this.calculateVector(pair.input));
                candidates.push({
                    index,
                    pair,
                    similarity
                });
            }
        });

        candidates.sort((a, b) => b.similarity - a.similarity);
        return candidates.slice(0, topN);
    }

    predictOutput(inputText, emotion, relationship) {
        const similarPairs = this.findSimilar(inputText, emotion, relationship, 3);
        
        if (similarPairs.length === 0) {
            return null;
        }

        const totalSimilarity = similarPairs.reduce((sum, p) => sum + p.similarity, 0);
        
        if (totalSimilarity < 0.1) {
            return null;
        }

        const weightedOutputs = similarPairs.map(p => ({
            output: p.pair.output,
            weight: p.similarity / totalSimilarity,
            originalSimilarity: p.similarity
        }));

        weightedOutputs.sort((a, b) => b.weight - a.weight);
        
        const bestMatch = weightedOutputs[0];
        
        if (bestMatch.originalSimilarity > 0.7) {
            return {
                output: bestMatch.output,
                confidence: bestMatch.originalSimilarity,
                source: 'vector_match',
                matchedInput: similarPairs[0].pair.input
            };
        } else if (weightedOutputs.length >= 2) {
            return {
                output: this.combineOutputs(weightedOutputs),
                confidence: totalSimilarity / similarPairs.length,
                source: 'vector_combined',
                matchedCount: similarPairs.length
            };
        }

        return null;
    }

    combineOutputs(weightedOutputs) {
        const outputs = weightedOutputs.map(w => w.output);
        const shortest = outputs.reduce((a, b) => a.length < b.length ? a : b);
        
        let combined = '';
        const sentences = outputs.map(o => o.split(/[。！？]/).filter(s => s.trim())).flat();
        
        const usedSentences = new Set();
        sentences.forEach(sentence => {
            const trimmed = sentence.trim();
            if (trimmed.length > 5 && !usedSentences.has(trimmed)) {
                if (combined.length + trimmed.length < 100) {
                    combined += (combined ? '。' : '') + trimmed;
                    usedSentences.add(trimmed);
                }
            }
        });

        return combined || shortest;
    }

    getTrainingStats() {
        const stats = {
            totalPairs: this.trainingData.length,
            emotions: {},
            relationships: {},
            avgInputLength: 0,
            avgOutputLength: 0
        };

        if (this.trainingData.length > 0) {
            let totalInputLen = 0;
            let totalOutputLen = 0;

            this.trainingData.forEach(pair => {
                stats.emotions[pair.emotion] = (stats.emotions[pair.emotion] || 0) + 1;
                stats.relationships[pair.relationship] = (stats.relationships[pair.relationship] || 0) + 1;
                totalInputLen += pair.input.length;
                totalOutputLen += pair.output.length;
            });

            stats.avgInputLength = Math.round(totalInputLen / this.trainingData.length);
            stats.avgOutputLength = Math.round(totalOutputLen / this.trainingData.length);
        }

        return stats;
    }
}

module.exports = VectorLearner;
