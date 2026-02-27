/**
 * 智能体调试系统
 * 功能：详细日志记录、错误追踪、性能监控、智能错误诊断
 */

// 敏感字段列表
const SENSITIVE_FIELDS = ['password', 'token', 'secret', 'key', 'apiKey', 'api_key', 'authorization', 'Authorization'];
const SENSITIVE_PATTERN = /sk-[a-zA-Z0-9]{40,50}|ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36}|AKIA[0-9A-Z]{16}/g;

/**
 * 脱敏处理函数
 */
function sanitizeForLogging(obj) {
    if (!obj) return obj;
    
    if (typeof obj === 'string') {
        // 脱敏API密钥格式
        return obj.replace(SENSITIVE_PATTERN, '***REDACTED***');
    }
    
    if (typeof obj !== 'object') {
        return obj;
    }
    
    if (Array.isArray(obj)) {
        return obj.map(item => sanitizeForLogging(item));
    }
    
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
        const isSensitive = SENSITIVE_FIELDS.some(field => 
            key.toLowerCase().includes(field.toLowerCase())
        );
        
        if (isSensitive && typeof value === 'string') {
            sanitized[key] = '***REDACTED***';
        } else if (typeof value === 'object' && value !== null) {
            sanitized[key] = sanitizeForLogging(value);
        } else {
            sanitized[key] = value;
        }
    }
    
    return sanitized;
}

class DebugSystem {
    constructor() {
        this.debugLogs = new Map();          // processId -> 日志数组
        this.performanceMetrics = new Map(); // 性能指标
        this.errorTracker = new Map();       // 错误追踪
        this.activeProcesses = new Map();    // 活跃进程
        this.maxLogsPerProcess = 1000;       // 每个进程最大日志数
        this.maxProcesses = 100;            // 最大保留进程数
        
        // 性能统计
        this.stats = {
            totalRequests: 0,
            successCount: 0,
            errorCount: 0,
            avgResponseTime: 0,
            responseTimes: []
        };
    }

    /**
     * 创建新的调试会话
     */
    createSession(processId, metadata = {}) {
        const session = {
            id: processId,
            startTime: Date.now(),
            metadata,
            logs: [],
            errors: [],
            checkpoints: [],
            status: 'running'
        };
        
        this.debugLogs.set(processId, session);
        this.activeProcesses.set(processId, session);
        
        // 清理旧会话
        this.cleanupOldSessions();
        
        return session;
    }

    /**
     * 记录调试日志
     */
    log(processId, level, step, data = {}) {
        if (!this.debugLogs.has(processId)) {
            this.createSession(processId);
        }
        
        const session = this.debugLogs.get(processId);
        const timestamp = new Date().toISOString();
        
        // 脱敏处理数据
        const sanitizedData = sanitizeForLogging(data);
        
        const logEntry = {
            timestamp,
            level, // 'info', 'warn', 'error', 'debug'
            step,
            data: sanitizedData,
            duration: session.startTime ? Date.now() - session.startTime : 0
        };
        
        session.logs.push(logEntry);
        
        // 限制日志数量
        if (session.logs.length > this.maxLogsPerProcess) {
            session.logs = session.logs.slice(-this.maxLogsPerProcess);
        }
        
        // 同步输出到控制台（脱敏后）
        const prefix = `[${level.toUpperCase()}] [${processId}]`;
        switch (level) {
            case 'error':
                console.error(`${prefix} ${step}`, sanitizedData);
                break;
            case 'warn':
                console.warn(`${prefix} ${step}`, sanitizedData);
                break;
            default:
                console.log(`${prefix} ${step}`, sanitizedData);
        }
        
        return logEntry;
    }

    /**
     * 记录检查点
     */
    checkpoint(processId, name, metadata = {}) {
        const session = this.debugLogs.get(processId);
        if (!session) return null;
        
        const checkpoint = {
            name,
            timestamp: new Date().toISOString(),
            duration: Date.now() - session.startTime,
            metadata
        };
        
        session.checkpoints.push(checkpoint);
        this.log(processId, 'debug', `📍 Checkpoint: ${name}`, metadata);
        
        return checkpoint;
    }

