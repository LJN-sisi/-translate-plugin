// ============================================
// API Configuration - 智能体后端服务
// ============================================
// 使用相对路径，自动适配当前服务器
const API_BASE = '';

const API_CONFIG = {
    // 意见相关 API
    feedback: {
        list: '/api/feedback',           // GET 获取意见列表
        create: '/api/feedback',         // POST 创建意见
        support: '/api/feedback/:id/support',  // POST 支持意见
        replies: '/api/feedback/:id/replies',  // GET/POST 回应
    },
    // 智能体相关 API - DeepSeek AI 驱动
    agent: {
        process: '/api/agent/process',   // POST 处理反馈（核心功能）
        stream: '/api/agent/process/stream', // SSE 流式处理
        stats: '/api/agent/stats',       // GET 处理统计
        queue: '/api/agent/queue',       // GET 处理队列
        // 自动化迭代 API
        autoIterate: '/api/agent/auto-iterate',       // POST 触发自动化迭代
        processAndIterate: '/api/agent/process-and-iterate', // POST 一键处理并迭代
        iteration: '/api/agent/iteration',  // GET 获取迭代状态
        githubStatus: '/api/agent/github-status', // GET GitHub 配置状态
    },
    // 管理后台 API
    admin: {
        login: '/api/admin/login',       // POST 登录
        feedback: '/api/admin/feedback', // GET 管理端意见列表
        stats: '/api/admin/stats',      // GET 统计数据
    },
    // 进化轨迹 API
    timeline: {
        list: '/api/timeline',           // GET 获取进化记录列表
        create: '/api/timeline',         // POST 创建新记录（智能体触发）
    },
    // GitHub API
    github: {
        releases: 'https://api.github.com/repos/:repo/releases',
        tags: 'https://api.github.com/repos/:repo/tags',
    }
};

// 真实 API 调用
const API = {
    async request(endpoint, options = {}) {
        const url = API_BASE + endpoint;
        console.log(`[API] ${options.method || 'GET'} ${url}`, options.body || '');
        try {
            const response = await fetch(url, {
                ...options,
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            });
            return await response.json();
        } catch (error) {
            console.error('[API] 请求失败:', error);
            return { success: false, error: error.message };
        }
    }
};

// ============================================
// Data Storage
// ============================================
const DB = {
    feedbacks: [],
    processingQueue: [],
    commits: 0
};

// Generate user hash
function generateUserHash() {
    return Math.random().toString(16).substring(2, 6).toUpperCase();
}

// Format timestamp
function formatTime(timestamp) {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);

    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    if (hours < 24) return `${hours}小时前`;
    return new Date(timestamp).toLocaleDateString();
}

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    initNavbar();
    initFeedbackInput();
    initFilterTabs();
    renderFeedbackList();
    initAgent();  // 初始化智能体（初始为空）
    initVersionSelector();  // 初始化版本选择器
    updateStats();
});

// Navigation scroll effect
function initNavbar() {
    const navbar = document.getElementById('navbar');
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const mobileMenu = document.getElementById('mobileMenu');

    window.addEventListener('scroll', () => {
        if (window.scrollY > 50) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }
    });

    mobileMenuBtn.addEventListener('click', () => {
        mobileMenu.classList.toggle('active');
    });

    mobileMenu.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => {
            mobileMenu.classList.remove('active');
        });
    });
}

// ============================================
// Feedback Input
// ============================================
function initFeedbackInput() {
    const input = document.getElementById('feedbackInput');
    const submitBtn = document.getElementById('submitFeedback');
    const charCount = document.getElementById('charCount');

    input.addEventListener('input', () => {
        const len = input.value.length;
        charCount.textContent = len;
        submitBtn.disabled = len === 0;

        if (len > 280) {
            input.value = input.value.substring(0, 280);
        }
    });

    submitBtn.addEventListener('click', () => {
        if (input.value.trim()) {
            submitFeedback(input.value.trim());
            input.value = '';
            charCount.textContent = '0';
            submitBtn.disabled = true;
        }
    });

    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
            submitBtn.click();
        }
    });
}

// Submit new feedback
async function submitFeedback(content) {
    const newFeedback = {
        id: Date.now(),
        userHash: generateUserHash(),
        content: content,
        timestamp: Date.now(),
        likes: 0,
        replies: 0,
        replyList: [],
        status: 'pending',
        tags: detectTags(content),
        aiResponded: false
    };

    // 保存到本地数据库
    DB.feedbacks.unshift(newFeedback);
    
    // 渲染反馈列表
    renderFeedbackList();
    updateStats();
    
    // 调用 API 保存到后端
    await API.request(API_CONFIG.feedback.create, {
        method: 'POST',
        body: JSON.stringify(newFeedback)
    });

    // 触发智能体处理
    processFeedback(newFeedback);
}

// Detect tags from content
function detectTags(content) {
    const tags = [];
    const lower = content.toLowerCase();

    if (lower.includes('德语') || lower.includes('german')) tags.push('准确性');
    if (lower.includes('日语') || lower.includes('japanese')) tags.push('准确性');
    if (lower.includes('法语') || lower.includes('french')) tags.push('准确性');
    if (lower.includes('速度') || lower.includes('slow')) tags.push('速度');
    if (lower.includes('ui') || lower.includes('界面')) tags.push('UI');
    if (lower.includes('离线')) tags.push('功能');

    return tags.length > 0 ? tags : ['其他'];
}

// Filter tabs
function initFilterTabs() {
    const tabs = document.querySelectorAll('.filter-tab');
    let currentFilter = 'all';

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentFilter = tab.dataset.filter;
            renderFeedbackList(currentFilter);
        });
    });
}

