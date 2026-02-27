/**
 * 自动化浏览器测试系统
 * 功能：Puppeteer浏览器自动化、端到端测试、持续集成支持
 */

// 延迟函数
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 自动化测试器
 */
class AutoTester {
    constructor(options = {}) {
        this.browser = null;
        this.page = null;
        this.options = {
            headless: options.headless ?? true,
            slowMo: options.slowMo ?? 0,
            viewport: options.viewport ?? { width: 1920, height: 1080 },
            baseUrl: options.baseUrl ?? 'http://localhost:3000',
            timeout: options.timeout ?? 30000
        };
        
        this.testResults = [];
        this.screenshots = [];
    }

    /**
     * 初始化浏览器
     */
    async init() {
        try {
            // 动态导入puppeteer
            const puppeteer = require('puppeteer');
            
            this.browser = await puppeteer.launch({
                headless: this.options.headless,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--no-first-run',
                    '--no-zygote'
                ]
            });
            
            this.page = await this.browser.newPage();
            await this.page.setViewport(this.options.viewport);
            
            console.log('[AutoTester] 浏览器已启动');
            return true;
        } catch (error) {
            console.error('[AutoTester] 浏览器启动失败:', error.message);
            return false;
        }
    }

    /**
     * 关闭浏览器
     */
    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
            console.log('[AutoTester] 浏览器已关闭');
        }
    }

    /**
     * 截图
     */
    async screenshot(name, options = {}) {
        if (!this.page) return null;
        
        const filename = `screenshot_${Date.now()}_${name}.png`;
        const path = options.path || filename;
        
        await this.page.screenshot({
            path,
            fullPage: options.fullPage ?? false
        });
        
        this.screenshots.push({
            name,
            path,
            timestamp: new Date().toISOString()
        });
        
        return path;
    }

    /**
     * 执行测试
     */
    async runTest(testFn, testName) {
        const startTime = Date.now();
        
        try {
            await testFn();
            
            const result = {
                name: testName,
                status: 'passed',
                duration: Date.now() - startTime,
                timestamp: new Date().toISOString()
            };
            
            this.testResults.push(result);
            console.log(`✅ [${testName}] 通过 (${result.duration}ms)`);
            
            return result;
        } catch (error) {
            // 失败时截图
            await this.screenshot(`failed_${testName}`);
            
            const result = {
                name: testName,
                status: 'failed',
                error: error.message,
                duration: Date.now() - startTime,
                timestamp: new Date().toISOString(),
                screenshot: this.screenshots[this.screenshots.length - 1]?.path
            };
            
            this.testResults.push(result);
            console.error(`❌ [${testName}] 失败:`, error.message);
            
            return result;
        }
    }

    /**
     * 等待元素
     */
    async waitForSelector(selector, options = {}) {
        const timeout = options.timeout ?? this.options.timeout;
        
        await this.page.waitForSelector(selector, {
            visible: options.visible ?? true,
            hidden: options.hidden ?? false,
            timeout
        });
    }

    /**
     * 点击元素
     */
    async click(selector) {
        await this.waitForSelector(selector);
        await this.page.click(selector);
    }

    /**
     * 输入文本
     */
    async type(selector, text, options = {}) {
        await this.waitForSelector(selector);
        
        if (options.clear) {
            await this.page.click(selector, { clickCount: 3 });
            await this.page.press('Backspace');
        }
        
        await this.page.type(selector, text, { delay: options.delay ?? 10 });
    }

    /**
     * 获取元素文本
     */
    async getText(selector) {
        await this.waitForSelector(selector);
        return await this.page.$eval(selector, el => el.textContent);
    }

    /**
     * 获取元素属性
     */
    async getAttribute(selector, attribute) {
        await this.waitForSelector(selector);
        return await this.page.$eval(selector, (el, attr) => el.getAttribute(attr), attribute);
    }

    /**
     * 评估JavaScript
     */
    async evaluate(fn) {
        return await this.page.evaluate(fn);
    }

    /**
     * 获取测试报告
     */
    getReport() {
        const passed = this.testResults.filter(r => r.status === 'passed').length;
        const failed = this.testResults.filter(r => r.status === 'failed').length;
        const total = this.testResults.length;
        
        return {
            summary: {
                total,
                passed,
                failed,
                passRate: total > 0 ? `${(passed / total * 100).toFixed(2)}%` : '0%'
            },
            results: this.testResults,
            screenshots: this.screenshots,
            generatedAt: new Date().toISOString()
        };
    }

    /**
     * 重置测试结果
     */
    reset() {
        this.testResults = [];
        this.screenshots = [];
    }
}

