const { PaymentIntent, User, LP } = require('../models/mysql/index');
const { parseQRCode, identifyPaymentPlatform } = require('../utils/qrcode.utils');
const { validatePaymentData } = require('../utils/validation.utils');
const { paymentService } = require('../services/payment.service');
const web3 = require('web3');
const { serializeModels } = require('../utils/serialization.utils');
const { Op, Sequelize } = require('sequelize');

// 支持的支付平台列表
const SUPPORTED_PLATFORMS = ['PayPal', 'GCash', 'Alipay', 'WeChat', 'Other'];

/**
 * 创建支付意图
 * @route POST /api/payment-intent
 * @access Public
 */
exports.createPaymentIntent = async (req, res) => {
  try {
    console.log('开始创建支付意图，请求数据:', req.body);
    // 获取请求参数
    let { 
      userWalletAddress,
      walletAddress, 
      amount, 
      platform, 
      description = '', 
      qrContent = '',
      merchantPaypalEmail = '',
      lpWalletAddress,
      lpAddress = null,
      fee_rate = 0.5,
      fee_amount = 0,
      total_amount = 0,
      autoMatchLP = false
    } = req.body;
    
    // 确保兼容性 - 支持用户钱包地址字段的两种命名方式
    walletAddress = userWalletAddress || walletAddress;
    lpAddress = lpWalletAddress || lpAddress;
    
    // 费率处理
    const feeRate = parseFloat(fee_rate || 0.5);
    
    console.log('支付请求参数:', {
      walletAddress,
      amount,
      platform,
      lpAddress,
      feeRate,
      autoMatchLP
    });
    
    // 验证钱包地址格式 - 同时支持以太坊和Solana
    const isEthAddress = /^0x[a-fA-F0-9]{40}$/.test(walletAddress);
    const isSolAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress);
    
    if (!isEthAddress && !isSolAddress) {
      console.error('无效的钱包地址格式:', walletAddress);
      return res.status(400).json({
        success: false,
        message: '无效的钱包地址格式'
      });
    }
    
    // LP 钱包地址验证 - 支持以太坊和Solana (如果提供了LP地址)
    if (lpAddress && lpAddress !== 'auto') {
      const isLPEthAddress = /^0x[a-fA-F0-9]{40}$/.test(lpAddress);
      const isLPSolAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(lpAddress);
      
      if (!isLPEthAddress && !isLPSolAddress) {
        console.error('无效的LP钱包地址格式:', lpAddress);
        return res.status(400).json({
          success: false,
          message: '无效的LP钱包地址格式'
        });
      }
    }
    
    if (!platform) {
      return res.status(400).json({
        success: false,
        message: '支付平台不能为空'
      });
    }
    
    if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
      return res.status(400).json({
        success: false,
        message: '金额必须为正数'
      });
    }

    // 金额转换为数字
    amount = parseFloat(amount);
    
    // 处理LP地址
    // 如果请求了自动匹配或没有提供LP地址，使用LP匹配服务
    if (autoMatchLP || !lpAddress || lpAddress === 'auto') {
      try {
        console.log(`需要自动匹配LP，费率: ${feeRate}%`);
        const lpMatchingService = require('../services/lp-matching.service');
        
        // 确保系统中有默认LP
        await lpMatchingService.ensureDefaultLP();
        
        const lp = await lpMatchingService.findBestLP(feeRate, amount);
        
        if (lp) {
          lpAddress = lp.walletAddress || lp.address;
          console.log(`自动匹配成功，LP地址: ${lpAddress}, 费率: ${lp.feeRate || feeRate}%`);
        } else {
          // 如果LP匹配服务返回null（极少情况），使用环境变量中的默认LP
          lpAddress = process.env.DEFAULT_LP_ADDRESS;
          console.log(`LP匹配失败，使用默认LP地址: ${lpAddress}`);
          
          // 如果仍然没有LP地址，创建一个系统LP
          if (!lpAddress) {
            lpAddress = '0x0000000000000000000000000000000000000001';
            console.log(`没有配置默认LP，使用系统LP地址: ${lpAddress}`);
          }
        }
      } catch (error) {
        console.error('LP匹配失败:', error);
        
        // 使用备用LP地址
        lpAddress = process.env.DEFAULT_LP_ADDRESS || '0x0000000000000000000000000000000000000001';
        console.log(`LP匹配出错，使用备用LP地址: ${lpAddress}`);
      }
    }
    
    // 确保LP地址有效
    if (!lpAddress || lpAddress === 'auto') {
      return res.status(400).json({
        success: false,
        message: 'LP地址无效或未能找到合适的LP'
      });
    }
    
    console.log(`最终使用LP地址: ${lpAddress}, 费率: ${feeRate}%`);
    
    // 验证必要参数
    if (!amount || !platform || !walletAddress) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数：金额、支付平台和用户钱包地址必须提供'
      });
    }

    // 如果是PayPal支付，验证商家PayPal邮箱
    if (platform === 'PayPal' && !merchantPaypalEmail) {
      console.error('缺少PayPal商家邮箱');
      return res.status(400).json({
        success: false,
        message: '使用PayPal支付时必须提供商家PayPal邮箱'
      });
    }
    
    // 如果是PayPal支付，额外验证商家邮箱格式
    if (platform === 'PayPal' && merchantPaypalEmail) {
      // 简单验证邮箱格式
      if (!merchantPaypalEmail.includes('@') || merchantPaypalEmail.length < 5) {
        console.error('无效的PayPal邮箱格式:', merchantPaypalEmail);
        return res.status(400).json({
          success: false,
          message: '无效的PayPal邮箱格式'
        });
      }

      // 检查是否是个人账号
      if (merchantPaypalEmail.includes('personal.example.com')) {
        console.error('提供的是PayPal个人账号，无法用于商家收款:', merchantPaypalEmail);
        return res.status(400).json({
          success: false,
          message: '请提供PayPal商家账号，而不是个人账号'
        });
      }
      
      console.log(`验证通过，商家PayPal邮箱: ${merchantPaypalEmail}`);
    } else if (platform === 'PayPal' && !merchantPaypalEmail) {
      console.error('使用PayPal支付时未提供商家邮箱');
      return res.status(400).json({
        success: false,
        message: '使用PayPal支付时必须提供商家PayPal邮箱'
      });
    }

    // 验证金额
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: '无效的支付金额，金额必须大于0'
      });
    }
    
    let paymentPlatform = platform;
    let merchantInfo = {};
    let qrCodeAmount = null;

    // 如果提供了二维码内容，则解析二维码
    if (merchantPaypalEmail) {
      console.log('商家PayPal邮箱:', merchantPaypalEmail);
      
      // 如果是PayPal支付，确保平台设置为PayPal
      if (platform === 'PayPal') {
        paymentPlatform = 'PayPal';
        merchantInfo = {
          email: merchantPaypalEmail,
          platform: 'PayPal'
        };
        console.log('设置支付平台为PayPal，邮箱:', merchantPaypalEmail);
      } else {
        // 否则尝试解析二维码内容
        const parsedQRData = await parseQRCode(merchantPaypalEmail);
        console.log('Parsed QR Data:', parsedQRData);
        
    if (!parsedQRData.success) {
      return res.status(400).json({
        success: false,
        message: '无法解析二维码内容',
        error: parsedQRData.error
      });
    }
    
    // 识别支付平台
    const platformInfo = identifyPaymentPlatform(parsedQRData.data);
        console.log('Platform Info:', platformInfo);
        
    if (!platformInfo.success) {
          return res.status(400).json({
            success: false,
            message: platformInfo.message || '无法识别支付平台',
            debug: {
              qrContent: merchantPaypalEmail,
              parsedData: parsedQRData.data
            }
          });
        }

        paymentPlatform = platformInfo.platform;
        qrCodeAmount = platformInfo.data.amount;
        merchantInfo = {
          id: platformInfo.data.merchantId || '',
          name: platformInfo.data.merchantName || '',
          accountId: platformInfo.data.accountId || '',
          qrCodeContent: merchantPaypalEmail,
          platform: paymentPlatform
        };

        // 验证二维码中的金额是否匹配
        if (qrCodeAmount && Math.abs(qrCodeAmount - parsedAmount) > 0.01) {
          return res.status(400).json({
            success: false,
            message: '二维码中的支付金额与输入金额不匹配',
            qrCodeAmount,
            inputAmount: parsedAmount
          });
        }
      }
    } else if (!platform) {
      return res.status(400).json({
        success: false,
        message: '必须提供支付平台或二维码内容'
      });
    }

    // 验证支付平台
    if (!SUPPORTED_PLATFORMS.includes(paymentPlatform)) {
      return res.status(400).json({
        success: false,
        message: '不支持的支付平台'
      });
    }
    
    // 查找或创建用户
    console.log('查找用户:', walletAddress);
    let user = await User.findOne({ where: { walletAddress: walletAddress } });
    if (!user) {
      console.log('用户不存在，创建新用户');
      user = await User.create({ walletAddress: walletAddress });
    }
    console.log('用户信息:', user.toJSON());
    
    // 创建支付意图
    console.log('开始创建支付意图，数据:', {
      amount: parsedAmount,
      currency: 'USD',
      platform: paymentPlatform,
      userWalletAddress: walletAddress,
      userId: user.id,
      merchantPaypalEmail
    });
    
    // 确保PayPal商家邮箱是一个字符串
    let paypalEmail = null;
    if (merchantPaypalEmail) {
      if (typeof merchantPaypalEmail === 'object') {
        console.warn('商家PayPal邮箱是一个对象，尝试提取字符串值:', JSON.stringify(merchantPaypalEmail));
        if (merchantPaypalEmail.email) {
          paypalEmail = merchantPaypalEmail.email;
        } else {
          paypalEmail = JSON.stringify(merchantPaypalEmail);
        }
      } else {
        paypalEmail = String(merchantPaypalEmail);
      }
      console.log('最终使用的商家PayPal邮箱(字符串格式):', paypalEmail);

      // 再次检查是否是个人账号
      if (paypalEmail.includes('personal.example.com')) {
        console.error('提供的是PayPal个人账号，无法用于商家收款:', paypalEmail);
        return res.status(400).json({
          success: false,
          message: '请提供PayPal商家账号，而不是个人账号'
        });
      }
    }
    
    // 构建merchantInfo对象
    if (platform === 'PayPal' && paypalEmail) {
      merchantInfo = {
        paypalEmail: paypalEmail,
        platform: 'PayPal'
      };
    }
    
    console.log(`创建支付意图 - 平台: ${platform}, 商家信息:`, JSON.stringify(merchantInfo));
    
    const paymentIntent = await PaymentIntent.create({
      amount: parsedAmount,
      currency: 'USD',
      platform: paymentPlatform,
      userWalletAddress: walletAddress,
      userId: user.id,
      merchantPaypalEmail: paypalEmail, // 确保是字符串格式
      merchantInfo: Object.keys(merchantInfo).length > 0 ? merchantInfo : null,
      description,
      status: 'created',
      statusHistory: [{
        status: 'created',
        timestamp: new Date(),
        note: '支付意图创建'
      }],
      expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30分钟后过期
      lpWalletAddress: lpAddress,
      fee_rate: feeRate,
      fee_amount: fee_amount || (parsedAmount * feeRate / 100),
      total_amount: total_amount || (parsedAmount * (1 + feeRate / 100))
    });
    
    // 确保merchantInfo字段已正确保存
    if (platform === 'PayPal' && paypalEmail && !paymentIntent.merchantInfo) {
      console.log('merchantInfo字段未正确保存，尝试更新...');
      await paymentIntent.update({
        merchantInfo: merchantInfo
      });
      console.log('merchantInfo字段已更新');
    }
    
    console.log('支付意图创建成功:', JSON.stringify({
      id: paymentIntent.id,
      platform: paymentIntent.platform,
      amount: paymentIntent.amount,
      merchantPaypalEmail: paymentIntent.merchantPaypalEmail,
      merchantInfo: paymentIntent.merchantInfo
    }));

    // 确保最终保存的商家邮箱有效 
    const finalMerchantPaypalEmail = paymentIntent.merchantPaypalEmail;
    console.log(`最终保存在支付意图中的PayPal商家邮箱: ${finalMerchantPaypalEmail || '无'}`);
    
    if (platform === 'PayPal' && (!finalMerchantPaypalEmail || 
        !finalMerchantPaypalEmail.includes('@') || 
        finalMerchantPaypalEmail.includes('personal.example.com'))) {
      console.error(`警告: 支付意图创建成功但商家PayPal邮箱无效或丢失: ${finalMerchantPaypalEmail || '无'}`);
      // 不中断流程，但记录错误
    }
    
    // 发送支付状态更新事件
    const io = req.app.get('io');
    if (io) {
      io.emit('paymentStatusUpdate', {
        walletAddress: walletAddress,
        paymentIntentId: paymentIntent.id,
        status: paymentIntent.status,
        lpAddress: lpAddress
      });
    }
    
    // 构建返回数据
    const responseData = {
      paymentIntentId: paymentIntent.id,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      platform: paymentIntent.platform,
      status: paymentIntent.status,
      merchantPaypalEmail: paymentIntent.merchantPaypalEmail,
      lpAddress: lpAddress,
      feeRate: feeRate
    };
    
    console.log('支付创建成功，返回数据:', responseData);
    
    // 发送Socket.io通知
    try {
      if (io) {
        console.log('发送payment_created Socket事件:', { id: paymentIntent.id });
        io.emit('payment_created', responseData);
      }
    } catch (socketError) {
      console.error('发送Socket通知失败:', socketError);
      // 不影响主流程，继续返回成功响应
    }
    
    return res.status(201).json({
      success: true,
      message: '支付意图创建成功',
      data: responseData
    });
  } catch (error) {
    console.error('创建支付意图失败:', error);
    return res.status(500).json({
      success: false,
      message: '创建支付意图失败: ' + error.message
    });
  }
};