// Render feedback list
function renderFeedbackList(filter = 'all') {
    const container = document.getElementById('feedbackList');
    if (!container) return;
    
    let feedbacks = [...DB.feedbacks];

    if (filter === 'pending') {
        feedbacks = feedbacks.filter(f => f.status === 'pending');
    } else if (filter === 'processed') {
        feedbacks = feedbacks.filter(f => f.status === 'processed');
    }

    if (feedbacks.length === 0) {
        container.innerHTML = '<div class="empty-state">还没有反馈，来发表第一条进化驱动吧</div>';
        return;
    }

    container.innerHTML = feedbacks.map(f => `
        <div class="feedback-card" data-id="${f.id}">
            <div class="feedback-header">
                <span class="feedback-user">用户_${f.userHash}</span>
                <span class="feedback-time">· ${formatTime(f.timestamp)}</span>
                ${f.aiResponded ? '<span class="ai-badge">🤖 AI回应</span>' : ''}
            </div>
            <div class="feedback-content">${escapeHtml(f.content)}</div>
            ${f.aiResponse ? `
            <div class="ai-response">
                <div class="ai-response-header">
                    <span class="ai-icon">🤖</span>
                    <span>智能回复</span>
                </div>
                <div class="ai-response-content">${escapeHtml(f.aiResponse)}</div>
            </div>
            ` : ''}
            <div class="feedback-actions">
                <button class="action-btn like-btn" data-id="${f.id}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 19V5M5 12l7-7 7 7"/>
                    </svg>
                    <span>${f.likes}</span>
                </button>
                <button class="action-btn reply-btn" data-id="${f.id}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                    <span>${f.replies}条回应</span>
                </button>
                ${f.status === 'processed' ? '<span class="status-badge">✓ 已处理</span>' : ''}
            </div>
            <div class="reply-section" id="reply-${f.id}">
                ${f.replyList && f.replyList.length > 0 ? f.replyList.map(r => `
                    <div class="reply-item ${r.isAI ? 'ai-reply' : ''}">
                        <div class="reply-header">
                            <span class="reply-user">${r.isAI ? '🤖 AI助手' : '用户_' + r.userHash}</span>
                            <span class="reply-time">${formatTime(r.timestamp)}</span>
                        </div>
                        <div class="reply-content">${escapeHtml(r.content)}</div>
                    </div>
                `).join('') : ''}
                <div class="reply-input-wrapper">
                    <input type="text" class="reply-input" placeholder="写下你的回应..." data-id="${f.id}">
                    <button class="reply-submit-btn" data-id="${f.id}">发送</button>
                </div>
            </div>
        </div>
    `).join('');

    // 绑定点赞事件
    container.querySelectorAll('.like-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = parseInt(btn.dataset.id);
            const feedback = DB.feedbacks.find(f => f.id === id);
            if (feedback) {
                feedback.likes++;
                renderFeedbackList(filter);
            }
        });
    });

    // 绑定评论展开事件
    container.querySelectorAll('.reply-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = parseInt(btn.dataset.id);
            const replySection = document.getElementById(`reply-${id}`);
            replySection.classList.toggle('active');
        });
    });

    // 绑定评论提交事件
    container.querySelectorAll('.reply-submit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = parseInt(btn.dataset.id);
            const input = document.querySelector(`.reply-input[data-id="${id}"]`);
            const content = input.value.trim();
            if (content) {
                addReply(id, content);
                input.value = '';
            }
        });
    });

    // 绑定回车提交
    container.querySelectorAll('.reply-input').forEach(input => {
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const id = parseInt(input.dataset.id);
                const content = input.value.trim();
                if (content) {
                    addReply(id, content);
                    input.value = '';
                }
            }
        });
    });
}

// 添加回复
function addReply(feedbackId, content) {
    const feedback = DB.feedbacks.find(f => f.id === feedbackId);
    if (feedback) {
        if (!feedback.replyList) feedback.replyList = [];
        feedback.replyList.push({
            userHash: generateUserHash(),
            content: content,
            timestamp: Date.now(),
            isAI: false
        });
        feedback.replies = feedback.replyList.length;
        renderFeedbackList();
    }
}

// Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Update stats
function updateStats() {
    const today = DB.feedbacks.filter(f => {
        const today = new Date().toDateString();
        return new Date(f.timestamp).toDateString() === today;
    });

    const pending = DB.feedbacks.filter(f => f.status === 'pending').length;

    document.getElementById('todayFeedback').textContent = `${today.length}条`;
    document.getElementById('pendingFeedback').textContent = `${pending}条`;
    document.getElementById('todayCount').textContent = today.length;
}

// ============================================
// Agent System - 智能体处理系统
// ============================================

// 初始化智能体（初始状态为空）
function initAgent() {
    const feedbackContainer = document.getElementById('agentFeedbackList');
    const streamContainer = document.getElementById('streamOutput');
    
    // 初始全部为空
    if (feedbackContainer) feedbackContainer.innerHTML = '';
    if (streamContainer) {
        streamContainer.innerHTML = `
            <div class="stream-welcome">
                <div class="stream-prompt">$</div>
                <div class="stream-text">等待反馈输入，触发智能体处理...</div>
            </div>
        `;
    }
    
    // 监听用户反馈，触发智能体处理
    window.addEventListener('agent:process', (e) => {
        processFeedback(e.detail);
    });
}

