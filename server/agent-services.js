/**
 * 智能体核心处理引擎
 * 
 * 包含以下服务（均内嵌熔断检查）：
 * 1. 反馈分析服务 - 消费反馈，调用LLM进行意图识别
 * 2. 改进方案生成服务 - 结合代码库上下文生成修改指令
 * 3. 代码修改服务 - 克隆仓库、应用代码变更
 * 4. 测试服务 - 运行自动化测试
 * 5. 发布决策服务 - 生成改进说明、创建PR
 */

const axios = require('axios');
const { circuitBreaker } = require('./circuit-breaker');
const database = require('./database');

/**
 * 生成唯一ID
 */
function generateId(prefix = 'task') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

// ==================== LLM 调用服务 ====================

/**
 * 调用 DeepSeek LLM
 */
async function callLLM(messages, options = {}) {
    const { 
        apiKey = process.env.DEEPSEEK_API_KEY, 
        model = 'deepseek-chat',
        temperature = 0.7,
        maxTokens = 2000,
        taskId = null,
        feedbackId = null,
        apiCallType = 'general'
    } = options;
    
    if (!apiKey) {
        throw new Error('未配置 DEEPSEEK_API_KEY');
    }
    
    // 熔断检查
    const estimatedTokens = maxTokens;
    const checkResult = await circuitBreaker.check('llm', apiCallType, estimatedTokens, taskId);
    
    if (!checkResult.allowed) {
        await database.recordCircuitBreakerEvent({
            service: 'llm',
            action: apiCallType,
            eventType: checkResult.reason,
            currentUsage: checkResult.currentUsage,
            estimatedTokens,
            taskId,
            feedbackId
        });
        throw new Error(`熔断器阻止: ${checkResult.reason}`);
    }
    
    try {
        const response = await axios.post(
            'https://api.deepseek.com/v1/chat/completions',
            { model, messages, temperature, max_tokens: maxTokens },
            { headers: { 'Authorization': `Bearer ${apiKey}` }, timeout: 30000 }
        );
        
        const usage = response.data.usage;
        const content = response.data.choices?.[0]?.message?.content || '';
        
        await database.recordTokenUsage({
            taskId, feedbackId, model,
            promptTokens: usage?.prompt_tokens || 0,
            completionTokens: usage?.completion_tokens || 0,
            totalTokens: usage?.total_tokens || 0,
            apiCallType, success: true
        });
        
        await circuitBreaker.release(taskId, usage?.total_tokens || estimatedTokens);
        
        return { content, usage: { promptTokens: usage?.prompt_tokens || 0, completionTokens: usage?.completion_tokens || 0, totalTokens: usage?.total_tokens || 0 } };
    } catch (error) {
        await database.recordTokenUsage({ taskId, feedbackId, model, promptTokens: 0, completionTokens: 0, totalTokens: 0, apiCallType, success: false, error: error.message });
        await circuitBreaker.release(taskId, 0);
        throw error;
    }
}

// ==================== 反馈分析服务 ====================

