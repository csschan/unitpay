/**
 * Unitpay 服务器入口点
 */

// 导入应用程序
const app = require('./app');
const logger = require('./utils/logger');

// 确保应用正常运行
process.on('uncaughtException', (error) => {
  logger.error('未捕获的异常:', error);
  logger.error('堆栈跟踪:', error.stack);
  // 不立即退出，允许日志记录
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('未处理的Promise拒绝:', reason);
  // 不立即退出，允许日志记录
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

// 打印启动信息
logger.info('Unitpay 服务器已启动');
logger.info(`环境: ${process.env.NODE_ENV || 'development'}`);
logger.info(`当前时间: ${new Date().toISOString()}`);

// 导出app实例用于测试
module.exports = app; 