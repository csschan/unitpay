const express = require('express');
const path = require('path');
const cors = require('cors');
const logger = require('./utils/logger');
const winston = require('winston');
const apiRoutes = require('./routes/api.routes');
const contractRoutes = require('./routes/contract.routes');
const mainRoutes = require('./routes');
const paymentIntentRoutes = require('./routes/payment-intent.routes');
const { sequelize } = require('./config/database');
const { SOLANA_NETWORK_CONFIG } = require('./config/solana');
const fs = require('fs');
const http = require('http');
const socketIo = require('socket.io');

const app = express();

// Mock mode flag for Solana
const isMockSolana = process.env.SOLANA_MODE === 'mock';

// Mock mode-based import of solana-monitor to prevent require errors
let startMonitoring = () => {};
if (!isMockSolana) {
  try {
    startMonitoring = require('./scripts/solana-monitor').startMonitoring;
  } catch (err) {
    logger.warn('加载 solana-monitor 失败，跳过链上监控:', err);
  }
}

// 初始化数据库
async function initDatabase() {
  const maxRetries = 5;
  const retryDelay = 5000; // 5秒
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      await sequelize.authenticate();
      console.log('数据库连接已建立');
      
      // 同步模型到数据库，但不自动更改表结构
      await sequelize.sync({ alter: false });
      console.log('数据库模型已同步');

      // 确保 payment_intents.platform 枚举包含 Solana
      try {
        await sequelize.query(
          "ALTER TABLE payment_intents MODIFY COLUMN platform ENUM('PayPal','GCash','Alipay','WeChat','Other','Solana') NOT NULL DEFAULT 'Other';"
        );
        console.log('已更新 payment_intents.platform 列，包含 Solana 枚举');
      } catch (enumErr) {
        console.warn('更新 platform 枚举失败，可能已包含 Solana 或权限不足:', enumErr.message);
      }

      // 检查并添加 blockchain_payment_id 字段
      try {
        // 首先检查字段是否存在
        const [columns] = await sequelize.query(
          "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'unitpay' AND TABLE_NAME = 'payment_intents' AND COLUMN_NAME = 'blockchain_payment_id';"
        );
        
        if (columns.length === 0) {
          // 字段不存在，添加它
          await sequelize.query(
            "ALTER TABLE payment_intents ADD COLUMN blockchain_payment_id VARCHAR(255) DEFAULT NULL;"
          );
          console.log('已添加 blockchain_payment_id 字段');
        } else {
          console.log('blockchain_payment_id 字段已存在');
        }
      } catch (columnErr) {
        console.warn('处理 blockchain_payment_id 字段失败:', columnErr.message);
      }

      return true;
    } catch (error) {
      retryCount++;
      console.error(`数据库连接失败 (尝试 ${retryCount}/${maxRetries}):`, error);
      
      if (retryCount < maxRetries) {
        console.log(`将在 ${retryDelay/1000} 秒后重试...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        console.error('达到最大重试次数，数据库连接失败');
        return false;
      }
    }
  }
  return false;
}

// 添加Solana初始化
if (!isMockSolana) {
  console.log('Solana网络配置:', SOLANA_NETWORK_CONFIG.networkName);
  // 启动Solana合约事件监控
  startMonitoring();
} else {
  console.log('Solana mock 模式，已跳过链上监控');
}

// 调用初始化函数
initDatabase().then(success => {
  console.log('数据库初始化状态:', success ? '成功' : '失败');
}).catch(err => {
  console.error('数据库初始化失败:', err);
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 添加请求路径日志
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    next();
});

// 静态文件服务
const publicPath = path.join(__dirname, '../public');
console.log('静态文件目录:', publicPath);
app.use(express.static(publicPath));

// 检查重要HTML文件是否存在
const files = ['index.html', 'solana-test.html'];
files.forEach(file => {
    const filePath = path.join(publicPath, file);
    console.log(`检查文件 ${file}: ${fs.existsSync(filePath) ? '存在' : '不存在'}`);
});

// 添加路由调试日志
console.log('注册API路由...');
console.log('API路由路径数量:', apiRoutes.stack ? apiRoutes.stack.length : 0);
console.log('合约路由路径数量:', contractRoutes.stack ? contractRoutes.stack.length : 0);
console.log('主要路由对象:', typeof mainRoutes);
console.log('主要路由路径数量:', mainRoutes.stack ? mainRoutes.stack.length : 0);
if (mainRoutes.stack) {
  console.log('主要路由详情:');
  mainRoutes.stack.forEach((layer, index) => {
    if (layer.route) {
      console.log(`路由 ${index}: ${layer.route.path} [${Object.keys(layer.route.methods).filter(m => layer.route.methods[m]).join(', ')}]`);
    }
  });
}

// Register routes
app.use('/api', paymentIntentRoutes);
app.use('/api', apiRoutes);
app.use('/api/contract', contractRoutes);
app.use('/', mainRoutes);

// 错误处理中间件
app.use((err, req, res, next) => {
    console.error('错误:', err);
    res.status(500).json({
        success: false,
        message: '服务器内部错误',
        error: process.env.NODE_ENV === 'development' ? err.message : '服务器错误'
    });
});

// 404处理
app.use((req, res) => {
    console.log(`404错误 - 未找到资源: ${req.method} ${req.originalUrl}`);
    res.status(404).json({
        success: false,
        message: '未找到请求的资源',
        path: req.originalUrl
    });
});

// 创建HTTP服务器
const server = http.createServer(app);

// 初始化Socket.io
const io = socketIo(server, {
  path: '/socket.io',
  allowEIO3: true,
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// Debug Socket.io connections
io.engine.on('connection_error', (err) => console.error('[Socket.IO] engine connection_error', err));
io.on('connection', (socket) => console.log('[Socket.IO] client connected:', socket.id));

// 将Socket.io实例添加到Express应用
app.set('io', io);

// 存储所有连接的客户端
const clients = new Map();

// Socket.io连接处理
io.on('connection', (socket) => {
  console.log('客户端连接成功，ID:', socket.id);
  
  // 处理客户端识别
  socket.on('identify', (data) => {
    if (data && data.walletAddress) {
      console.log(`客户端身份识别: ${data.walletAddress}`);
      socket.join(data.walletAddress);
      clients.set(socket.id, {
        walletAddress: data.walletAddress,
        socket: socket
      });
    }
  });

  // 处理钱包连接事件
  socket.on('wallet_connect', (data) => {
    if (data && data.walletAddress) {
      console.log(`钱包连接: ${data.walletAddress}, 类型: ${data.userType || '未知'}`);
      socket.join(data.walletAddress);
      clients.set(socket.id, {
        walletAddress: data.walletAddress,
        userType: data.userType || 'unknown',
        socket: socket
      });
    }
  });
  
  // 断开连接事件
  socket.on('disconnect', () => {
    console.log('客户端断开连接:', socket.id);
    clients.delete(socket.id);
  });
  
  // 发送初始连接确认
  socket.emit('connect_confirmed', { socketId: socket.id });
});

// 重写logger的transport，添加Socket.io广播
logger.add(new winston.transports.Console({
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
    winston.format.printf(info => {
      const logMessage = JSON.stringify(info);
      io.emit('log_message', info);
      return logMessage;
    })
  )
}));

// 启动HTTP服务器 (Solana service)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`Solana 服务已启动，运行在端口 ${PORT}`);
});

// 导出服务器实例
module.exports = { app, server };