// 处理用户反馈 - 触发智能体工作流程 (流式版本)
async function processFeedback(feedback, autoIterate = true) {
    console.log('[Agent] 开始处理反馈 (流式):', feedback);
    
    // 注意：反馈只在智能体确认处理后才显示在实时意见流
    // 初始不在意见流显示，等待AI处理结果
    
    // 1. 获取流式输出容器
    const streamContainer = document.getElementById('streamOutput');
    const time = new Date().toLocaleTimeString();
    
    // 移除欢迎信息
    if (streamContainer) {
        const welcome = streamContainer.querySelector('.stream-welcome');
        if (welcome) welcome.remove();
        
        // 创建流式输出项
        const streamItem = document.createElement('div');
        streamItem.className = 'stream-item';
        streamContainer.insertBefore(streamItem, streamContainer.firstChild);
        
        // 初始化显示接收反馈
        streamItem.innerHTML = `
            <div class="stream-item-header">
                <span class="stream-item-status processing">接收中</span>
                <span class="log-time">${time}</span>
            </div>
            <div class="stream-item-content">
                正在解码用户反馈: "<span class="highlight">${feedback.content.substring(0, 20)}...</span>"
                <span class="stream-typing">▊</span>
            </div>
        `;
    }
    
    // 用于累积代码块内容
    let codeChunkBuffer = '';
    let currentStage = '';
    
    // 3. 调用流式智能体 API
    const result = await new Promise((resolve, reject) => {
        callAgentAPIStream(
            feedback,
            // onMessage - 接收流式消息
            (type, data) => {
                console.log('[Stream] 收到消息:', type, data);
                
                const container = document.getElementById('streamOutput');
                if (!container) return;
                
                const streamItem = container.querySelector('.stream-item');
                if (!streamItem) return;
                
                switch (type) {
                    case 'stage':
                        currentStage = data.stage;
                        streamItem.innerHTML = `
                            <div class="stream-item-header">
                                <span class="stream-item-status processing">${getStageName(data.stage)}</span>
                                <span class="log-time">${new Date().toLocaleTimeString()}</span>
                            </div>
                            <div class="stream-item-content">
                                ${data.message} <span class="stream-typing">▊</span>
                            </div>
                        `;
                        break;
                        
                    case 'intent':
                        // AI确认处理后，才将反馈添加到实时意见流
                        addAgentFeedback(feedback);
                        
                        streamItem.innerHTML = `
                            <div class="stream-item-header">
                                <span class="stream-item-status completed">意图识别</span>
                                <span class="log-time">${new Date().toLocaleTimeString()}</span>
                            </div>
                            <div class="stream-item-content">
                                ✓ 识别到问题类型: <span class="highlight">${data.intent}</span> (置信度: ${(data.confidence * 100).toFixed(0)}%)
                            </div>
                        `;
                        break;
                        
                    case 'code_chunk':
                        // 实时显示AI输出的每个字
                        codeChunkBuffer += data.chunk;
                        const contentDiv = streamItem.querySelector('.stream-item-content');
                        if (contentDiv) {
                            // 将JSON格式化显示
                            try {
                                const formatted = codeChunkBuffer.includes('{') 
                                    ? JSON.stringify(JSON.parse(codeChunkBuffer), null, 2)
                                    : codeChunkBuffer;
                                contentDiv.innerHTML = `<pre class="stream-code">${escapeHtml(formatted)}<span class="stream-typing">▊</span></pre>`;
                            } catch {
                                contentDiv.innerHTML = `<pre class="stream-code">${escapeHtml(codeChunkBuffer)}<span class="stream-typing">▊</span></pre>`;
                            }
                        }
                        break;
                        
                    case 'suggestion':
                        codeChunkBuffer = '';
                        streamItem.innerHTML = `
                            <div class="stream-item-header">
                                <span class="stream-item-status completed">方案生成</span>
                                <span class="log-time">${new Date().toLocaleTimeString()}</span>
                            </div>
                            <div class="stream-item-content">
                                <div class="stream-code">
                                    <div class="stream-code-add">+ 文件: ${data.file}</div>
                                    <div class="stream-code-modify">* 操作: ${data.action}</div>
                                    <div class="stream-code-add">+ 描述: ${data.description}</div>
                                    <div class="stream-code-add">+ 代码变更: ${data.codeDiff}</div>
                                </div>
                            </div>
                        `;
                        break;
                        
                    case 'test_progress':
                        const progressContent = streamItem.querySelector('.stream-item-content');
                        if (progressContent) {
                            progressContent.innerHTML = `测试进度: ${data.progress}% <span class="stream-typing">▊</span>`;
                        }
                        break;
                        
                    case 'test_result':
                        streamItem.innerHTML = `
                            <div class="stream-item-header">
                                <span class="stream-item-status ${data.passed ? 'completed' : 'error'}">${data.passed ? '测试通过' : '测试失败'}</span>
                                <span class="log-time">${new Date().toLocaleTimeString()}</span>
                            </div>
                            <div class="stream-item-content">
                                ${data.message}
                            </div>
                        `;
                        break;
                        
                    case 'pr':
                        streamItem.innerHTML = `
                            <div class="stream-item-header">
                                <span class="stream-item-status completed">PR已创建</span>
                                <span class="log-time">${new Date().toLocaleTimeString()}</span>
                            </div>
                            <div class="stream-item-content">
                                ✓ GitHub PR: <a href="${data.url}" target="_blank">${data.title}</a>
                            </div>
                        `;
                        break;
                }
                
                // 限制显示数量
                const items = container.querySelectorAll('.stream-item');
                if (items.length > 5) {
                    items[items.length - 1].remove();
                }
            },
            // onComplete - 处理完成
            (data) => {
                console.log('[Stream] 处理完成:', data);
                resolve(data.result || { success: true, status: 'completed' });
            },
            // onError - 处理错误
            (data) => {
                console.error('[Stream] 错误:', data);
                reject(new Error(data.message));
            }
        );
    });
    
    // 4. 显示处理日志和代码变更
    showProcessingLog(feedback, result);
    
    // 5. 更新提交统计
    updateCommitCount();
    
    // 6. 更新反馈状态
    const idx = DB.feedbacks.findIndex(f => f.id === feedback.id);
    if (idx !== -1) {
        DB.feedbacks[idx].status = 'processed';
        DB.feedbacks[idx].result = result;
        renderFeedbackList();
    }
    
    // 7. 触发自动化迭代（如果启用）
    if (autoIterate) {
        const streamContainer = document.getElementById('streamOutput');
        const time = new Date().toLocaleTimeString();
        
        // 显示自动化迭代状态
        if (streamContainer) {
            const iterateItem = document.createElement('div');
            iterateItem.className = 'stream-item';
            iterateItem.innerHTML = `
                <div class="stream-item-header">
                    <span class="stream-item-status processing">迭代中</span>
                    <span class="log-time">${time}</span>
                </div>
                <div class="stream-item-content">
                    🚀 触发 GitHub 自动化迭代...
                </div>
            `;
            streamContainer.insertBefore(iterateItem, streamContainer.firstChild);
        }
        
        const iterationResult = await triggerAutoIteration(feedback.id);
        
        if (streamContainer) {
            // 移除迭代中的提示
            const iterating = streamContainer.querySelector('.stream-item-status.processing');
            if (iterating && iterating.textContent === '迭代中') {
                iterating.closest('.stream-item').remove();
            }
            
            // 添加迭代结果
            const resultItem = document.createElement('div');
            resultItem.className = 'stream-item';
            
            if (iterationResult.success) {
                console.log('[Agent] 自动化迭代已触发:', iterationResult);
                if (iterationResult.data?.pr?.url) {
                    resultItem.innerHTML = `
                        <div class="stream-item-header">
                            <span class="stream-item-status completed">已合并</span>
                            <span class="log-time">${time}</span>
                        </div>
                        <div class="stream-item-content">
                            🎉 PR 已创建: <a href="${iterationResult.data.pr.url}" target="_blank">#${iterationResult.data.pr.number}</a>
                        </div>
                    `;
                } else {
                    resultItem.innerHTML = `
                        <div class="stream-item-header">
                            <span class="stream-item-status completed">完成</span>
                            <span class="log-time">${time}</span>
                        </div>
                        <div class="stream-item-content">
                            ✓ 自动化迭代完成
                        </div>
                    `;
                }
            } else {
                resultItem.innerHTML = `
                    <div class="stream-item-header">
                        <span class="stream-item-status error">待配置</span>
                        <span class="log-time">${time}</span>
                    </div>
                    <div class="stream-item-content">
                        ⚠️ ${iterationResult.error || iterationResult.message || '请配置 GitHub Token 启用自动化'}
                    </div>
                `;
            }
            streamContainer.insertBefore(resultItem, streamContainer.firstChild);
            
            // 限制显示数量
            const items = streamContainer.querySelectorAll('.stream-item');
            if (items.length > 5) {
                items[items.length - 1].remove();
            }
        }
        
        // 更新反馈状态
        if (idx !== -1) {
            DB.feedbacks[idx].status = iterationResult.data?.merged ? 'merged' : 'iterating';
        } else {
            if (logContainer) {
                const errorEntry = document.createElement('div');
                errorEntry.className = 'log-entry error-text';
                errorEntry.innerHTML = `<span class="log-time">[${time}]</span><span class="log-indent">└─ ⚠️ ${iterationResult.error || iterationResult.message}</span>`;
                logContainer.insertBefore(errorEntry, logContainer.firstChild);
            }
        }
    }
}

