/**
 * 监控告警系统
 * 性能监控、告警通知、健康检查
 */

const EventEmitter = require('events');

// 监控指标
class MetricsCollector extends EventEmitter {
    constructor() {
        super();
        this.metrics = {
            requests: {
                total: 0,
                success: 0,
                failed: 0,
                byEndpoint: {}
            },
            responseTime: {
                sum: 0,
                count: 0,
                min: Infinity,
                max: 0,
                p50: [],
                p95: [],
                p99: []
            },
            errors: [],
            system: {
                memory: 0,
                cpu: 0,
                uptime: 0
            }
        };
        
        // 定期清理旧数据
        setInterval(() => this.cleanup(), 60000); // 每分钟
    }
    
    // 记录请求
    recordRequest(endpoint, success, responseTime) {
        this.metrics.requests.total++;
        if (success) {
            this.metrics.requests.success++;
        } else {
            this.metrics.requests.failed++;
        }
        
        // 按端点统计
        if (!this.metrics.requests.byEndpoint[endpoint]) {
            this.metrics.requests.byEndpoint[endpoint] = { total: 0, success: 0, failed: 0 };
        }
        this.metrics.requests.byEndpoint[endpoint].total++;
        if (success) {
            this.metrics.requests.byEndpoint[endpoint].success++;
        } else {
            this.metrics.requests.byEndpoint[endpoint].failed++;
        }
        
        // 响应时间统计
        this.metrics.responseTime.sum += responseTime;
        this.metrics.responseTime.count++;
        this.metrics.responseTime.min = Math.min(this.metrics.responseTime.min, responseTime);
        this.metrics.responseTime.max = Math.max(this.metrics.responseTime.max, responseTime);
        
        // 百分位数采样
        this.metrics.responseTime.p50.push(responseTime);
        this.metrics.responseTime.p95.push(responseTime);
        this.metrics.responseTime.p99.push(responseTime);
        
        // 触发事件
        this.emit('request', { endpoint, success, responseTime });
    }
    
    // 记录错误
    recordError(error) {
        const errorEntry = {
            message: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString(),
            type: error.constructor.name
        };
        
        this.metrics.errors.unshift(errorEntry);
        
        // 只保留最近100个错误
        if (this.metrics.errors.length > 100) {
            this.metrics.errors = this.metrics.errors.slice(0, 100);
        }
        
        // 触发告警事件
        this.emit('error', errorEntry);
    }
    
    // 更新系统指标
    updateSystemMetrics() {
        const memUsage = process.memoryUsage();
        this.metrics.system.memory = memUsage.heapUsed / memUsage.heapTotal;
        this.metrics.system.uptime = process.uptime();
        
        // CPU 使用率（简单估算）
        const cpuUsage = process.cpuUsage();
        this.metrics.system.cpu = (cpuUsage.user + cpuUsage.system) / 1000000;
    }
    
    // 获取统计报告
    getReport() {
        const avgResponseTime = this.metrics.responseTime.count > 0
            ? this.metrics.responseTime.sum / this.metrics.responseTime.count
            : 0;
        
        // 计算百分位数
        const calcPercentile = (arr, p) => {
            if (arr.length === 0) return 0;
            const sorted = [...arr].sort((a, b) => a - b);
            const idx = Math.ceil(sorted.length * p / 100) - 1;
            return sorted[Math.max(0, idx)];
        };
        
        return {
            requests: {
                total: this.metrics.requests.total,
                success: this.metrics.requests.success,
                failed: this.metrics.requests.failed,
                successRate: this.metrics.requests.total > 0
                    ? (this.metrics.requests.success / this.metrics.requests.total * 100).toFixed(2) + '%'
                    : '0%'
            },
            responseTime: {
                avg: avgResponseTime.toFixed(2) + 'ms',
                min: this.metrics.responseTime.min === Infinity ? 0 : this.metrics.responseTime.min + 'ms',
                max: this.metrics.responseTime.max + 'ms',
                p50: calcPercentile(this.metrics.responseTime.p50, 50) + 'ms',
                p95: calcPercentile(this.metrics.responseTime.p95, 95) + 'ms',
                p99: calcPercentile(this.metrics.responseTime.p99, 99) + 'ms'
            },
            errors: {
                count: this.metrics.errors.length,
                recent: this.metrics.errors.slice(0, 5)
            },
            system: {
                memory: (this.metrics.system.memory * 100).toFixed(2) + '%',
                uptime: Math.floor(this.metrics.system.uptime) + 's'
            }
        };
    }
    
