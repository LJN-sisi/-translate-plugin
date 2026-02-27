/**
 * 智能测试系统 (Smart Test System)
 * 功能：
 * 1. 自动重试机制 - 最多重试3次
 * 2. 自动回滚 - 失败时恢复到上一个稳定版本
 * 3. 失败保护 - 防止无限循环
 * 4. 智能决策 - 根据测试结果决定下一步操作
 * 
 * 设计原则：不让功能死磕，三次不成功果断放弃
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// 延迟函数
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 版本管理器 - 负责代码快照和回滚
 */
class VersionManager {
    constructor(options = {}) {
        this.snapshotDir = options.snapshotDir || path.join(__dirname, '../snapshots');
        this.maxSnapshots = options.maxSnapshots || 10;
        this.ensureSnapshotDir();
    }

    ensureSnapshotDir() {
        if (!fs.existsSync(this.snapshotDir)) {
            fs.mkdirSync(this.snapshotDir, { recursive: true });
        }
    }

    /**
     * 创建代码快照
     */
    createSnapshot(name) {
        const snapshotId = `snap_${Date.now()}_${name.replace(/[^a-zA-Z0-9]/g, '_')}`;
        const snapshotPath = path.join(this.snapshotDir, snapshotId);
        
        try {
            // 复制关键文件到快照目录
            fs.mkdirSync(snapshotPath, { recursive: true });
            
            const filesToSnapshot = [
                '../index.html',
                '../styles.css',
                '../app.js'
            ];
            
            for (const file of filesToSnapshot) {
                const srcPath = path.join(__dirname, file);
                const destPath = path.join(snapshotPath, path.basename(file));
                
                if (fs.existsSync(srcPath)) {
                    fs.copyFileSync(srcPath, destPath);
                }
            }
            
            // 写入快照元数据
            const metadata = {
                id: snapshotId,
                name,
                createdAt: new Date().toISOString(),
                files: filesToSnapshot.map(f => path.basename(f))
            };
            
            fs.writeFileSync(
                path.join(snapshotPath, 'metadata.json'),
                JSON.stringify(metadata, null, 2)
            );
            
            // 清理旧快照
            this.cleanOldSnapshots();
            
            console.log(`📸 快照已创建: ${snapshotId}`);
            return snapshotId;
        } catch (error) {
            console.error('创建快照失败:', error.message);
            return null;
        }
    }

    /**
     * 恢复到指定快照
     */
    restoreSnapshot(snapshotId) {
        const snapshotPath = path.join(this.snapshotDir, snapshotId);
        
        if (!fs.existsSync(snapshotPath)) {
            console.error(`快照不存在: ${snapshotId}`);
            return false;
        }
        
        try {
            // 读取快照元数据
            const metadata = JSON.parse(
                fs.readFileSync(path.join(snapshotPath, 'metadata.json'), 'utf-8')
            );
            
            // 恢复文件
            for (const file of metadata.files) {
                const srcPath = path.join(snapshotPath, file);
                const destPath = path.join(__dirname, '..', file);
                
                if (fs.existsSync(srcPath)) {
                    fs.copyFileSync(srcPath, destPath);
                    console.log(`🔄 已恢复: ${file}`);
                }
            }
            
            console.log(`♻️ 已恢复到快照: ${snapshotId}`);
            return true;
        } catch (error) {
            console.error('恢复快照失败:', error.message);
            return false;
        }
    }

    /**
     * 获取最新快照
     */
    getLatestSnapshot() {
        const dirs = fs.readdirSync(this.snapshotDir)
            .filter(f => fs.statSync(path.join(this.snapshotDir, f)).isDirectory())
            .sort()
            .reverse();
        
        if (dirs.length === 0) return null;
        
        const latestDir = dirs[0];
        const metadataPath = path.join(this.snapshotDir, latestDir, 'metadata.json');
        
        if (fs.existsSync(metadataPath)) {
            return JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        }
        
        return null;
    }