// 调用智能体 API - DeepSeek AI 驱动
async function callAgentAPI(feedback) {
    console.log('[Agent API] 发送反馈到 DeepSeek 智能体:', feedback.content);
    
    try {
        const response = await fetch(API_BASE + API_CONFIG.agent.process, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                content: feedback.content,
                userId: feedback.userHash || feedback.userId,
                language: feedback.language || 'zh'
            })
        });
        
        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }
        
        const result = await response.json();
        
        if (result.success && result.data) {
            console.log('[Agent API] DeepSeek 处理完成:', result.data);
            return result.data;
        } else {
            throw new Error(result.error || '处理失败');
        }
    } catch (error) {
        console.error('[Agent API] 调用失败，使用本地处理:', error.message);
        // 降级到本地处理
        return {
            processing: {
                intent: detectIntent(feedback.content),
                confidence: 0.7,
                status: 'local_fallback'
            },
            output: {
                solution: generateSolution(feedback.content),
                codeChanges: generateCodeChanges(feedback.content),
                commit_id: 'local_' + Date.now()
            }
        };
    }
}

// ==================== 流式智能体 API ====================

// 流式处理反馈 - 实时显示AI输出的每个字
async function callAgentAPIStream(feedback, onMessage, onComplete, onError) {
    console.log('[Stream API] 开始流式处理反馈:', feedback.content);
    
    try {
        const response = await fetch(API_BASE + '/api/agent/process/stream', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                content: feedback.content,
                userId: feedback.userHash || feedback.userId,
                language: feedback.language || 'zh',
                autoTest: true
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            
            // 处理SSE事件
            const lines = buffer.split('\n');
            buffer = lines.pop(); // 保留不完整的行

            for (const line of lines) {
                const trimmedLine = line.trim();
                
                if (trimmedLine.startsWith('event:')) {
                    currentEvent = trimmedLine.replace('event:', '').trim();
                } else if (trimmedLine.startsWith('data:') && currentEvent) {
                    const dataStr = trimmedLine.replace('data:', '').trim();
                    try {
                        const data = JSON.parse(dataStr);
                        
                        // 根据事件类型调用回调
                        switch (currentEvent) {
                            case 'connected':
                                console.log('[Stream] 连接成功');
                                break;
                            case 'stage':
                                onMessage && onMessage('stage', data);
                                break;
                            case 'intent':
                                onMessage && onMessage('intent', data);
                                break;
                            case 'code_chunk':
                                onMessage && onMessage('code_chunk', data);
                                break;
                            case 'suggestion':
                                onMessage && onMessage('suggestion', data);
                                break;
                            case 'test_progress':
                                onMessage && onMessage('test_progress', data);
                                break;
                            case 'test_result':
                                onMessage && onMessage('test_result', data);
                                break;
                            case 'pr':
                                onMessage && onMessage('pr', data);
                                break;
                            case 'complete':
                                onComplete && onComplete(data);
                                break;
                            case 'error':
                                onError && onError(data);
                                break;
                            case 'done':
                                console.log('[Stream] 完成');
                                break;
                        }
                    } catch (e) {
                        console.error('[Stream] 解析数据失败:', e, dataStr);
                    }
                    currentEvent = ''; // 重置事件类型
                }
            }
        }
    } catch (error) {
        console.error('[Stream API] 流式处理失败:', error);
        onError && onError({ message: error.message });
    }
}

// ==================== 自动化迭代功能 ====================

// 检查 GitHub 自动化状态
async function checkGitHubStatus() {
    try {
        const response = await fetch(API_BASE + API_CONFIG.agent.githubStatus);
        const result = await response.json();
        return result.data;
    } catch (error) {
        console.error('[GitHub Status] 检查失败:', error.message);
        return { configured: false, message: '无法连接到服务器' };
    }
}

