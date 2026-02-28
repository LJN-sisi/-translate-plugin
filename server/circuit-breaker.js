/**
 * 熔断管理器 - 智能体核心组件
 * 控制LLM调用成本与风险
 * 
 * 维护实时用量数据：
 * - 当前时间段内已消耗的token总数（按天/小时统计）
 * - 当前正在处理的任务数
 * - 每个任务已消耗的token
 * 
 * 配置阈值：
 * - MAX_DAILY_TOKENS：每日总token上限
 * - MAX_TASK_TOKENS：单个任务最大token
 * - MAX_CONCURRENT_TASKS：最大并发任务数
 * - MAX_RETRIES：同一反馈最大重试次数
 */

const EventEmitter = require('events');

// 默认配置阈值
const DEFAULT_CONFIG = {
    MAX_DAILY_TOKENS: 1000000,      // 每日100万token
    MAX_TASK_TOKENS: 50000,         // 单任务5万token
    MAX_CONCURRENT_TASKS: 10,       // 最大10并发
    MAX_RETRIES: 3,                 // 最多重试3次
    TOKEN_WINDOW_MS: 24 * 60 * 60 * 1000, // 24小时窗口
    HALF_OPEN_TEST_INTERVAL: 10 * 60 * 1000 // 10分钟尝试恢复
};