    /**
     * 清理旧快照
     */
    cleanOldSnapshots() {
        const dirs = fs.readdirSync(this.snapshotDir)
            .filter(f => fs.statSync(path.join(this.snapshotDir, f)).isDirectory())
            .sort()
            .reverse();
        
        if (dirs.length > this.maxSnapshots) {
            for (let i = this.maxSnapshots; i < dirs.length; i++) {
                const oldPath = path.join(this.snapshotDir, dirs[i]);
                fs.rmSync(oldPath, { recursive: true, force: true });
                console.log(`🗑️ 已清理旧快照: ${dirs[i]}`);
            }
        }
    }

    /**
     * 列出所有快照
     */
    listSnapshots() {
        return fs.readdirSync(this.snapshotDir)
            .filter(f => fs.statSync(path.join(this.snapshotDir, f)).isDirectory())
            .map(dir => {
                const metadataPath = path.join(this.snapshotDir, dir, 'metadata.json');
                if (fs.existsSync(metadataPath)) {
                    return JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
                }
                return { id: dir, name: 'unknown' };
            })
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }
}

/**
 * 测试执行器 - 负责运行测试并捕获错误
 */
class TestExecutor {
    constructor(options = {}) {
        this.baseUrl = options.baseUrl || 'http://localhost:3000';
        this.timeout = options.timeout || 30000;
    }

    /**
     * 运行单个测试
     */
    async runTest(testFn, testName) {
        const startTime = Date.now();
        
        try {
            await Promise.race([
                testFn(),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('测试超时')), this.timeout)
                )
            ]);
            
            return {
                name: testName,
                status: 'passed',
                duration: Date.now() - startTime,
                error: null
            };
        } catch (error) {
            return {
                name: testName,
                status: 'failed',
                duration: Date.now() - startTime,
                error: error.message
            };
        }
    }

    /**
     * 测试页面加载
     */
    async testPageLoad(page) {
        return this.runTest(async () => {
            await page.goto(this.baseUrl, { 
                waitUntil: 'networkidle0',
                timeout: this.timeout 
            });
            
            // 验证页面基本元素
            const title = await page.title();
            if (!title) {
                throw new Error('页面标题为空');
            }
            
            console.log(`   ✅ 页面加载成功: ${title}`);
        }, '页面加载');
    }

    /**
     * 测试API端点
     */
    async testAPI(page, endpoint, method = 'GET', body = null) {
        return this.runTest(async () => {
            const result = await page.evaluate(async (args) => {
                const { endpoint, method, body } = args;
                const options = { method, headers: { 'Content-Type': 'application/json' } };
                if (body) options.body = JSON.stringify(body);
                
                const res = await fetch(endpoint, options);
                return {
                    status: res.status,
                    ok: res.ok,
                    data: res.headers.get('content-type')?.includes('json') 
                        ? await res.json() 
                        : await res.text()
                };
            }, { endpoint, method, body });
            
            if (!result.ok) {
                throw new Error(`API ${endpoint} 返回错误: ${result.status}`);
            }
            
            console.log(`   ✅ API测试通过: ${endpoint}`);
            return result;
        }, `API测试-${endpoint}`);
    }

    /**
     * 测试JavaScript错误
     */
    async testNoJSErrors(page) {
        return this.runTest(async () => {
            const errors = [];
            
            page.on('pageerror', error => {
                errors.push(error.message);
            });
            
            // 等待一段时间让脚本执行
            await delay(2000);
            
            if (errors.length > 0) {
                throw new Error(`检测到JavaScript错误: ${errors.join(', ')}`);
            }
            
            console.log('   ✅ 无JavaScript错误');
        }, 'JavaScript错误检测');
    }

    /**
     * 测试关键元素存在
     */
    async testCriticalElements(page, selectors) {
        return this.runTest(async () => {
            for (const selector of selectors) {
                const exists = await page.$(selector);
                if (!exists) {
                    throw new Error(`关键元素不存在: ${selector}`);
                }
            }
            
            console.log(`   ✅ 关键元素检查通过: ${selectors.join(', ')}`);
        }, '关键元素检查');
    }

    /**
     * 测试控制台错误
     */
    async testConsoleErrors(page) {
        return this.runTest(async () => {
            const consoleErrors = [];
            
            page.on('console', msg => {
                if (msg.type() === 'error') {
                    consoleErrors.push(msg.text());
                }
            });
            
            await delay(1000);
            
            if (consoleErrors.length > 0) {
                throw new Error(`控制台错误: ${consoleErrors.join(', ')}`);
            }
            
            console.log('   ✅ 无控制台错误');
        }, '控制台错误检测');
    }
}

