/**
 * 测试运行脚本
 * 用于本地开发和CI环境运行自动化测试
 */

const { E2ETestSuite, CITestRunner } = require('./auto-tester');

async function main() {
    const isCI = process.argv.includes('--ci');
    
    if (isCI) {
        // CI模式
        const runner = new CITestRunner();
        await runner.run();
    } else {
        // 本地开发模式
        console.log('🧪 本地测试模式\n');
        
        const tester = new E2ETestSuite({
            baseUrl: process.env.TEST_URL || 'http://localhost:3000',
            headless: false,  // 本地模式显示浏览器
            slowMo: 50
        });
        
        await tester.runFullSuite();
    }
}

main().catch(console.error);