/**
 * 获取用户的支付意图列表
 * @route GET /api/payment-intents/user/:walletAddress
 * @access Public
 */
exports.getUserPaymentIntents = async (req, res) => {
  try {
    const { walletAddress } = req.params;
    
    console.log('获取用户支付意图列表, 钱包地址:', walletAddress);
    
    // 验证钱包地址格式 - 同时支持以太坊和Solana
    const isEthAddress = /^0x[a-fA-F0-9]{40}$/.test(walletAddress);
    const isSolAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress);
    
    if (!isEthAddress && !isSolAddress) {
      return res.status(400).json({
        success: false,
        message: '无效的钱包地址格式'
      });
    }
    
    // 查询支付意图 - 不排除任何列，用代码后处理
    const paymentIntents = await PaymentIntent.findAll({
      where: { userWalletAddress: walletAddress },
      order: [['createdAt', 'DESC']]
    });
    
    // 使用序列化工具函数处理返回数据
    const serializedPaymentIntents = serializeModels(paymentIntents);
    
    // 后处理 - 添加 blockchainPaymentId 字段
    serializedPaymentIntents.forEach(intent => {
      if (intent.processingDetails && intent.processingDetails.blockchainPaymentId) {
        intent.blockchainPaymentId = intent.processingDetails.blockchainPaymentId;
      } else if (intent.settlementTxHash) {
        intent.blockchainPaymentId = `TX-${intent.settlementTxHash.substring(0, 10)}`;
      }
    });
    
    return res.status(200).json({
      success: true,
      data: {
        paymentIntents: serializedPaymentIntents
      }
    });
    
  } catch (error) {
    console.error('获取用户支付意图列表失败:', error);
    return res.status(500).json({
      success: false,
      message: '获取支付意图失败',
      error: error.message
    });
  }
};