    // 清理旧数据
    cleanup() {
        // 清理百分位数采样（保留最新1000个）
        const maxSamples = 1000;
        ['p50', 'p95', 'p99'].forEach(key => {
            if (this.metrics.responseTime[key].length > maxSamples) {
                this.metrics.responseTime[key] = this.metrics.responseTime[key].slice(-maxSamples);
            }
        });
    }
    
    // 重置
    reset() {
        this.metrics = {
            requests: { total: 0, success: 0, failed: 0, byEndpoint: {} },
            responseTime: { sum: 0, count: 0, min: Infinity, max: 0, p50: [], p95: [], p99: [] },
            errors: [],
            system: { memory: 0, cpu: 0, uptime: 0 }
        };
    }
}

/**
 * 告警管理器
 */
class AlertManager extends EventEmitter {
    constructor() {
        super();
        this.alerts = [];
        this.rules = [
            { name: 'high_error_rate', threshold: 0.1, window: 300, severity: 'critical' },
            { name: 'slow_response', threshold: 5000, window: 60, severity: 'warning' },
            { name: 'high_memory', threshold: 0.9, window: 60, severity: 'warning' }
        ];
    }
    
    // 检查告警规则
    checkRules(metrics) {
        // 检查错误率
        if (metrics.requests.total > 0) {
            const errorRate = metrics.requests.failed / metrics.requests.total;
            if (errorRate > 0.1) {
                this.triggerAlert('high_error_rate', {
                    message: `错误率过高: ${(errorRate * 100).toFixed(2)}%`,
                    severity: 'critical'
                });
            }
        }
        
        // 检查响应时间
        const avgTime = parseFloat(metrics.responseTime.avg);
        if (avgTime > 5000) {
            this.triggerAlert('slow_response', {
                message: `响应时间过长: ${avgTime}ms`,
                severity: 'warning'
            });
        }
        
        // 检查内存
        const memPercent = parseFloat(metrics.system.memory);
        if (memPercent > 0.9) {
            this.triggerAlert('high_memory', {
                message: `内存使用过高: ${(memPercent * 100).toFixed(2)}%`,
                severity: 'warning'
            });
        }
    }
    
    // 触发告警
    triggerAlert(name, data) {
        const alert = {
            id: `alert_${Date.now()}`,
            name,
            ...data,
            timestamp: new Date().toISOString()
        };
        
        this.alerts.unshift(alert);
        
        // 只保留最近50个告警
        if (this.alerts.length > 50) {
            this.alerts = this.alerts.slice(0, 50);
        }
        
        // 发出告警事件
        this.emit('alert', alert);
        
        console.warn(`🚨 告警 [${data.severity}]: ${name} - ${data.message}`);
    }
    
    // 获取告警列表
    getAlerts(limit = 10) {
        return this.alerts.slice(0, limit);
    }
}

// 导出单例
const metricsCollector = new MetricsCollector();
const alertManager = new AlertManager();

// 绑定告警检查
alertManager.on('alert', (alert) => {
    // 这里可以添加发送通知的逻辑（邮件、Slack等）
    console.log(`[Alert] ${alert.name}: ${alert.message}`);
});

// 定期检查
setInterval(() => {
    const report = metricsCollector.getReport();
    alertManager.checkRules(report);
}, 30000); // 每30秒检查一次

module.exports = {
    metricsCollector,
    alertManager,
    MetricsCollector,
    AlertManager
};