class CircuitBreakerManager extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = { ...DEFAULT_CONFIG, ...config };
        
        // 实时用量数据
        this.usage = {
            dailyTokens: 0,           // 今日已消耗token
            dailyTokenReset: Date.now() + this.config.TOKEN_WINDOW_MS,
            concurrentTasks: 0,       // 当前并发任务数
            tasks: new Map()           // taskId -> { tokens, retries, status }
        };
        
        // 熔断状态
        this.circuitState = {
            isOpen: false,            // 熔断是否打开
            lastOpenTime: null,
            halfOpenTestCount: 0,    // 半开测试次数
            nextAllowedTime: null
        };
        
        // 熔断事件日志
        this.events = [];
        
        // 启动定时器清理
        this.startCleanupTimer();
    }
    
    /**
     * 检查是否允许执行操作
     */
    async check(service, action, estimatedTokens = 0, taskId = null) {
        const now = Date.now();
        const result = {
            allowed: true,
            reason: '',
            currentUsage: {
                dailyTokens: this.usage.dailyTokens,
                concurrentTasks: this.usage.concurrentTasks,
                maxDailyTokens: this.config.MAX_DAILY_TOKENS,
                maxConcurrentTasks: this.config.MAX_CONCURRENT_TASKS
            }
        };
        
        // 检查熔断是否打开
        if (this.circuitState.isOpen) {
            if (now < this.circuitState.nextAllowedTime) {
                result.allowed = false;
                result.reason = '熔断器已打开，请稍后重试';
                this.recordEvent(service, action, 'CIRCUIT_OPEN', estimatedTokens, taskId);
                return result;
            } else {
                this.circuitState.isOpen = false;
                this.circuitState.halfOpenTestCount = 0;
                this.emit('circuit_half_open', { service, action });
            }
        }
        
        // 检查每日token上限
        if (this.usage.dailyTokens + estimatedTokens > this.config.MAX_DAILY_TOKENS) {
            result.allowed = false;
            result.reason = `每日token限额已用完 (${this.usage.dailyTokens}/${this.config.MAX_DAILY_TOKENS})`;
            this.recordEvent(service, action, 'DAILY_TOKEN_LIMIT', estimatedTokens, taskId);
            return result;
        }
        
        // 检查并发任务上限
        if (this.usage.concurrentTasks >= this.config.MAX_CONCURRENT_TASKS) {
            result.allowed = false;
            result.reason = `并发任务数已达上限 (${this.usage.concurrentTasks}/${this.config.MAX_CONCURRENT_TASKS})`;
            this.recordEvent(service, action, 'CONCURRENT_LIMIT', estimatedTokens, taskId);
            return result;
        }
        
        // 检查单任务token上限
        if (taskId && this.usage.tasks.has(taskId)) {
            const taskUsage = this.usage.tasks.get(taskId);
            if (taskUsage.tokens + estimatedTokens > this.config.MAX_TASK_TOKENS) {
                result.allowed = false;
                result.reason = `任务token限额已用完 (${taskUsage.tokens}/${this.config.MAX_TASK_TOKENS})`;
                this.recordEvent(service, action, 'TASK_TOKEN_LIMIT', estimatedTokens, taskId);
                return result;
            }
        }
        
        // 预占资源
        if (estimatedTokens > 0) {
            this.usage.dailyTokens += estimatedTokens;
        }
        
        if (taskId) {
            if (!this.usage.tasks.has(taskId)) {
                this.usage.concurrentTasks++;
                this.usage.tasks.set(taskId, {
                    tokens: estimatedTokens,
                    retries: 0,
                    status: 'running',
                    createdAt: now
                });
            } else {
                const task = this.usage.tasks.get(taskId);
                task.tokens += estimatedTokens;
            }
        }
        
        result.currentUsage = {
            dailyTokens: this.usage.dailyTokens,
            concurrentTasks: this.usage.concurrentTasks,
            maxDailyTokens: this.config.MAX_DAILY_TOKENS,
            maxConcurrentTasks: this.config.MAX_CONCURRENT_TASKS
        };
        
        this.recordEvent(service, action, 'ALLOWED', estimatedTokens, taskId);
        this.emit('check_passed', { service, action, taskId });
        
        return result;
    }
    
    /**
     * 释放预占资源
     */
    async release(taskId, actualTokens = 0) {
        if (taskId && this.usage.tasks.has(taskId)) {
            const task = this.usage.tasks.get(taskId);
            const tokenDiff = actualTokens - task.tokens;
            this.usage.dailyTokens = Math.max(0, this.usage.dailyTokens + tokenDiff);
            this.usage.tasks.delete(taskId);
            this.usage.concurrentTasks = Math.max(0, this.usage.concurrentTasks - 1);
            this.emit('task_released', { taskId, actualTokens });
        }
    }
    
    /**
     * 记录熔断事件
     */
    recordEvent(service, action, status, tokens, taskId) {
        const event = {
            id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            timestamp: new Date().toISOString(),
            service,
            action,
            status,
            tokens,
            taskId,
            dailyTokens: this.usage.dailyTokens,
            concurrentTasks: this.usage.concurrentTasks
        };
        
        this.events.unshift(event);
        if (this.events.length > 1000) {
            this.events = this.events.slice(0, 1000);
        }
        
        if (status !== 'ALLOWED') {
            this.emit('circuit_event', event);
            const recentFailures = this.events
                .filter(e => e.status !== 'ALLOWED' && Date.now() - new Date(e.timestamp).getTime() < 60000)
                .length;
            if (recentFailures >= 5) {
                this.openCircuit();
            }
        }
    }
    
    /**
     * 打开熔断器
     */
    openCircuit() {
        if (!this.circuitState.isOpen) {
            this.circuitState.isOpen = true;
            this.circuitState.lastOpenTime = Date.now();
            this.circuitState.nextAllowedTime = Date.now() + this.config.HALF_OPEN_TEST_INTERVAL;
            this.emit('circuit_opened', { reason: '连续失败触发熔断' });
            console.warn('[熔断器] 已打开，10分钟后尝试恢复');
        }
    }
    
    /**
     * 获取重试次数
     */
    getRetryCount(taskId) {
        if (taskId && this.usage.tasks.has(taskId)) {
            return this.usage.tasks.get(taskId).retries;
        }
        return 0;
    }
    
    /**
     * 增加重试次数
     */
    incrementRetry(taskId) {
        if (taskId && this.usage.tasks.has(taskId)) {
            const task = this.usage.tasks.get(taskId);
            task.retries++;
            if (task.retries >= this.config.MAX_RETRIES) {
                this.recordEvent('agent', 'retry', 'MAX_RETRIES_EXCEEDED', 0, taskId);
                return false;
            }
        }
        return true;
    }
    
    /**
     * 获取当前状态
     */
    getStatus() {
        return {
            config: this.config,
            usage: {
                dailyTokens: this.usage.dailyTokens,
                dailyTokenReset: this.usage.dailyTokenReset,
                concurrentTasks: this.usage.concurrentTasks,
                activeTasks: this.usage.tasks.size
            },
            circuit: {
                isOpen: this.circuitState.isOpen,
                lastOpenTime: this.circuitState.lastOpenTime,
                nextAllowedTime: this.circuitState.nextAllowedTime
            },
            recentEvents: this.events.slice(0, 20)
        };
    }
    
    /**
     * 清理定时器
     */
    startCleanupTimer() {
        setInterval(() => {
            const now = Date.now();
            if (now >= this.usage.dailyTokenReset) {
                this.usage.dailyTokens = 0;
                this.usage.dailyTokenReset = now + this.config.TOKEN_WINDOW_MS;
                console.log('[熔断器] 每日token计数已重置');
                this.emit('daily_reset');
            }
            for (const [taskId, task] of this.usage.tasks) {
                if (now - task.createdAt > 60 * 60 * 1000) {
                    this.usage.tasks.delete(taskId);
                    this.usage.concurrentTasks = Math.max(0, this.usage.concurrentTasks - 1);
                }
            }
        }, 60000);
    }
}

// 导出单例
const circuitBreaker = new CircuitBreakerManager();

module.exports = {
    circuitBreaker,
    CircuitBreakerManager,
    DEFAULT_CONFIG
};