/**
 * 获取LP的支付意图列表
 * @route GET /api/payment-intents/lp/:walletAddress
 * @access Public
 */
exports.getLPPaymentIntents = async (req, res) => {
  try {
    const { walletAddress } = req.params;
    
    console.log('获取LP支付意图列表, 钱包地址:', walletAddress);
    
    // 验证钱包地址格式 - 同时支持以太坊和Solana
    const isEthAddress = /^0x[a-fA-F0-9]{40}$/.test(walletAddress);
    const isSolAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress);
    
    if (!isEthAddress && !isSolAddress) {
      return res.status(400).json({
        success: false,
        message: '无效的钱包地址格式'
      });
    }
    
    // 查询支付意图 - 不排除任何列，用代码后处理
    const paymentIntents = await PaymentIntent.findAll({
      where: { lpWalletAddress: walletAddress },
      order: [['createdAt', 'DESC']]
    });
    
    // 使用序列化工具函数处理返回数据
    const serializedPaymentIntents = serializeModels(paymentIntents);
    
    // 后处理 - 添加 blockchainPaymentId 字段
    serializedPaymentIntents.forEach(intent => {
      if (intent.processingDetails && intent.processingDetails.blockchainPaymentId) {
        intent.blockchainPaymentId = intent.processingDetails.blockchainPaymentId;
      } else if (intent.settlementTxHash) {
        intent.blockchainPaymentId = `TX-${intent.settlementTxHash.substring(0, 10)}`;
      }
    });
    
    return res.status(200).json({
      success: true,
      data: {
        paymentIntents: serializedPaymentIntents
      }
    });
    
  } catch (error) {
    console.error('获取LP支付意图列表失败:', error);
    return res.status(500).json({
      success: false,
      message: '获取支付意图失败',
      error: error.message
    });
  }
};