/**
 * 智能决策引擎 - 根据测试结果决定下一步
 */
class DecisionEngine {
    constructor(options = {}) {
        this.maxRetries = options.maxRetries || 3;
        this.retryDelay = options.retryDelay || 2000;
    }

    /**
     * 分析测试结果并做出决策
     */
    analyze(testResults) {
        const passed = testResults.filter(r => r.status === 'passed');
        const failed = testResults.filter(r => r.status === 'failed');
        
        const passRate = testResults.length > 0 
            ? passed.length / testResults.length 
            : 0;
        
        return {
            passed: passed.length,
            failed: failed.length,
            passRate,
            isPassing: passRate >= 0.8, // 80%通过率视为通过
            shouldRetry: failed.length > 0 && failed.length < testResults.length / 2,
            shouldRollback: passRate < 0.3, // 低于30%通过率需要回滚
            shouldAbort: passRate === 0, // 全部失败需要终止
            errorSummary: failed.map(f => `${f.name}: ${f.error}`).join('; ')
        };
    }

    /**
     * 获取下一步建议
     */
    getRecommendation(analysis, attemptNumber) {
        if (analysis.shouldAbort) {
            return {
                action: 'abort',
                reason: '所有测试失败，功能可能存在严重问题',
                message: `第${attemptNumber}次尝试失败 - 放弃此功能`
            };
        }
        
        if (analysis.shouldRollback) {
            return {
                action: 'rollback',
                reason: '通过率过低，需要回滚到上一个版本',
                message: `第${attemptNumber}次尝试失败 - 回滚代码`
            };
        }
        
        if (analysis.shouldRetry && attemptNumber < this.maxRetries) {
            return {
                action: 'retry',
                reason: '部分测试失败，尝试重新运行',
                message: `第${attemptNumber}次尝试失败 - 准备第${attemptNumber + 1}次重试`
            };
        }
        
        if (attemptNumber >= this.maxRetries) {
            return {
                action: 'abort',
                reason: '已达到最大重试次数',
                message: `第${attemptNumber}次尝试失败 - 放弃此功能`
            };
        }
        
        return {
            action: 'continue',
            reason: '测试基本通过',
            message: '测试通过，继续下一步'
        };
    }
}

/**
 * 智能测试系统主类
 */
class SmartTestSystem {
    constructor(options = {}) {
        this.versionManager = new VersionManager(options);
        this.testExecutor = new TestExecutor(options);
        this.decisionEngine = new DecisionEngine(options);
        
        this.currentAttempt = 0;
        this.testHistory = [];
        this.abortedFeatures = new Set();
        
        this.puppeteer = null;
        this.browser = null;
        this.page = null;
    }

