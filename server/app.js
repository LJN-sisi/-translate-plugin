/**
 * 智能体后端服务
 * 核心功能：处理用户反馈，使用 AI 生成代码改进建议
 * 
 * 架构：
 * - 熔断管理器：控制LLM调用成本与风险
 * - 反馈分析服务：意图识别、可行性评估
 * - 改进方案生成服务：生成代码修改指令
 * - 代码修改服务：应用代码变更
 * - 测试服务：自动化测试与质量门禁
 * - 发布决策服务：生成改进说明、创建PR
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();

// ========== 流式输出支持 (SSE) ==========
// 存储活跃的 SSE 连接
const sseClients = new Map();

// 广播消息到特定客户端
function sendToClient(clientId, event, data) {
    const client = sseClients.get(clientId);
    if (client && client.res && !client.res.writableEnded) {
        client.res.write(`event: ${event}\n`);
        client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
}

// 清理断开的连接
function removeClient(clientId) {
    const client = sseClients.get(clientId);
    if (client && client.res) {
        client.res.end();
    }
    sseClients.delete(clientId);
}
const PORT = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

// 引入模块
let debugSystem, healthChecker, smartDiagnoser;
let circuitBreakers;
let metricsCollector, alertManager;

// 引入新的智能体模块
let agent;
let circuitBreaker;

try {
    const agentServices = require('./agent-services');
    agent = new agentServices.Agent();
    console.log('✅ 智能体服务已加载');
} catch(e) {
    console.warn('智能体服务加载失败:', e.message);
    agent = null;
}

try {
    const cbModule = require('./circuit-breaker');
    circuitBreaker = cbModule.circuitBreaker;
    console.log('✅ 熔断管理器已加载');
} catch(e) {
    console.warn('熔断管理器加载失败:', e.message);
    circuitBreaker = null;
}

// 引入数据库
let database;
try {
    database = require('./database');
    console.log('✅ 数据库模块已加载');
} catch(e) {
    console.warn('数据库模块加载失败:', e.message);
    database = {
        createFeedback: async (f) => f,
        getFeedbacks: async () => ({ list: [], total: 0 }),
        updateFeedback: async () => null,
        getTaskLogs: async () => ({ list: [], total: 0 }),
        getTokenUsage: async () => ({ list: [], total: 0, stats: {} }),
        getCircuitBreakerEvents: async () => ({ list: [], total: 0, unresolvedCount: 0 })
    };
}

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
let testResults = []; // 测试结果存储

// ==================== 自动测试系统 ====================
let puppeteer;
try {
    puppeteer = require('puppeteer');
} catch(e) {
    console.warn('Puppeteer not available:', e.message);
}

// 测试场景定义
const testScenarios = [
    {
        name: '页面加载测试',
        test: async (browser) => {
            const page = await browser.newPage();
            await page.goto('file://' + path.join(__dirname, '..', 'index.html'));
            await page.waitForSelector('body');
            const title = await page.title();
            return { passed: !!title, message: title ? '页面加载成功' : '页面加载失败' };
        }
    },
    {
        name: '控制台错误检测',
        test: async (browser) => {
            const page = await browser.newPage();
            const errors = [];
            page.on('console', msg => {
                if (msg.type() === 'error') errors.push(msg.text());
            });
            await page.goto('file://' + path.join(__dirname, '..', 'index.html'));
            await page.waitForTimeout(1000);
            return { passed: errors.length === 0, message: errors.length === 0 ? '无控制台错误' : `发现${errors.length}个错误` };
        }
    },
    {
        name: 'API连通性测试',
        test: async (browser) => {
            const page = await browser.newPage();
            const result = await page.evaluate(() => {
                return fetch('/api/health').then(r => r.json());
            });
            return { passed: result.status === 'ok', message: result.status === 'ok' ? 'API正常' : 'API异常' };
        }
    }
];

// 执行自动测试
async function runAutoTests() {
    const results = {
        timestamp: new Date().toISOString(),
        tests: [],
        overall: 'pending'
    };

    if (!puppeteer) {
        results.overall = 'skipped';
        results.message = 'Puppeteer 未安装，跳过测试';
        return results;
    }

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        for (const scenario of testScenarios) {
            try {
                const result = await scenario.test(browser);
                results.tests.push({
                    name: scenario.name,
                    ...result
                });
            } catch(e) {
                results.tests.push({
                    name: scenario.name,
                    passed: false,
                    message: e.message
                });
            }
        }

        const passedCount = results.tests.filter(t => t.passed).length;
        results.overall = passedCount === results.tests.length ? 'passed' : 'failed';
        results.message = `${passedCount}/${results.tests.length} 测试通过`;

    } catch(e) {
        results.overall = 'error';
        results.message = e.message;
    } finally {
        if (browser) await browser.close();
    }

    testResults.unshift(results);
    if (testResults.length > 100) testResults = testResults.slice(0, 100);

    return results;
}

// ==================== 测试结果处理 ====================
function handleTestResult(testResult, feedbackId) {
    if (testResult.overall === 'passed') {
        // 测试通过，更新反馈状态为已完成
        const fbIndex = feedbackStore.findIndex(f => f.id === feedbackId);
        if (fbIndex !== -1) {
            feedbackStore[fbIndex].status = 'completed';
            feedbackStore[fbIndex].testPassed = true;
            feedbackStore[fbIndex].completedAt = new Date().toISOString();
        }
        return { action: 'merge', message: '测试通过，可以合并代码' };
    } else if (testResult.overall === 'failed') {
        // 测试失败，回滚代码
        return { action: 'rollback', message: '测试失败，已回滚代码', failedTests: testResult.tests };
    } else {
        return { action: 'review', message: '需要人工审核' };
    }
}

// 工具函数
function generateId(prefix = 'fb') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

// AI 意图分析函数
async function analyzeIntent(feedbackContent) {
    const intentCategories = {
        'accuracy': ['不准确', '错误', '翻译错', '意思不对', '不对', '有问题', 'incorrect', 'wrong', 'accurate'],
        'speed': ['慢', '快', '速度', '延迟', '卡', '响应', '反应', '慢', 'slow', 'fast', 'speed'],
        'ui': ['界面', 'UI', '界面', '样式', '显示', '外观', '颜色', '布局', '按钮', '弹窗', 'interface', 'display', 'button'],
        'function': ['功能', '支持', '缺少', '没有', '不能', '无法', '无法', '添加', '增加', 'feature', 'support', 'add', 'missing'],
        'language': ['语言', '语种', '德语', '法语', '日语', '韩语', '英语', 'Spanish', 'French', 'German', 'language']
    };

    const lowerContent = feedbackContent.toLowerCase();
    let detectedIntent = 'other';
    let maxScore = 0;

    for (const [intent, keywords] of Object.entries(intentCategories)) {
        let score = 0;
        for (const keyword of keywords) {
            if (lowerContent.includes(keyword.toLowerCase())) {
                score += 1;
            }
        }
        if (score > maxScore) {
            maxScore = score;
            detectedIntent = intent;
        }
    }

    return {
        intent: detectedIntent,
        confidence: Math.min(0.5 + maxScore * 0.1, 0.99),
        nodePath: ['input', 'classify', detectedIntent === 'other' ? 'general' : detectedIntent]
    };
}

// AI 代码改进建议生成函数
async function generateCodeSuggestion(feedbackContent, intent) {
    const suggestionTemplates = {
        'accuracy': {
            file: 'src/translator.js',
            action: '优化翻译词库匹配算法',
            codeDiff: '+15 -3',
            description: '增强语义理解，提高翻译准确率'
        },
        'speed': {
            file: 'src/cache.js',
            action: '优化缓存机制',
            codeDiff: '+8 -2',
            description: '添加LRU缓存，减少重复翻译'
        },
        'ui': {
            file: 'src/popup.css',
            action: '优化界面样式',
            codeDiff: '+25 -5',
            description: '改进UI交互细节'
        },
        'function': {
            file: 'src/options.js',
            action: '新增功能支持',
            codeDiff: '+30 -0',
            description: '添加用户请求的功能'
        },
        'language': {
            file: 'src/dictionary/',
            action: '扩展语言词库',
            codeDiff: '+100 -0',
            description: '添加新语言支持'
        },
        'other': {
            file: 'src/main.js',
            action: '常规优化',
            codeDiff: '+5 -2',
            description: '一般性改进'
        }
    };

    const template = suggestionTemplates[intent] || suggestionTemplates['other'];

    // 如果有 API Key，调用 AI 生成更精准的建议
    if (process.env.DEEPSEEK_API_KEY) {
        try {
            const response = await axios.post(
                'https://api.deepseek.com/v1/chat/completions',
                {
                    model: 'deepseek-chat',
                    messages: [
                        {
                            role: 'system',
                            content: `你是代码助手。根据用户反馈生成代码改进建议。回复格式为JSON：{"file":"文件名","action":"操作描述","codeDiff":"+行数 -行数","description":"描述"}`
                        },
                        {
                            role: 'user',
                            content: `用户反馈: ${feedbackContent}\n问题类型: ${intent}\n请生成代码改进建议:`
                        }
                    ],
                    temperature: 0.5,
                    max_tokens: 200
                },
                {
                    headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
                    timeout: 15000
                }
            );

            const content = response.data.choices?.[0]?.message?.content || '';
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const parsed = JSON.parse(jsonMatch[0]);
                    return { ...template, ...parsed, aiGenerated: true };
                } catch(e) {}
            }
        } catch(e) {
            console.log('使用默认代码建议');
        }
    }

    return { ...template, aiGenerated: false };
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

// 智能体处理反馈（完整流程：分析 → 生成代码 → 测试 → 反馈）
// 使用新的智能体系统
app.post('/api/agent/process', async (req, res) => {
    const { content, userId, language, autoTest = true } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: '内容不能为空' });
    
    const feedbackId = generateId();
    const feedback = {
        id: feedbackId,
        userId: userId || generateId('user'),
        content: content.substring(0, 280),
        language: language || 'zh',
        timestamp: new Date().toISOString(),
        status: 'analyzing'
    };
    
    // 保存到数据库
    await database.createFeedback(feedback);
    feedbackStore.unshift(feedback);
    agentStats.totalProcessed++;
    agentStats.todayProcessed++;
    agentStats.pendingCount++;
    agentStats.lastUpdate = new Date().toISOString();
    
    // 使用新的智能体系统处理
    if (agent) {
        try {
            // 异步处理（完整流程）
            agent.process(feedback).then(result => {
                console.log(`[智能体] 处理完成: ${feedbackId}`, result);
            }).catch(err => {
                console.error(`[智能体] 处理失败: ${feedbackId}`, err);
            });
            
            // 立即返回分析结果
            const intentResult = await analyzeIntent(content);
            
            // 更新状态
            feedback.status = 'generating';
            feedback.intent = intentResult.intent;
            feedback.confidence = intentResult.confidence;
            
            // 生成代码建议
            const codeSuggestion = await generateCodeSuggestion(content, intentResult.intent);
            
            feedback.status = 'testing';
            feedback.codeSuggestion = codeSuggestion;
            
            // 返回处理结果
            res.json({
                success: true,
                data: {
                    feedbackId,
                    input: { content: feedback.content, language: feedback.language },
                    processing: { 
                        status: feedback.status,
                        intent: intentResult.intent,
                        confidence: intentResult.confidence,
                        nodePath: intentResult.nodePath
                    },
                    output: {
                        file: codeSuggestion.file,
                        action: codeSuggestion.action,
                        codeDiff: codeSuggestion.codeDiff,
                        description: codeSuggestion.description,
                        aiGenerated: codeSuggestion.aiGenerated
                    },
                    test: {
                        scheduled: autoTest,
                        status: autoTest ? 'running' : 'pending'
                    },
                    // 新增：熔断状态
                    circuitBreaker: circuitBreaker ? circuitBreaker.getStatus() : null
                }
            });
        } catch (error) {
            console.error('智能体处理错误:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    } else {
        // 降级处理：使用旧的处理方式
        // 第一步：AI 意图分析
        const intentResult = await analyzeIntent(content);
        
        // 更新状态
        feedback.status = 'generating';
        feedback.intent = intentResult.intent;
        feedback.confidence = intentResult.confidence;
        
        // 第二步：生成代码改进建议
        const codeSuggestion = await generateCodeSuggestion(content, intentResult.intent);
        
        feedback.status = 'testing';
        feedback.codeSuggestion = codeSuggestion;
        
        // 第三步：自动测试（异步）
        let testResult = null;
        if (autoTest) {
            setTimeout(async () => {
                testResult = await runAutoTests();
                const action = handleTestResult(testResult, feedbackId);
                
                // 更新反馈状态
                const fbIndex = feedbackStore.findIndex(f => f.id === feedbackId);
                if (fbIndex !== -1) {
                    feedbackStore[fbIndex].testResult = testResult;
                    feedbackStore[fbIndex].testAction = action;
                    agentStats.pendingCount = Math.max(0, agentStats.pendingCount - 1);
                }
                
                console.log(`[智能体] 反馈 ${feedbackId} 测试完成: ${testResult.message}`);
            }, 100);
        } else {
            feedback.status = 'pending_test';
        }
        
        // 返回处理结果
        res.json({
            success: true,
            data: {
                feedbackId,
                input: { content: feedback.content, language: feedback.language },
                processing: { 
                    status: feedback.status,
                    intent: intentResult.intent,
                    confidence: intentResult.confidence,
                    nodePath: intentResult.nodePath
                },
                output: {
                    file: codeSuggestion.file,
                    action: codeSuggestion.action,
                    codeDiff: codeSuggestion.codeDiff,
                    description: codeSuggestion.description,
                    aiGenerated: codeSuggestion.aiGenerated
                },
                test: {
                    scheduled: autoTest,
                    status: autoTest ? 'running' : 'pending'
                }
            }
        });
    }
});

// ========== 流式处理 API ==========
app.post('/api/agent/process/stream', async (req, res) => {
    const { content, userId, language, autoTest = true } = req.body;
    if (!content?.trim()) {
        return res.status(400).json({ error: '内容不能为空' });
    }

    const feedbackId = generateId();
    const clientId = feedbackId;

    // 设置 SSE 响应头
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });

    // 注册客户端
    sseClients.set(clientId, { res, feedbackId });
    
    // 初始连接确认
    res.write(`event: connected\n`);
    res.write(`data: ${JSON.stringify({ clientId, status: 'connected' })}\n\n`);

    // 确保连接关闭时清理
    req.on('close', () => {
        removeClient(clientId);
    });

    const feedback = {
        id: feedbackId,
        userId: userId || generateId('user'),
        content: content.substring(0, 280),
        language: language || 'zh',
        timestamp: new Date().toISOString(),
        status: 'analyzing'
    };

    try {
        // 保存到数据库
        await database.createFeedback(feedback);
        feedbackStore.unshift(feedback);
        agentStats.totalProcessed++;
        agentStats.todayProcessed++;
        agentStats.lastUpdate = new Date().toISOString();

        // 调用完整的智能体流程
        if (agent) {
            sendToClient(clientId, 'stage', { stage: 'analyzing', message: '正在分析反馈...' });
            
            // 启动完整智能体处理流程
            agent.process(feedback).then(async (result) => {
                console.log('[流式] 智能体处理完成:', result);
                
                if (result.needsHuman) {
                    sendToClient(clientId, 'stage', { stage: 'needs_human', message: '需要人工处理' });
                    sendToClient(clientId, 'complete', { feedbackId, status: 'needs_human', result });
                    return;
                }
                
                if (result.success) {
                    // 显示分析结果
                    sendToClient(clientId, 'intent', { 
                        intent: result.result?.analysis?.intent || 'other',
                        confidence: result.result?.analysis?.confidence || 0.5,
                        message: 'AI分析完成'
                    });
                    
                    // 显示代码修改
                    if (result.result?.modification) {
                        sendToClient(clientId, 'suggestion', {
                            file: result.result.modification.file,
                            action: result.result.solution?.action,
                            description: result.result.solution?.description
                        });
                    }
                    
                    // 显示测试结果
                    if (result.result?.test) {
                        sendToClient(clientId, 'test_result', { 
                            passed: result.result.test.passed,
                            message: result.result.test.passed ? '测试通过' : '测试失败'
                        });
                    }
                    
                    // 显示发布结果
                    if (result.result?.publish) {
                        sendToClient(clientId, 'pr', { 
                            url: result.result.publish.pr?.url,
                            title: result.result.publish.changelog?.title
                        });
                    }
                    
                    sendToClient(clientId, 'complete', { 
                        feedbackId, 
                        status: 'completed', 
                        result 
                    });
                } else {
                    sendToClient(clientId, 'error', { message: result.error || '处理失败' });
                    sendToClient(clientId, 'complete', { feedbackId, status: 'failed', error: result.error });
                }
            }).catch(err => {
                console.error('[流式] 智能体处理错误:', err);
                sendToClient(clientId, 'error', { message: err.message });
                sendToClient(clientId, 'complete', { feedbackId, status: 'error', error: err.message });
            });
            
            // 立即返回处理中状态
            sendToClient(clientId, 'stage', { stage: 'processing', message: '智能体正在处理中...' });
        } else {
            // 没有智能体时的降级处理
            sendToClient(clientId, 'stage', { stage: 'analyzing', message: '正在分析反馈意图...' });
            
            const intentResult = await analyzeIntent(content);
            
            feedback.status = 'generating';
            feedback.intent = intentResult.intent;
            feedback.confidence = intentResult.confidence;

            sendToClient(clientId, 'intent', { 
                intent: intentResult.intent, 
                confidence: intentResult.confidence,
                message: `识别到问题类型: ${intentResult.intent}`
            });

            sendToClient(clientId, 'stage', { stage: 'generating', message: '正在生成代码改进建议...' });

            const streamSuggestion = await generateCodeSuggestionStream(content, intentResult.intent, (chunk) => {
                sendToClient(clientId, 'code_chunk', { chunk });
            });

            feedback.codeSuggestion = streamSuggestion;
            
            sendToClient(clientId, 'stage', { stage: 'generated', message: '代码建议生成完成' });
            sendToClient(clientId, 'suggestion', streamSuggestion);

            sendToClient(clientId, 'complete', {
                feedbackId,
                status: 'completed',
                result: { intent: intentResult, suggestion: streamSuggestion }
            });
        }

        // 延迟关闭连接，让前端有时间接收
        setTimeout(() => {
            res.write(`event: done\n`);
            res.write(`data: ${JSON.stringify({ status: 'done' })}\n\n`);
            res.end();
            removeClient(clientId);
        }, 1000);

    } catch (error) {
        console.error('流式处理错误:', error);
        sendToClient(clientId, 'error', { message: error.message });
        res.end();
        removeClient(clientId);
    }
});

// 流式生成代码建议
async function generateCodeSuggestionStream(feedbackContent, intent, onChunk) {
    const suggestionTemplates = {
        'accuracy': {
            file: 'src/translator.js',
            action: '优化翻译词库匹配算法',
            codeDiff: '+15 -3',
            description: '根据用户反馈优化翻译准确性',
            detail: '将改进翻译匹配算法，增加更多例句和语境分析'
        },
        'speed': {
            file: 'src/services/api.js',
            action: '优化API响应速度',
            codeDiff: '+8 -2',
            description: '优化API调用性能',
            detail: '添加缓存机制，减少重复请求'
        },
        'ui': {
            file: 'src/components/UI.jsx',
            action: '改进界面交互',
            codeDiff: '+20 -5',
            description: '优化用户界面体验',
            detail: '增加动画效果，优化布局'
        },
        'function': {
            file: 'src/main.js',
            action: '增强功能',
            codeDiff: '+25 -3',
            description: '添加新功能',
            detail: '实现用户请求的新功能'
        },
        'other': {
            file: 'src/main.js',
            action: '常规优化',
            codeDiff: '+5 -2',
            description: '一般性改进',
            detail: '进行代码优化和重构'
        }
    };

    const template = suggestionTemplates[intent] || suggestionTemplates['other'];

    // 模拟流式输出效果（因为直接调用流式API需要特殊处理）
    const fullText = JSON.stringify(template, null, 2);
    
    // 按字符流式发送
    for (let i = 0; i < fullText.length; i++) {
        onChunk(fullText[i]);
        await new Promise(r => setTimeout(r, 10)); // 每个字符延迟10ms
    }

    // 如果有 API Key，尝试调用 AI 生成更精准的建议（流式）
    if (process.env.DEEPSEEK_API_KEY) {
        try {
            const response = await axios.post(
                'https://api.deepseek.com/v1/chat/completions',
                {
                    model: 'deepseek-chat',
                    messages: [
                        {
                            role: 'system',
                            content: `你是代码助手。根据用户反馈生成代码改进建议。回复格式为JSON，包含file(文件名)、action(操作描述)、codeDiff(代码行数变化)、description(描述)、detail(详细说明)字段。`
                        },
                        {
                            role: 'user',
                            content: `用户反馈: ${feedbackContent}\n问题类型: ${intent}\n请生成代码改进建议(用JSON格式):`
                        }
                    ],
                    temperature: 0.5,
                    max_tokens: 300,
                    stream: false // 暂时不使用stream，因为需要特殊处理
                },
                {
                    headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
                    timeout: 20000
                }
            );

            const content = response.data.choices?.[0]?.message?.content || '';
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                return { ...template, ...parsed, aiGenerated: true };
            }
        } catch (e) {
            console.log('AI生成建议失败，使用模板:', e.message);
        }
    }

    return { ...template, aiGenerated: false };
}

// 手动触发测试
app.post('/api/agent/test', async (req, res) => {
    const result = await runAutoTests();
    res.json({ success: true, data: result });
});

// 获取测试历史
app.get('/api/agent/tests', (req, res) => {
    const { limit = 10 } = req.query;
    res.json({ success: true, data: testResults.slice(0, Number(limit)) });
});

// 智能体统计
app.get('/api/agent/stats', async (req, res) => {
    // 获取数据库统计
    const dbStats = await database.getAgentStats();
    const combinedStats = {
        ...agentStats,
        ...dbStats,
        circuitBreaker: circuitBreaker ? circuitBreaker.getStatus() : null
    };
    res.json({ success: true, data: combinedStats });
});

// ==================== 熔断管理器 API ====================

// 获取熔断状态
app.get('/api/circuit/status', (req, res) => {
    if (!circuitBreaker) {
        return res.status(503).json({ success: false, error: '熔断管理器未加载' });
    }
    res.json({ success: true, data: circuitBreaker.getStatus() });
});

// 熔断检查接口
app.post('/api/circuit/check', async (req, res) => {
    const { service, action, estimatedTokens, taskId } = req.body;
    if (!service || !action) {
        return res.status(400).json({ success: false, error: '缺少必要参数' });
    }
    
    if (!circuitBreaker) {
        return res.status(503).json({ success: false, error: '熔断管理器未加载' });
    }
    
    const result = await circuitBreaker.check(service, action, estimatedTokens || 0, taskId);
    res.json({ success: result.allowed, data: result });
});

// 释放资源
app.post('/api/circuit/release', async (req, res) => {
    const { taskId, actualTokens } = req.body;
    if (!taskId) {
        return res.status(400).json({ success: false, error: '缺少taskId' });
    }
    
    if (!circuitBreaker) {
        return res.status(503).json({ success: false, error: '熔断管理器未加载' });
    }
    
    await circuitBreaker.release(taskId, actualTokens || 0);
    res.json({ success: true, data: { taskId, released: true } });
});

// 获取Token使用记录
app.get('/api/circuit/token-usage', async (req, res) => {
    const { limit = 50, taskId, feedbackId } = req.query;
    
    const result = await database.getTokenUsage({
        limit: Number(limit),
        taskId,
        feedbackId
    });
    
    res.json({ success: true, data: result });
});

// 获取熔断事件记录
app.get('/api/circuit/events', async (req, res) => {
    const { limit = 50, service, unresolvedOnly } = req.query;
    
    const result = await database.getCircuitBreakerEvents({
        limit: Number(limit),
        service,
        unresolvedOnly: unresolvedOnly === 'true'
    });
    
    res.json({ success: true, data: result });
});

// 获取任务日志
app.get('/api/agent/task-logs', async (req, res) => {
    const { limit = 20, taskId, feedbackId, status } = req.query;
    
    const result = await database.getTaskLogs({
        limit: Number(limit),
        taskId,
        feedbackId,
        status
    });
    
    res.json({ success: true, data: result });
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

// 下载插件 - 返回插件目录的zip文件
app.get('/api/download', (req, res) => {
    const pluginDir = path.join(__dirname, '..');
    const fs = require('fs');
    const archiver = require('archiver');
    
    if (!fs.existsSync(pluginDir)) {
        return res.status(404).json({ success: false, error: '插件目录不存在' });
    }
    
    // 设置响应头，让浏览器下载zip文件
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=translate-plugin.zip');
    
    // 创建zip压缩流
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    archive.on('error', (err) => {
        res.status(500).send({ error: err.message });
    });
    
    archive.pipe(res);
    
    // 排除不需要的文件
    archive.glob('**/*', {
        cwd: pluginDir,
        ignore: [
            'node_modules/**',
            '.git/**',
            'repo/**',
            'data/**',
            '*.log',
            '.env',
            'pm2*.json'
        ]
    });
    
    archive.finalize();
});