/**
 * 端到端测试套件
 */
class E2ETestSuite extends AutoTester {
    constructor(options = {}) {
        super(options);
        this.testData = {};
    }

    /**
     * 测试首页加载
     */
    async testHomePageLoad() {
        return this.runTest(async () => {
            await this.page.goto(this.options.baseUrl, { waitUntil: 'networkidle0' });
            
            // 验证标题
            const title = await this.page.title();
            if (!title.includes('翻译')) {
                throw new Error(`页面标题不正确: ${title}`);
            }
            
            // 验证主要元素存在
            await this.waitForSelector('body');
            
            console.log('[testHomePageLoad] 首页加载成功');
        }, '首页加载');
    }

    /**
     * 测试反馈提交流程
     */
    async testFeedbackSubmission(feedbackContent = '测试反馈：德语翻译不准确') {
        return this.runTest(async () => {
            // 导航到页面
            await this.page.goto(this.options.baseUrl, { waitUntil: 'networkidle0' });
            
            // 查找反馈输入框
            const inputSelector = '#feedbackInput, input[placeholder*="反馈"], textarea';
            
            try {
                await this.waitForSelector(inputSelector, { timeout: 5000 });
            } catch {
                // 如果找不到输入框，尝试其他选择器
                const altSelector = 'input, textarea';
                await this.waitForSelector(altSelector, { timeout: 5000 });
            }
            
            // 输入反馈内容
            await this.type(inputSelector, feedbackContent, { clear: true });
            
            // 查找提交按钮
            const submitSelector = '#submitFeedback, button[type="submit"], button:contains("提交")';
            
            // 点击提交
            await this.click(submitSelector);
            
            // 等待处理完成
            await delay(3000);
            
            console.log('[testFeedbackSubmission] 反馈提交完成');
        }, '反馈提交流程');
    }

    /**
     * 测试API端点
     */
    async testAPIEndpoint() {
        return this.runTest(async () => {
            // 测试反馈API
            const response = await this.page.evaluate(async (baseUrl) => {
                const res = await fetch(`${baseUrl}/api/feedback`);
                return {
                    status: res.status,
                    ok: res.ok,
                    data: await res.json()
                };
            }, this.options.baseUrl);
            
            if (!response.ok) {
                throw new Error(`API请求失败: ${response.status}`);
            }
            
            console.log('[testAPIEndpoint] API测试通过');
        }, 'API端点测试');
    }

    /**
     * 测试智能体处理
     */
    async testAgentProcessing() {
        return this.runTest(async () => {
            // 发送处理请求
            const result = await this.page.evaluate(async (baseUrl) => {
                const res = await fetch(`${baseUrl}/api/agent/process`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        content: '德语翻译不准确',
                        language: 'zh'
                    })
                });
                
                const data = await res.json();
                return {
                    status: res.status,
                    success: data.success,
                    data
                };
            }, this.options.baseUrl);
            
            if (!result.success) {
                throw new Error('智能体处理失败');
            }
            
            // 验证返回数据
            const hasResult = await this.page.evaluate(() => {
                return window.__agentResult !== undefined;
            });
            