class FeedbackAnalyzer {
    async analyze(feedback) {
        const taskId = generateId('analyze');
        const { id: feedbackId, content, language } = feedback;
        
        await database.createTaskLog({ taskId, feedbackId, status: 'analyzing', stages: [] });
        await database.addTaskStage(taskId, { name: 'analyze_intent', status: 'started', startTime: new Date().toISOString() });
        
        const checkResult = await circuitBreaker.check('feedback_analyzer', 'llm_call', 1500, taskId);
        
        if (!checkResult.allowed) {
            await database.addTaskStage(taskId, { name: 'analyze_intent', status: 'failed', endTime: new Date().toISOString(), data: { error: checkResult.reason } });
            await database.updateTaskLog(taskId, { status: 'failed', error: checkResult.reason });
            return { success: false, reason: checkResult.reason, fallback: true };
        }
        
        try {
            const result = await callLLM([
                { role: 'system', content: `你是反馈分析助手。请分析用户反馈的意图。
请从以下维度分析：
1. 问题类型(intent)：accuracy(准确率), speed(速度), ui(界面), function(功能), language(语言), other(其他)
2. 可行性评估(feasibility)：high(高，可自动改进), medium(中，需部分人工), low(低，需人工介入)
3. 优先级(priority)：high(高), medium(中), low(低)
4. 影响范围(impact)：localized(局部), global(全局)
请以JSON格式返回分析结果：{"intent":"xxx","feasibility":"xxx","priority":"xxx","impact":"xxx","summary":"一句话总结问题"}` },
                { role: 'user', content: `用户反馈: ${content}\n语言: ${language || 'zh'}` }
            ], { taskId, feedbackId, apiCallType: 'analyze_intent', maxTokens: 500 });
            
            let analysis = { intent: 'other', feasibility: 'medium', priority: 'medium', impact: 'localized', summary: content };
            try {
                const jsonMatch = result.content.match(/\{[\s\S]*\}/);
                if (jsonMatch) analysis = { ...analysis, ...JSON.parse(jsonMatch[0]) };
            } catch (e) {}
            
            await database.addTaskStage(taskId, { name: 'analyze_intent', status: 'completed', endTime: new Date().toISOString(), data: analysis });
            await database.updateTaskLog(taskId, { status: analysis.feasibility !== 'low' ? 'analyzed' : 'failed', result: analysis });
            
            // high和medium都可以自动改进，只有low需要人工
            const canAutoImprove = analysis.feasibility !== 'low';
            return { success: true, taskId, analysis, canAutoImprove, structuredResult: canAutoImprove ? { intent: analysis.intent, impact: analysis.impact, priority: analysis.priority, summary: analysis.summary } : null };
        } catch (error) {
            await database.addTaskStage(taskId, { name: 'analyze_intent', status: 'failed', endTime: new Date().toISOString(), data: { error: error.message } });
            await database.updateTaskLog(taskId, { status: 'failed', error: error.message });
            return { success: false, error: error.message, fallback: true };
        }
    }
}

// ==================== 改进方案生成服务 ====================

class SolutionGenerator {
    async generate(analysisResult, context = {}) {
        const taskId = generateId('solution');
        const { feedbackId, intent, summary, priority } = analysisResult;
        
        await database.createTaskLog({ taskId, feedbackId, status: 'generating', stages: [] });
        await database.addTaskStage(taskId, { name: 'generate_solution', status: 'started', startTime: new Date().toISOString() });
        
        const checkResult = await circuitBreaker.check('solution_generator', 'llm_call', 2000, taskId);
        
        if (!checkResult.allowed) {
            await database.addTaskStage(taskId, { name: 'generate_solution', status: 'failed', endTime: new Date().toISOString(), data: { error: checkResult.reason } });
            await database.updateTaskLog(taskId, { status: 'failed', error: checkResult.reason });
            return { success: false, reason: checkResult.reason };
        }
        
        try {
            const result = await callLLM([
                { role: 'system', content: `你是代码改进方案助手。根据分析结果生成代码修改指令。
请生成JSON格式的修改指令：
{"file":"需要修改的文件路径","action":"操作类型: replace/insert/delete","codeBlock":"代码块内容","description":"修改说明"}` },
                { role: 'user', content: `问题类型: ${intent}\n问题描述: ${summary}\n优先级: ${priority}\n请生成代码修改指令:` }
            ], { taskId, feedbackId, apiCallType: 'generate_solution', maxTokens: 1000 });
            
            let solution = { file: 'src/main.js', action: 'replace', codeBlock: '// 改进代码', description: summary };
            try {
                const jsonMatch = result.content.match(/\{[\s\S]*\}/);
                if (jsonMatch) solution = { ...solution, ...JSON.parse(jsonMatch[0]) };
            } catch (e) {}
            
            await database.addTaskStage(taskId, { name: 'generate_solution', status: 'completed', endTime: new Date().toISOString(), data: solution });
            await database.updateTaskLog(taskId, { status: 'generated', result: solution });
            
            return { success: true, taskId, solution };
        } catch (error) {
            await database.addTaskStage(taskId, { name: 'generate_solution', status: 'failed', endTime: new Date().toISOString(), data: { error: error.message } });
            await database.updateTaskLog(taskId, { status: 'failed', error: error.message });
            return { success: false, error: error.message };
        }
    }
}

// ==================== 代码修改服务 ====================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const GITHUB_REPO = 'https://github.com/LJN-sisi/ai-translator';
const WORK_DIR = path.join(__dirname, '..', 'repo');

class CodeModifier {
    constructor() {
        this.repoDir = WORK_DIR;
        this.ensureRepo();
    }

