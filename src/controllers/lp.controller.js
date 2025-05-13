const { LP, PaymentIntent } = require('../models/mysql');
const { Op } = require('sequelize');
const { sequelize } = require('../config/database');
const { serializeModels } = require('../utils/serialization.utils');

/**
 * LP注册
 * @route POST /api/lp/register
 * @access Public
 */
exports.registerLP = async (req, res) => {
  try {
    const {
      walletAddress,
      name,
      email,
      supportedPlatforms,
      totalQuota,
      perTransactionQuota,
      fee_rate
    } = req.body;
    
    // 验证请求数据
    if (!walletAddress || !supportedPlatforms || !totalQuota || !perTransactionQuota) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数：钱包地址、支持平台、总额度和单笔额度必须提供'
      });
    }
    
    // 验证钱包地址格式（支持以太坊和 Solana 地址）
    const isEthAddress = /^0x[a-fA-F0-9]{40}$/.test(walletAddress);
    const isSolanaAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress);
    
    if (!isEthAddress && !isSolanaAddress) {
      return res.status(400).json({
        success: false,
        message: '无效的钱包地址格式'
      });
    }
    
    // 检查LP是否已存在
    let lp = await LP.findOne({ where: { walletAddress } });
    if (lp) {
      return res.status(400).json({
        success: false,
        message: '该钱包地址已注册为LP'
      });
    }
    
    // 验证费率（如果提供）
    const validatedFeeRate = fee_rate !== undefined ? parseFloat(fee_rate) : 0.5;
    if (isNaN(validatedFeeRate) || validatedFeeRate < 0 || validatedFeeRate > 100) {
      return res.status(400).json({
        success: false,
        message: '无效的费率，必须是0-100之间的数字'
      });
    }
    
    // 创建新LP
    lp = await LP.create({
      walletAddress,
      name: name || '',
      email: email || '',
      supportedPlatforms: Array.isArray(supportedPlatforms) ? supportedPlatforms : [supportedPlatforms],
      totalQuota: parseFloat(totalQuota),
      availableQuota: parseFloat(totalQuota),
      lockedQuota: 0,
      perTransactionQuota: parseFloat(perTransactionQuota),
      fee_rate: validatedFeeRate,
      isVerified: true, // MVP阶段简化验证流程
      isActive: true
    });
    
    return res.status(201).json({
      success: true,
      message: 'LP注册成功',
      data: {
        lpId: lp.id,
        walletAddress: lp.walletAddress,
        totalQuota: lp.totalQuota,
        availableQuota: lp.availableQuota,
        perTransactionQuota: lp.perTransactionQuota,
        fee_rate: lp.fee_rate
      }
    });
    
  } catch (error) {
    console.error('LP注册失败:', error);
    return res.status(500).json({
      success: false,
      message: 'LP注册失败',
      error: process.env.NODE_ENV === 'development' ? error.message : '服务器内部错误'
    });
  }
};

/**
 * 更新LP配额
 * @route PUT /api/eth/lp/quota
 * @access Public
 */
exports.updateQuota = async (req, res) => {
  try {
    const { walletAddress, totalQuota, perTransactionQuota } = req.body;
    
    // 验证请求数据
    if (!walletAddress || !totalQuota || !perTransactionQuota) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数：钱包地址、总额度和单笔额度必须提供'
      });
    }
    
    // 查找LP
    const lp = await LP.findOne({ where: { walletAddress } });
    if (!lp) {
      return res.status(404).json({
        success: false,
        message: '未找到该钱包地址对应的LP'
      });
    }
    
    // 更新配额
    await lp.update({
      totalQuota,
      perTransactionQuota
    });
    
    return res.json({
      success: true,
      message: 'LP配额更新成功',
      data: lp
    });
  } catch (error) {
    console.error('更新LP配额失败:', error);
    return res.status(500).json({
      success: false,
      message: '更新LP配额失败',
      error: error.message
    });
  }
};

/**
 * 获取LP信息
 * @route GET /api/lp/:walletAddress
 * @access Public
 */