// 触发自动化迭代
async function triggerAutoIteration(feedbackId, autoMerge = false) {
    console.log('[Auto Iterate] 触发自动化迭代:', feedbackId);
    
    try {
        const response = await fetch(API_BASE + API_CONFIG.agent.autoIterate, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ feedbackId, autoMerge })
        });
        
        const result = await response.json();
        
        if (result.success) {
            console.log('[Auto Iterate] 迭代成功:', result.data);
            return result.data;
        } else {
            throw new Error(result.error || result.message);
        }
    } catch (error) {
        console.error('[Auto Iterate] 迭代失败:', error.message);
        return { success: false, error: error.message };
    }
}

// 一键处理并迭代（完整流程）
async function processAndIterate(feedback) {
    console.log('[Process & Iterate] 一键处理并迭代:', feedback.content);
    
    try {
        const response = await fetch(API_BASE + API_CONFIG.agent.processAndIterate, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: feedback.content,
                userId: feedback.userHash || feedback.userId,
                language: feedback.language || 'zh',
                autoMerge: false
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            console.log('[Process & Iterate] 完成:', result);
            
            // 更新本地状态
            const idx = DB.feedbacks.findIndex(f => f.id === feedback.id);
            if (idx !== -1) {
                DB.feedbacks[idx].status = result.data.iteration?.success ? 'iterating' : 'pending_review';
                DB.feedbacks[idx].iteration = result.data.iteration;
            }
            
            return result.data;
        } else {
            throw new Error(result.error);
        }
    } catch (error) {
        console.error('[Process & Iterate] 失败:', error.message);
        return { success: false, error: error.message };
    }
}

// 获取迭代状态
async function getIterationStatus(feedbackId) {
    try {
        const response = await fetch(`${API_BASE}${API_CONFIG.agent.iteration}/${feedbackId}`);
        const result = await response.json();
        return result.data;
    } catch (error) {
        console.error('[Iteration Status] 获取失败:', error.message);
        return null;
    }
}

// 检测意图
function detectIntent(content) {
    const lower = content.toLowerCase();
    if (lower.includes('德语') || lower.includes('日语') || lower.includes('法语')) {
        return 'accuracy';
    }
    if (lower.includes('速度') || lower.includes('慢')) {
        return 'speed';
    }
    if (lower.includes('ui') || lower.includes('界面')) {
        return 'ui';
    }
    return 'other';
}

// 生成解决方案
function generateSolution(content) {
    const lower = content.toLowerCase();
    if (lower.includes('德语')) return '优化德语词库';
    if (lower.includes('日语')) return '修复日语敬语';
    if (lower.includes('法语') || lower.includes('英语')) return '完善翻译规则';
    if (lower.includes('离线')) return '增加离线提示';
    if (lower.includes('速度')) return '优化长文本处理';
    return '分析处理中';
}

// 生成代码变更
function generateCodeChanges(content) {
    const lower = content.toLowerCase();
    const changes = [];
    
    if (lower.includes('德语')) {
        changes.push({ type: 'file', content: 'translate.js' });
        changes.push({ type: 'remove', content: '- Hallo → Hello' });
        changes.push({ type: 'add', content: '+ Hallo → Hello (formal)' });
        changes.push({ type: 'add', content: '+ Servus → Hello (informal)' });
    } else if (lower.includes('日语')) {
        changes.push({ type: 'file', content: 'jp-honorifics.js' });
        changes.push({ type: 'remove', content: '- でした → desu (formal)' });
        changes.push({ type: 'add', content: '+ でした → desu (context-aware)' });
    } else if (lower.includes('离线')) {
        changes.push({ type: 'file', content: 'offline-detector.js' });
        changes.push({ type: 'add', content: '+ checkOnlineStatus()' });
        changes.push({ type: 'add', content: '+ showOfflineWarning()' });
    } else {
        changes.push({ type: 'file', content: 'analyzer.js' });
        changes.push({ type: 'add', content: '+ analyzeFeedback()' });
    }
    
    return changes;
}

// 模拟延迟
function simulateDelay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 获取阶段名称
function getStageName(stage) {
    const stageNames = {
        'analyzing': '分析中',
        'generating': '生成中',
        'generated': '已生成',
        'testing': '测试中',
        'publishing': '发布中'
    };
    return stageNames[stage] || stage;
}

// HTML转义
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 添加反馈到智能体实时意见流
function addAgentFeedback(feedback) {
    const container = document.getElementById('agentFeedbackList');
    if (!container) return;

    const newItem = document.createElement('div');
    newItem.className = 'feedback-item';
    newItem.innerHTML = `<span class="feedback-lang">${feedback.language === 'zh' ? '🇨🇳' : '🇺🇸'}</span> <span class="feedback-user">用户_${feedback.userHash}</span>: <span class="feedback-content">${feedback.content.substring(0, 30)}${feedback.content.length > 30 ? '...' : ''}</span>`;
    container.insertBefore(newItem, container.firstChild);

    const items = container.querySelectorAll('.feedback-item');
    if (items.length > 10) {
        items[items.length - 1].remove();
    }
}