    /**
     * 记录错误
     */
    error(processId, error, context = {}) {
        const session = this.debugLogs.get(processId);
        if (!session) {
            this.createSession(processId);
        }
        
        const sessionRef = this.debugLogs.get(processId);
        
        // 脱敏处理上下文
        const sanitizedContext = sanitizeForLogging(context);
        
        const errorEntry = {
            id: `err_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            timestamp: new Date().toISOString(),
            message: error.message || String(error),
            stack: error.stack ? error.stack.substring(0, 500) : '', // 限制堆栈长度
            context: sanitizedContext,
            recovered: false
        };
        
        sessionRef.errors.push(errorEntry);
        
        // 追踪错误
        const errorKey = `${error.message}`.substring(0, 100);
        if (!this.errorTracker.has(errorKey)) {
            this.errorTracker.set(errorKey, {
                count: 0,
                firstSeen: errorEntry.timestamp,
                lastSeen: errorEntry.timestamp,
                examples: []
            });
        }
        
        const tracker = this.errorTracker.get(errorKey);
        tracker.count++;
        tracker.lastSeen = errorEntry.timestamp;
        if (tracker.examples.length < 3) {
            tracker.examples.push(errorEntry);
        }
        
        this.log(processId, 'error', `❌ Error: ${error.message}`, sanitizedContext);
        
        return errorEntry;
    }

    /**
     * 标记错误已恢复
     */
    markRecovered(processId, errorId) {
        const session = this.debugLogs.get(processId);
        if (!session) return;
        
        const error = session.errors.find(e => e.id === errorId);
        if (error) {
            error.recovered = true;
            error.recoveredAt = new Date().toISOString();
            this.log(processId, 'info', `✅ Error recovered: ${errorId}`);
        }
    }

    /**
     * 记录性能指标
     */
    recordPerformance(processId, operation, duration) {
        const key = `${processId}:${operation}`;
        
        if (!this.performanceMetrics.has(key)) {
            this.performanceMetrics.set(key, {
                operation,
                count: 0,
                totalDuration: 0,
                minDuration: Infinity,
                maxDuration: 0,
                avgDuration: 0,
                lastDuration: 0
            });
        }
        
        const metric = this.performanceMetrics.get(key);
        metric.count++;
        metric.totalDuration += duration;
        metric.minDuration = Math.min(metric.minDuration, duration);
        metric.maxDuration = Math.max(metric.maxDuration, duration);
        metric.avgDuration = metric.totalDuration / metric.count;
        metric.lastDuration = duration;
        
        return metric;
    }

    /**
     * 更新全局统计
     */
    updateStats(success, responseTime) {
        this.stats.totalRequests++;
        
        if (success) {
            this.stats.successCount++;
        } else {
            this.stats.errorCount++;
        }
        
        this.stats.responseTimes.push(responseTime);
        
        // 保持最近1000条记录
        if (this.stats.responseTimes.length > 1000) {
            this.stats.responseTimes.shift();
        }
        
        // 计算平均响应时间
        const sum = this.stats.responseTimes.reduce((a, b) => a + b, 0);
        this.stats.avgResponseTime = sum / this.stats.responseTimes.length;
    }

    /**
     * 获取会话日志
     */
    getSessionLogs(processId) {
        return this.debugLogs.get(processId) || null;
    }

    /**
     * 获取所有会话摘要
     */
    getSessionsSummary() {
        const summaries = [];
        
        for (const [id, session] of this.debugLogs) {
            summaries.push({
                id,
                status: session.status,
                startTime: session.startTime,
                duration: Date.now() - session.startTime,
                logCount: session.logs.length,
                errorCount: session.errors.length,
                checkpointCount: session.checkpoints.length
            });
        }
        
        return summaries.sort((a, b) => b.startTime - a.startTime);
    }

    /**
     * 获取错误统计
     */
    getErrorStats() {
        const errors = [];
        
        for (const [key, tracker] of this.errorTracker) {
            errors.push({
                message: key,
                count: tracker.count,
                firstSeen: tracker.firstSeen,
                lastSeen: tracker.lastSeen
            });
        }
        
        return errors.sort((a, b) => b.count - a.count);
    }

    /**
     * 获取性能报告
     */
    getPerformanceReport() {
        const report = {
            overall: {
                totalRequests: this.stats.totalRequests,
                successRate: this.stats.totalRequests > 0 
                    ? (this.stats.successCount / this.stats.totalRequests * 100).toFixed(2) + '%'
                    : '0%',
                avgResponseTime: `${this.stats.avgResponseTime.toFixed(2)}ms`,
                errorRate: this.stats.totalRequests > 0
                    ? (this.stats.errorCount / this.stats.totalRequests * 100).toFixed(2) + '%'
                    : '0%'
            },
            operations: []
        };
        
        for (const [key, metric] of this.performanceMetrics) {
            report.operations.push({
                operation: metric.operation,
                count: metric.count,
                avgDuration: `${metric.avgDuration.toFixed(2)}ms`,
                minDuration: `${metric.minDuration.toFixed(2)}ms`,
                maxDuration: `${metric.maxDuration.toFixed(2)}ms`
            });
        }
        
        return report;
    }

    /**
     * 完成会话
     */
    completeSession(processId, status = 'completed') {
        const session = this.debugLogs.get(processId);
        if (!session) return null;
        
        session.status = status;
        session.endTime = Date.now();
        session.duration = session.endTime - session.startTime;
        
        this.activeProcesses.delete(processId);
        
        this.log(processId, 'info', `Session ${status}`, {
            duration: session.duration,
            totalLogs: session.logs.length,
            errors: session.errors.length
        });
        
        return session;
    }

    /**
     * 清理旧会话
     */
    cleanupOldSessions() {
        if (this.debugLogs.size > this.maxProcesses) {
            const sessions = Array.from(this.debugLogs.entries())
                .sort((a, b) => a[1].startTime - b[1].startTime);
            
            const toRemove = sessions.slice(0, sessions.length - this.maxProcesses);
            for (const [id] of toRemove) {
                this.debugLogs.delete(id);
            }
        }
    }

    /**
     * 导出调试数据
     */
    exportDebugData(processId = null) {
        if (processId) {
            return this.debugLogs.get(processId);
        }
        
        return {
            sessions: this.getSessionsSummary(),
            errors: this.getErrorStats(),
            performance: this.getPerformanceReport(),
            exportedAt: new Date().toISOString()
        };
    }

    /**
     * 清空所有调试数据
     */
    clear() {
        this.debugLogs.clear();
        this.activeProcesses.clear();
        this.performanceMetrics.clear();
        this.errorTracker.clear();
        this.stats = {
            totalRequests: 0,
            successCount: 0,
            errorCount: 0,
            avgResponseTime: 0,
            responseTimes: []
        };
    }
}

/**
 * 智能错误诊断系统
 * 使用AI分析错误并提供修复建议
 */
class SmartDiagnoser {
    constructor(debugSystem, aiClient = null) {
        this.debugSystem = debugSystem;
        this.aiClient = aiClient;
        this.diagnosisCache = new Map(); // 错误消息 -> 诊断结果
    }

    /**
     * 诊断错误
     */
    async diagnose(error, context = {}) {
        const errorKey = `${error.message}`.substring(0, 100);
        
        // 检查缓存
        if (this.diagnosisCache.has(errorKey)) {
            const cached = this.diagnosisCache.get(errorKey);
            if (Date.now() - cached.timestamp < 3600000) { // 1小时缓存
                return cached.diagnosis;
            }
        }
        
        // 基础诊断
        const basicDiagnosis = this.basicDiagnose(error, context);
        
        // 如果有AI客户端，尝试AI诊断
        let aiDiagnosis = null;
        if (this.aiClient) {
            try {
                aiDiagnosis = await this.aiDiagnose(error, context);
            } catch (e) {
                console.warn('AI诊断失败:', e.message);
            }
        }
        
        const diagnosis = {
            ...basicDiagnosis,
            aiSuggestion: aiDiagnosis,
            timestamp: new Date().toISOString()
        };
        
        // 缓存结果
        this.diagnosisCache.set(errorKey, {
            diagnosis,
            timestamp: Date.now()
        });
        
        return diagnosis;
    }

    /**
     * 基础诊断（基于规则）
     */
    basicDiagnose(error, context) {
        const message = error.message || String(error);
        const stack = error.stack || '';
        
        let category = 'unknown';
        let severity = 'medium';
        let suggestion = '';
        let possibleCauses = [];
        
        // 错误类型识别
        if (message.includes('ENOTFOUND') || message.includes('ECONNREFUSED')) {
            category = 'network';
            severity = 'high';
            suggestion = '检查网络连接或API服务状态';
            possibleCauses = ['网络中断', '服务不可用', '防火墙阻止'];
        } else if (message.includes('timeout')) {
            category = 'timeout';
            severity = 'medium';
            suggestion = '增加超时时间或检查服务响应速度';
            possibleCauses = ['服务响应慢', '网络延迟', '请求处理时间长'];
        } else if (message.includes('unauthorized') || message.includes('401')) {
            category = 'auth';
            severity = 'high';
            suggestion = '检查API密钥或认证凭证';
            possibleCauses = ['API密钥无效', '权限不足', 'Token过期'];
        } else if (message.includes('rate limit') || message.includes('429')) {
            category = 'rate_limit';
            severity = 'medium';
            suggestion = '实施请求限流，增加重试间隔';
            possibleCauses = ['请求频率过高', '达到API限制', '需要排队'];
        } else if (message.includes('JSON') || message.includes('parse')) {
            category = 'parsing';
            severity = 'medium';
            suggestion = '检查返回数据格式';
            possibleCauses = ['API返回格式错误', '数据编码问题', '响应不完整'];
        } else if (message.includes('GitHub') || message.includes('git')) {
            category = 'github';
            severity = 'medium';
            suggestion = '检查GitHub API配置和权限';
            possibleCauses = ['分支已存在', '权限不足', '仓库不存在'];
        } else if (message.includes('ReferenceError') || message.includes('TypeError')) {
            category = 'code';
            severity = 'high';
            suggestion = '检查代码中的变量和方法';
            possibleCauses = ['未定义变量', '类型错误', '调用错误'];
        }
        
        return {
            category,
            severity,
            suggestion,
            possibleCauses,
            stack: stack.substring(0, 500)
        };
    }

    /**
     * AI诊断（需要AI客户端）
     */
    async aiDiagnose(error, context) {
        if (!this.aiClient) return null;
        
        const prompt = `分析以下错误并提供修复建议：

错误信息: ${error.message}
错误堆栈: ${error.stack || '无'}
上下文: ${JSON.stringify(context)}

请提供：
1. 错误根因分析
2. 具体修复步骤
3. 预防措施
4. 相关代码示例（如果适用）

请用JSON格式返回：
{
    "rootCause": "...",
    "fixSteps": ["步骤1", "步骤2"],
    "prevention": "...",
    "codeExample": "..."
}`;
        
        try {
            const response = await this.aiClient(prompt);
            return JSON.parse(response);
        } catch (e) {
            return {
                rootCause: 'AI诊断失败',
                fixSteps: ['请手动检查错误上下文'],
                prevention: '配置有效的AI客户端以获取智能诊断',
                codeExample: null
            };
        }
    }

    /**
     * 批量诊断
     */
    async diagnoseBatch(errors) {
        const results = [];
        
        for (const error of errors) {
            const diagnosis = await this.diagnose(error.error, error.context);
            results.push({
                errorId: error.id,
                diagnosis
            });
        }
        
        return results;
    }
}

/**
 * 健康检查系统
 */
class HealthChecker {
    constructor() {
        this.checks = new Map();
        this.lastCheckResults = new Map();
        
        // 注册默认检查
        this.registerDefaultChecks();
    }

    /**
     * 注册默认检查
     */
    registerDefaultChecks() {
        this.registerCheck('memory', async () => {
            const usage = process.memoryUsage();
            return {
                status: usage.heapUsed / usage.heapLimit > 0.9 ? 'critical' : 'healthy',
                details: {
                    heapUsed: `${(usage.heapUsed / 1024 / 1024).toFixed(2)}MB`,
                    heapTotal: `${(usage.heapTotal / 1024 / 1024).toFixed(2)}MB`,
                    heapLimit: `${(usage.heapLimit / 1024 / 1024).toFixed(2)}MB`,
                    usagePercent: `${(usage.heapUsed / usage.heapLimit * 100).toFixed(2)}%`
                }
            };
        });

        this.registerCheck('uptime', async () => {
            const uptime = process.uptime();
            return {
                status: 'healthy',
                details: {
                    uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
                    seconds: Math.floor(uptime)
                }
            };
        });
    }

    /**
     * 注册检查项
     */
    registerCheck(name, checkFn) {
        this.checks.set(name, checkFn);
    }

    /**
     * 运行健康检查
     */
    async runCheck(name) {
        const checkFn = this.checks.get(name);
        if (!checkFn) {
            return { status: 'unknown', error: 'Check not found' };
        }
        
        try {
            const result = await checkFn();
            this.lastCheckResults.set(name, {
                ...result,
                timestamp: new Date().toISOString()
            });
            return result;
        } catch (error) {
            return {
                status: 'error',
                error: error.message,
                timestamp: new Date().toISOString()
            };
        }
    }

    /**
     * 运行所有检查
     */
    async runAllChecks() {
        const results = {};
        let overallStatus = 'healthy';
        
        for (const [name] of this.checks) {
            results[name] = await this.runCheck(name);
            if (results[name].status === 'critical') {
                overallStatus = 'critical';
            } else if (results[name].status === 'warning' && overallStatus !== 'critical') {
                overallStatus = 'warning';
            }
        }
        
        return {
            status: overallStatus,
            timestamp: new Date().toISOString(),
            checks: results
        };
    }

    /**
     * 获取检查历史
     */
    getCheckHistory(name) {
        return this.lastCheckResults.get(name);
    }
}

// 导出模块
module.exports = {
    DebugSystem,
    SmartDiagnoser,
    HealthChecker
};