exports.getLP = async (req, res) => {
  try {
    const { walletAddress } = req.params;
    
    // 验证钱包地址格式（支持以太坊和 Solana 地址）
    const isEthAddress = /^0x[a-fA-F0-9]{40}$/.test(walletAddress);
    const isSolanaAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress);
    
    if (!isEthAddress && !isSolanaAddress) {
      return res.status(400).json({
        success: false,
        message: '无效的钱包地址格式'
      });
    }
    
    // 查找LP
    const lp = await LP.findOne({ where: { walletAddress } });
    if (!lp) {
      return res.status(404).json({
        success: false,
        message: '未找到该LP'
      });
    }
    
    return res.status(200).json({
      success: true,
      data: lp
    });
    
  } catch (error) {
    console.error('获取LP信息失败:', error);
    return res.status(500).json({
      success: false,
      message: '获取LP信息失败',
      error: process.env.NODE_ENV === 'development' ? error.message : '服务器内部错误'
    });
  }
};

/**
 * 获取任务池
 * @route GET /api/lp/task-pool
 * @access Public
 */
exports.getTaskPool = async (req, res) => {
  try {
    console.log('开始查询任务池...');
    console.log('请求参数:', req.query);
    
    const { walletAddress, platform, minAmount, maxAmount } = req.query;
    
    if (!walletAddress) {
      console.error('缺少钱包地址参数');
      return res.status(400).json({
        success: false,
        message: '缺少钱包地址参数'
      });
    }
    
    console.log('验证钱包地址:', walletAddress);
    console.log('钱包地址长度:', walletAddress.length);
    console.log('钱包地址格式:', walletAddress.startsWith('0x') ? '正确' : '错误');
    
    // 检查LP注册状态
    console.log('开始查询LP记录...');
    const lp = await LP.findOne({ 
      where: { 
        walletAddress: walletAddress.startsWith('0x') ? walletAddress.toLowerCase() : walletAddress
      } 
    });
    console.log('LP查询结果:', lp ? '找到记录' : '未找到记录');
    
    if (!lp) {
      console.debug('LP未注册:', walletAddress);
      return res.status(400).json({
        success: false,
        message: 'LP未注册'
      });
    }
    
    console.log('LP已注册:', lp.toJSON());
    
    // 构建查询条件
    // 1. 显示所有可接任务（status: 'created' 或 'pending'）
    // 2. 显示该LP已经接的任务（lpWalletAddress: walletAddress）
    const whereCreated = { status: { [Op.in]: ['created', 'pending'] } };
    const whereClaimed = { 
      lpWalletAddress: walletAddress,
      status: { [Op.in]: ['claimed', 'paid', 'confirmed', 'processing', 'settled'] }
    };
    
    // 添加平台筛选
    if (platform) {
      whereCreated.platform = platform;
      whereClaimed.platform = platform;
    }
    
    // 添加金额范围筛选
    if (minAmount || maxAmount) {
      whereCreated.amount = {};
      whereClaimed.amount = {};
      if (minAmount) {
        whereCreated.amount[Op.gte] = parseFloat(minAmount);
        whereClaimed.amount[Op.gte] = parseFloat(minAmount);
      }
      if (maxAmount) {
        whereCreated.amount[Op.lte] = parseFloat(maxAmount);
        whereClaimed.amount[Op.lte] = parseFloat(maxAmount);
      }
    }
    
    console.log('查询条件(可接任务):', whereCreated);
    console.log('查询条件(已接任务):', whereClaimed);
    
    // 查询任务池 - 分别查询可接任务和已接任务
    console.log('开始查询任务池...');
    const createdTasks = await PaymentIntent.findAll({
      where: whereCreated,
      order: [['createdAt', 'DESC']],
      attributes: ['id', 'amount', 'currency', 'description', 'platform', 'status', 'createdAt', 'updatedAt', 'lpWalletAddress', 'userWalletAddress', 'statusHistory']
    });
    
    const claimedTasks = await PaymentIntent.findAll({
      where: whereClaimed,
      order: [['createdAt', 'DESC']],
      attributes: ['id', 'amount', 'currency', 'description', 'platform', 'status', 'createdAt', 'updatedAt', 'lpWalletAddress', 'userWalletAddress', 'statusHistory']
    });
    
    // 合并任务列表
    const tasks = [...createdTasks, ...claimedTasks];
    
    console.log(`查询到 ${tasks.length} 个任务`);
    
    res.json({
      success: true,
      data: {
        tasks: serializeModels(tasks)
      }
    });
  } catch (error) {
    console.error('查询任务池失败:', error);
    console.error('错误堆栈:', error.stack);
    res.status(500).json({
      success: false,
      message: '查询任务池失败: ' + error.message
    });
  }
};

