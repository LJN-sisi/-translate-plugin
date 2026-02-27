/**
 * 数据库存储模块
 * 支持内存存储、文件存储、Redis（可选）
 * 生产环境建议使用 MongoDB/PostgreSQL
 */

const fs = require('fs');
const path = require('path');

class Database {
    constructor(options = {}) {
        this.mode = options.mode || 'memory'; // memory, file, mongodb
        this.dataDir = options.dataDir || path.join(__dirname, '..', 'data');
        
        // 内存存储
        this.stores = {
            feedback: [],
            agent: {},
            settings: {}
        };
        
        // 初始化
        this.init();
    }
    
    init() {
        // 文件存储模式
        if (this.mode === 'file') {
            this.ensureDataDir();
            this.loadFromFile();
        }
        
        // 定期保存（文件模式）
        if (this.mode === 'file') {
            setInterval(() => this.saveToFile(), 30000); // 每30秒保存
        }
    }
    
    ensureDataDir() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }
    
    // 加载数据
    loadFromFile() {
        const file = path.join(this.dataDir, 'database.json');
        if (fs.existsSync(file)) {
            try {
                const data = JSON.parse(fs.readFileSync(file, 'utf8'));
                this.stores = { ...this.stores, ...data };
                console.log('📦 数据已从文件加载');
            } catch (e) {
                console.error('加载数据失败:', e.message);
            }
        }
    }
    
    // 保存数据
    saveToFile() {
        const file = path.join(this.dataDir, 'database.json');
        try {
            fs.writeFileSync(file, JSON.stringify(this.stores, null, 2));
        } catch (e) {
            console.error('保存数据失败:', e.message);
        }
    }
    
    // ==================== Feedback 操作 ====================
    
    async createFeedback(feedback) {
        const item = {
            id: feedback.id || `fb_${Date.now()}`,
            userId: feedback.userId,
            content: feedback.content,
            language: feedback.language || 'zh',
            timestamp: feedback.timestamp || new Date().toISOString(),
            status: feedback.status || 'pending',
            likes: 0,
            comments: 0,
            aiResponded: false,
            tags: [],
            result: null,
            ...feedback
        };
        
        this.stores.feedback.unshift(item);
        
        // 限制存储数量
        if (this.stores.feedback.length > 1000) {
            this.stores.feedback = this.stores.feedback.slice(0, 1000);
        }
        
        if (this.mode === 'file') this.saveToFile();
        
        return item;
    }
    
    async getFeedbacks(options = {}) {
        const { limit = 20, offset = 0, status, language } = options;
        
        let list = [...this.stores.feedback];
        
        if (status) {
            list = list.filter(f => f.status === status);
        }
        if (language) {
            list = list.filter(f => f.language === language);
        }
        
        return {
            list: list.slice(offset, offset + limit),
            total: list.length,
            limit,
            offset
        };
    }
    
    async getFeedbackById(id) {
        return this.stores.feedback.find(f => f.id === id);
    }
    
    async updateFeedback(id, updates) {
        const index = this.stores.feedback.findIndex(f => f.id === id);
        if (index !== -1) {
            this.stores.feedback[index] = { ...this.stores.feedback[index], ...updates };
            if (this.mode === 'file') this.saveToFile();
            return this.stores.feedback[index];
        }
        return null;
    }
    
    // ==================== Agent 操作 ====================
    
    async saveAgentResult(feedbackId, result) {
        this.stores.agent[feedbackId] = {
            ...result,
            timestamp: new Date().toISOString()
        };
        if (this.mode === 'file') this.saveToFile();
        return this.stores.agent[feedbackId];
    }
    
    async getAgentResult(feedbackId) {
        return this.stores.agent[feedbackId] || null;
    }
    
    async getAgentStats() {
        const feedbacks = this.stores.feedback;
        const today = new Date().toDateString();
        
        return {
            totalProcessed: Object.keys(this.stores.agent).length,
            todayProcessed: feedbacks.filter(f => 
                new Date(f.timestamp).toDateString() === today && f.status === 'completed'
            ).length,
            pendingCount: feedbacks.filter(f => f.status === 'pending').length,
            lastUpdate: feedbacks[0]?.timestamp || null
        };
    }
    
    // ==================== Settings 操作 ====================
    
    async getSetting(key) {
        return this.stores.settings[key];
    }
    
    async setSetting(key, value) {
        this.stores.settings[key] = value;
        if (this.mode === 'file') this.saveToFile();
    }
    
    // ==================== 统计 ====================
    
    async getStats() {
        const feedbacks = this.stores.feedback;
        const today = new Date().toDateString();
        
        return {
            total: feedbacks.length,
            today: feedbacks.filter(f => new Date(f.timestamp).toDateString() === today).length,
            pending: feedbacks.filter(f => f.status === 'pending').length,
            completed: feedbacks.filter(f => f.status === 'completed').length,
            aiResponded: feedbacks.filter(f => f.aiResponded).length
        };
    }
    
    // ==================== 导出/导入 ====================
    
    exportData() {
        return JSON.stringify(this.stores, null, 2);
    }
    
    importData(jsonString) {
        try {
            const data = JSON.parse(jsonString);
            this.stores = { ...this.stores, ...data };
            if (this.mode === 'file') this.saveToFile();
            return true;
        } catch (e) {
            return false;
        }
    }
    
    clear() {
        this.stores = {
            feedback: [],
            agent: {},
            settings: {}
        };
        if (this.mode === 'file') this.saveToFile();
    }
}

// 导出单例
module.exports = new Database({
    mode: process.env.DB_MODE || 'memory',
    dataDir: process.env.DB_DATA_DIR
});