/**
 * 获取单个支付意图的详情
 * @route GET /api/payment-intent/:id
 * @access Public
 */
exports.getPaymentIntentById = async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`获取支付意图详情: ${id}`);
    
    // 查询支付意图
    const paymentIntent = await PaymentIntent.findByPk(id);
    
    if (!paymentIntent) {
      console.log(`支付意图不存在: ${id}`);
      return res.status(404).json({
        success: false,
        message: '未找到请求的资源'
      });
    }
    
    // 序列化支付意图数据 - 修正从serializeModels到serializeModel
    const { serializeModel } = require('../utils/serialization.utils');
    const serializedPaymentIntent = serializeModel(paymentIntent);
    
    // 检查处理详情中是否有区块链ID
    if (serializedPaymentIntent.processingDetails && 
        serializedPaymentIntent.processingDetails.blockchainPaymentId) {
      // 为向后兼容添加 blockchainPaymentId 字段
      serializedPaymentIntent.blockchainPaymentId = 
        serializedPaymentIntent.processingDetails.blockchainPaymentId;
    }
    
    // 如果有settlementTxHash但没有blockchainPaymentId，可以使用settlementTxHash作为标识
    if (!serializedPaymentIntent.blockchainPaymentId && serializedPaymentIntent.settlementTxHash) {
      serializedPaymentIntent.blockchainPaymentId = `TX-${serializedPaymentIntent.settlementTxHash.substring(0, 10)}`;
    }
    
    console.log(`支付意图详情: ${JSON.stringify({
      id: serializedPaymentIntent.id,
      status: serializedPaymentIntent.status,
      blockchainPaymentId: serializedPaymentIntent.blockchainPaymentId || '未设置'
    })}`);
    
    return res.status(200).json({
      success: true,
      message: '获取支付意图成功',
      data: serializedPaymentIntent
    });
  } catch (error) {
    console.error('获取支付意图详情失败:', error);
    return res.status(500).json({
      success: false,
      message: '获取支付意图失败',
      error: error.message
    });
  }
};