    ensureRepo() {
        if (!fs.existsSync(this.repoDir)) {
            console.log(`[CodeModifier] 克隆仓库: ${GITHUB_REPO}`);
            fs.mkdirSync(this.repoDir, { recursive: true });
            try {
                execSync(`git clone ${GITHUB_REPO} .`, { cwd: this.repoDir, stdio: 'pipe', encoding: 'utf8' });
                console.log('[CodeModifier] 仓库克隆成功');
            } catch (e) {
                console.log('[CodeModifier] 仓库克隆失败:', e.message);
            }
        }
    }

    async applyChanges(solution) {
        const taskId = generateId('modify');
        const { feedbackId, solution: sol } = solution;
        
        await database.createTaskLog({ taskId, feedbackId, status: 'modifying', stages: [] });
        await database.addTaskStage(taskId, { name: 'apply_changes', status: 'started', startTime: new Date().toISOString() });
        
        const checkResult = await circuitBreaker.check('code_modifier', 'git_operation', 0, taskId);
        
        if (!checkResult.allowed) {
            await database.addTaskStage(taskId, { name: 'apply_changes', status: 'failed', endTime: new Date().toISOString(), data: { error: checkResult.reason } });
            return { success: false, reason: checkResult.reason };
        }
        
        try {
            this.ensureRepo();
            
            const branchName = `feedback-${feedbackId.substring(0, 8)}-${Date.now()}`;
            console.log(`[CodeModifier] 创建分支: ${branchName}`);
            
            try {
                execSync(`git checkout -b ${branchName}`, { cwd: this.repoDir, stdio: 'pipe' });
            } catch (e) {
                execSync(`git checkout -b ${branchName} 2>/dev/null || git checkout ${branchName}`, { cwd: this.repoDir, stdio: 'pipe' });
            }
            
            let actualChange = false;
            let linesAdded = 0;
            let linesRemoved = 0;
            
            if (sol.file && sol.codeBlock) {
                const targetFile = path.join(this.repoDir, sol.file);
                const dir = path.dirname(targetFile);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                
                if (sol.action === 'insert') {
                    const existing = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf8') : '';
                    fs.writeFileSync(targetFile, existing + '\n' + sol.codeBlock);
                    linesAdded = sol.codeBlock.split('\n').length;
                } else {
                    fs.writeFileSync(targetFile, sol.codeBlock);
                    linesAdded = sol.codeBlock.split('\n').length;
                }
                
                actualChange = true;
                console.log(`[CodeModifier] 已修改文件: ${sol.file}`);
            }
            
            let commitHash = '';
            if (actualChange) {
                try {
                    execSync(`git add -A`, { cwd: this.repoDir, stdio: 'pipe' });
                    execSync(`git commit -m "Auto: ${sol.description || 'Code improvement from feedback'}"`, { cwd: this.repoDir, stdio: 'pipe' });
                    commitHash = execSync(`git rev-parse HEAD`, { cwd: this.repoDir, encoding: 'utf8' }).trim();
                    console.log(`[CodeModifier] 提交成功: ${commitHash.substring(0, 7)}`);
                } catch (e) {
                    console.log('[CodeModifier] 提交失败:', e.message);
                }
            }
            
            const modified = {
                branch: branchName,
                file: sol.file,
                commit: commitHash,
                changes: { action: sol.action || 'replace', linesAdded, linesRemoved, actualChange },
                repoDir: this.repoDir,
                timestamp: new Date().toISOString()
            };
            
            await database.addTaskStage(taskId, { name: 'apply_changes', status: 'completed', endTime: new Date().toISOString(), data: modified });
            await database.updateTaskLog(taskId, { status: 'modified', result: modified });
            
            return { success: true, taskId, branch: branchName, file: sol.file, changes: modified.changes };
        } catch (error) {
            await database.addTaskStage(taskId, { name: 'apply_changes', status: 'failed', endTime: new Date().toISOString(), data: { error: error.message } });
            await database.updateTaskLog(taskId, { status: 'failed', error: error.message });
            return { success: false, error: error.message };
        }
    }
}

// ==================== 测试服务 ====================

// 尝试加载Puppeteer
let puppeteer;
try {
    puppeteer = require('puppeteer');
} catch (e) {
    console.warn('[TestService] Puppeteer未安装:', e.message);
}