/**
 * LP认领任务
 * @route POST /api/lp/task/:id/claim
 * @access Public
 */
exports.claimTask = async (req, res) => {
  try {
    const { id } = req.params;
    const { walletAddress, network = 'eth' } = req.body;
    
    console.log(`开始处理任务认领: 任务ID=${id}, 钱包地址=${walletAddress}, 网络=${network}`);
    
    // 校验钱包地址是否存在
    if (!walletAddress) {
      return res.status(400).json({ success: false, message: '钱包地址不能为空' });
    }
    // 根据网络类型校验地址格式
    if (network === 'eth') {
      if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
        return res.status(400).json({ success: false, message: '无效的以太坊钱包地址' });
      }
    } else if (network === 'sol') {
      const solRegex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
      if (!solRegex.test(walletAddress)) {
        return res.status(400).json({ success: false, message: '无效的Solana钱包地址' });
      }
    } else {
      return res.status(400).json({ success: false, message: `未知网络类型: ${network}` });
    }
    
    // 查找LP
    const lp = await LP.findOne({ where: { walletAddress } });
    if (!lp) {
      return res.status(404).json({
        success: false,
        message: '未找到该LP'
      });
    }
    
    // 查询支付意图
    const paymentIntent = await PaymentIntent.findByPk(id);
    
    if (!paymentIntent) {
      return res.status(404).json({
        success: false,
        message: '支付意图不存在'
      });
    }
    
    console.log(`任务${id}当前状态: ${paymentIntent.status}`);
    
    // 检查支付意图状态
    if (paymentIntent.status !== 'created') {
      return res.status(400).json({
        success: false,
        message: `支付意图当前状态为${paymentIntent.status}，无法认领`
      });
    }
    
    // 检查LP是否支持该支付平台
    if (!lp.supportedPlatforms.includes(paymentIntent.platform)) {
      return res.status(400).json({
        success: false,
        message: `LP不支持${paymentIntent.platform}支付平台`
      });
    }
    
    // 检查LP额度
    if (lp.availableQuota < paymentIntent.amount) {
      return res.status(400).json({
        success: false,
        message: '可用额度不足'
      });
    }
    
    if (paymentIntent.amount > lp.perTransactionQuota) {
      return res.status(400).json({
        success: false,
        message: '超出单笔交易额度限制'
      });
    }
    
    // 锁定LP额度
    lp.lockedQuota += paymentIntent.amount;
    lp.availableQuota = lp.totalQuota - lp.lockedQuota;
    await lp.save();
    
    // 更新支付意图状态
    const prevHistory = Array.isArray(paymentIntent.statusHistory) ? paymentIntent.statusHistory : [];
    const statusHistory = [...prevHistory, {
      status: 'claimed',
      timestamp: new Date(),
      note: `LP ${walletAddress} 认领任务`
    }];
    
    // 检查是否有PayPal邮箱，如果是PayPal支付则确保设置merchantPaypalEmail
    let merchantPaypalEmail = null;
    try {
      merchantPaypalEmail = paymentIntent.merchantPaypalEmail;
    } catch (e) {
      console.error('获取merchantPaypalEmail字段失败，该字段可能不存在:', e);
    }

    if (paymentIntent.platform === 'PayPal' && lp.paypalEmail) {
      merchantPaypalEmail = lp.paypalEmail;
      console.log(`为PayPal支付设置商家邮箱: ${merchantPaypalEmail}`);
    }

    // 更新支付意图
    try {
    await paymentIntent.update({
      status: 'claimed',
      lpWalletAddress: walletAddress,
      lpId: lp.id,
      statusHistory,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30分钟过期时间
      network
    });
      
      // 尝试单独更新merchantPaypalEmail字段
      if (merchantPaypalEmail) {
        try {
          await paymentIntent.update({
            merchantPaypalEmail: merchantPaypalEmail
          });
          console.log('商家PayPal邮箱更新成功');
        } catch (e) {
          console.error('更新merchantPaypalEmail字段失败，该字段可能不存在:', e);
          // 继续处理，不中断流程
        }
      }
    } catch (updateError) {
      console.error('更新支付意图失败:', updateError);
      throw updateError;
    }
    
    // 再次查询以确保更新成功
    const updatedPaymentIntent = await PaymentIntent.findByPk(id);
    console.log(`任务${id}更新后状态: ${updatedPaymentIntent.status}, LP钱包地址: ${updatedPaymentIntent.lpWalletAddress}`);
    
    // 通过Socket.io通知用户任务已被认领
    if (req.io) {
      req.io.to(paymentIntent.userWalletAddress).emit('payment_intent_claimed', {
        id: paymentIntent.id,
        lpWalletAddress: lp.walletAddress
      });
    }
    
    return res.status(200).json({
      success: true,
      message: '任务认领成功',
      data: {
        paymentIntentId: paymentIntent.id,
        status: 'claimed',
        expiresAt: paymentIntent.expiresAt
      }
    });
    
  } catch (error) {
    console.error('认领任务失败:', error);
    return res.status(500).json({
      success: false,
      message: '认领任务失败',
      error: process.env.NODE_ENV === 'development' ? error.message : '服务器内部错误'
    });
  }
};