/**
 * 取消支付意图
 * @route PUT /api/payment-intent/:id/cancel
 * @access Public
 */
exports.cancelPaymentIntent = async (req, res) => {
  try {
    const { id } = req.params;
    const { walletAddress } = req.body;
    
    console.log('取消支付意图请求:', { id, walletAddress });
    
    // 验证钱包地址格式 - 同时支持以太坊和Solana
    const isEthAddress = /^0x[a-fA-F0-9]{40}$/.test(walletAddress);
    const isSolAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress);
    
    if (!isEthAddress && !isSolAddress) {
      console.log('无效的钱包地址:', walletAddress);
      return res.status(400).json({
        success: false,
        message: '无效的钱包地址格式'
      });
    }
    
    // 查询支付意图
    console.log('查询支付意图:', id);
    const paymentIntent = await PaymentIntent.findByPk(id);
    
    if (!paymentIntent) {
      console.log('支付意图不存在:', id);
      return res.status(404).json({
        success: false,
        message: '支付意图不存在'
      });
    }
    
    console.log('找到支付意图:', paymentIntent.toJSON());
    
    // 验证用户是否有权限取消
    if (paymentIntent.userWalletAddress !== walletAddress) {
      console.log('无权取消:', { 
        requestWallet: walletAddress, 
        intentWallet: paymentIntent.userWalletAddress 
      });
      return res.status(403).json({
        success: false,
        message: '无权取消此支付意图'
      });
    }
    
    // 检查支付意图状态
    if (!['created', 'claimed'].includes(paymentIntent.status)) {
      console.log('当前状态不允许取消:', paymentIntent.status);
      return res.status(400).json({
        success: false,
        message: `支付意图当前状态为${paymentIntent.status}，无法取消`
      });
    }
    
    // 如果已被LP认领，需要解锁LP额度
    if (paymentIntent.status === 'claimed' && paymentIntent.lpId) {
      console.log('解锁LP额度:', paymentIntent.lpId);
      const lp = await LP.findByPk(paymentIntent.lpId);
      if (lp) {
        lp.lockedQuota -= paymentIntent.amount;
        lp.availableQuota = lp.totalQuota - lp.lockedQuota;
        await lp.save();
        console.log('LP额度已解锁:', lp.toJSON());
      }
    }
    
    // 更新支付意图状态
    const statusHistory = [...paymentIntent.statusHistory, {
      status: 'cancelled',
      timestamp: new Date(),
      note: `用户 ${walletAddress} 取消支付意图`
    }];
    
    await paymentIntent.update({
      status: 'cancelled',
      statusHistory
    });
    
    console.log('支付意图已取消:', paymentIntent.toJSON());
    
    // 通过Socket.io通知LP支付意图已取消
    if (paymentIntent.lpWalletAddress) {
      const io = req.app.get('io');
      if (io) {
        io.to(paymentIntent.lpWalletAddress).emit('payment_intent_cancelled', {
        id: paymentIntent.id,
        userWalletAddress: walletAddress
      });
        console.log('已通知LP支付意图已取消:', paymentIntent.lpWalletAddress);
      }
    }
    
    return res.status(200).json({
      success: true,
      message: '支付意图取消成功',
      data: {
        paymentIntentId: paymentIntent.id,
        status: 'cancelled'
      }
    });
    
  } catch (error) {
    console.error('取消支付意图失败:', error);
    return res.status(500).json({
      success: false,
      message: '取消支付意图失败: ' + error.message
    });
  }
};