// 智能体流式输出 - 合并处理日志和代码变更
async function showAgentStream(feedback) {
    const container = document.getElementById('streamOutput');
    if (!container) return;

    // 移除欢迎信息
    const welcome = container.querySelector('.stream-welcome');
    if (welcome) welcome.remove();

    const time = new Date().toLocaleTimeString();
    const intentText = {
        'accuracy': '准确性',
        'speed': '速度',
        'ui': '界面',
        'feature': '功能',
        'other': '其他'
    };

    // 创建流式输出项
    const streamItem = document.createElement('div');
    streamItem.className = 'stream-item';
    container.insertBefore(streamItem, container.firstChild);

    // 第1步: 接收反馈
    streamItem.innerHTML = `
        <div class="stream-item-header">
            <span class="stream-item-status processing">接收中</span>
            <span class="log-time">${time}</span>
        </div>
        <div class="stream-item-content">
            正在解码用户反馈: "<span class="highlight">${feedback.content.substring(0, 20)}...</span>"
            <span class="stream-typing">▊</span>
        </div>
    `;
    await simulateDelay(800);

    // 第2步: AI 分析中
    streamItem.innerHTML = `
        <div class="stream-item-header">
            <span class="stream-item-status processing">分析中</span>
            <span class="log-time">${time}</span>
        </div>
        <div class="stream-item-content">
            DeepSeek AI 正在理解反馈语义...
            <span class="stream-typing">▊</span>
        </div>
    `;
    await simulateDelay(1200);

    // 第3步: 意图识别
    const intent = 'accuracy'; // 从 result 获取
    streamItem.innerHTML = `
        <div class="stream-item-header">
            <span class="stream-item-status processing">识别中</span>
            <span class="log-time">${time}</span>
        </div>
        <div class="stream-item-content">
            意图识别: <span class="highlight">${intentText[intent] || '其他'}</span>
            <br>语义理解: "${feedback.content.substring(0, 25)}..."
            <span class="stream-typing">▊</span>
        </div>
    `;
    await simulateDelay(800);

    // 第4步: 生成解决方案
    streamItem.innerHTML = `
        <div class="stream-item-header">
            <span class="stream-item-status processing">生成中</span>
            <span class="log-time">${time}</span>
        </div>
        <div class="stream-item-content">
            正在生成代码变更方案...
            <span class="stream-typing">▊</span>
        </div>
    `;
    await simulateDelay(1000);

    // 第5步: 完成 - 显示代码变更
    streamItem.innerHTML = `
        <div class="stream-item-header">
            <span class="stream-item-status completed">完成</span>
            <span class="log-time">${time}</span>
        </div>
        <div class="stream-item-content">
            ✓ 解决方案: 优化翻译词库，提升准确性
            <div class="stream-code">
                <div class="stream-code-add">+ 添加德语专业术语映射 (dictionary.js)</div>
                <div class="stream-code-modify">* 优化德语翻译规则 (translate.js)</div>
            </div>
        </div>
    `;

    // 限制显示数量
    const items = container.querySelectorAll('.stream-item');
    if (items.length > 5) {
        items[items.length - 1].remove();
    }
}

// 显示处理日志 - 兼容 DeepSeek API 响应格式
function showProcessingLog(feedback, result) {
    const container = document.getElementById('streamOutput');
    if (!container) return;

    // 兼容 DeepSeek 返回的嵌套结构
    const intent = result.processing?.intent || result.intent || 'other';
    const confidence = result.processing?.confidence || result.confidence || 0.5;
    const solution = result.output?.solution || result.solution || '处理完成';
    const codeChanges = result.output?.codeChanges || result.codeChanges || [];

    const time = new Date().toLocaleTimeString();
    const intentText = {
        'accuracy': '准确性',
        'speed': '速度',
        'ui': '界面',
        'feature': '功能',
        'other': '其他'
    };

    // 移除欢迎信息
    const welcome = container.querySelector('.stream-welcome');
    if (welcome) welcome.remove();

    // 创建流式输出项
    const streamItem = document.createElement('div');
    streamItem.className = 'stream-item';
    container.insertBefore(streamItem, container.firstChild);

    // 显示处理日志和代码变更
    streamItem.innerHTML = `
        <div class="stream-item-header">
            <span class="stream-item-status completed">完成</span>
            <span class="log-time">${time}</span>
        </div>
        <div class="stream-item-content">
            <div>✓ 意图识别: ${intentText[intent] || '其他'} (${Math.round(confidence * 100)}%)</div>
            <div>✓ 解决方案: ${solution}</div>
            ${codeChanges.length > 0 ? `
            <div class="stream-code">
                ${codeChanges.map(c => {
                    const typeClass = c.type === 'add' ? 'stream-code-add' : c.type === 'remove' ? 'stream-code-remove' : 'stream-code-modify';
                    const prefix = c.type === 'add' ? '+' : c.type === 'remove' ? '-' : '*';
                    return `<div class="${typeClass}">${prefix} ${c.content} (${c.file})</div>`;
                }).join('')}
            </div>
            ` : ''}
        </div>
    `;

    // 限制显示数量
    const items = container.querySelectorAll('.stream-item');
    if (items.length > 5) {
        items[items.length - 1].remove();
    }
}

// 显示代码变更 - 兼容 DeepSeek API 响应格式
function showCodeChange(result) {
    const container = document.getElementById('codeList');
    if (!container) return;
    
    // 清空之前的代码
    container.innerHTML = '';
    
    // 兼容嵌套结构: result.output.codeChanges
    const codeChanges = result.output?.codeChanges || result.codeChanges || [];
    
    codeChanges.forEach(change => {
        const div = document.createElement('div');
        div.className = `code-diff ${change.type}`;
        
        // 根据类型显示不同前缀
        let prefix = '';
        if (change.type === 'file') prefix = '📄 ';
        else if (change.type === 'add') prefix = '+ ';
        else if (change.type === 'remove') prefix = '- ';
        else if (change.type === 'modify') prefix = '* ';
        
        div.textContent = prefix + (change.content || change.file || '');
        container.appendChild(div);
    });
    
    // 如果没有代码变更，显示默认消息
    if (codeChanges.length === 0) {
        const div = document.createElement('div');
        div.className = 'code-diff';
        div.textContent = '+ 分析用户反馈中...';
        container.appendChild(div);
    }
}

// 更新提交计数
function updateCommitCount() {
    DB.commits++;
    document.getElementById('commitCount').textContent = DB.commits;
    
    const progress = (DB.commits / 60) * 100;
    document.getElementById('commitProgress').style.width = `${progress}%`;
}

// ============================================
// Version Selector - 版本/分支选择器
// ============================================
const GITHUB_REPO = 'LJN-sisi/ai-translator'; // 你的仓库

function initVersionSelector() {
    // 页面加载时立即获取数据
    loadGitHubData();
    
    // 设置自动刷新，每15秒刷新一次进化轨迹
    setInterval(() => {
        loadGitHubData();
    }, 15000);
}

// 更新最后更新时间显示
function updateLastUpdateTime() {
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0];
    const lastUpdateEl = document.getElementById('lastUpdateTime');
    if (lastUpdateEl) {
        lastUpdateEl.textContent = timeStr;
    }
}