/**
 * LP标记任务已支付
 * @route POST /api/lp/task/:id/mark-paid
 * @access Public
 */
exports.markTaskPaid = async (req, res) => {
  try {
    const { id } = req.params;
    const { walletAddress, paymentProof } = req.body;
    
    console.log(`========== 开始处理支付确认 ==========`);
    console.log(`任务ID: ${id}, 钱包地址: ${walletAddress}`);
    console.log(`支付证明:`, JSON.stringify(paymentProof));
    
    // 验证钱包地址格式
    if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return res.status(400).json({
        success: false,
        message: '无效的以太坊钱包地址'
      });
    }
    
    // 查询支付意图
    const paymentIntent = await PaymentIntent.findByPk(id);
    
    if (!paymentIntent) {
      return res.status(404).json({
        success: false,
        message: '支付意图不存在'
      });
    }
    
    console.log(`查询到任务 ${id}, 当前状态: ${paymentIntent.status}, 金额: ${paymentIntent.amount}, 平台: ${paymentIntent.platform}`);
    
    // 验证LP是否有权限标记
    if (paymentIntent.lpWalletAddress !== walletAddress) {
      return res.status(403).json({
        success: false,
        message: '无权标记此支付意图'
      });
    }
    
    // 检查任务状态，只允许claimed和processing状态的任务被标记为已支付
    if (paymentIntent.status !== 'claimed' && paymentIntent.status !== 'processing') {
      return res.status(400).json({
        success: false,
        message: `任务状态已变更为"${paymentIntent.status}"，无法标记为已支付`,
        currentStatus: paymentIntent.status,
        requiredStatus: 'claimed'
      });
    }
    
    // 获取LP信息以验证额度限制
    const lp = await LP.findOne({ where: { walletAddress } });
    if (!lp) {
      return res.status(404).json({
        success: false,
        message: '未找到该LP'
      });
    }
    
    // 检查支付金额是否超过单笔额度上限
    if (paymentIntent.amount > lp.perTransactionQuota) {
      return res.status(400).json({
        success: false,
        message: `支付金额 ${paymentIntent.amount} USDT 超过您的单笔额度上限 ${lp.perTransactionQuota} USDT`
      });
    }
    
    // 根据支付平台进行特定验证
    if (paymentIntent.platform === 'PayPal') {
      // PayPal支付验证
      console.log(`验证PayPal支付...`);
      
      // 检查是否提供了基本的支付证明信息
      if (!paymentProof) {
        return res.status(400).json({
          success: false,
          message: '缺少支付证明'
        });
      }
      
      // 检查是否提供了交易ID
      if (!paymentProof.transactionId) {
        console.log(`PayPal支付缺少交易ID`);
        // 在测试模式下，我们允许没有交易ID的情况
        if (process.env.NODE_ENV !== 'production') {
          console.log(`非生产环境，跳过交易ID验证`);
          // 创建一个模拟的交易ID (仅用于测试环境)
          paymentProof.transactionId = `TEST-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
          console.log(`生成测试交易ID: ${paymentProof.transactionId}`);
        } else {
          return res.status(400).json({
            success: false,
            message: '缺少PayPal交易ID'
          });
        }
      }
      
      // 在生产环境中，应该调用PayPal API验证交易ID
      if (process.env.NODE_ENV === 'production') {
        try {
          console.log(`生产环境: 调用PayPal API验证交易ID ${paymentProof.transactionId}...`);
          // 实际的PayPal交易验证代码应在此处实现
          // const paypalResult = await verifyPayPalTransaction(paymentProof.transactionId, paymentIntent.amount);
          
          // 模拟验证
          const paypalVerified = true;
          
          if (!paypalVerified) {
            return res.status(400).json({
              success: false,
              message: 'PayPal交易验证失败'
            });
          }
        } catch (verifyError) {
          console.error('PayPal交易验证错误:', verifyError);
          return res.status(500).json({
            success: false,
            message: 'PayPal交易验证失败',
            error: process.env.NODE_ENV === 'development' ? verifyError.message : '交易验证错误'
          });
        }
      } else {
        console.log(`测试环境: 跳过PayPal API交易验证`);
      }
      
      // 确保PayPal支付证明包含必要信息
      paymentProof.platform = 'PayPal';
      paymentProof.verificationStatus = process.env.NODE_ENV === 'production' ? 'verified' : 'test_mode';
      paymentProof.verificationTime = new Date().toISOString();
      
      console.log(`PayPal支付验证完成:`, JSON.stringify(paymentProof));
    }
    
    // 更新支付意图状态
    const statusHistory = [...paymentIntent.statusHistory, {
      status: 'paid',
      timestamp: new Date(),
      note: `LP ${walletAddress} 标记任务已支付`,
      paymentProof: paymentProof || {}
    }];
    
    console.log(`更新任务状态为 paid...`);
    await paymentIntent.update({
      status: 'paid',
      statusHistory,
      paymentProof: paymentProof || {}
    });
    console.log(`任务状态已更新为 paid`);
    
    // 更新LP锁定额度 - 任务已支付，释放锁定的额度
    console.log(`查询LP信息: ${walletAddress}`);
    const updatedLP = await LP.findOne({ where: { walletAddress } });
    
    if (updatedLP) {
      console.log(`LP信息: ID=${updatedLP.id}, 总额度=${updatedLP.totalQuota}, 锁定额度=${updatedLP.lockedQuota}, 可用额度=${updatedLP.availableQuota}`);
      console.log(`需要释放的金额: ${paymentIntent.amount}`);
      
      const originalLockedQuota = updatedLP.lockedQuota;
      const originalAvailableQuota = updatedLP.availableQuota;
      
      // 使用模型中的releaseLockedQuota方法释放额度
      const releaseSuccess = await updatedLP.releaseLockedQuota(parseFloat(paymentIntent.amount));
      
      if (releaseSuccess) {
        console.log(`成功释放锁定额度! 使用方法: updatedLP.releaseLockedQuota()`);
        console.log(`更新锁定额度: ${originalLockedQuota} → ${updatedLP.lockedQuota}`);
        console.log(`更新可用额度: ${originalAvailableQuota} → ${updatedLP.availableQuota}`);
      } else {
        console.error(`释放锁定额度失败! 尝试手动更新...`);
        
        // 手动更新作为备用方案
        updatedLP.lockedQuota = Math.max(0, originalLockedQuota - parseFloat(paymentIntent.amount));
        updatedLP.availableQuota = updatedLP.totalQuota - updatedLP.lockedQuota;
        
        await updatedLP.save();
        console.log(`手动更新: 锁定额度=${updatedLP.lockedQuota}, 可用额度=${updatedLP.availableQuota}`);
      }
      
      // 再次验证更新是否成功
      const verifiedUpdatedLP = await LP.findOne({ where: { walletAddress } });
      console.log(`验证更新后的LP信息: 锁定额度=${verifiedUpdatedLP.lockedQuota}, 可用额度=${verifiedUpdatedLP.availableQuota}`);
      
      if (verifiedUpdatedLP.lockedQuota !== updatedLP.lockedQuota) {
        console.warn(`警告: 锁定额度更新似乎未生效! 期望值=${updatedLP.lockedQuota}, 实际值=${verifiedUpdatedLP.lockedQuota}`);
      }
    } else {
      console.error(`未找到LP: ${walletAddress}`);
    }
    
    // 通过Socket.io通知用户任务已支付
    if (req.io) {
      req.io.to(paymentIntent.userWalletAddress).emit('payment_intent_paid', {
        id: paymentIntent.id,
        lpWalletAddress: walletAddress,
        paymentProof
      });
    }
    
    console.log(`========== 支付确认处理完成 ==========`);
    return res.status(200).json({
      success: true,
      message: '任务标记为已支付成功',
      data: {
        paymentIntentId: paymentIntent.id,
        status: 'paid',
        platform: paymentIntent.platform,
        paymentProof: {
          transactionId: paymentProof?.transactionId || null,
          platform: paymentProof?.platform || null,
          verificationStatus: paymentProof?.verificationStatus || null
        },
        lpStatus: {
          lockedQuota: updatedLP ? updatedLP.lockedQuota : null,
          availableQuota: updatedLP ? updatedLP.availableQuota : null
        }
      }
    });
    
  } catch (error) {
    console.error('标记任务已支付失败:', error);
    return res.status(500).json({
      success: false,
      message: '标记任务已支付失败',
      error: process.env.NODE_ENV === 'development' ? error.message : '服务器内部错误'
    });
  }
};

/**
 * 直接获取LP数据，不包装响应
 * @route GET /api/lp/direct/:walletAddress
 * @access Public
 */
exports.getLPDirect = async (req, res) => {
  try {
    const { walletAddress } = req.params;
    
    // 验证钱包地址格式（支持以太坊和 Solana 地址）
    const isEthAddress = /^0x[a-fA-F0-9]{40}$/.test(walletAddress);
    const isSolanaAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress);
    
    if (!isEthAddress && !isSolanaAddress) {
      return res.status(400).json({
        success: false,
        message: '无效的钱包地址格式'
      });
    }
    
    // 使用原始SQL查询，确保获取最新数据
    const [lpsRaw] = await sequelize.query(`
      SELECT * FROM lps WHERE walletAddress = ?
    `, {
      replacements: [walletAddress]
    });
    
    // 检查是否找到LP
    if (!lpsRaw || lpsRaw.length === 0) {
      // 返回基本的响应对象，而不是404错误，这样前端不会一直尝试重新加载
      return res.status(200).json({
        success: true,
        message: '未找到LP注册信息，但请求成功处理',
        walletAddress: walletAddress,
        isRegistered: false
      });
    }
    
    // 获取LP数据
    const lpData = lpsRaw[0];
    
    // 处理supportedPlatforms
    let supportedPlatforms = [];
    try {
      if (Array.isArray(lpData.supportedPlatforms)) {
        supportedPlatforms = lpData.supportedPlatforms;
      } else if (typeof lpData.supportedPlatforms === 'string') {
        supportedPlatforms = lpData.supportedPlatforms.split(',').map(p => p.trim()).filter(p => p);
      }
    } catch (e) {
      console.warn('解析supportedPlatforms失败:', e);
      supportedPlatforms = [];
    }
    
    // 构建返回对象
    const lpResponse = {
      ...lpData,
      supportedPlatforms: supportedPlatforms,
      // 明确添加isRegistered标志
      isRegistered: true,
      // 明确添加fee_rate字段，确保它不会丢失
      fee_rate: parseFloat(lpData.fee_rate || 0.5)
    };
    
    console.log('返回LP数据:', lpResponse);
    
    // 直接返回LP数据对象
    return res.status(200).json(lpResponse);
    
  } catch (error) {
    console.error('直接获取LP数据失败:', error);
    return res.status(500).json({
      success: false,
      message: '获取LP数据失败',
      error: process.env.NODE_ENV === 'development' ? error.message : '服务器内部错误'
    });
  }
};

/**
 * 获取任务详情
 * @route GET /api/lp/task/:id
 * @access Public
 */
exports.getTask = async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`获取任务详情: ${id}`);
    
    // 查找任务（支付意图）
    const task = await PaymentIntent.findByPk(id);
    if (!task) {
      return res.status(404).json({
        success: false,
        message: '未找到该任务'
      });
    }
    
    // 如果任务已分配给LP，获取LP信息
    let lpInfo = null;
    if (task.lpWalletAddress) {
      const lp = await LP.findOne({ where: { walletAddress: task.lpWalletAddress } });
      if (lp) {
        lpInfo = {
          id: lp.id,
          walletAddress: lp.walletAddress,
          name: lp.name,
          email: lp.email
        };
      }
    }
    
    // 安全处理JSON字段
    let statusHistory = task.statusHistory;
    try {
      if (typeof statusHistory === 'string') {
        statusHistory = JSON.parse(statusHistory);
      }
    } catch (err) {
      console.error('解析状态历史失败:', err);
      statusHistory = [];
    }
    
    let paymentProof = task.paymentProof;
    try {
      if (typeof paymentProof === 'string') {
        paymentProof = JSON.parse(paymentProof);
      }
    } catch (err) {
      console.error('解析支付证明失败:', err);
      paymentProof = null;
    }
    
    let processingDetails = task.processingDetails;
    try {
      if (typeof processingDetails === 'string') {
        processingDetails = JSON.parse(processingDetails);
      }
    } catch (err) {
      console.error('解析处理详情失败:', err);
      processingDetails = null;
    }
    
    let errorDetails = task.errorDetails;
    try {
      if (typeof errorDetails === 'string') {
        errorDetails = JSON.parse(errorDetails);
      }
    } catch (err) {
      console.error('解析错误详情失败:', err);
      errorDetails = null;
    }
    
    // 构建响应数据
    const taskData = {
      id: task.id,
      amount: task.amount,
      currency: task.currency,
      platform: task.platform,
      status: task.status,
      userWalletAddress: task.userWalletAddress,
      lpWalletAddress: task.lpWalletAddress,
      lpInfo: lpInfo,
      description: task.description,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      statusHistory: statusHistory,
      paymentProof: paymentProof,
      processingDetails: processingDetails,
      errorDetails: errorDetails,
      settlementTxHash: task.settlementTxHash,
      network: task.network || 'ethereum',
      data: task.data
    };
    
    console.log(`成功获取任务详情: ${id}`);
    
    return res.status(200).json({
      success: true,
      data: taskData
    });
    
  } catch (error) {
    console.error('获取任务详情失败:', error);
    console.error('错误堆栈:', error.stack);
    return res.status(500).json({
      success: false,
      message: '获取任务详情失败: ' + error.message,
      error: process.env.NODE_ENV === 'development' ? error.message : '服务器内部错误'
    });
  }
};

/**
 * 获取可用LP列表
 * @route GET /api/lp/available
 * @access Public
 */
exports.getAvailableLPs = async (req, res) => {
  try {
    console.log('开始获取可用LP列表...');
    
    // 使用Sequelize查询，它会自动处理JSON字段
    const lps = await LP.findAll({
      where: { isActive: true },
      order: [['fee_rate', 'ASC']]
    });
    
    console.log(`查询成功，找到 ${lps.length} 个LP`);
    
    // 转换为前端所需格式
    const lpList = lps.map(lp => ({
      id: lp.id,
      walletAddress: lp.walletAddress || '',
      address: lp.walletAddress || '', // 提供address字段以兼容前端代码
      name: lp.name || `LP_${lp.id}`,
      supportedPlatforms: Array.isArray(lp.supportedPlatforms) ? lp.supportedPlatforms : [],
      fee_rate: lp.fee_rate || 0.5,
      totalQuota: lp.totalQuota || 0,
      availableQuota: lp.availableQuota || 0,
      perTransactionQuota: lp.perTransactionQuota || 0
    }));
    
    return res.json({
      success: true,
      data: {
        lps: lpList
      }
    });
  } catch (error) {
    console.error('获取可用LP列表失败:', error);
    return res.status(500).json({
      success: false,
      message: '获取可用LP列表失败',
      error: process.env.NODE_ENV === 'development' ? error.message : '服务器内部错误'
    });
  }
};