/**
 * 确认支付意图（用户确认已收到服务）
 * @route POST /api/payment-intents/:id/confirm
 * @access Public
 */
exports.confirmPaymentIntent = async (req, res) => {
  try {
    const { id } = req.params;
    const { txHash, blockchainPaymentId } = req.body;

    // 获取支付意图
    const paymentIntent = await PaymentIntent.findByPk(id);
    if (!paymentIntent) {
      return res.status(404).json({
        success: false,
        message: '支付意图不存在'
      });
    }

    // 验证支付状态（允许 paid/locked/processing 确认）
    if (!['paid','locked','processing'].includes(paymentIntent.status)) {
      return res.status(400).json({
        success: false,
        message: '当前支付状态不允许确认'
      });
    }

    // 更新支付意图状态
    await paymentIntent.update({
      status: 'confirmed',
      escrowStatus: 'CONFIRMED',
      settlementTxHash: txHash,
      blockchainPaymentId,
      statusHistory: [...(paymentIntent.statusHistory || []), {
        status: 'confirmed',
        timestamp: new Date(),
        txHash: txHash,
        blockchainPaymentId,
        description: '用户已确认收到服务'
      }]
    });

    // 返回成功响应
    return res.json({
      success: true,
      message: '支付确认成功',
      data: paymentIntent
    });
  } catch (error) {
    console.error('确认支付失败:', error);
    return res.status(500).json({
      success: false,
      message: '确认支付失败: ' + error.message
    });
  }
};

// 检查用户余额
exports.checkBalance = async (req, res) => {
  try {
    const { userWalletAddress, amount } = req.body;
    const hasEnoughBalance = await paymentService.checkUserBalance(userWalletAddress, amount);
    res.json({ hasEnoughBalance });
  } catch (error) {
    console.error('检查余额失败:', error);
    res.status(500).json({ error: '检查余额失败' });
  }
};

// 锁定资金
exports.lockFunds = async (req, res) => {
  try {
    const { paymentIntentId, amount, userWalletAddress } = req.body;
    const result = await paymentService.handleFundsLock(paymentIntentId, amount, userWalletAddress);
    res.json(result);
  } catch (error) {
    console.error('锁定资金失败:', error);
    res.status(500).json({ error: error.message });
  }
};

// 确认收款并释放资金
exports.confirmAndRelease = async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    const result = await paymentService.handleFundsRelease(paymentIntentId, false);
    res.json(result);
  } catch (error) {
    console.error('确认收款失败:', error);
    res.status(500).json({ error: error.message });
  }
};