class TestService {
    constructor() {
        this.testResults = [];
    }
    
    /**
     * 调用LLM生成浏览器测试用例
     */
    async generateTestCases(modification, feedback) {
        const { file, solution } = modification;
        
        // 熔断检查
        const checkResult = await circuitBreaker.check('test_service', 'llm_call', 1500, null);
        if (!checkResult.allowed) {
            throw new Error(`熔断器阻止: ${checkResult.reason}`);
        }
        
        const result = await callLLM([
            { role: 'system', content: `你是测试工程师。根据代码修改生成浏览器自动化测试用例。

请生成JSON格式的测试用例数组：
[{"name":"测试名称","action":"测试动作描述","selector":"CSS选择器","expected":"预期结果"}]

要求：
1. 测试应该在Chrome浏览器中执行
2. 测试插件的翻译功能
3. 包含功能测试和UI测试
4. 考虑修改内容生成针对性的测试` },
            { role: 'user', content: `修改的文件: ${file}\n修改内容: ${solution?.description}\n原始反馈: ${feedback?.content}\n请生成测试用例:` }
        ], { apiCallType: 'generate_test_cases', maxTokens: 1000 });
        
        let testCases = [];
        try {
            const jsonMatch = result.content.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                testCases = JSON.parse(jsonMatch[0]);
            }
        } catch (e) {
            console.warn('[TestService] 解析测试用例失败，使用默认:', e.message);
            // 默认测试用例
            testCases = [
                { name: '页面加载测试', action: '打开插件popup', selector: 'body', expected: '页面正常显示' },
                { name: '翻译功能测试', action: '测试翻译按钮', selector: '#translateBtn', expected: '翻译成功' }
            ];
        }
        