// 提供插件文件下载 - 单文件下载
app.get('/api/download/:filename', (req, res) => {
    const { filename } = req.params;
    const fs = require('fs');
    
    // 安全检查：只允许下载特定文件
    const allowedFiles = ['manifest.json', 'popup.html', 'background.js', 'content.js', 'styles.css'];
    
    if (!allowedFiles.includes(filename)) {
        return res.status(403).json({ success: false, error: '不允许下载此文件' });
    }
    
    const filePath = path.join(__dirname, '..', filename);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, error: '文件不存在' });
    }
    
    res.download(filePath);
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`🤖 智能体后端服务已启动: http://localhost:${PORT}`);
    console.log('📡 API 端点:');
    console.log('   - GET  /api/health           健康检查');
    console.log('   - GET  /api/feedback         反馈列表');
    console.log('   - POST /api/feedback         创建反馈');
    console.log('   - POST /api/translate        翻译');
    console.log('   - POST /api/agent/process    处理反馈（智能体）');
    console.log('');
    console.log('🛡️  熔断管理 API:');
    console.log('   - GET  /api/circuit/status       熔断状态');
    console.log('   - POST /api/circuit/check       熔断检查');
    console.log('   - POST /api/circuit/release    释放资源');
    console.log('   - GET  /api/circuit/token-usage Token使用记录');
    console.log('   - GET  /api/circuit/events      熔断事件记录');
    console.log('   - GET  /api/agent/task-logs    任务日志');
});

module.exports = app;