async function loadGitHubData() {
    try {
        const commits = await fetchGitHubCommits(GITHUB_REPO);
        renderTimeline(commits);
        updateLastUpdateTime();
    } catch (error) {
        console.error('加载进化轨迹失败:', error);
        document.getElementById('versionTimeline').innerHTML = 
            '<div class="timeline-empty">加载失败，请检查网络</div>';
    }
}

// 获取 GitHub 分支列表
async function fetchGitHubBranches(repo) {
    const url = `https://api.github.com/repos/${repo}/branches`;
    
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error('获取分支失败');
        return await response.json();
    } catch (error) {
        console.error('GitHub API 错误:', error);
        return getMockBranches();
    }
}

// 获取 GitHub 提交历史
async function fetchGitHubCommits(repo) {
    const url = `https://api.github.com/repos/${repo}/commits?per_page=20`;
    
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error('获取提交失败');
        const commits = await response.json();
        return commits.map(c => ({
            sha: c.sha.substring(0, 7),
            message: c.commit.message.split('\n')[0],
            date: c.commit.author.date,
            branch: 'main',
            author: c.commit.author.name
        }));
    } catch (error) {
        console.error('GitHub API 错误:', error);
        return getMockCommits();
    }
}

// 渲染时间线 - 点线串联形式
function renderTimeline(commits) {
    const container = document.getElementById('versionTimeline');
    const detailsContainer = document.getElementById('versionDetails');
    
    if (!container || !detailsContainer) return;

    if (commits.length === 0) {
        container.innerHTML = '<div class="timeline-empty">暂无提交记录</div>';
        return;
    }

    // 生成版本点HTML
    const timelineLine = '<div class="timeline-line"></div>';
    const total = commits.length;
    
    const pointsHtml = commits.map((commit, index) => {
        const date = new Date(commit.date);
        const dateStr = formatDate(date);
        const isActive = index === 0 ? 'active' : '';
        
        // 生成版本号: v主版本.次版本.修订号
        // 每10个提交为一个次版本，每10个次版本为一个主版本
        const revision = total - index; // 修订号倒序
        const minor = Math.floor((revision - 1) / 10) + 1; // 次版本
        const major = Math.floor((minor - 1) / 10) + 1; // 主版本
        const version = `v${major}.${minor}.${(revision - 1) % 10}`;
        
        return `
            <div class="timeline-point ${isActive}" data-index="${index}">
                <div class="point-dot"></div>
                <div class="point-info">
                    <div class="point-label">${version}</div>
                    <div class="point-date">${dateStr}</div>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = timelineLine + pointsHtml;

    // 渲染第一个提交的详情
    renderVersionDetails(commits[0], 0, total);

    // 绑定点击事件
    container.querySelectorAll('.timeline-point').forEach(point => {
        point.addEventListener('click', () => {
            const index = parseInt(point.dataset.index);
            // 更新激活状态
            container.querySelectorAll('.timeline-point').forEach(p => p.classList.remove('active'));
            point.classList.add('active');
            // 渲染详情
            renderVersionDetails(commits[index], index, total);
        });
    });
}

// 渲染版本详情
function renderVersionDetails(commit, index, total) {
    const container = document.getElementById('versionDetails');
    if (!container) return;

    const date = new Date(commit.date);
    const dateStr = date.toLocaleString('zh-CN', { 
        year: 'numeric', 
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
    const isLatest = index === 0;
    
    // 生成版本号
    const revision = total - index;
    const minor = Math.floor((revision - 1) / 10) + 1;
    const major = Math.floor((minor - 1) / 10) + 1;
    const version = `v${major}.${minor}.${(revision - 1) % 10}`;

    // 提取功能描述
    const feature = extractFeatureDesc(commit.message);

    // 最新进化显示详细信息，历史版本显示摘要
    const detailHtml = isLatest ? `
        <div class="feature-detail">
            <div class="feature-type">${feature.type}</div>
            <div class="feature-desc">${escapeHtml(feature.desc)}</div>
            <div class="feature-full">
                <div class="feature-label">完整更新信息</div>
                <div class="feature-message">${escapeHtml(commit.message.split('\n')[0])}</div>
            </div>
        </div>
    ` : `
        <p class="version-desc">${escapeHtml(commit.message.split('\n')[0])}</p>
    `;

    container.innerHTML = `
        <div class="version-card">
            <div class="version-header">
                <span class="version-tag">${isLatest ? '最新进化' : '历史版本'}</span>
                <h3 class="version-title">${version}</h3>
            </div>
            ${detailHtml}
            <div class="version-meta">
                <span class="commit-author">${escapeHtml(commit.author)}</span>
                <span class="release-date">${dateStr}</span>
            </div>
        </div>
    `;
}

// 格式化日期 - 精确到分
function formatDate(date) {
    const now = new Date();
    const diff = now - date;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    if (hours < 24) return `${hours}小时前`;
    if (days === 1) return '昨天';
    if (days < 7) return `${days}天前`;
    
    return date.toLocaleDateString('zh-CN', { 
        year: 'numeric', 
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// 提取功能描述 - 从 commit message 中提取
function extractFeatureDesc(message) {
    // 尝试提取 commit message 中的功能描述
    const lines = message.split('\n').filter(l => l.trim());
    const firstLine = lines[0] || '';
    
    // 如果是常规格式: "feat: description" 或 "fix: description"
    const featMatch = firstLine.match(/^(feat|fix|docs|style|refactor|perf|chore)(\(.+\))?:\s*(.+)$/i);
    if (featMatch) {
        const type = {
            'feat': '✨ 新功能',
            'fix': '🐛 问题修复',
            'docs': '📝 文档更新',
            'style': '💄 样式调整',
            'refactor': '♻️ 代码重构',
            'perf': '⚡ 性能优化',
            'chore': '🔧 维护更新'
        }[featMatch[1].toLowerCase()] || '📌 更新';
        
        return { type, desc: featMatch[3] };
    }
    
    // 否则返回原始消息
    return { type: '📌 更新', desc: firstLine };
}

// 渲染分支图（保留旧接口）
function renderBranchGraph(branches, commits) {
    const container = document.getElementById('branchGraph');
    if (!container) return;

    if (commits.length === 0) {
        container.innerHTML = '<div class="graph-placeholder">暂无提交记录</div>';
        return;
    }

    // 为提交分配分支颜色
    const branchColors = {
        'main': 'main',
        'master': 'main',
        'dev': 'feature',
        'develop': 'feature',
        'default': 'feature'
    };

    commits.forEach((commit, index) => {
        // 根据提交索引模拟不同分支
        if (index % 3 === 0) commit.branch = 'main';
        else if (index % 3 === 1) commit.branch = 'dev';
        else commit.branch = 'feature';
    });

    const html = commits.map(commit => {
        const colorClass = branchColors[commit.branch] || 'feature';
        const timeAgo = formatTimeAgo(commit.date);
        
        return `
            <div class="graph-node" data-sha="${commit.sha}" onclick="showCommitDetails('${commit.sha}', '${escapeHtml(commit.message)}', '${timeAgo}', '${commit.author}')">
                <div class="graph-line branch-${colorClass}"></div>
                <div class="graph-dot ${colorClass}"></div>
                <div class="graph-commit">${commit.sha}</div>
                <div class="graph-message">${escapeHtml(commit.message)}</div>
                <div class="graph-time">${timeAgo}</div>
            </div>
        `;
    }).join('');

    container.innerHTML = html;
}

// 格式化相对时间
function formatTimeAgo(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now - date;
    
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor(diff / (1000 * 60));
    
    if (days > 0) return `${days}天前`;
    if (hours > 0) return `${hours}小时前`;
    if (minutes > 0) return `${minutes}分钟前`;
    return '刚刚';
}

// 显示提交详情
function showCommitDetails(sha, message, timeAgo, author) {
    const container = document.getElementById('versionDetails');
    
    // 高亮选中节点
    document.querySelectorAll('.graph-node').forEach(n => n.classList.remove('active'));
    document.querySelector(`.graph-node[data-sha="${sha}"]`)?.classList.add('active');

    // 解析 message 获取功能描述
    const lines = message.split('\n');
    const features = lines.slice(1).filter(l => l.trim()).map(l => l.trim().replace(/^[-\*]\s*/, ''));

    const html = `
        <div class="details-header">
            <div class="details-version">${sha}</div>
            <div class="details-branch">commit</div>
            <div class="details-meta">${timeAgo} · ${author}</div>
        </div>
        <div class="details-message" style="font-size: 16px; color: var(--text-white); margin-bottom: 16px;">
            ${escapeHtml(message)}
        </div>
        ${features.length > 0 ? `
            <div class="details-features">
                <div style="font-size: 14px; color: var(--text-dim); margin-bottom: 12px;">变更内容</div>
                ${features.map(f => `
                    <div class="details-feature">
                        <div class="details-feature-icon"></div>
                        <div class="details-feature-text">${escapeHtml(f)}</div>
                    </div>
                `).join('')}
            </div>
        ` : ''}
    `;

    container.innerHTML = html;
}

// 模拟分支数据
function getMockBranches() {
    return [
        { name: 'main', protected: true },
        { name: 'dev', protected: false },
        { name: 'feature/new-ui', protected: false }
    ];
}

// 模拟提交数据
function getMockCommits() {
    return [
        { sha: 'a1b2c3d', message: 'feat: 添加 DeepSeek AI 翻译支持', date: '2024-01-15T10:30:00Z', author: 'Dev', branch: 'main' },
        { sha: 'b2c3d4e', message: 'feat: 添加 Alt+T 快捷翻译', date: '2024-01-14T15:20:00Z', author: 'Dev', branch: 'main' },
        { sha: 'c3d4e5f', message: 'fix: 修复语言检测问题', date: '2024-01-13T09:15:00Z', author: 'Dev', branch: 'main' },
        { sha: 'd4e5f6g', message: 'feat: 优化翻译速度', date: '2024-01-12T14:00:00Z', author: 'Dev', branch: 'dev' },
        { sha: 'e5f6g7h', message: 'docs: 更新 README', date: '2024-01-11T11:30:00Z', author: 'Dev', branch: 'dev' },
        { sha: 'f6g7h8i', message: 'refactor: 重构代码结构', date: '2024-01-10T16:45:00Z', author: 'Dev', branch: 'feature' },
        { sha: 'g7h8i9j', message: 'feat: 添加多语言支持', date: '2024-01-09T10:00:00Z', author: 'Dev', branch: 'main' },
        { sha: 'h8i9j0k', message: 'init: 初始化项目', date: '2024-01-08T08:00:00Z', author: 'Dev', branch: 'main' }
    ];
}

// ============================================
// WebSocket 连接 - 实时接收智能体数据
// ============================================
function connectAgentWebSocket() {
    // TODO: 实现 WebSocket 连接
    // const ws = new WebSocket(API_CONFIG.agent.stream);
    // 
    // ws.onmessage = (event) => {
    //     const data = JSON.parse(event.data);
    //     handleAgentMessage(data);
    // };
    
    console.log('[WebSocket] 等待连接智能体服务...');
}

// 处理智能体消息
function handleAgentMessage(data) {
    switch (data.type) {
        case 'feedback':
            addAgentFeedback(data.content);
            break;
        case 'log':
            addProcessingLogEntry(data.content);
            break;
        case 'code':
            addCodeChangeEntry(data.content);
            break;
    }
}

// ============================================
// 导出供外部调用
// ============================================
window.TranslatePlugin = {
    // 提交反馈
    submitFeedback,
    
    // 获取反馈列表
    getFeedbacks: () => DB.feedbacks,
    
    // 获取统计数据
    getStats: () => ({
        today: DB.feedbacks.filter(f => new Date(f.timestamp).toDateString() === new Date().toDateString()).length,
        pending: DB.feedbacks.filter(f => f.status === 'pending').length,
        commits: DB.commits
    }),
    
    // API 配置
    API: API_CONFIG,
    
    // 手动触发智能体处理（供测试或外部调用）
    processFeedback
};