// LP申请提币
exports.requestWithdrawal = async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    const result = await paymentService.handleLPWithdrawal(paymentIntentId);
    res.json(result);
  } catch (error) {
    console.error('申请提币失败:', error);
    res.status(500).json({ error: error.message });
  }
};

// 处理LP接单
exports.assignLP = async (req, res) => {
  try {
    const { orderId, lpWalletAddress } = req.body;

    // 验证订单是否存在
    const order = await PaymentIntent.findByPk(orderId);
    if (!order) {
      return res.status(404).json({ error: '订单不存在' });
    }

    // 验证订单状态
    if (order.status !== 'pending') {
      return res.status(400).json({ error: '订单状态不正确' });
    }

    // 验证LP钱包地址
    if (!lpWalletAddress || !web3.utils.isAddress(lpWalletAddress)) {
      return res.status(400).json({ error: '无效的LP钱包地址' });
    }

    // 检查LP托管余额
    const escrowContract = new web3.eth.Contract(
      ESCROW_ABI,
      process.env.ESCROW_ADDRESS
    );
    const escrowBalance = await escrowContract.methods
      .getEscrowBalance(lpWalletAddress)
      .call();
    
    if (web3.utils.toBN(escrowBalance).lt(
      web3.utils.toBN(web3.utils.toWei(order.amount.toString(), 'ether'))
    )) {
      return res.status(400).json({ error: 'LP托管资金不足' });
    }

    // 更新订单状态
    await order.update({
      lpWalletAddress,
      status: 'processing',
      statusHistory: [
        ...order.statusHistory,
        {
          status: 'processing',
          timestamp: new Date().toISOString(),
          details: `LP ${lpWalletAddress} 接单，锁定资金 ${order.amount} USDT`
        }
      ]
    });

    res.json({ success: true, order });
  } catch (error) {
    console.error('LP接单失败:', error);
    res.status(500).json({ error: '服务器错误' });
  }
};

// 完成订单
exports.completeOrder = async (req, res) => {
  try {
    const { id } = req.params;
    
    // 验证订单是否存在
    const order = await PaymentIntent.findByPk(id);
    if (!order) {
      return res.status(404).json({ error: '订单不存在' });
    }
    
    // 验证订单状态
    if (order.status !== 'processing') {
      return res.status(400).json({ error: '订单状态不正确' });
    }
    
    // 更新订单状态
    await order.update({
      status: 'completed',
      statusHistory: [
        ...order.statusHistory,
        {
          status: 'completed',
          timestamp: new Date().toISOString(),
          details: '订单已完成，资金已释放'
        }
      ]
    });
    
    res.json({ success: true, order });
  } catch (error) {
    console.error('完成订单失败:', error);
    res.status(500).json({ error: '服务器错误' });
  }
};

/**
 * 更新支付意图状态
 * @route PUT /api/payment-intents/:id/status
 * @access Public
 */
exports.updatePaymentIntentStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, txHash, error } = req.body;
    
    console.log('更新支付意图状态:', { id, status, txHash, error });
    
    // 查找支付意图
    const paymentIntent = await PaymentIntent.findByPk(id);
    if (!paymentIntent) {
      return res.status(404).json({
        success: false,
        message: '支付意图不存在'
      });
    }
    
    // 验证状态转换是否有效
    const validStatuses = ['created', 'funds_locked', 'claimed', 'paid', 'confirmed', 'settled', 'failed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: '无效的状态值'
      });
    }
    
    // 构建更新数据
    const updateData = {
      status,
      statusHistory: [
        ...paymentIntent.statusHistory || [],
        {
          status,
      timestamp: new Date(),
          txHash,
          error
        }
      ]
    };
    
    // 如果有交易哈希，更新它
    if (txHash) {
      updateData.settlementTxHash = txHash;
    }
    
    // 如果有错误信息，更新它
    if (error) {
      updateData.errorDetails = error;
    }
    
    // 更新支付意图
    await paymentIntent.update(updateData);
    
    // 序列化数据
    const serializedPayment = serializeModels(paymentIntent);
    
    // 发送Socket.io通知
    try {
      const io = req.app.get('io');
      if (io) {
        console.log('发送payment_updated Socket事件:', { id, status });
        io.emit('payment_updated', serializedPayment);
      }
    } catch (socketError) {
      console.error('发送Socket通知失败:', socketError);
      // 不影响主流程，继续返回成功响应
    }
    
    return res.json({
      success: true,
      message: '支付意图状态更新成功',
      data: serializedPayment
    });
    
  } catch (error) {
    console.error('更新支付意图状态失败:', error);
    return res.status(500).json({
      success: false,
      message: '更新支付意图状态失败',
      error: process.env.NODE_ENV === 'development' ? error.message : '服务器内部错误'
    });
  }
};

