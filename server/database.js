/**
 * 数据库存储模块
 * 支持内存存储、文件存储、Redis（可选）
 * 生产环境建议使用 MongoDB/PostgreSQL
 * 
 * 表设计：
 * - feedback：存储原始反馈、状态、处理结果
 * - task_logs：记录每个任务的生命周期、各阶段耗时
 * - token_usage：记录每次LLM调用的token数、模型、时间
 * - circuit_breaker_events：记录熔断事件（时间、原因、阈值）
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
            settings: {},
            // 新增：任务日志
            taskLogs: [],
            // 新增：Token使用记录
            tokenUsage: [],
            // 新增：熔断事件记录
            circuitBreakerEvents: []
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
            settings: {},
            taskLogs: [],
            tokenUsage: [],
            circuitBreakerEvents: []
        };
        if (this.mode === 'file') this.saveToFile();
    }
    
    // ==================== Task Logs 操作 ====================
    // 记录每个任务的生命周期、各阶段耗时
    
    async createTaskLog(taskLog) {
        const item = {
            id: taskLog.id || `task_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            feedbackId: taskLog.feedbackId,
            taskId: taskLog.taskId,
            status: taskLog.status || 'pending', // pending, analyzing, generating, testing, publishing, completed, failed
            stages: taskLog.stages || [], // 各阶段信息
            createdAt: taskLog.createdAt || new Date().toISOString(),
            updatedAt: taskLog.updatedAt || new Date().toISOString(),
            completedAt: null,
            error: null,
            ...taskLog
        };
        
        this.stores.taskLogs.unshift(item);
        
        // 限制存储数量
        if (this.stores.taskLogs.length > 1000) {
            this.stores.taskLogs = this.stores.taskLogs.slice(0, 1000);
        }
        
        if (this.mode === 'file') this.saveToFile();
        
        return item;
    }
    
    async updateTaskLog(taskId, updates) {
        const index = this.stores.taskLogs.findIndex(t => t.taskId === taskId);
        if (index !== -1) {
            this.stores.taskLogs[index] = { 
                ...this.stores.taskLogs[index], 
                ...updates,
                updatedAt: new Date().toISOString()
            };
            if (this.mode === 'file') this.saveToFile();
            return this.stores.taskLogs[index];
        }
        return null;
    }
    
    async getTaskLogByTaskId(taskId) {
        return this.stores.taskLogs.find(t => t.taskId === taskId);
    }
    
    async getTaskLogs(options = {}) {
        const { limit = 20, offset = 0, feedbackId, status } = options;
        
        let list = [...this.stores.taskLogs];
        
        if (feedbackId) {
            list = list.filter(t => t.feedbackId === feedbackId);
        }
        if (status) {
            list = list.filter(t => t.status === status);
        }
        
        return {
            list: list.slice(offset, offset + limit),
            total: list.length
        };
    }
    
    // 添加任务阶段记录
    async addTaskStage(taskId, stage) {
        const task = await this.getTaskLogByTaskId(taskId);
        if (task) {
            task.stages.push({
                name: stage.name,
                status: stage.status, // started, completed, failed
                startTime: stage.startTime || new Date().toISOString(),
                endTime: stage.endTime || null,
                duration: stage.duration || null,
                data: stage.data || {}
            });
            
            if (stage.status === 'completed' || stage.status === 'failed') {
                task.updatedAt = new Date().toISOString();
            }
            
            if (this.mode === 'file') this.saveToFile();
            return task;
        }
        return null;
    }
    
    // ==================== Token Usage 操作 ====================
    // 记录每次LLM调用的token数、模型、时间
    
    async recordTokenUsage(usage) {
        const item = {
            id: usage.id || `token_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            taskId: usage.taskId,
            feedbackId: usage.feedbackId,
            model: usage.model, // deepseek-chat, gpt-4, etc.
            promptTokens: usage.promptTokens || 0,
            completionTokens: usage.completionTokens || 0,
            totalTokens: usage.totalTokens || (usage.promptTokens + usage.completionTokens),
            cost: usage.cost || null, // 预估成本
            apiCallType: usage.apiCallType, // analyze_intent, generate_solution, generate_response, evaluate_test
            timestamp: usage.timestamp || new Date().toISOString(),
            success: usage.success !== false,
            error: usage.error || null,
            ...usage
        };
        
        this.stores.tokenUsage.unshift(item);
        
        // 限制存储数量
        if (this.stores.tokenUsage.length > 5000) {
            this.stores.tokenUsage = this.stores.tokenUsage.slice(0, 5000);
        }
        
        if (this.mode === 'file') this.saveToFile();
        
        return item;
    }
    
    async getTokenUsage(options = {}) {
        const { limit = 50, offset = 0, taskId, feedbackId, startDate, endDate } = options;
        
        let list = [...this.stores.tokenUsage];
        
        if (taskId) {
            list = list.filter(t => t.taskId === taskId);
        }
        if (feedbackId) {
            list = list.filter(t => t.feedbackId === feedbackId);
        }
        if (startDate) {
            list = list.filter(t => new Date(t.timestamp) >= new Date(startDate));
        }
        if (endDate) {
            list = list.filter(t => new Date(t.timestamp) <= new Date(endDate));
        }
        
        // 计算统计数据
        const stats = {
            totalCalls: list.length,
            totalTokens: list.reduce((sum, t) => sum + t.totalTokens, 0),
            successCalls: list.filter(t => t.success).length,
            failedCalls: list.filter(t => !t.success).length,
            byModel: {},
            byType: {}
        };
        
        list.forEach(t => {
            if (!stats.byModel[t.model]) {
                stats.byModel[t.model] = { calls: 0, tokens: 0 };
            }
            stats.byModel[t.model].calls++;
            stats.byModel[t.model].tokens += t.totalTokens;
            
            if (!stats.byType[t.apiCallType]) {
                stats.byType[t.apiCallType] = { calls: 0, tokens: 0 };
            }
            stats.byType[t.apiCallType].calls++;
            stats.byType[t.apiCallType].tokens += t.totalTokens;
        });
        
        return {
            list: list.slice(offset, offset + limit),
            total: list.length,
            stats
        };
    }
    
    // ==================== Circuit Breaker Events 操作 ====================
    // 记录熔断事件（时间、原因、阈值）
    
    async recordCircuitBreakerEvent(event) {
        const item = {
            id: event.id || `cbe_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            timestamp: event.timestamp || new Date().toISOString(),
            service: event.service, // feedback_analyzer, solution_generator, etc.
            action: event.action, // llm_call, git_operation, test_run
            eventType: event.eventType, // CIRCUIT_OPEN, DAILY_TOKEN_LIMIT, CONCURRENT_LIMIT, etc.
            currentUsage: event.currentUsage || {},
            threshold: event.threshold || {},
            estimatedTokens: event.estimatedTokens || 0,
            taskId: event.taskId || null,
            resolved: false,
            resolution: null,
            ...event
        };
        
        this.stores.circuitBreakerEvents.unshift(item);
        
        // 限制存储数量
        if (this.stores.circuitBreakerEvents.length > 1000) {
            this.stores.circuitBreakerEvents = this.stores.circuitBreakerEvents.slice(0, 1000);
        }
        
        if (this.mode === 'file') this.saveToFile();
        
        return item;
    }
    
    async getCircuitBreakerEvents(options = {}) {
        const { limit = 50, offset = 0, service, eventType, unresolvedOnly } = options;
        
        let list = [...this.stores.circuitBreakerEvents];
        
        if (service) {
            list = list.filter(e => e.service === service);
        }
        if (eventType) {
            list = list.filter(e => e.eventType === eventType);
        }
        if (unresolvedOnly) {
            list = list.filter(e => !e.resolved);
        }
        
        return {
            list: list.slice(offset, offset + limit),
            total: list.length,
            unresolvedCount: list.filter(e => !e.resolved).length
        };
    }
    
    async resolveCircuitBreakerEvent(eventId, resolution) {
        const index = this.stores.circuitBreakerEvents.findIndex(e => e.id === eventId);
        if (index !== -1) {
            this.stores.circuitBreakerEvents[index].resolved = true;
            this.stores.circuitBreakerEvents[index].resolution = resolution;
            this.stores.circuitBreakerEvents[index].resolvedAt = new Date().toISOString();
            if (this.mode === 'file') this.saveToFile();
            return this.stores.circuitBreakerEvents[index];
        }
        return null;
    }
}

// 导出单例
module.exports = new Database({
    mode: process.env.DB_MODE || 'memory',
    dataDir: process.env.DB_DATA_DIR
});