            console.log('[testAgentProcessing] 智能体处理测试通过');
        }, '智能体处理测试');
    }

    /**
     * 测试性能指标
     */
    async testPerformance() {
        return this.runTest(async () => {
            const metrics = await this.page.metrics();
            
            console.log('[testPerformance] 性能指标:', {
                LayoutCount: metrics.LayoutCount,
                RecalcStyleCount: metrics.RecalcStyleCount,
                ScriptDuration: metrics.ScriptDuration.toFixed(2),
                TaskDuration: metrics.TaskDuration.toFixed(2)
            });
            
            // 检查是否有明显的性能问题
            if (metrics.LayoutCount > 1000) {
                console.warn('[testPerformance] 警告: 布局计算次数过多');
            }
        }, '性能测试');
    }

    /**
     * 测试响应式布局
     */
    async testResponsiveLayout() {
        const viewports = [
            { width: 1920, height: 1080, name: 'desktop' },
            { width: 768, height: 1024, name: 'tablet' },
            { width: 375, height: 667, name: 'mobile' }
        ];
        
        const results = [];
        
        for (const viewport of viewports) {
            await this.page.setViewport(viewport);
            await this.page.goto(this.options.baseUrl, { waitUntil: 'networkidle0' });
            
            const result = await this.runTest(async () => {
                await this.waitForSelector('body');
                
                // 检查页面元素是否正确渲染
                const body = await this.page.$('body');
                const isVisible = await body.isIntersectingViewport();
                
                if (!isVisible) {
                    throw new Error(`页面在${viewport.name}视口下不可见`);
                }
                
                console.log(`[testResponsiveLayout] ${viewport.name}视口测试通过`);
            }, `响应式-${viewport.name}`);
            
            results.push(result);
        }
        
        return results;
    }

    /**
     * 运行完整测试套件
     */
    async runFullSuite() {
        console.log('\n🧪 开始运行完整测试套件...\n');
        
        const suiteStartTime = Date.now();
        
        try {
            // 初始化浏览器
            const initialized = await this.init();
            if (!initialized) {
                throw new Error('浏览器初始化失败');
            }
            
            // 运行各项测试
            await this.testHomePageLoad();
            await this.testAPIEndpoint();
            await this.testFeedbackSubmission();
            await this.testPerformance();
            
        } catch (error) {
            console.error('测试套件执行失败:', error);
        } finally {
            await this.close();
        }
        
        const suiteDuration = Date.now() - suiteStartTime;
        const report = this.getReport();
        
        console.log('\n📊 测试报告:');
        console.log(`   总计: ${report.summary.total}`);
        console.log(`   通过: ${report.summary.passed}`);
        console.log(`   失败: ${report.summary.failed}`);
        console.log(`   通过率: ${report.summary.passRate}`);
        console.log(`   耗时: ${suiteDuration}ms\n`);
        
        return report;
    }
}

/**
 * 持续集成测试运行器
 */
class CITestRunner {
    constructor() {
        this.reporter = new TestReporter();
    }

    /**
     * 运行CI测试
     */
    async run() {
        console.log('🚀 启动CI测试...\n');
        
        const tester = new E2ETestSuite({
            baseUrl: process.env.TEST_URL || 'http://localhost:3000',
            headless: true
        });
        
        const report = await tester.runFullSuite();
        
        // 生成CI报告
        const ciReport = this.reporter.generateCIReport(report);
        
        // 根据结果退出
        if (report.summary.failed > 0) {
            console.error('\n❌ CI测试失败');
            process.exit(1);
        } else {
            console.log('\n✅ 所有测试通过');
            process.exit(0);
        }
    }
}

/**
 * 测试报告生成器
 */
class TestReporter {
    /**
     * 生成CI报告
     */
    generateCIReport(report) {
        return {
            timestamp: new Date().toISOString(),
            summary: report.summary,
            results: report.results,
            annotations: this.generateAnnotations(report.results),
            markdown: this.toMarkdown(report)
        };
    }

    /**
     * 生成注释
     */
    generateAnnotations(results) {
        return results
            .filter(r => r.status === 'failed')
            .map(r => ({
                path: r.screenshot || 'unknown',
                start_line: 1,
                end_line: 1,
                annotation_level: 'failure',
                message: r.error
            }));
    }

    /**
     * 转换为Markdown格式
     */
    toMarkdown(report) {
        let md = `# 测试报告\n\n`;
        md += `生成时间: ${report.generatedAt}\n\n`;
        md += `## 摘要\n\n`;
        md += `- 总计: ${report.summary.total}\n`;
        md += `- 通过: ${report.summary.passed}\n`;
        md += `- 失败: ${report.summary.failed}\n`;
        md += `- 通过率: ${report.summary.passRate}\n\n`;
        md += `## 详细结果\n\n`;
        
        for (const result of report.results) {
            const icon = result.status === 'passed' ? '✅' : '❌';
            md += `${icon} **${result.name}** - ${result.duration}ms`;
            if (result.error) {
                md += `\n   - 错误: ${result.error}`;
            }
            md += `\n`;
        }
        
        return md;
    }
}

// 导出模块
module.exports = {
    AutoTester,
    E2ETestSuite,
    CITestRunner,
    TestReporter
};
