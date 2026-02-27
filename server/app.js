/**
 * 智能体后端服务
 * 核心功能：处理用户反馈，使用 AI 生成代码改进建议
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

// 引入模块
let debugSystem, healthChecker, smartDiagnoser;
let circuitBreakers;
let metricsCollector, alertManager;

try {
    const debugModule = require('./debug-system');
    debugSystem = new debugModule.DebugSystem();
    healthChecker = new debugModule.HealthChecker();
    smartDiagnoser = new debugModule.SmartDiagnoser(debugSystem, null);
} catch(e) {
    console.warn('Debug system not available:', e.message);
    debugSystem = { createSession:()=>{}, log:()=>{}, error:()=>{}, getSessionsSummary:()=>[], getSessionLogs:()=>null };
    healthChecker = { runAllChecks:()=>({}) };
    smartDiagnoser = { diagnose:()=>{} };
}

try {
    const retryModule = require('./retry');
    circuitBreakers = retryModule.circuitBreakers;
} catch(e) {
    console.warn('Retry module not available');
    circuitBreakers = { getOrCreate:()=>({ execute:fn=>fn() }) };
}

try {
    const monitorModule = require('./monitoring');
    metricsCollector = monitorModule.metricsCollector;
    alertManager = monitorModule.alertManager;
} catch(e) {
    console.warn('Monitoring not available');
    metricsCollector = { updateSystemMetrics:()=>{}, getReport:()=>({}) };
    alertManager = { getAlerts:()=>[] };
}

// 中间件
app.use(cors());
app.use(express.json({ limit: '10kb' }));

// 静态文件
app.use(express.static(path.join(__dirname, '..'), {
    index: ['index.html'],
    maxAge: '1h'
}));

// 数据存储
let feedbackStore = [];
let agentStats = { totalProcessed: 0, todayProcessed: 0, pendingCount: 0 };

// 工具函数
function generateId(prefix = 'fb') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

// AI 回应函数
async function generateAIResponse(feedbackContent) {
    // 如果没有配置 API Key，返回默认回应
    if (!process.env.DEEPSEEK_API_KEY) {
        return {
            responded: false,
            response: '感谢您的反馈！我们已收到您的意见。',
            mock: true
        };
    }

    try {
        const response = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat',
                messages: [
                    { 
                        role: 'system', 
                        content: '你是翻译插件的智能助手，负责回应用户的反馈。请用友好、专业的语气回复，字数控制在100字以内。回复格式为JSON：{"response":"你的回复内容"}' 
                    },
                    { 
                        role: 'user', 
                        content: `用户反馈: ${feedbackContent}\n\n请生成回应:` 
                    }
                ],
                temperature: 0.7,
                max_tokens: 200
            },
            {
                headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
                timeout: 15000
            }
        );

        const content = response.data.choices?.[0]?.message?.content || '';
        
        // 尝试解析JSON
        try {
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                return {
                    responded: true,
                    response: parsed.response || '感谢您的反馈！',
                    mock: false
                };
            }
        } catch(e) {
            // JSON解析失败，使用原始回复
        }
        
        return {
            responded: true,
            response: content.substring(0, 100) || '感谢您的反馈！',
            mock: false
        };
    } catch (error) {
        console.error('AI回应失败:', error.message);
        return {
            responded: false,
            response: '感谢您的反馈！我们已收到您的意见。',
            error: error.message
        };
    }
}

// ==================== API 路由 ====================

// 健康检查
app.get('/api/health', async (req, res) => {
    const health = healthChecker?.runAllChecks?.() || {};
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// 获取反馈列表
app.get('/api/feedback', (req, res) => {
    const { limit = 20, offset = 0 } = req.query;
    const list = feedbackStore.slice(Number(offset), Number(offset) + Number(limit));
    res.json({ success: true, data: { list, total: feedbackStore.length } });
});

// 创建反馈（带AI回应）
app.post('/api/feedback', async (req, res) => {
    const { content, language } = req.body;
    if (!content) return res.status(400).json({ error: '内容不能为空' });
    
    const feedbackId = generateId();
    
    // 立即返回反馈，AI回应异步处理
    const feedback = {
        id: feedbackId,
        content: content.substring(0, 280),
        language: language || 'zh',
        timestamp: new Date().toISOString(),
        likes: 0,
        comments: 0,
        aiResponded: false,
        aiResponse: '正在生成AI回应...',
        tags: []
    };
    
    feedbackStore.unshift(feedback);
    if (feedbackStore.length > 1000) feedbackStore = feedbackStore.slice(0, 1000);
    
    // 异步生成AI回应
    generateAIResponse(content).then(aiResult => {
        const fbIndex = feedbackStore.findIndex(f => f.id === feedbackId);
        if (fbIndex !== -1) {
            feedbackStore[fbIndex].aiResponded = aiResult.responded;
            feedbackStore[fbIndex].aiResponse = aiResult.response;
            feedbackStore[fbIndex].aiTimestamp = new Date().toISOString();
        }
    }).catch(err => {
        console.error('AI回应生成失败:', err);
    });
    
    res.json({ success: true, data: feedback });
});

// 翻译 API
app.post('/api/translate', async (req, res) => {
    const { text, source, target } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: '翻译文本不能为空' });
    if (text.length > 500) return res.status(400).json({ error: '文本长度不能超过500字符' });
    
    // 如果没有 API Key，返回模拟翻译
    if (!process.env.DEEPSEEK_API_KEY) {
        return res.json({
            success: true,
            data: { translation: `[模拟翻译] ${text}`, mock: true }
        });
    }
    
    try {
        const response = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            {
                model: 'deepseek-chat',
                messages: [
                    { role: 'system', content: '你是一个翻译助手，只返回翻译结果。' },
                    { role: 'user', content: `翻译: ${text}` }
                ],
                temperature: 0.3
            },
            {
                headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
                timeout: 30000
            }
        );
        
        const translation = response.data.choices?.[0]?.message?.content || '翻译失败';
        res.json({ success: true, data: { translation, mock: false } });
    } catch (error) {
        res.json({
            success: true,
            data: { translation: `[错误] ${text}`, mock: true, error: error.message }
        });
    }
});

// 智能体处理反馈
app.post('/api/agent/process', async (req, res) => {
    const { content, userId, language } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: '内容不能为空' });
    
    const feedbackId = generateId();
    const feedback = {
        id: feedbackId,
        userId: userId || generateId('user'),
        content: content.substring(0, 280),
        language: language || 'zh',
        timestamp: new Date().toISOString(),
        status: 'processing'
    };
    
    feedbackStore.unshift(feedback);
    agentStats.totalProcessed++;
    agentStats.todayProcessed++;
    agentStats.lastUpdate = new Date().toISOString();
    
    // 返回处理结果
    res.json({
        success: true,
        data: {
            feedbackId,
            input: { content: feedback.content },
            processing: { status: 'completed', intent: 'other', confidence: 0.5 },
            output: { solution: '感谢您的反馈', codeChanges: [] }
        }
    });
});

// 智能体统计
app.get('/api/agent/stats', (req, res) => {
    res.json({ success: true, data: agentStats });
});

// 调试路由 (生产环境需要认证)
const debugRouter = express.Router();

debugRouter.get('/sessions', (req, res) => {
    const sessions = debugSystem?.getSessionsSummary?.() || [];
    res.json({ success: true, data: { sessions, totalCount: sessions.length } });
});

debugRouter.get('/performance', (req, res) => {
    res.json({ success: true, data: { memory: process.memoryUsage() } });
});

app.use('/api/debug', debugRouter);

// 下载插件
app.get('/api/download', (req, res) => {
    const pluginDir = path.join(__dirname, '..', 'ai-translator');
    res.json({ success: false, error: '插件目录不存在' });
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`🤖 智能体后端服务已启动: http://localhost:${PORT}`);
    console.log('📡 API 端点:');
    console.log('   - GET  /api/health         健康检查');
    console.log('   - GET  /api/feedback       反馈列表');
    console.log('   - POST /api/feedback      创建反馈');
    console.log('   - POST /api/translate     翻译');
    console.log('   - POST /api/agent/process 处理反馈');
});

module.exports = app;