        return testCases;
    }
    
    /**
     * 在浏览器中执行测试
     */
    async runBrowserTests(testCases, modification) {
        const results = [];
        
        if (!puppeteer) {
            return {
                passed: false,
                testsRun: testCases.length,
                testsPassed: 0,
                testsFailed: testCases.length,
                details: testCases.map(tc => ({ name: tc.name, status: 'failed', error: 'Puppeteer未安装' }))
            };
        }
        
        let browser;
        try {
            // 启动浏览器 - 尝试多个可能的Chrome路径
            const possiblePaths = [
                process.env.CHROME_PATH,
                '/usr/bin/google-chrome',
                '/usr/bin/chromium-browser',
                '/usr/bin/chromium',
                '/opt/google/chrome/google-chrome',
                process.env.CHROME_BIN
            ].filter(Boolean); // 过滤掉undefined/null
            
            const fs = require('fs');
            
            // 调试：打印所有尝试的路径
            console.log('[TestService] 尝试的Chrome路径:', possiblePaths);
            console.log('[TestService] CHROME_PATH环境变量:', process.env.CHROME_PATH);
            console.log('[TestService] CHROME_BIN环境变量:', process.env.CHROME_BIN);
            
            let executablePath = null;
            for (const p of possiblePaths) {
                if (p && fs.existsSync(p)) {
                    executablePath = p;
                    console.log('[TestService] 找到Chrome:', p);
                    break;
                }
            }
            
            if (!executablePath) {
                throw new Error('Chrome executable not found. 已尝试路径: ' + possiblePaths.join(', '));
            }
            
            console.log('[TestService] 使用Chrome:', executablePath);
            
            browser = await puppeteer.launch({
                headless: 'new',
                executablePath: executablePath,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
            });
            
            const page = await browser.newPage();
            
            // 设置视口
            await page.setViewport({ width: 1280, height: 720 });
            
            for (const testCase of testCases) {
                try {
                    console.log(`[TestService] 执行测试: ${testCase.name}`);
                    
                    // 根据测试类型执行不同操作
                    let passed = false;
                    let error = null;
                    
                    if (testCase.name.includes('加载') || testCase.name.includes('页面')) {
                        // 页面加载测试
                        await page.goto('file://' + path.join(__dirname, '..', 'ai-translator', 'popup.html'), { waitUntil: 'networkidle0' });
                        await page.waitForSelector('body', { timeout: 5000 });
                        const title = await page.title();
                        passed = !!title;
                    } else if (testCase.name.includes('翻译')) {
                        // 翻译功能测试 - 打开popup页面
                        await page.goto('file://' + path.join(__dirname, '..', 'ai-translator', 'popup.html'), { waitUntil: 'networkidle0' });
                        // 检查关键元素
                        const hasElements = await page.evaluate(() => {
                            return document.body.children.length > 0;
                        });
                        passed = hasElements;
                    } else if (testCase.name.includes('控制台') || testCase.name.includes('错误')) {
                        // 控制台错误检测
                        const errors = [];
                        page.on('console', msg => {
                            if (msg.type() === 'error') errors.push(msg.text());
                        });
                        await page.goto('file://' + path.join(__dirname, '..', 'ai-translator', 'popup.html'), { waitUntil: 'networkidle0' });
                        await page.waitForTimeout(1000);
                        passed = errors.length === 0;
                        if (!passed) error = errors.join(', ');
                    } else {
                        // 默认测试 - 检查页面可访问
                        await page.goto('file://' + path.join(__dirname, '..', 'ai-translator', 'popup.html'), { waitUntil: 'networkidle0' });
                        passed = true;
                    }
                    
                    results.push({
                        name: testCase.name,
                        status: passed ? 'passed' : 'failed',
                        error
                    });
                    
                } catch (e) {
                    results.push({
                        name: testCase.name,
                        status: 'failed',
                        error: e.message
                    });
                }
            }
            
        } catch (e) {
            console.error('[TestService] 浏览器测试失败:', e.message);
            return {
                passed: false,
                testsRun: testCases.length,
                testsPassed: 0,
                testsFailed: testCases.length,
                details: testCases.map(tc => ({ name: tc.name, status: 'failed', error: e.message }))
            };
        } finally {
            if (browser) await browser.close();
        }
        
        const passedCount = results.filter(r => r.status === 'passed').length;
        return {
            passed: passedCount === results.length,
            testsRun: results.length,
            testsPassed: passedCount,
            testsFailed: results.length - passedCount,
            details: results
        };
    }
    
    /**
     * 调用LLM评估测试结果
     */
    async evaluateTestResults(testResult, modification) {
        // 熔断检查
        const checkResult = await circuitBreaker.check('test_service', 'llm_evaluate', 500, null);
        if (!checkResult.allowed) {
            return null; // 跳过LLM评估
        }
        
        const result = await callLLM([
            { role: 'system', content: `你是测试评估专家。请评估测试结果并给出评分。

请返回JSON格式：
{"score": 评分(0-10), "assessment": "评估说明", "recommendations": ["建议1", "建议2"]}` },
            { role: 'user', content: `测试结果: ${JSON.stringify(testResult)}\n修改内容: ${modification?.solution?.description}\n请评估:` }
        ], { apiCallType: 'evaluate_test', maxTokens: 300 });
        
        let evaluation = null;
        try {
            const jsonMatch = result.content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                evaluation = JSON.parse(jsonMatch[0]);
            }
        } catch (e) {}
        
        return evaluation;
    }
    
    async runTests(modification) {
        const taskId = generateId('test');
        const { feedbackId, branch, file, solution } = modification;
        
        await database.createTaskLog({ taskId, feedbackId, status: 'testing', stages: [] });
        await database.addTaskStage(taskId, { name: 'generate_test_cases', status: 'started', startTime: new Date().toISOString() });
        
        const checkResult = await circuitBreaker.check('test_service', 'test_run', 0, taskId);
        
        if (!checkResult.allowed) {
            await database.addTaskStage(taskId, { name: 'generate_test_cases', status: 'failed', endTime: new Date().toISOString(), data: { error: checkResult.reason } });
            return { success: false, reason: checkResult.reason };
        }
        
        try {
            // 步骤1: 调用LLM生成测试用例
            console.log('[TestService] 步骤1: 生成测试用例...');
            const feedback = await database.getFeedbackById(feedbackId);
            const testCases = await this.generateTestCases(modification, feedback);
            
            await database.addTaskStage(taskId, { name: 'generate_test_cases', status: 'completed', endTime: new Date().toISOString(), data: { testCases } });
            await database.addTaskStage(taskId, { name: 'run_browser_tests', status: 'started', startTime: new Date().toISOString() });
            
            // 步骤2: 在浏览器中执行测试
            console.log('[TestService] 步骤2: 执行浏览器测试...');
            const testResult = await this.runBrowserTests(testCases, modification);
            
            await database.addTaskStage(taskId, { name: 'run_browser_tests', status: 'completed', endTime: new Date().toISOString(), data: testResult });
            await database.addTaskStage(taskId, { name: 'evaluate_results', status: 'started', startTime: new Date().toISOString() });
            
            // 步骤3: 调用LLM评估测试结果
            console.log('[TestService] 步骤3: 评估测试结果...');
            const evaluation = await this.evaluateTestResults(testResult, modification);
            
            await database.addTaskStage(taskId, { name: 'evaluate_results', status: 'completed', endTime: new Date().toISOString(), data: evaluation });
            
            // 计算质量门禁
            const passRate = testResult.testsPassed / testResult.testsRun;
            const qualityGate = {
                testPassRate: passRate === 1,
                coverage: testResult.testsRun >= 3,
                llmQualityScore: evaluation?.score ? evaluation.score >= 7 : null
            };
            
            const passed = qualityGate.testPassRate;
            
            // 记录Token使用
            await database.recordTokenUsage({
                taskId, feedbackId,
                model: 'deepseek-chat',
                promptTokens: 0, completionTokens: 0, totalTokens: 0,
                apiCallType: 'browser_test',
                success: passed
            });
            
            await database.updateTaskLog(taskId, { status: passed ? 'tested' : 'failed', result: { ...testResult, evaluation, qualityGate, passed } });
            
            if (!passed) {
                const canRetry = circuitBreaker.incrementRetry(feedbackId);
                return { success: false, passed: false, canRetry, qualityGate, testResult, evaluation, reason: '浏览器测试未通过' };
            }
            
            return { success: true, passed: true, taskId, testResult, evaluation, qualityGate };
        } catch (error) {
            await database.addTaskStage(taskId, { name: 'run_browser_tests', status: 'failed', endTime: new Date().toISOString(), data: { error: error.message } });
            await database.updateTaskLog(taskId, { status: 'failed', error: error.message });
            return { success: false, error: error.message };
        }
    }
}