    /**
     * 初始化浏览器
     */
    async initBrowser() {
        try {
            this.puppeteer = require('puppeteer');
            
            this.browser = await this.puppeteer.launch({
                headless: options.headless ?? true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage'
                ]
            });
            
            this.page = await this.browser.newPage();
            console.log('✅ 浏览器已启动');
            
            return true;
        } catch (error) {
            console.error('浏览器启动失败:', error.message);
            return false;
        }
    }

    /**
     * 关闭浏览器
     */
    async closeBrowser() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.page = null;
            console.log('✅ 浏览器已关闭');
        }
    }

    /**
     * 创建测试前快照
     */
    createPreTestSnapshot(featureName) {
        console.log(`\n📸 创建测试前快照: ${featureName}`);
        return this.versionManager.createSnapshot(featureName);
    }

    /**
     * 运行测试并获取结果
     */
    async runTests(testName, testFunctions) {
        console.log(`\n🧪 运行测试: ${testName}`);
        
        const results = [];
        
        for (const test of testFunctions) {
            const result = await test(this.page);
            results.push(result);
        }
        
        return results;
    }

    /**
     * 智能测试运行 - 核心方法
     * 包含重试、回滚和放弃逻辑
     */
    async runSmartTest(featureName, testFunctions, options = {}) {
        const maxAttempts = options.maxAttempts || 3;
        const snapshotBeforeTest = options.snapshotBeforeTest !== false;
        
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🚀 开始智能测试: ${featureName}`);
        console.log(`${'='.repeat(60)}`);
        
        // 如果需要，先创建快照
        let preSnapshot = null;
        if (snapshotBeforeTest) {
            preSnapshot = this.createPreTestSnapshot(featureName);
        }
        
        // 获取上一个稳定版本
        const lastStable = this.versionManager.getLatestSnapshot();
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            this.currentAttempt = attempt;
            
            console.log(`\n📋 第 ${attempt}/${maxAttempts} 次尝试`);
            console.log('-'.repeat(40));
            
            // 运行测试
            const testResults = await this.runTests(
                `${featureName}-attempt-${attempt}`, 
                testFunctions
            );
            
            // 记录测试历史
            this.testHistory.push({
                featureName,
                attempt,
                results: testResults,
                timestamp: new Date().toISOString()
            });
            
            // 分析结果
            const analysis = this.decisionEngine.analyze(testResults);
            
            console.log(`\n📊 测试分析:`);
            console.log(`   通过: ${analysis.passed}, 失败: ${analysis.failed}`);
            console.log(`   通过率: ${(analysis.passRate * 100).toFixed(1)}%`);
            
            // 获取决策建议
            const decision = this.decisionEngine.getRecommendation(analysis, attempt);
            
            console.log(`\n🎯 决策: ${decision.action}`);
            console.log(`   原因: ${decision.reason}`);
            
            // 执行决策
            switch (decision.action) {
                case 'continue':
                    console.log(`\n✅ ${featureName} 测试通过!`);
                    return {
                        success: true,
                        attempts: attempt,
                        results: testResults,
                        message: `测试通过，耗时${attempt}次尝试`
                    };
                
                case 'retry':
                    console.log(`\n⏳ 等待重试...`);
                    await delay(options.retryDelay || 2000);
                    continue;
                
                case 'rollback':
                    console.log(`\n🔄 执行回滚...`);
                    if (lastStable) {
                        this.versionManager.restoreSnapshot(lastStable.id);
                    } else if (preSnapshot) {
                        this.versionManager.restoreSnapshot(preSnapshot);
                    }
                    await delay(1000);
                    continue;
                
                case 'abort':
                    console.log(`\n🛑 放弃此功能`);
                    this.abortedFeatures.add(featureName);
                    
                    // 恢复到上一个稳定版本
                    if (lastStable) {
                        console.log(`♻️ 恢复到稳定版本: ${lastStable.id}`);
                        this.versionManager.restoreSnapshot(lastStable.id);
                    }
                    
                    return {
                        success: false,
                        attempts: attempt,
                        results: testResults,
                        message: decision.message,
                        error: analysis.errorSummary,
                        aborted: true
                    };
            }
        }
        
        // 超过最大尝试次数
        console.log(`\n❌ 达到最大尝试次数，测试失败`);
        this.abortedFeatures.add(featureName);
        
        return {
            success: false,
            attempts: maxAttempts,
            message: `达到最大尝试次数(${maxAttempts})`,
            aborted: true
        };
    }

    /**
     * 快速冒烟测试
     */
    async runSmokeTest() {
        console.log('\n🔥 运行快速冒烟测试...');
        
        if (!await this.initBrowser()) {
            return { success: false, error: '浏览器启动失败' };
        }
        
        try {
            // 测试页面加载
            const loadResult = await this.testExecutor.testPageLoad(this.page);
            
            // 测试API
            const apiResult = await this.testExecutor.testAPI(this.page, '/api/health', 'GET');
            
            const results = [loadResult, apiResult];
            const passed = results.filter(r => r.status === 'passed').length;
            
            return {
                success: passed === results.length,
                results,
                message: `冒烟测试: ${passed}/${results.length} 通过`
            };
        } finally {
            await this.closeBrowser();
        }
    }

    /**
     * 完整测试套件
     */
    async runFullSuite() {
        console.log('\n🧪 开始完整测试套件\n');
        
        const suiteResults = [];
        
        // 测试1: 基础功能测试
        const basicTests = [
            async (page) => await this.testExecutor.testPageLoad(page),
            async (page) => await this.testExecutor.testNoJSErrors(page),
            async (page) => await this.testExecutor.testConsoleErrors(page)
        ];
        
        const basicResult = await this.runSmartTest('基础功能', basicTests);
        suiteResults.push({ name: '基础功能', ...basicResult });
        
        // 测试2: API测试
        if (basicResult.success) {
            const apiTests = [
                async (page) => await this.testExecutor.testAPI(page, '/api/feedback', 'GET'),
                async (page) => await this.testExecutor.testAPI(page, '/api/stats', 'GET')
            ];
            
            const apiResult = await this.runSmartTest('API功能', apiTests);
            suiteResults.push({ name: 'API功能', ...apiResult });
        }
        
        // 输出总结
        console.log('\n' + '='.repeat(60));
        console.log('📊 测试套件总结');
        console.log('='.repeat(60));
        
        for (const result of suiteResults) {
            const icon = result.success ? '✅' : '❌';
            console.log(`${icon} ${result.name}: ${result.message}`);
        }
        
        const totalPassed = suiteResults.filter(r => r.success).length;
        console.log(`\n总计: ${totalPassed}/${suiteResults.length} 测试通过`);
        
        if (this.abortedFeatures.size > 0) {
            console.log(`\n⚠️ 已放弃的功能: ${[...this.abortedFeatures].join(', ')}`);
        }
        
        return suiteResults;
    }

    /**
     * 获取测试历史
     */
    getHistory() {
        return this.testHistory;
    }

    /**
     * 获取已放弃的功能
     */
    getAbortedFeatures() {
        return [...this.abortedFeatures];
    }

    /**
     * 获取快照列表
     */
    getSnapshots() {
        return this.versionManager.listSnapshots();
    }
}

/**
 * 部署前验证器
 */
class DeployValidator {
    constructor(smartTestSystem) {
        this.smartTest = smartTestSystem;
    }

    /**
     * 部署前验证流程
     */
    async validateBeforeDeploy() {
        console.log('\n🚀 开始部署前验证...\n');
        
        // 1. 创建部署前快照
        const snapshotId = this.smartTest.versionManager.createSnapshot('pre-deploy');
        
        // 2. 运行冒烟测试
        const smokeResult = await this.smartTest.runSmokeTest();
        
        if (!smokeResult.success) {
            console.error('❌ 冒烟测试失败，取消部署');
            return { 
                success: false, 
                reason: '冒烟测试失败',
                canDeploy: false 
            };
        }
        
        // 3. 运行完整测试
        const fullResult = await this.smartTest.runFullSuite();
        
        const allPassed = fullResult.every(r => r.success);
        
        if (allPassed) {
            console.log('\n✅ 所有验证通过，可以部署!');
            return {
                success: true,
                snapshotId,
                canDeploy: true
            };
        } else {
            console.log('\n❌ 部分测试失败，已回滚');
            
            // 恢复到部署前快照
            if (snapshotId) {
                this.smartTest.versionManager.restoreSnapshot(snapshotId);
            }
            
            return {
                success: false,
                canDeploy: false,
                details: fullResult
            };
        }
    }
}

// 导出模块
module.exports = {
    VersionManager,
    TestExecutor,
    DecisionEngine,
    SmartTestSystem,
    DeployValidator
};

// 如果直接运行
if (require.main === module) {
    console.log('🧪 智能测试系统');
    console.log('================\n');
    
    const smartTest = new SmartTestSystem({
        baseUrl: process.env.TEST_URL || 'http://localhost:3000',
        maxRetries: 3,
        retryDelay: 2000
    });
    
    // 运行快速冒烟测试
    (async () => {
        try {
            const result = await smartTest.runSmokeTest();
            console.log('\n结果:', result);
            
            // 显示快照列表
            console.log('\n📸 可用快照:');
            console.log(smartTest.getSnapshots());
            
            process.exit(result.success ? 0 : 1);
        } catch (error) {
            console.error('测试失败:', error);
            process.exit(1);
        }
    })();
}