/**
 * 为支付记录生成并保存区块链ID
 * @route POST /api/payment-intent/:id/generate-blockchain-id
 * @access Public
 */
exports.generateBlockchainId = async (req, res) => {
  const { paymentId } = req.params;
  
  try {
    // 查找支付意图
    const paymentIntent = await PaymentIntent.findOne({
      where: { id: paymentId }
    });
    
    if (!paymentIntent) {
      return res.status(404).json({
        success: false,
        message: '支付意图不存在'
      });
    }
    
    // 生成区块链支付ID (简单示例，实际实现可能更复杂)
    const blockchainId = `BLC-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    
    // 直接更新blockchainPaymentId字段
    await paymentIntent.update({
      blockchainPaymentId: blockchainId
    });
    
    // 更新状态历史记录，记录新的区块链ID
    const statusHistory = [...(paymentIntent.statusHistory || []), {
      status: paymentIntent.status,
      timestamp: new Date(),
      note: `生成区块链ID: ${blockchainId}`
    }];
    
    await paymentIntent.update({
      statusHistory
    });
    
    return res.status(200).json({
      success: true,
      message: '区块链ID生成成功',
      data: {
        paymentId,
        blockchainId
      }
    });
    
  } catch (error) {
    console.error('生成区块链ID时出错:', error);
    return res.status(500).json({
      success: false,
      message: '服务器错误',
      error: error.message
    });
  }
};

/**
 * 更新支付意图为已提款状态
 * @route PUT /api/payment-intent/:id/withdraw-complete
 * @access Public
 */
exports.updateWithdrawalStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { txHash, walletAddress } = req.body;
    
    console.log(`更新支付ID ${id} 的提款状态，交易哈希: ${txHash}`);
    
    if (!txHash) {
      return res.status(400).json({
        success: false,
        message: '交易哈希不能为空'
      });
    }
    
    // 查询支付意图
    const paymentIntent = await PaymentIntent.findByPk(id);
    
    if (!paymentIntent) {
      console.log(`支付意图 ${id} 不存在`);
      return res.status(404).json({
        success: false,
        message: '未找到请求的资源'
      });
    }
    
    // 验证钱包地址（如果提供）
    if (walletAddress && paymentIntent.lpWalletAddress !== walletAddress) {
      console.log(`钱包地址不匹配: ${walletAddress} != ${paymentIntent.lpWalletAddress}`);
      return res.status(403).json({
        success: false,
        message: '无权更新此支付状态'
      });
    }
    
    // 更新支付意图状态
    const updateData = {
      status: 'settled',
      settlementTxHash: txHash,
      statusHistory: [
        ...paymentIntent.statusHistory || [],
        {
          status: 'settled',
          timestamp: new Date(),
          txHash: txHash,
          note: '资金已提取到钱包',
          action: 'withdraw'
        }
      ]
    };
    
    await paymentIntent.update(updateData);
    
    // 获取更新后的支付意图
    const updatedPaymentIntent = await PaymentIntent.findByPk(id);
    const serializedPaymentIntent = serializeModels(updatedPaymentIntent);
    
    // 发送Socket.io通知（如果可用）
    try {
      const io = req.app.get('io');
      if (io) {
        console.log(`发送payment_withdrawn Socket事件: ${id}`);
        io.emit('payment_withdrawn', {
          id,
          txHash,
          status: 'settled'
        });
      }
    } catch (socketError) {
      console.error('发送Socket通知失败:', socketError);
      // 不影响主流程，继续返回成功响应
    }
    
    return res.status(200).json({
      success: true,
      message: '支付意图已更新为已提款状态',
      data: serializedPaymentIntent
    });
  } catch (error) {
    console.error('更新提款状态失败:', error);
    return res.status(500).json({
      success: false,
      message: '更新提款状态失败',
      error: error.message
    });
  }
};