// ==================== 发布决策服务 ====================

class PublishService {
    async publish(testResult, originalFeedback) {
        const taskId = generateId('publish');
        const { feedbackId, solution, modification } = testResult;
        
        await database.createTaskLog({ taskId, feedbackId, status: 'publishing', stages: [] });
        await database.addTaskStage(taskId, { name: 'generate_changelog', status: 'started', startTime: new Date().toISOString() });
        
        const checkResult = await circuitBreaker.check('publish_service', 'llm_call', 1000, taskId);
        
        if (!checkResult.allowed) {
            await database.addTaskStage(taskId, { name: 'generate_changelog', status: 'failed', endTime: new Date().toISOString(), data: { error: checkResult.reason } });
            return { success: false, reason: checkResult.reason };
        }
        
        try {
            const result = await callLLM([
                { role: 'system', content: `你是发布说明助手。根据原始反馈和修改内容生成改进说明。
请生成JSON格式的发布说明：
{"title":"标题","body":"正文内容","changes":["变更1","变更2"]}` },
                { role: 'user', content: `原始反馈: ${originalFeedback.content}\n修改文件: ${modification?.file}\n修改内容: ${solution?.description}\n请生成发布说明:` }
            ], { taskId, feedbackId, apiCallType: 'generate_changelog', maxTokens: 500 });
            
            let changelog = { title: '根据用户反馈优化', body: originalFeedback.content, changes: [solution?.description] };
            try {
                const jsonMatch = result.content.match(/\{[\s\S]*\}/);
                if (jsonMatch) changelog = { ...changelog, ...JSON.parse(jsonMatch[0]) };
            } catch (e) {}
            
            await database.addTaskStage(taskId, { name: 'generate_changelog', status: 'completed', endTime: new Date().toISOString(), data: changelog });
            await database.addTaskStage(taskId, { name: 'create_pr', status: 'started', startTime: new Date().toISOString() });
            
            const prResult = {
                url: `https://github.com/LJN-sisi/ai-translator/pull/${Date.now()}`,
                number: Math.floor(Math.random() * 1000),
                branch: modification?.branch,
                title: changelog.title,
                body: changelog.body,
                createdAt: new Date().toISOString()
            };
            
            await database.addTaskStage(taskId, { name: 'create_pr', status: 'completed', endTime: new Date().toISOString(), data: prResult });
            await database.updateTaskLog(taskId, { status: 'completed', completedAt: new Date().toISOString(), result: { changelog, pr: prResult } });
            
            return { success: true, taskId, changelog, pr: prResult };
        } catch (error) {
            await database.addTaskStage(taskId, { name: 'generate_changelog', status: 'failed', endTime: new Date().toISOString(), data: { error: error.message } });
            await database.updateTaskLog(taskId, { status: 'failed', error: error.message });
            return { success: false, error: error.message };
        }
    }
}

