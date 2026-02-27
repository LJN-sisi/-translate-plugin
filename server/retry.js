/**
 * API 重试机制模块
 * 支持指数退避、熔断器模式
 */

const axios = require('axios');

// 简单日志
const log = {
    info: (...args) => console.log('[Retry]', ...args),
    warn: (...args) => console.warn('[Retry]', ...args),
    error: (...args) => console.error('[Retry]', ...args)
};

/**
 * 指数退避重试装饰器
 */
function withRetry(options = {}) {
    const {
        maxRetries = 3,
        initialDelay = 1000,
        maxDelay = 10000,
        backoffMultiplier = 2,
        retryableErrors = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ENETUNREACH'],
        retryCondition = null
    } = options;
    
    return async function retryWrapper(fn, context) {
        let lastError;
        let delay = initialDelay;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await fn(context);
            } catch (error) {
                lastError = error;
                
                // 检查是否可重试
                const isRetryable = 
                    retryableErrors.includes(error.code) ||
                    (error.response?.status >= 500) ||
                    (error.response?.status === 429) || // Rate limit
                    (retryCondition && retryCondition(error));
                
                if (!isRetryable || attempt === maxRetries) {
                    throw error;
                }
                
                log.warn(`重试 ${attempt}/${maxRetries}, 等待 ${delay}ms: ${error.message}`);
                
                // 等待后重试
                await new Promise(resolve => setTimeout(resolve, delay));
                
                // 指数退避
                delay = Math.min(delay * backoffMultiplier, maxDelay);
            }
        }
        
        throw lastError;
    };
}

/**
 * 熔断器类
 */
class CircuitBreaker {
    constructor(options = {}) {
        this.name = options.name || 'default';
        this.failureThreshold = options.failureThreshold || 5;
        this.successThreshold = options.successThreshold || 2;
        this.timeout = options.timeout || 60000; // 1分钟
        
        this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
        this.failures = 0;
        this.successes = 0;
        this.lastFailureTime = null;
        this.nextAttempt = Date.now();
        
        // 监控统计
        this.stats = {
            totalCalls: 0,
            successfulCalls: 0,
            failedCalls: 0,
            rejectedCalls: 0
        };
    }
    
    // 执行受保护的操作
    async execute(fn) {
        this.stats.totalCalls++;
        
        // 检查状态
        if (this.state === 'OPEN') {
            if (Date.now() < this.nextAttempt) {
                this.stats.rejectedCalls++;
                throw new Error(`熔断器 ${this.name} 已打开，拒绝请求`);
            }
            // 进入半开状态
            this.state = 'HALF_OPEN';
            this.successes = 0;
            log.info(`熔断器 ${this.name} 进入半开状态`);
        }
        
        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (error) {
            this.onFailure();
            throw error;
        }
    }
    
    onSuccess() {
        this.stats.successfulCalls++;
        
        if (this.state === 'HALF_OPEN') {
            this.successes++;
            if (this.successes >= this.successThreshold) {
                this.state = 'CLOSED';
                this.failures = 0;
                log.info(`熔断器 ${this.name} 已关闭`);
            }
        } else {
            this.failures = 0;
        }
    }
    
    onFailure() {
        this.stats.failedCalls++;
        this.failures++;
        this.lastFailureTime = Date.now();
        
        if (this.state === 'HALF_OPEN') {
            this.state = 'OPEN';
            this.nextAttempt = Date.now() + this.timeout;
            log.warn(`熔断器 ${this.name} 重新打开`);
        } else if (this.failures >= this.failureThreshold) {
            this.state = 'OPEN';
            this.nextAttempt = Date.now() + this.timeout;
            log.warn(`熔断器 ${this.name} 打开（失败 ${this.failures} 次）`);
        }
    }
    
    // 获取状态
    getState() {
        return {
            state: this.state,
            failures: this.failures,
            successes: this.successes,
            nextAttempt: this.nextAttempt,
            stats: this.stats
        };
    }
    
    // 手动重置
    reset() {
        this.state = 'CLOSED';
        this.failures = 0;
        this.successes = 0;
        this.nextAttempt = Date.now();
    }
}

/**
 * 熔断器管理器
 */
class CircuitBreakerManager {
    constructor() {
        this.breakers = new Map();
    }
    
    getOrCreate(name, options) {
        if (!this.breakers.has(name)) {
            this.breakers.set(name, new CircuitBreaker({ name, ...options }));
        }
        return this.breakers.get(name);
    }
    
    getAllStates() {
        const states = {};
        for (const [name, breaker] of this.breakers) {
            states[name] = breaker.getState();
        }
        return states;
    }
    
    resetAll() {
        for (const breaker of this.breakers.values()) {
            breaker.reset();
        }
    }
}

// 导出
module.exports = {
    withRetry,
    CircuitBreaker,
    CircuitBreakerManager,
    // 预定义熔断器
    circuitBreakers: new CircuitBreakerManager()
};