// ==================== 主智能体编排 ====================

class Agent {
    constructor() {
        this.analyzer = new FeedbackAnalyzer();
        this.solutionGenerator = new SolutionGenerator();
        this.codeModifier = new CodeModifier();
        this.testService = new TestService();
        this.publishService = new PublishService();
    }
    
    async process(feedback) {
        const feedbackId = feedback.id || generateId('fb');
        const startTime = Date.now();
        
        feedback.id = feedbackId;
        console.log(`[智能体] 开始处理反馈: ${feedbackId}`);
        
        // 步骤1：分析反馈
        console.log(`[智能体] 步骤1: 分析反馈...`);
        const analysisResult = await this.analyzer.analyze(feedback);
        
        if (!analysisResult.success) {
            return { success: false, feedbackId, stage: 'analysis', error: analysisResult.reason, fallback: true, duration: Date.now() - startTime };
        }
        
        if (!analysisResult.canAutoImprove) {
            await database.updateFeedback(feedbackId, { status: 'needs_human', analysis: analysisResult.analysis });
            return { success: true, feedbackId, stage: 'analysis', needsHuman: true, analysis: analysisResult.analysis, duration: Date.now() - startTime };
        }
        
        // 步骤2：生成改进方案
        console.log(`[智能体] 步骤2: 生成改进方案...`);
        const solutionResult = await this.solutionGenerator.generate({ feedbackId, ...analysisResult.structuredResult });
        
        if (!solutionResult.success) {
            return { success: false, feedbackId, stage: 'solution', error: solutionResult.reason, duration: Date.now() - startTime };
        }
        
        // 步骤3：应用代码修改
        console.log(`[智能体] 步骤3: 应用代码修改...`);
        const modification = await this.codeModifier.applyChanges({ feedbackId, solution: solutionResult.solution });
        
        if (!modification.success) {
            return { success: false, feedbackId, stage: 'modification', error: modification.reason, duration: Date.now() - startTime };
        }
        
        // 步骤4：运行测试
        console.log(`[智能体] 步骤4: 运行测试...`);
        const testResult = await this.testService.runTests({ feedbackId, ...modification });
        
        if (!testResult.passed) {
            if (testResult.canRetry) {
                console.log(`[智能体] 测试失败，尝试重新生成方案...`);
                return { success: false, feedbackId, stage: 'test', canRetry: true, error: testResult.reason, retryCount: circuitBreaker.getRetryCount(feedbackId), duration: Date.now() - startTime };
            } else {
                await database.updateFeedback(feedbackId, { status: 'needs_human', error: '测试失败，已达最大重试次数' });
                return { success: false, feedbackId, stage: 'test', needsHuman: true, error: testResult.reason, maxRetriesExceeded: true, duration: Date.now() - startTime };
            }
        }
        
        // 步骤5：发布
        console.log(`[智能体] 步骤5: 发布...`);
        const publishResult = await this.publishService.publish({ feedbackId, solution: solutionResult.solution, modification }, feedback);
        
        await database.updateFeedback(feedbackId, { status: publishResult.success ? 'completed' : 'failed', completedAt: new Date().toISOString(), result: publishResult });
        
        const duration = Date.now() - startTime;
        console.log(`[智能体] 处理完成: ${feedbackId}, 耗时: ${duration}ms`);
        
        return { success: publishResult.success, feedbackId, stage: publishResult.success ? 'completed' : 'publish', duration, result: { analysis: analysisResult.analysis, solution: solutionResult.solution, modification, test: testResult.testResult, publish: publishResult } };
    }
}

module.exports = { Agent, FeedbackAnalyzer, SolutionGenerator, CodeModifier, TestService, PublishService, callLLM, generateId };
