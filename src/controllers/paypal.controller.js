const { LP, PaymentIntent, User, TaskPool } = require('../models/mysql');
const paypalConfig = require('../config/paypal');
const paypal = require('@paypal/checkout-server-sdk');
const { Op } = require('sequelize');
const { sequelize } = require('../config/database');  // 修正sequelize的导入路径
const { verifyWebhookSignature, logPayPalError, logPayPalEvent, logPayPalTransaction } = require('../config/paypal');
const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_MODE } = require('../config/paypal');

// 使用PayPal客户端
const paypalClient = paypalConfig.client;

/**
 * 创建PayPal API客户端
 * @returns {Promise<Object>} PayPal客户端实例
 */
async function createPayPalClient() {
  try {
    // 检查是否已经有缓存的客户端
    if (paypalClient) {
      return paypalClient;
    }
    
    console.log('创建新的PayPal API客户端...');
    let environment;
    
    // 根据环境配置创建适当的PayPal环境
    if (PAYPAL_MODE === 'sandbox') {
      environment = new paypal.core.SandboxEnvironment(
        PAYPAL_CLIENT_ID,
        PAYPAL_CLIENT_SECRET
      );
    } else {
      environment = new paypal.core.LiveEnvironment(
        PAYPAL_CLIENT_ID,
        PAYPAL_CLIENT_SECRET
      );
    }
    
    // 创建客户端
    const client = new paypal.core.PayPalHttpClient(environment);
    return client;
  } catch (error) {
    console.error('创建PayPal客户端失败:', error);
    throw error;
  }
}

/**
 * LP连接PayPal账户
 * @route POST /api/lp/paypal/connect
 * @access Public
 */
exports.connectLPPayPal = async (req, res) => {
  try {
    const { walletAddress, paypalEmail } = req.body;
    
    if (!walletAddress || !paypalEmail) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数：钱包地址和PayPal邮箱必须提供'
      });
    }
    
    // 验证钱包地址格式
    if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return res.status(400).json({
        success: false,
        message: '无效的以太坊钱包地址'
      });
    }
    
    // 验证邮箱格式
    if (!paypalEmail.includes('@') || paypalEmail.length < 5) {
      return res.status(400).json({
        success: false,
        message: '无效的PayPal邮箱格式'
      });
    }
    
    // 验证是否为商家账号（不是个人账号）
    if (paypalEmail.includes('personal.example.com')) {
      return res.status(400).json({
        success: false,
        message: '请提供PayPal商家账号，而不是个人账号（个人账号无法用于收款）'
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
    
    // 检查支持的平台列表
    let supportedPlatforms = lp.supportedPlatforms || [];
    if (!Array.isArray(supportedPlatforms)) {
      supportedPlatforms = [];
    }
    
    // 如果PayPal不在支持的平台列表中，添加它
    if (!supportedPlatforms.includes('PayPal')) {
      supportedPlatforms.push('PayPal');
    }
    
    // 更新LP的PayPal信息
    await lp.update({
      paypalEmail,
      supportedPlatforms
    });
    
    await logPayPalEvent('lpConnected', {
      lpId: lp.id,
      walletAddress,
      paypalEmail
    });
    
    return res.status(200).json({
      success: true,
      message: 'PayPal账户连接成功',
      data: {
        lpId: lp.id,
        walletAddress: lp.walletAddress,
        paypalEmail: paypalEmail,
        supportedPlatforms: supportedPlatforms
      }
    });
  } catch (error) {
    console.error('PayPal账户连接失败:', error);
    await logPayPalError('connectLPPayPal', error);
    return res.status(500).json({
      success: false,
      message: 'PayPal账户连接失败',
      error: process.env.NODE_ENV === 'development' ? error.message : '服务器内部错误'
    });
  }
};

/**
 * 创建PayPal支付订单
 * @route POST /api/payment/paypal/create-order
 * @access Public
 */
exports.createPayPalOrder = async (req, res) => {
  const t = await sequelize.transaction();
  
  try {
    const {
      paymentIntentId,
      userWalletAddress,
      merchantPaypalEmail: requestMerchantEmail,
      amount: orderAmount,
      currency: orderCurrency,
      description: orderDescription
    } = req.body;
    
    console.log(`----- 开始创建PayPal订单 -----`);
    console.log(`PaymentIntentID: ${paymentIntentId}`);
    console.log(`请求体:`, JSON.stringify(req.body));
    
    if (!paymentIntentId) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数：支付意图ID必须提供'
      });
    }
    
    // 验证用户钱包地址格式
    if (userWalletAddress && !/^0x[a-fA-F0-9]{40}$/.test(userWalletAddress)) {
      return res.status(400).json({
        success: false,
        message: '无效的钱包地址格式'
      });
    }
    
    // 查找支付意图
    const paymentIntent = await PaymentIntent.findOne({
      where: { id: paymentIntentId },
      transaction: t,
      lock: true
    });
    
    if (!paymentIntent) {
      await t.rollback();
      return res.status(404).json({
        success: false,
        message: '未找到该支付意图'
      });
    }
    
    console.log(`找到支付意图，当前状态: ${paymentIntent.status}`);
    // 使用前端传递的金额/币种，否则使用原支付意图数据
    const payAmount = orderAmount != null ? orderAmount : paymentIntent.amount;
    // 构建并校验币种，确保为3位大写字母，否则回退到USD
    let payCurrency = orderCurrency || paymentIntent.currency || 'USD';
    if (typeof payCurrency === 'string') {
      payCurrency = payCurrency.toUpperCase();
    }
    if (!/^[A-Z]{3}$/.test(payCurrency)) {
      console.warn(`不支持的币种 ${payCurrency}，使用 USD 代替`);
      payCurrency = 'USD';
    }
    console.log(`创建订单金额: ${payAmount}, 币种: ${payCurrency}`);
    
    // 验证支付意图状态
    if (paymentIntent.status !== 'created' && paymentIntent.status !== 'processing' && paymentIntent.status !== 'claimed') {
      await t.rollback();
      return res.status(400).json({
        success: false,
        message: `支付意图状态 ${paymentIntent.status} 不允许创建订单`
      });
    }
    
    // 优先使用请求中传递的商家PayPal邮箱
    let merchantPaypalEmail = null;
    let merchantEmailSource = null;
    
    // 1. 首先使用请求中的商家邮箱
    if (requestMerchantEmail && 
        typeof requestMerchantEmail === 'string' && 
        requestMerchantEmail.includes('@') &&
        !requestMerchantEmail.includes('personal.example.com')) {
      merchantPaypalEmail = requestMerchantEmail;
      merchantEmailSource = "request";
      console.log(`使用请求中的商家PayPal邮箱: ${merchantPaypalEmail}`);
    }
    
    // 2. 如果没有有效的商家邮箱，从支付意图中获取
    if (!merchantPaypalEmail && paymentIntent.merchantPaypalEmail) {
      merchantPaypalEmail = paymentIntent.merchantPaypalEmail;
      merchantEmailSource = "payment_intent";
      console.log(`使用支付意图中的商家PayPal邮箱: ${merchantPaypalEmail}`);
    }
    
    // 3. 如果仍然没有，从商家信息中获取
    if (!merchantPaypalEmail && paymentIntent.merchantInfo) {
      let merchantInfo = paymentIntent.merchantInfo;
      if (typeof merchantInfo === 'string') {
        try {
          merchantInfo = JSON.parse(merchantInfo);
        } catch (e) {
          console.error('解析商家信息失败:', e);
        }
      }
      
      if (merchantInfo && merchantInfo.paypalEmail) {
        merchantPaypalEmail = merchantInfo.paypalEmail;
        merchantEmailSource = "merchant_info";
        console.log(`使用商家信息中的PayPal邮箱: ${merchantPaypalEmail}`);
      }
    }
    
    // 4. 如果仍然没有，且订单已被LP认领，尝试从LP获取
    if (!merchantPaypalEmail && paymentIntent.lpWalletAddress) {
      try {
        const lp = await LP.findOne({
          where: { walletAddress: paymentIntent.lpWalletAddress },
          transaction: t
        });
        
        if (lp && lp.paypalEmail) {
          merchantPaypalEmail = lp.paypalEmail;
          merchantEmailSource = "lp";
          console.log(`使用LP的PayPal邮箱: ${merchantPaypalEmail}`);
        }
      } catch (error) {
        console.error('获取LP信息失败:', error);
      }
    }
    
    // 5. 如果仍然没有有效的商家邮箱，返回错误
    if (!merchantPaypalEmail || !merchantPaypalEmail.includes('@')) {
      await t.rollback();
      return res.status(400).json({
        success: false,
        message: '无法获取有效的商家PayPal邮箱',
        error: '未找到有效的商家PayPal邮箱，请确保商家已设置PayPal邮箱'
      });
    }
    
    // 更新支付意图状态为processing
    let statusHistory = paymentIntent.statusHistory || [];
    if (typeof statusHistory === 'string') {
      try {
        statusHistory = JSON.parse(statusHistory);
      } catch (e) {
        statusHistory = [];
      }
    }
    
    statusHistory.push({
      status: 'processing',
      timestamp: new Date().toISOString(),
      note: 'PayPal订单创建中'
    });
    
    await paymentIntent.update({
      status: 'processing',
      statusHistory,
      processingDetails: {
        processingStarted: new Date().toISOString(),
        platform: 'PayPal',
        merchantEmail: merchantPaypalEmail,
        merchantEmailSource
      }
    }, { transaction: t });
    
    // 创建PayPal订单
    console.log(`使用PayPal SDK创建订单，金额: ${payAmount} ${payCurrency}`);
    const paypalClient = await createPayPalClient();
    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer('return=representation');
    
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: {
          currency_code: payCurrency,
          value: payAmount.toString()
        },
        payee: {
          email_address: merchantPaypalEmail
        }
      }],
      application_context: {
        return_url: `${process.env.APP_URL || 'http://localhost:3030'}/payment-success`,
        cancel_url: `${process.env.APP_URL || 'http://localhost:3030'}/payment-cancel`
      }
    });
    
    console.log('PayPal订单请求体:', JSON.stringify(request.requestBody));
    
    // 执行PayPal API请求
    const order = await paypalClient.execute(request);
    console.log('PayPal订单创建成功:', order.result.id);
    
    // 更新支付意图
    const paymentProof = {
      paypalOrderId: order.result.id,
      createTime: new Date().toISOString(),
      merchantEmail: merchantPaypalEmail,
      merchantEmailSource
    };
    
    await paymentIntent.update({
      paymentProof
    }, { transaction: t });
    
    // 提取PayPal批准URL
    const approvalLink = order.result.links.find(link => link.rel === 'approve');
    const approvalUrl = approvalLink ? approvalLink.href : null;
    
    if (!approvalUrl) {
      throw new Error('PayPal未返回批准URL');
    }
    
    // 记录PayPal事件
    await logPayPalEvent('order_created', {
      paymentIntentId: paymentIntent.id,
      orderId: order.result.id,
      amount: payAmount,
      currency: payCurrency,
      status: order.result.status
    });
    
    // 提交事务
    await t.commit();
    console.log(`数据库更新成功，事务已提交`);
    
    // 返回成功响应
    return res.status(200).json({
      success: true,
      message: 'PayPal订单创建成功',
      data: {
        paypalOrderId: order.result.id,
        approvalUrl: approvalUrl,
        status: order.result.status
      }
    });
    
  } catch (error) {
    // 回滚事务
    await t.rollback();
    
    console.error('----- 创建PayPal订单失败 -----');
    console.error('错误详情:', error);
    console.error('错误堆栈:', error.stack);
    
    await logPayPalError('createPayPalOrder', error);
    
    // 返回错误响应
    return res.status(500).json({
      success: false,
      message: '创建PayPal订单失败',
      error: process.env.NODE_ENV === 'development' ? error.message : '服务器内部错误'
    });
  }
};

/**
 * 捕获PayPal支付
 * @route POST /api/payment/paypal/capture-order
 * @access Public
 */
exports.capturePayPalOrder = async (req, res) => {
  try {
    const { orderId, paymentIntentId, merchantPaypalEmail } = req.body;
    
    console.log(`捕获PayPal订单支付 - OrderID: ${orderId}, PaymentIntentID: ${paymentIntentId}, 商家邮箱: ${merchantPaypalEmail || '未提供'}`);
    
    // 验证必要参数
    if (!orderId || !paymentIntentId) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数：订单ID和支付意图ID必须提供'
      });
    }
    
    // 查找支付意图
    const paymentIntent = await PaymentIntent.findByPk(paymentIntentId);
    if (!paymentIntent) {
      return res.status(404).json({
        success: false,
        message: '未找到该支付意图'
      });
    }
    
    // 如果提供了商家邮箱，更新支付意图中的商家邮箱
    if (merchantPaypalEmail && merchantPaypalEmail.includes('@') && 
        !merchantPaypalEmail.includes('personal.example.com') &&
        merchantPaypalEmail !== paymentIntent.merchantPaypalEmail) {
      console.log(`在捕获前更新商家邮箱: ${merchantPaypalEmail}`);
      try {
        // 同时更新merchantInfo对象
        let merchantInfo = paymentIntent.merchantInfo || {};
        if (typeof merchantInfo === 'string') {
          try {
            merchantInfo = JSON.parse(merchantInfo);
          } catch (e) {
            merchantInfo = {};
          }
        }
        
        merchantInfo = {
          ...merchantInfo,
          paypalEmail: merchantPaypalEmail,
          platform: 'PayPal'
        };
        
        await paymentIntent.update({ 
          merchantPaypalEmail,
          merchantInfo
        });
        console.log(`商家邮箱已更新为: ${merchantPaypalEmail}`);
      } catch (e) {
        console.error('更新商家邮箱失败:', e);
      }
    }
    
    // 如果当前商家邮箱是个人账号，返回错误
    if (paymentIntent.merchantPaypalEmail && paymentIntent.merchantPaypalEmail.includes('personal.example.com')) {
      console.error(`捕获订单失败: 检测到个人账号 ${paymentIntent.merchantPaypalEmail}，无法用于商家收款`);
      return res.status(400).json({
        success: false,
        message: '无法捕获PayPal订单: 检测到个人账号',
        error: '请使用商家账号而不是个人账号来接收付款'
      });
    }
    
    // 从支付意图中提取PayPal订单ID
    let paymentProof = paymentIntent.paymentProof || {};
    if (typeof paymentProof === 'string') {
      try {
        paymentProof = JSON.parse(paymentProof);
      } catch (e) {
        paymentProof = {};
      }
    }
    
    // 检查是否直接在支付凭证中存在订单ID
    if (paymentProof.paypalOrderId && paymentProof.paypalOrderId !== orderId) {
      console.log(`订单ID不匹配: 支付意图中存储的=${paymentProof.paypalOrderId}, 收到的=${orderId}`);
      return res.status(400).json({
        success: false,
        message: '订单ID不匹配'
      });
    }

    // 先检查PayPal订单状态
    console.log(`验证PayPal订单状态: ${orderId}`);
    const checkRequest = new paypal.orders.OrdersGetRequest(orderId);
    const orderDetails = await paypalClient.execute(checkRequest);
    
    console.log(`当前PayPal订单状态: ${orderDetails.result.status}`);
    console.log(`订单详情:`, JSON.stringify(orderDetails.result));
    
    // 如果订单不是APPROVED状态，则无法捕获
    if (orderDetails.result.status !== 'APPROVED') {
      console.log(`订单状态不是APPROVED，无法捕获: ${orderDetails.result.status}`);
      
      // 更新支付意图状态
      let statusHistory = paymentIntent.statusHistory || [];
      if (typeof statusHistory === 'string') {
        try {
          statusHistory = JSON.parse(statusHistory);
        } catch (e) {
          statusHistory = [];
        }
      }
      
      statusHistory.push({
        status: 'failed',
        timestamp: new Date().toISOString(),
        note: `PayPal订单状态: ${orderDetails.result.status}`
      });
      
      await paymentIntent.update({
        status: 'failed',
        statusHistory,
        errorDetails: JSON.stringify({
          code: 'INVALID_ORDER_STATUS',
          message: `订单状态 ${orderDetails.result.status} 不允许捕获`,
          time: new Date().toISOString()
        })
      });
      
      return res.status(400).json({
        success: false,
        message: `订单状态 ${orderDetails.result.status} 不允许捕获`,
        orderStatus: orderDetails.result.status
      });
    }

    console.log(`验证通过，开始捕获订单...`);
    const request = new paypal.orders.OrdersCaptureRequest(orderId);
    const capture = await paypalClient.execute(request);
    
    console.log(`订单捕获成功: ${JSON.stringify(capture.result.status)}`);
    
    // 获取捕获ID
    const captureId = capture.result.purchase_units[0].payments.captures[0].id;
    console.log(`捕获ID: ${captureId}`);
    
    // 添加状态历史记录
    const statusHistory = [...paymentIntent.statusHistory || [], {
      status: 'paid',
      timestamp: new Date(),
      note: `PayPal支付已捕获，订单ID: ${orderId}, 捕获ID: ${captureId}`
    }];
    
    // 准备支付凭证
    const updatedPaymentProof = {
      paypalOrderId: orderId,
      paypalCaptureId: captureId,  // 确保存储捕获ID
      captureId: captureId,        // 兼容两种格式
      createTime: capture.result.purchase_units[0].payments.captures[0].create_time,
      transactionTime: new Date(),
      merchantEmail: capture.result.purchase_units[0].payee?.email_address || paymentIntent.merchantPaypalEmail,
      status: capture.result.status,
      paypalStatus: capture.result.purchase_units[0].payments.captures[0].status
    };
    
    // 准备处理详情
    let updatedProcessingDetails = paymentIntent.processingDetails || {};
    if (typeof updatedProcessingDetails === 'string') {
      try {
        updatedProcessingDetails = JSON.parse(updatedProcessingDetails);
      } catch (e) {
        updatedProcessingDetails = {};
      }
    }
    
    updatedProcessingDetails = {
      ...updatedProcessingDetails,
      paypalOrderCapture: {
        captureId,
        captureTime: new Date(),
        captureStatus: capture.result.status
      }
    };
    
    // 更新支付意图
    await paymentIntent.update({
      status: 'paid',
      statusHistory,
      paymentProof: updatedPaymentProof,
      processingDetails: updatedProcessingDetails
    });
    
    await logPayPalTransaction('orderCaptured', {
      orderId,
      paymentIntentId,
      captureId: captureId,
      status: capture.result.status
    });

    return res.status(200).json({
      success: true,
      message: 'PayPal订单捕获成功',
      purchase_units: capture.result.purchase_units, // 兼容前端处理
      status: capture.result.status,
      paymentStatus: 'paid'
    });
  } catch (error) {
    console.error('捕获PayPal订单失败:', error);
    await logPayPalError('capturePayPalOrder', error);
    return res.status(500).json({
      success: false,
      message: '捕获PayPal订单失败: ' + (error.message || '服务器内部错误')
    });
  }
};

/**
 * 获取PayPal支付状态
 * @route GET /api/payment/paypal/status/:paymentIntentId
 * @access Public
 */
exports.getPayPalStatus = async (req, res) => {
  try {
    const { paymentIntentId } = req.params;
    
    if (!paymentIntentId) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数：支付意图ID必须提供'
      });
    }
    
    // 查找支付意图
    const paymentIntent = await PaymentIntent.findByPk(paymentIntentId);
    if (!paymentIntent) {
      return res.status(404).json({
        success: false,
        message: '未找到该支付意图'
      });
    }
    
    console.log(`获取PayPal支付状态 - PaymentIntentID: ${paymentIntentId}`);
    
    // 获取支付意图的状态
    const paymentStatus = paymentIntent.status;
    
    // 获取PayPal订单ID和捕获ID（如果存在）
    let paypalOrderId = null;
    let captureId = null;
    let paypalOrderStatus = null;
    
    // 从支付凭证中提取PayPal订单和捕获信息
    const paymentProof = paymentIntent.paymentProof;
    if (paymentProof) {
      if (typeof paymentProof === 'string') {
        try {
          const parsedProof = JSON.parse(paymentProof);
          paypalOrderId = parsedProof.paypalOrderId;
          captureId = parsedProof.paypalCaptureId || parsedProof.captureId;
        } catch (e) {
          console.error('解析支付凭证失败:', e);
        }
      } else {
        paypalOrderId = paymentProof.paypalOrderId;
        captureId = paymentProof.paypalCaptureId || paymentProof.captureId;
      }
    }
    
    // 从处理详情中获取订单状态（如果存在）
    const processingDetails = paymentIntent.processingDetails;
    if (processingDetails) {
      if (typeof processingDetails === 'string') {
        try {
          const parsedDetails = JSON.parse(processingDetails);
          if (parsedDetails.paypalOrderStatus) {
            paypalOrderStatus = parsedDetails.paypalOrderStatus;
          }
        } catch (e) {
          console.error('解析处理详情失败:', e);
        }
      } else if (processingDetails.paypalOrderStatus) {
        paypalOrderStatus = processingDetails.paypalOrderStatus;
      }
    }
    
    // 如果有PayPal订单ID但没有订单状态，尝试从PayPal获取最新状态
    if (paypalOrderId && !paypalOrderStatus) {
      try {
        // 创建PayPal客户端
        const paypalClient = await createPayPalClient();
        
        // 获取订单详情
        const getOrderRequest = new paypal.orders.OrdersGetRequest(paypalOrderId);
        const orderDetails = await paypalClient.execute(getOrderRequest);
        
        paypalOrderStatus = orderDetails.result.status;
        
        // 更新支付意图的处理详情
        let updatedProcessingDetails = processingDetails || {};
        if (typeof updatedProcessingDetails === 'string') {
          try {
            updatedProcessingDetails = JSON.parse(updatedProcessingDetails);
          } catch (e) {
            updatedProcessingDetails = {};
          }
        }
        
        updatedProcessingDetails = {
          ...updatedProcessingDetails,
          paypalOrderStatus,
          lastCheckedAt: new Date()
        };
        
        // 更新支付意图
        await paymentIntent.update({ processingDetails: updatedProcessingDetails });
      } catch (error) {
        console.error('获取PayPal订单状态失败:', error);
        // 不返回错误，继续使用现有信息
      }
    }
    
    return res.status(200).json({
      success: true,
      data: {
        paymentIntentId,
        paymentStatus,
        paypalOrderId,
        paypalOrderStatus,
        captureId,  // 确保前端可以验证是否有有效的捕获ID
        updatedAt: new Date()
      }
    });
    
  } catch (error) {
    console.error('获取PayPal支付状态失败:', error);
    await logPayPalError('get_paypal_status', error, { paymentIntentId: req.params.paymentIntentId });
    return res.status(500).json({
      success: false,
      message: '获取PayPal支付状态失败',
      error: process.env.NODE_ENV === 'development' ? error.message : '服务器内部错误'
    });
  }
};

/**
 * 处理PayPal退款
 * @route POST /api/payment/paypal/refund
 * @access Public
 */
exports.refundPayPalPayment = async (req, res) => {
  try {
    const { captureId, amount, reason } = req.body;
    
    if (!captureId) {
      return res.status(400).json({
        success: false,
        message: 'Capture ID is required'
      });
    }

    const request = new paypal.payments.CapturesRefundRequest(captureId);
    if (amount) {
      request.requestBody({
        amount: {
          value: amount.toString(),
          currency_code: 'USD'
        },
        note_to_payer: reason
      });
    }

    const refund = await paypalClient.execute(request);
    
    await logPayPalTransaction('paymentRefunded', {
      captureId,
      refundId: refund.result.id,
      amount,
      reason,
      status: refund.result.status
    });

    res.json(refund.result);
  } catch (error) {
    await logPayPalError('refundPayment', error);
    res.status(500).json({
      success: false,
      message: 'Failed to refund payment'
    });
  }
};

/**
 * 验证PayPal退款状态
 * @route GET /api/payment/paypal/refund-status/:refundId
 * @access Public
 */
exports.getPayPalRefundStatus = async (req, res) => {
  try {
    const { refundId } = req.params;
    
    const request = new paypal.payments.RefundsGetRequest(refundId);
    const refund = await paypalClient.execute(request);
    
    await logPayPalEvent('refundStatusChecked', {
      refundId,
      status: refund.result.status
    });
    
    res.json(refund.result);
  } catch (error) {
    await logPayPalError('getRefundStatus', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get refund status'
    });
  }
};

/**
 * 处理PayPal Webhook通知
 * @route POST /api/payment/paypal/webhook
 * @description 处理来自PayPal的Webhook事件
 * @access Public
 */
exports.handleWebhook = async (req, res) => {
  try {
    const webhookEvent = req.body;
    
    // 记录到日志
    console.log('收到PayPal Webhook事件:', `类型=${webhookEvent.event_type}, ID=${webhookEvent.id}`);
    
    // 先响应PayPal，避免超时
    res.status(200).json({ received: true });
    
    // 处理不同类型的事件
    switch(webhookEvent.event_type) {
      case 'PAYMENT.CAPTURE.COMPLETED':
        console.log('处理支付捕获完成事件');
        await handlePaymentCaptureCompleted(webhookEvent);
        break;
      
      case 'PAYMENT.CAPTURE.DENIED':
        console.log('处理支付捕获拒绝事件');
        await handlePaymentCaptureDenied(webhookEvent);
        break;
      
      case 'PAYMENT.CAPTURE.REFUNDED':
        console.log('处理支付退款事件');
        await handlePaymentCaptureRefunded(webhookEvent);
        break;
      
      case 'PAYMENT.CAPTURE.REVERSED':
        console.log('处理支付撤销事件');
        await handlePaymentCaptureReversed(webhookEvent);
        break;

      // 添加对PayPal取消支付事件的处理
      case 'CHECKOUT.ORDER.CANCELLED':
        console.log('处理订单取消事件');
        await handleOrderCancelled(webhookEvent);
        break;
        
      case 'CHECKOUT.PAYMENT.CANCELLED':
        console.log('处理支付取消事件');
        await handlePaymentCancelled(webhookEvent);
        break;
      
      default:
        console.log(`未处理的事件类型: ${webhookEvent.event_type}`);
        // 记录未处理的事件
        await logPayPalEvent('unhandled_webhook', {
          event_type: webhookEvent.event_type,
          event_id: webhookEvent.id
        });
    }
  } catch (error) {
    console.error('处理PayPal Webhook失败:', error);
    await logPayPalError('webhook_processing', error);
    // 已经返回200给PayPal，所以这里不需要再次响应
  }
};

/**
 * 获取PayPal配置
 * @route GET /api/payment/paypal/config
 * @access Public
 */
exports.getConfig = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      data: {
        clientId: PAYPAL_CLIENT_ID,
        mode: PAYPAL_MODE
      }
    });
  } catch (error) {
    console.error('获取PayPal配置失败:', error);
    await logPayPalError('getConfig', error);
    return res.status(500).json({
      success: false,
      message: '获取PayPal配置失败',
      error: process.env.NODE_ENV === 'development' ? error.message : '服务器内部错误'
    });
  }
};

/**
 * 创建PayPal订单
 * @route POST /api/payment/paypal/create
 * @access Public
 */
exports.createOrder = async (req, res) => {
  try {
    const { amount, currency = 'USD' } = req.body;
    
    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid amount'
      });
    }

    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer("return=representation");
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: {
          currency_code: currency,
          value: amount.toString()
        }
      }]
    });

    const order = await paypalClient.execute(request);
    
    await logPayPalTransaction('orderCreated', {
      orderId: order.result.id,
      amount,
      currency
    });
    
    res.json(order.result);
  } catch (error) {
    await logPayPalError('createOrder', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create PayPal order'
    });
  }
};

/**
 * 捕获PayPal支付
 * @route POST /api/payment/paypal/capture
 * @access Public
 */
exports.capturePayment = async (req, res) => {
  try {
    const { orderId } = req.body;
    
    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: 'Order ID is required'
      });
    }

    const request = new paypal.orders.OrdersCaptureRequest(orderId);
    const capture = await paypalClient.execute(request);
    
    await logPayPalTransaction('paymentCaptured', {
      orderId,
      captureId: capture.result.purchase_units[0].payments.captures[0].id,
      status: capture.result.status
    });

    res.json(capture.result);
  } catch (error) {
    await logPayPalError('capturePayment', error);
    res.status(500).json({
      success: false,
      message: 'Failed to capture PayPal payment'
    });
  }
};

/**
 * 处理支付捕获完成事件
 * @private
 */
async function handlePaymentCaptureCompleted(webhookEvent) {
  try {
    const resource = webhookEvent.resource;
    const captureId = resource.id;
    
    // 记录事件处理开始
    logPayPalEvent('capture_completed_processing', {
      captureId,
      event_id: webhookEvent.id
    });
    
    // 确保捕获状态是COMPLETED
    if (resource.status !== 'COMPLETED') {
      console.error(`收到的捕获状态不是COMPLETED: ${resource.status}`);
      logPayPalEvent('capture_completed_invalid_status', {
        captureId,
        event_id: webhookEvent.id,
        status: resource.status
      });
      return { success: false, error: 'invalid_capture_status', captureId, status: resource.status };
    }
    
    // 查找相关的支付意图
    const paymentIntent = await PaymentIntent.findOne({
      where: sequelize.literal(`paymentProof->>'$.paypalCaptureId' = '${captureId}'`)
    });
    
    if (!paymentIntent) {
      console.error(`找不到与捕获ID相关的支付意图: ${captureId}`);
      logPayPalEvent('capture_completed_no_payment_intent', {
        captureId,
        event_id: webhookEvent.id
      });
      return { success: false, error: 'payment_intent_not_found', captureId };
    }
    
    // 更新支付意图状态
    // 如果之前不是已确认状态，则更新为已确认
    if (paymentIntent.status !== 'confirmed') {
      // 更新状态历史
      let statusHistory = paymentIntent.statusHistory || [];
      if (typeof statusHistory === 'string') {
        try {
          statusHistory = JSON.parse(statusHistory);
        } catch (e) {
          statusHistory = [];
        }
      }
      
      statusHistory.push({
        status: 'confirmed',
        timestamp: new Date().toISOString(),
        note: 'PayPal Webhook确认支付已完成'
      });
      
      // 添加处理详情
      let processingDetails = paymentIntent.processingDetails || {};
      if (typeof processingDetails === 'string') {
        try {
          processingDetails = JSON.parse(processingDetails);
        } catch (e) {
          processingDetails = {};
        }
      }
      
      processingDetails.paypalWebhookCaptureCompleted = {
        timestamp: new Date().toISOString(),
        captureId: captureId,
        eventId: webhookEvent.id,
        captureStatus: resource.status,
        captureAmount: resource.amount ? `${resource.amount.value} ${resource.amount.currency_code}` : null
      };
      
      await paymentIntent.update({
        status: 'confirmed',
        statusHistory,
        processingDetails
      });
      
      console.log(`支付意图 ${paymentIntent.id} 已被确认 (由PayPal Webhook触发)`);
      logPayPalEvent('payment_intent_confirmed', {
        paymentIntentId: paymentIntent.id,
        captureId,
        eventId: webhookEvent.id
      });
      
      // 如果支付意图关联了LP，更新LP统计
      if (paymentIntent.lpWalletAddress) {
        const lp = await LP.findOne({ where: { walletAddress: paymentIntent.lpWalletAddress } });
        if (lp) {
          await lp.updateTransactionStats(parseFloat(paymentIntent.amount), true);
          logPayPalEvent('lp_stats_updated', {
            lpId: lp.id,
            lpWalletAddress: lp.walletAddress,
            amount: paymentIntent.amount
          });
        }
      }
      
      return { 
        success: true, 
        paymentIntentId: paymentIntent.id,
        newStatus: 'confirmed',
        previousStatus: paymentIntent.status
      };
    }
    
    return { 
      success: true, 
      paymentIntentId: paymentIntent.id,
      status: 'already_confirmed'
    };
  } catch (error) {
    console.error('处理PAYMENT.CAPTURE.COMPLETED事件失败:', error);
    logPayPalError('capture_completed_processing_error', error, {
      event_id: webhookEvent.id,
      captureId: webhookEvent.resource?.id
    });
    return { success: false, error: error.message };
  }
}

/**
 * 处理支付捕获拒绝事件
 * @private
 */
async function handlePaymentCaptureDenied(webhookEvent) {
  try {
    const resource = webhookEvent.resource;
    const captureId = resource.id;
    
    // 查找相关的支付意图
    const paymentIntent = await PaymentIntent.findOne({
      where: sequelize.literal(`paymentProof->>'$.paypalCaptureId' = '${captureId}'`)
    });
    
    if (!paymentIntent) {
      console.error(`找不到与捕获ID相关的支付意图: ${captureId}`);
      return;
    }
    
    // 更新支付意图状态为失败
    // 更新状态历史
    let statusHistory = paymentIntent.statusHistory || {};
    if (typeof statusHistory === 'string') {
      try {
        statusHistory = JSON.parse(statusHistory);
      } catch (e) {
        statusHistory = {};
      }
    }
    
    statusHistory['failed'] = new Date().toISOString();
    
    // 记录失败原因
    let paymentProof = paymentIntent.paymentProof || {};
    if (typeof paymentProof === 'string') {
      try {
        paymentProof = JSON.parse(paymentProof);
      } catch (e) {
        paymentProof = {};
      }
    }
    
    paymentProof.failureReason = resource.status_details?.reason || 'PayPal捕获被拒绝';
    
    await paymentIntent.update({
      status: 'failed',
      statusHistory: statusHistory,
      paymentProof: paymentProof
    });
    
    console.log(`支付意图 ${paymentIntent.id} 支付失败 (由PayPal触发)`);
    
    // 如果支付意图已关联LP，释放锁定的额度
    if (paymentIntent.lpId) {
      const lp = await LP.findByPk(paymentIntent.lpId);
      if (lp) {
        await lp.releaseLockedQuota(parseFloat(paymentIntent.amount));
        console.log(`已释放LP ${lp.id} 锁定的额度: ${paymentIntent.amount}`);
      }
    }
  } catch (error) {
    console.error('处理PAYMENT.CAPTURE.DENIED事件失败:', error);
  }
}

/**
 * 处理支付捕获退款事件
 * @private
 */
async function handlePaymentCaptureRefunded(webhookEvent) {
  try {
    const resource = webhookEvent.resource;
    const refundId = resource.id;
    const captureId = resource.links.find(link => link.rel === 'capture')?.href.split('/').pop();
    
    if (!captureId) {
      console.error('无法从退款资源中提取捕获ID');
      return;
    }
    
    // 查找相关的支付意图
    const paymentIntent = await PaymentIntent.findOne({
      where: sequelize.literal(`paymentProof->>'$.paypalCaptureId' = '${captureId}'`)
    });
    
    if (!paymentIntent) {
      console.error(`找不到与捕获ID相关的支付意图: ${captureId}`);
      return;
    }
    
    // 更新支付意图状态为退款
    // 更新状态历史
    let statusHistory = paymentIntent.statusHistory || {};
    if (typeof statusHistory === 'string') {
      try {
        statusHistory = JSON.parse(statusHistory);
      } catch (e) {
        statusHistory = {};
      }
    }
    
    statusHistory['refunded'] = new Date().toISOString();
    
    // 更新支付凭证
    let paymentProof = paymentIntent.paymentProof || {};
    if (typeof paymentProof === 'string') {
      try {
        paymentProof = JSON.parse(paymentProof);
      } catch (e) {
        paymentProof = {};
      }
    }
    
    paymentProof.paypalRefundId = refundId;
    paymentProof.paypalRefundStatus = resource.status;
    paymentProof.paypalRefundDetails = JSON.stringify(resource);
    
    await paymentIntent.update({
      status: 'refunded',
      statusHistory: statusHistory,
      paymentProof: paymentProof
    });
    
    console.log(`支付意图 ${paymentIntent.id} 已退款 (由PayPal触发)`);
    
    // 如果支付意图已关联LP，释放锁定的额度
    if (paymentIntent.lpId) {
      const lp = await LP.findByPk(paymentIntent.lpId);
      if (lp) {
        await lp.releaseLockedQuota(parseFloat(paymentIntent.amount));
        console.log(`已释放LP ${lp.id} 锁定的额度: ${paymentIntent.amount}`);
      }
    }
  } catch (error) {
    console.error('处理PAYMENT.CAPTURE.REFUNDED事件失败:', error);
  }
}

/**
 * 处理支付捕获撤销事件
 * @private
 */
async function handlePaymentCaptureReversed(webhookEvent) {
  try {
    const resource = webhookEvent.resource;
    const captureId = resource.id;
    
    // 查找相关的支付意图
    const paymentIntent = await PaymentIntent.findOne({
      where: sequelize.literal(`paymentProof->>'$.paypalCaptureId' = '${captureId}'`)
    });
    
    if (!paymentIntent) {
      console.error(`找不到与捕获ID相关的支付意图: ${captureId}`);
      return;
    }
    
    // 更新支付意图状态为撤销
    // 更新状态历史
    let statusHistory = paymentIntent.statusHistory || {};
    if (typeof statusHistory === 'string') {
      try {
        statusHistory = JSON.parse(statusHistory);
      } catch (e) {
        statusHistory = {};
      }
    }
    
    statusHistory['reversed'] = new Date().toISOString();
    
    await paymentIntent.update({
      status: 'reversed',
      statusHistory: statusHistory
    });
    
    console.log(`支付意图 ${paymentIntent.id} 已撤销 (由PayPal触发)`);
    
    // 如果支付意图已关联LP，释放锁定的额度
    if (paymentIntent.lpId) {
      const lp = await LP.findByPk(paymentIntent.lpId);
      if (lp) {
        await lp.releaseLockedQuota(parseFloat(paymentIntent.amount));
        console.log(`已释放LP ${lp.id} 锁定的额度: ${paymentIntent.amount}`);
      }
    }
  } catch (error) {
    console.error('处理PAYMENT.CAPTURE.REVERSED事件失败:', error);
  }
}

// 添加新的PayPal仪表板API端点

/**
 * 获取PayPal交易统计数据
 * @public
 */
async function getPayPalStats(req, res) {
  try {
    const currentDate = new Date();
    const startOfDay = new Date(currentDate.setHours(0, 0, 0, 0)).toISOString();
    
    // 获取今日交易统计
    const todayTransactions = await PaymentIntent.findAll({
      where: {
        platform: 'PayPal',
        createdAt: {
          [Op.gte]: startOfDay
        }
      }
    });
    
    // 计算总金额
    const todayAmount = todayTransactions.reduce((sum, tx) => {
      return sum + parseFloat(tx.amount || 0);
    }, 0);
    
    // 计算成功率
    const allRecentTransactions = await PaymentIntent.findAll({
      where: {
        platform: 'PayPal',
        createdAt: {
          [Op.gte]: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() // 最近30天
        }
      }
    });
    
    const completedTransactions = allRecentTransactions.filter(tx => 
      tx.status === 'completed' || tx.status === 'user_confirmed'
    );
    
    const successRate = allRecentTransactions.length > 0 
      ? completedTransactions.length / allRecentTransactions.length 
      : 0;
    
    // 计算平均处理时间
    let totalProcessingTime = 0;
    let transactionsWithCompleteHistory = 0;
    
    for (const tx of completedTransactions) {
      let statusHistory = tx.statusHistory;
      if (typeof statusHistory === 'string') {
        try {
          statusHistory = JSON.parse(statusHistory);
        } catch (e) {
          statusHistory = {};
        }
      }
      
      if (statusHistory && statusHistory['created'] && statusHistory['completed']) {
        const createdTime = new Date(statusHistory['created']).getTime();
        const completedTime = new Date(statusHistory['completed']).getTime();
        const processingTime = (completedTime - createdTime) / (60 * 1000); // 转换为分钟
        
        if (processingTime > 0) {
          totalProcessingTime += processingTime;
          transactionsWithCompleteHistory++;
        }
      }
    }
    
    const avgProcessTime = transactionsWithCompleteHistory > 0 
      ? Math.round(totalProcessingTime / transactionsWithCompleteHistory) 
      : 0;
    
    return res.json({
      todayAmount,
      todayCount: todayTransactions.length,
      successRate,
      avgProcessTime
    });
  } catch (error) {
    logPayPalError('Stats', 'Error getting PayPal statistics', error);
    return res.status(500).json({ error: 'Error fetching statistics' });
  }
}

/**
 * 获取PayPal交易列表
 * @public
 */
async function getPayPalTransactions(req, res) {
  try {
    const { startDate, endDate } = req.query;
    const where = { platform: 'PayPal' };
    
    if (startDate && endDate) {
      where.createdAt = {
        [Op.between]: [new Date(startDate), new Date(endDate).setHours(23, 59, 59, 999)]
      };
    }
    
    const transactions = await PaymentIntent.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit: 100
    });
    
    return res.json(transactions);
  } catch (error) {
    logPayPalError('Transactions', 'Error getting PayPal transactions', error);
    return res.status(500).json({ error: 'Error fetching transactions' });
  }
}

/**
 * 获取PayPal错误日志
 * @public
 */
async function getPayPalErrorLog(req, res) {
  try {
    // 由于我们没有实现错误日志存储，这里返回模拟数据
    // 在真实应用中，您应该从数据库或日志文件中检索
    const errorLogs = await getErrorLogsFromStorage();
    return res.json(errorLogs);
  } catch (error) {
    console.error('获取错误日志失败:', error);
    return res.status(500).json({ error: 'Error fetching error logs' });
  }
}

/**
 * 从存储中获取错误日志
 * @private
 */
async function getErrorLogsFromStorage() {
  // 在实际应用中，您应该从数据库或日志文件中检索
  // 这里我们返回模拟数据作为示例
  return [
    {
      timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      type: 'Webhook',
      message: 'Invalid webhook signature received'
    },
    {
      timestamp: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
      type: 'Capture',
      message: 'Payment capture failed: insufficient funds'
    },
    {
      timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      type: 'Refund',
      message: 'Refund request denied by PayPal'
    }
  ];
}

/**
 * 获取PayPal商家信息
 * @route GET /api/payment/paypal/merchant-info/:paymentIntentId
 * @access Public
 */
exports.getMerchantInfo = async (req, res) => {
  try {
    const { paymentIntentId } = req.params;
    console.log(`获取PayPal商家信息 - PaymentIntentID: ${paymentIntentId}`);
    
    if (!paymentIntentId) {
      console.log('获取PayPal商家信息失败: 缺少支付意图ID');
      return res.status(400).json({
        success: false,
        message: '缺少必要参数：支付意图ID必须提供'
      });
    }
    
    // 查找支付意图
    const paymentIntent = await PaymentIntent.findByPk(paymentIntentId, {
      attributes: { include: ['merchantPaypalEmail', 'merchantInfo'] } // 确保包含merchantPaypalEmail和merchantInfo字段
    });
    
    if (!paymentIntent) {
      console.log(`获取PayPal商家信息失败: 未找到支付意图 ID=${paymentIntentId}`);
      return res.status(404).json({
        success: false,
        message: '未找到该支付意图'
      });
    }
    
    // 详细打印整个支付意图对象，查找商家邮箱字段可能存储的位置
    console.log(`支付意图完整详情:`, paymentIntent);
    console.log(`支付意图字段列表:`, Object.keys(paymentIntent.dataValues || {}));
    console.log(`merchant_paypal_email原始值:`, paymentIntent.getDataValue('merchant_paypal_email'));
    console.log(`merchantPaypalEmail属性值:`, paymentIntent.merchantPaypalEmail);
    console.log(`merchantInfo值:`, paymentIntent.merchantInfo);
    
    // 尝试获取商家PayPal邮箱 - 按照优先级尝试不同字段
    let merchantEmail = null;
    let merchantEmailSource = null;
    
    // 1. 首先优先从merchantInfo对象中获取paypalEmail (最可靠的来源)
    try {
      if (paymentIntent.merchantInfo) {
        let merchantInfoObj = paymentIntent.merchantInfo;
        if (typeof merchantInfoObj === 'string') {
          try {
            merchantInfoObj = JSON.parse(merchantInfoObj);
          } catch (e) {
            console.error('解析merchantInfo失败:', e);
          }
        }
        
        if (merchantInfoObj && merchantInfoObj.paypalEmail && 
            typeof merchantInfoObj.paypalEmail === 'string' && 
            merchantInfoObj.paypalEmail.includes('@') &&
            !merchantInfoObj.paypalEmail.includes('personal.example.com')) {
          merchantEmail = merchantInfoObj.paypalEmail;
          merchantEmailSource = "merchant_info";
          console.log(`从merchantInfo获取到商家PayPal邮箱: ${merchantEmail}`);
        }
      }
    } catch (e) {
      console.error('从merchantInfo获取邮箱出错:', e);
    }
    
    // 2. 其次尝试直接从dataValues获取
    if (!merchantEmail) {
      let emailFromField = paymentIntent.merchantPaypalEmail || 
                           paymentIntent.getDataValue('merchant_paypal_email') || 
                           (paymentIntent.dataValues ? paymentIntent.dataValues.merchantPaypalEmail : null) ||
                           null;
      
      // 确保邮箱是字符串类型
      if (emailFromField) {
        if (typeof emailFromField === 'object') {
          if (emailFromField.email) {
            emailFromField = emailFromField.email;
          } else {
            try {
              emailFromField = JSON.stringify(emailFromField);
            } catch (e) {
              emailFromField = null;
            }
          }
        }
        
        if (typeof emailFromField === 'string' && 
            emailFromField.includes('@') &&
            !emailFromField.includes('personal.example.com')) {
          merchantEmail = emailFromField;
          merchantEmailSource = "payment_intent";
          console.log(`从支付意图merchantPaypalEmail字段获取到商家邮箱: ${merchantEmail}`);
        }
      }
    }
    
    // 检查是否是个人账号 - PayPal个人账号通常包含personal.example.com
    if (merchantEmail && merchantEmail.includes('personal.example.com')) {
      console.warn(`检测到个人账号邮箱: ${merchantEmail}，不能用作商家收款账号`);
      merchantEmail = null; // 清空，以触发获取其他邮箱的逻辑
    }
    
    console.log(`支付意图中的商家邮箱: ${merchantEmail || '无'}, 类型: ${typeof merchantEmail}`);
    
    // 确保merchantPaypalEmail字段的存储格式正确 - 必须是字符串类型
    if (typeof paymentIntent.merchantPaypalEmail === 'object') {
      console.warn('检测到merchantPaypalEmail为对象类型，尝试修复格式...');
      try {
        // 如果是对象，尝试提取邮箱或转换为字符串
        let fixedEmail = null;
        if (paymentIntent.merchantPaypalEmail !== null && typeof paymentIntent.merchantPaypalEmail === 'object') {
          if (paymentIntent.merchantPaypalEmail.email) {
            fixedEmail = paymentIntent.merchantPaypalEmail.email;
          } else {
            fixedEmail = JSON.stringify(paymentIntent.merchantPaypalEmail);
          }
        }
        
        // 更新支付意图中的商家邮箱
        await paymentIntent.update({ 
          merchantPaypalEmail: fixedEmail && fixedEmail.includes('@') ? fixedEmail : null
        });
        console.log(`已修复商家邮箱格式，从对象转换为字符串: ${fixedEmail || 'null'}`);
      } catch (e) {
        console.error('修复商家邮箱格式失败:', e);
      }
    }
    
    // 检查是否有关联的merchantInfo字段中包含PayPal商家邮箱 - 这应该是正确获取商户信息的地方
    if (!merchantEmail && paymentIntent.merchantInfo) {
      let merchantInfo = paymentIntent.merchantInfo;
      if (typeof merchantInfo === 'string') {
        try {
          merchantInfo = JSON.parse(merchantInfo);
        } catch (e) {
          merchantInfo = {};
        }
      }
      
      // 获取merchantInfo中的商家邮箱
      if (merchantInfo && merchantInfo.paypalEmail && merchantInfo.paypalEmail.includes('@') && 
          !merchantInfo.paypalEmail.includes('personal.example.com')) {
        merchantEmail = merchantInfo.paypalEmail;
        merchantEmailSource = "merchant_info";
        console.log(`从商家信息中获取到PayPal邮箱: ${merchantEmail}`);
        
        // 同步到merchantPaypalEmail字段
        try {
          await paymentIntent.update({ merchantPaypalEmail: merchantEmail });
          console.log(`已将商家信息中的邮箱同步到merchantPaypalEmail字段`);
        } catch (e) {
          console.error(`同步商家邮箱字段失败:`, e);
        }
      }
    }
    
    // 只有在支付意图没有商家邮箱时，才尝试从LP中获取 (这是备选方案，不应该是主要路径)
    if (!merchantEmail && paymentIntent.lpWalletAddress) {
      console.log(`未从支付意图中找到有效商家邮箱，尝试从LP钱包地址获取: ${paymentIntent.lpWalletAddress}`);
      const lp = await LP.findOne({ where: { walletAddress: paymentIntent.lpWalletAddress } });
      if (lp && lp.paypalEmail && 
          typeof lp.paypalEmail === 'string' && 
          lp.paypalEmail.includes('@') &&
          !lp.paypalEmail.includes('personal.example.com')) {
        merchantEmail = lp.paypalEmail;
        merchantEmailSource = "lp";
        console.log(`从LP钱包地址获取到商家邮箱: ${merchantEmail} (备选方案)`);
        
        // 更新支付意图中的商家邮箱，以便下次直接使用
        try {
          await paymentIntent.update({ merchantPaypalEmail: merchantEmail });
          console.log(`已更新支付意图中的商家邮箱为LP邮箱 (备选方案)`);
        } catch (e) {
          console.error(`更新支付意图商家邮箱失败:`, e);
        }
      } else {
        console.log(`LP钱包地址未找到相关商家邮箱或邮箱无效: ${lp?.paypalEmail || '无'}`);
      }
    }
    
    // 如果仍然没有找到商家邮箱，使用系统默认商家
    if (!merchantEmail) {
      console.log('未找到有效的商家PayPal邮箱，无法进行支付');
      
      // 记录错误事件
      await logPayPalError('merchant_info_requested', new Error('无有效商家PayPal邮箱'), {
        paymentIntentId: paymentIntent.id
      });
      
      return res.status(400).json({
        success: false,
        message: '未找到有效的商家PayPal邮箱，无法进行支付',
        error: '请确保商家已配置有效的PayPal商业账户'
      });
    }
    
    console.log(`最终使用的商家邮箱: ${merchantEmail}`);
    
    // 记录事件
    await logPayPalEvent('merchant_info_requested', {
      paymentIntentId: paymentIntent.id,
      merchantEmail,
      source: merchantEmailSource
    });
    
    return res.status(200).json({
      success: true,
      data: {
        paymentIntentId: paymentIntent.id,
        email: merchantEmail,
        platform: 'PayPal',
        // 添加更多相关的商家信息
        sourceType: merchantEmailSource,
        originalPaymentDetails: {
          amount: paymentIntent.amount,
          currency: paymentIntent.currency || 'USD',
          description: paymentIntent.description || 'UnitPay Payment'
        }
      }
    });
  } catch (error) {
    console.error('获取PayPal商家信息失败:', error);
    await logPayPalError('get_merchant_info', error, { paymentIntentId: req.params.paymentIntentId });
    return res.status(500).json({
      success: false,
      message: '获取PayPal商家信息失败',
      error: process.env.NODE_ENV === 'development' ? error.message : '服务器内部错误'
    });
  }
};

/**
 * 取消PayPal订单
 * @route POST /api/payment/paypal/cancel-order
 * @access Public
 */
exports.cancelOrder = async (req, res) => {
  try {
    const { paymentIntentId, orderId } = req.body;
    
    console.log(`----- 开始取消PayPal订单 -----`);
    console.log(`PaymentIntentID: ${paymentIntentId}, OrderID: ${orderId || '未提供'}`);
    console.log(`请求体:`, JSON.stringify(req.body));
    
    if (!paymentIntentId) {
      console.error('缺少支付意向ID参数');
      return res.status(400).json({
        success: false,
        message: '支付意向ID是必需的'
      });
    }
    
    // 获取支付意向
    const paymentIntent = await PaymentIntent.findOne({ 
      where: { id: paymentIntentId },
      raw: false
    });
    
    if (!paymentIntent) {
      console.error(`未找到支付意向，ID=${paymentIntentId}`);
      return res.status(404).json({
        success: false,
        message: '未找到支付意向'
      });
    }
    
    console.log(`找到支付意向，ID=${paymentIntent.id}, 当前状态: ${paymentIntent.status}, LP地址: ${paymentIntent.lpWalletAddress || '无'}`);
    
    // 检查状态是否可取消
    const cancelableStatuses = ['created', 'processing', 'pending', 'claimed'];
    if (!cancelableStatuses.includes(paymentIntent.status)) {
      console.error(`支付状态不可取消: ${paymentIntent.status}`);
      return res.status(400).json({
        success: false,
        message: `支付状态为 ${paymentIntent.status}，无法取消`
      });
    }
    
    // 如果提供了PayPal订单ID，尝试在PayPal取消
    if (orderId) {
      try {
        console.log(`尝试取消PayPal订单: ${orderId}, 支付意向ID: ${paymentIntentId}`);
        
        // 创建PayPal客户端
        const paypalClient = await createPayPalClient();
        
        // 创建请求对象来调用PayPal API取消订单
        const request = new paypal.orders.OrdersCreateRequest();
        request.prefer("return=representation");
        
        // 这里执行取消订单的PayPal API调用
        // 注意：PayPal API根据订单状态可能需要不同的处理方式
        // 例如，如果订单已被授权但未捕获，可能需要调用void authorization接口
        try {
          // 先尝试获取订单状态
          const getOrderRequest = new paypal.orders.OrdersGetRequest(orderId);
          const orderDetails = await paypalClient.execute(getOrderRequest);
          console.log(`PayPal订单状态: ${orderDetails.result.status}`);
          
          // 根据订单状态执行不同的取消操作
          if (orderDetails.result.status === 'CREATED' || orderDetails.result.status === 'SAVED') {
            // 对于未完成的订单，可以简单记录为已取消
            console.log(`PayPal订单 ${orderId} 处于 ${orderDetails.result.status} 状态，记录为已取消`);
          } else if (orderDetails.result.status === 'APPROVED') {
            // 对于已批准但未捕获的订单，需要进一步处理
            console.log(`PayPal订单 ${orderId} 处于已批准状态，需要特殊处理`);
            // 这里可能需要额外的API调用来取消已批准的订单
          } else if (orderDetails.result.status === 'COMPLETED') {
            console.log(`PayPal订单 ${orderId} 已完成，无法取消，只能通过退款处理`);
            // 对于已完成的订单，可能需要考虑发起退款流程
          }
        } catch (orderError) {
          console.error(`获取PayPal订单状态失败: ${orderError.message}`);
        }
        
        // 记录交易
        await logPayPalTransaction('orderCancelled', {
          orderId,
          paymentIntentId,
          cancelAttempted: true,
          timestamp: new Date().toISOString()
        });
        
      } catch (cancelError) {
        console.error('取消PayPal订单失败:', cancelError);
        await logPayPalError('cancelOrder', cancelError);
      }
    }
    
    // 准备状态历史
    let statusHistory = paymentIntent.statusHistory || [];
    if (typeof statusHistory === 'string') {
      try {
        statusHistory = JSON.parse(statusHistory);
      } catch (e) {
        statusHistory = [];
      }
    }
    if (!Array.isArray(statusHistory)) {
      statusHistory = [];
    }
    
    // 始终将支付状态恢复到created，不管之前是否有LP认领
    // 这确保取消支付后订单能立即回到任务池而无需等待定时任务检查
    const newStatus = 'created';
    const statusNote = 'PayPal支付被取消，恢复到待认领状态 [PAYMENT_CANCELLED]';
    console.log(`支付意向 ${paymentIntentId} 从 ${paymentIntent.status} 恢复到 created 状态 (待认领)`);
    
    // 添加状态历史记录
    statusHistory.push({
      status: newStatus,
      timestamp: new Date(),
      note: statusNote
    });
    
    // 再添加一条明确的取消标记记录，确保自动检测能识别
    statusHistory.push({
      status: 'cancelled',  // 添加一个额外的cancelled记录，即使实际状态是created
      timestamp: new Date(),
      note: '用户取消支付 [MANUAL_CANCEL]'
    });
    
    // 开启事务
    const t = await sequelize.transaction();
    
    try {
      // 更新支付意向状态
      await paymentIntent.update({
        status: newStatus,
        statusHistory: statusHistory,
        // 保存取消标记到元数据
        metadata: paymentIntent.metadata || {},
        // 清除LP关联，使其能重新被认领
        lpWalletAddress: null,
        lpId: null
      }, { transaction: t });
      
      // 更新或创建任务池记录
      const taskPoolData = {
        paymentIntentId: paymentIntent.id,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency || 'USD',
        status: newStatus,
        userWalletAddress: paymentIntent.userWalletAddress,
        lpWalletAddress: null, // 清除LP关联
        platform: 'PayPal',
        createdAt: paymentIntent.createdAt,
        updatedAt: new Date(),
        expiresAt: paymentIntent.expiresAt,
        description: paymentIntent.description || '用户取消的PayPal支付'
      };
      
      // 尝试查找现有任务记录
      let taskPool = await TaskPool.findOne({
        where: { paymentIntentId: paymentIntent.id },
        transaction: t
      });
      
      if (taskPool) {
        // 更新现有记录
        console.log(`更新任务池记录: ${taskPool.id}`);
        await taskPool.update(taskPoolData, { transaction: t });
      } else {
        // 创建新记录
        console.log(`创建新的任务池记录`);
        await TaskPool.create(taskPoolData, { transaction: t });
      }
      
      // 如果有LP，释放LP的锁定配额
      if (paymentIntent.lpWalletAddress) {
        const lp = await LP.findOne({ 
          where: { walletAddress: paymentIntent.lpWalletAddress },
          transaction: t 
        });
        
        if (lp) {
          console.log(`尝试释放LP锁定额度: ${paymentIntent.amount}, LP: ${paymentIntent.lpWalletAddress}`);
          await lp.releaseLockedQuota(parseFloat(paymentIntent.amount), t);
          console.log(`已为LP释放锁定额度`);
        }
      }
      
      // 提交事务
      await t.commit();
      console.log(`数据库更新成功，事务已提交`);
      
    } catch (dbError) {
      // 回滚事务
      await t.rollback();
      console.error('数据库操作失败:', dbError);
      throw dbError;
    }
    
    // 发送实时通知
    if (global.io) {
      // 立即向用户发送取消确认通知，确保前端能立即显示取消状态
      if (paymentIntent.userWalletAddress) {
        global.io.to(paymentIntent.userWalletAddress).emit('payment_cancelled', {
          paymentIntentId: paymentIntent.id,
          status: newStatus,
          message: statusNote,
          timestamp: new Date().toISOString()
        });
        
        // 同时发送常规状态更新通知
        global.io.to(paymentIntent.userWalletAddress).emit('payment_status_update', {
          paymentIntentId: paymentIntent.id,
          status: newStatus,
          message: statusNote,
          cancelled: true
        });
      }
      
      // 通知LP订单已被取消（如果有）
      if (paymentIntent.lpWalletAddress) {
        global.io.to(paymentIntent.lpWalletAddress).emit('payment_cancelled', {
          paymentIntentId: paymentIntent.id,
          status: newStatus,
          message: statusNote,
          timestamp: new Date().toISOString()
        });
        
        global.io.to(paymentIntent.lpWalletAddress).emit('payment_status_update', {
          paymentIntentId: paymentIntent.id,
          status: newStatus,
          message: statusNote,
          cancelled: true
        });
      }
      
      // 广播到所有LP客户端，通知有新任务可用
      global.io.emit('task_pool_updated', {
        action: 'task_returned',
        paymentIntentId: paymentIntent.id,
        status: 'created',
        cancelled: true
      });
    }
    
    console.log(`----- 成功取消PayPal订单 -----`);
    return res.status(200).json({
      success: true,
      message: '支付已取消并恢复到待认领状态',
      paymentIntent: {
        id: paymentIntent.id,
        status: newStatus
      }
    });
    
  } catch (error) {
    console.error('----- 取消支付失败:', error);
    console.error('错误堆栈:', error.stack);
    await logPayPalError('cancelOrder', error);
    return res.status(500).json({
      success: false,
      message: '取消支付失败',
      error: process.env.NODE_ENV === 'development' ? error.message : '服务器内部错误'
    });
  }
};

/**
 * 验证PayPal捕获ID
 * @route POST /api/payment/paypal/verify-capture
 * @access Public
 */
exports.verifyCapture = async (req, res) => {
  try {
    const { paymentIntentId, captureId, orderId } = req.body;
    
    if (!paymentIntentId || !captureId || !orderId) {
      return res.status(400).json({
        success: false,
        message: '缺少必要参数: 支付意图ID、捕获ID和订单ID必须提供'
      });
    }
    
    console.log(`验证PayPal捕获 - PaymentIntentID: ${paymentIntentId}, CaptureID: ${captureId}, OrderID: ${orderId}`);
    
    // 查找支付意图
    const paymentIntent = await PaymentIntent.findByPk(paymentIntentId);
    if (!paymentIntent) {
      return res.status(404).json({
        success: false,
        message: '未找到该支付意图'
      });
    }
    
    // 检查支付凭证中的捕获ID是否与提供的一致
    let paymentProof = paymentIntent.paymentProof;
    if (typeof paymentProof === 'string') {
      try {
        paymentProof = JSON.parse(paymentProof);
      } catch (e) {
        paymentProof = {};
      }
    }
    
    const storedCaptureId = paymentProof?.paypalCaptureId || paymentProof?.captureId;
    const storedOrderId = paymentProof?.paypalOrderId;
    
    // 必须同时验证捕获ID和订单ID
    if (!storedCaptureId || !storedOrderId) {
      return res.status(400).json({
        success: false,
        message: '支付凭证中缺少捕获ID或订单ID'
      });
    }
    
    if (storedCaptureId !== captureId) {
      console.error(`捕获ID不匹配 - 存储的: ${storedCaptureId}, 提供的: ${captureId}`);
      return res.status(400).json({
        success: false,
        message: '捕获ID验证失败: 不匹配'
      });
    }
    
    if (storedOrderId !== orderId) {
      console.error(`订单ID不匹配 - 存储的: ${storedOrderId}, 提供的: ${orderId}`);
      return res.status(400).json({
        success: false,
        message: '订单ID验证失败: 不匹配'
      });
    }
    
    // 尝试从PayPal API验证捕获状态
    try {
      // 创建PayPal客户端
      const paypalClient = await createPayPalClient();
      
      // 获取订单详情
      const getOrderRequest = new paypal.orders.OrdersGetRequest(orderId);
      const orderDetails = await paypalClient.execute(getOrderRequest);
      
      const orderStatus = orderDetails.result.status;
      
      if (orderStatus !== 'COMPLETED') {
        console.error(`PayPal订单状态验证失败 - 状态: ${orderStatus}`);
        return res.status(400).json({
          success: false,
          message: `PayPal订单状态验证失败: ${orderStatus}`
        });
      }
      
      // 查找此订单的捕获
      let captureFound = false;
      const purchaseUnits = orderDetails.result.purchase_units || [];
      
      for (const unit of purchaseUnits) {
        const payments = unit.payments || {};
        const captures = payments.captures || [];
        
        for (const capture of captures) {
          if (capture.id === captureId) {
            captureFound = true;
            
            if (capture.status !== 'COMPLETED') {
              console.error(`PayPal捕获状态验证失败 - 状态: ${capture.status}`);
              return res.status(400).json({
                success: false,
                message: `PayPal捕获状态验证失败: ${capture.status}`
              });
            }
            
            break;
          }
        }
        
        if (captureFound) break;
      }
      
      if (!captureFound) {
        console.error(`未在PayPal订单中找到匹配的捕获ID`);
        return res.status(400).json({
          success: false,
          message: '未在PayPal订单中找到匹配的捕获ID'
        });
      }
    } catch (error) {
      console.error('调用PayPal API验证捕获失败:', error);
      // 即使PayPal API调用失败，如果数据库中的值匹配，我们仍然继续
      console.warn('忽略PayPal API错误，使用数据库记录继续验证');
    }
    
    // 状态验证 - 确保支付状态为paid或confirmed
    if (paymentIntent.status !== 'paid' && paymentIntent.status !== 'confirmed') {
      console.error(`支付状态验证失败 - 状态: ${paymentIntent.status}`);
      return res.status(400).json({
        success: false,
        message: `支付状态验证失败: ${paymentIntent.status}`
      });
    }
    
    // 记录验证成功
    await logPayPalEvent('capture_verified', {
      paymentIntentId,
      captureId,
      orderId
    });
    
    return res.status(200).json({
      success: true,
      message: 'PayPal捕获验证成功',
      data: {
        paymentIntentId,
        captureId,
        orderId,
        status: paymentIntent.status
      }
    });
    
  } catch (error) {
    console.error('验证PayPal捕获失败:', error);
    await logPayPalError('verify_capture', error, { 
      paymentIntentId: req.body.paymentIntentId,
      captureId: req.body.captureId
    });
    return res.status(500).json({
      success: false,
      message: '验证PayPal捕获失败',
      error: process.env.NODE_ENV === 'development' ? error.message : '服务器内部错误'
    });
  }
};

/**
 * 自动检查并修复卡在processing状态的订单
 * 这个函数会定期运行，查找所有处于processing状态超过3分钟的订单
 * 并将其状态恢复到created状态，使其出现在任务池中
 * @private
 */
async function autoFixStuckProcessingOrders() {
  try {
    console.log('开始检查卡在processing状态的订单...');
    console.log(`当前时间: ${new Date().toISOString()}`);
    
    // 首先查询所有processing状态的订单，用于调试
    let allProcessingOrders = [];
    try {
      allProcessingOrders = await PaymentIntent.findAll({
        where: {
          status: 'processing'
        },
        attributes: ['id', 'status', 'updatedAt', 'createdAt', 'lpWalletAddress', 'statusHistory']
      });
      console.log(`总共找到 ${allProcessingOrders.length} 个处于processing状态的订单`);
    } catch (dbError) {
      console.error('查询processing状态订单失败:', dbError);
      console.error('尝试使用备选查询...');
      
      // 尝试不使用attributes参数
      try {
        allProcessingOrders = await PaymentIntent.findAll({
          where: {
            status: 'processing'
          }
        });
        console.log(`备选查询成功，找到 ${allProcessingOrders.length} 个处于processing状态的订单`);
      } catch (fallbackError) {
        console.error('备选查询也失败:', fallbackError);
        throw new Error('无法查询数据库，两种查询方法均失败');
      }
    }
    
    // 打印所有processing订单信息，用于调试
    const stuckOrdersToProcess = [];
    
    for (const order of allProcessingOrders) {
      const now = new Date();
      const updatedAt = new Date(order.updatedAt);
      const minutesDiff = Math.floor((now - updatedAt) / (60 * 1000));
      const secondsDiff = Math.floor((now - updatedAt) / 1000);
      
      console.log(`订单ID: ${order.id}, 状态: ${order.status}, 最后更新: ${order.updatedAt}, 距离现在: ${minutesDiff}分钟${secondsDiff % 60}秒`);
      
      // 检查订单状态历史中是否有取消记录
      let statusHistory = order.statusHistory || [];
      if (typeof statusHistory === 'string') {
        try {
          statusHistory = JSON.parse(statusHistory);
        } catch (e) {
          console.error(`解析订单${order.id}状态历史失败:`, e.message);
          statusHistory = [];
        }
      }
      
      if (!Array.isArray(statusHistory)) {
        console.log(`订单${order.id}状态历史不是数组，重置为空数组`);
        statusHistory = [];
      }
      
      // 检查最近的状态历史是否有取消记录
      // 查找最新10条记录中是否包含取消相关的关键词
      const recentHistory = statusHistory.slice(-10);
      const paymentCancelled = recentHistory.some(entry => 
        entry && (
          // 检查状态为cancelled的记录
          entry.status === 'cancelled' ||
          // 检查note中包含取消相关关键词的记录
          (entry.note && (
            entry.note.includes('取消') || 
            entry.note.includes('cancel') ||
            entry.note.includes('CANCEL') ||
            entry.note.includes('中断') ||
            entry.note.includes('PAYMENT_CANCELLED') ||
            entry.note.includes('MANUAL_CANCEL')
          ))
        )
      );
      
      console.log(`订单${order.id}取消状态: ${paymentCancelled ? '已取消' : '未取消'}, 状态历史记录数: ${statusHistory.length}`);
      
      // 打印最近几条状态历史，帮助调试
      if (statusHistory.length > 0) {
        console.log(`订单${order.id}最近状态历史:`);
        statusHistory.slice(-3).forEach((entry, index) => {
          console.log(`  [${index}] 状态: ${entry.status}, 说明: ${entry.note}`);
        });
      }
      
      // 情况1: 已被明确取消且超过15秒的订单
      if (paymentCancelled && secondsDiff > 15) {
        console.log(`订单 ${order.id} 已被取消且超过15秒，需要重置`);
        stuckOrdersToProcess.push({
          order,
          reason: 'payment_cancelled',
          message: '支付已取消，订单重置为待认领状态'
        });
      } 
      // 情况2: 未被取消但超过5分钟的订单
      else if (!paymentCancelled && minutesDiff >= 5) {
        console.log(`订单 ${order.id} 超过5分钟未完成，需要重置`);
        stuckOrdersToProcess.push({
          order,
          reason: 'processing_timeout',
          message: '订单处理超过5分钟超时，已重置为待认领状态'
        });
      } else {
        console.log(`订单 ${order.id} 不满足重置条件，保持当前状态`);
      }
      
      // 检查是否为需要特殊处理的订单
      // 订单98已被确认是被取消的，但状态没有正确标记
      const isSpecialOrder = (order.id === 98);
      if (isSpecialOrder) {
        console.log(`特殊处理：订单${order.id}已被确认为已取消状态，强制重置`);
        stuckOrdersToProcess.push({
          order,
          reason: 'special_case_cancelled',
          message: '确认已取消的支付，订单重置为待认领状态'
        });
        continue;
      }
    }
    
    console.log(`找到 ${stuckOrdersToProcess.length} 个需要处理的订单`);
    
    // 处理需要重置的订单
    for (const { order, reason, message } of stuckOrdersToProcess) {
      console.log(`处理卡住的订单: ${order.id}, 最后更新时间: ${order.updatedAt}, 原因: ${reason}`);
      
      // 准备状态历史
      let statusHistory = order.statusHistory || [];
      if (typeof statusHistory === 'string') {
        try {
          statusHistory = JSON.parse(statusHistory);
        } catch (e) {
          console.error(`解析订单${order.id}状态历史失败:`, e.message);
          statusHistory = [];
        }
      }
      
      if (!Array.isArray(statusHistory)) {
        console.log(`订单${order.id}状态历史不是数组，重置为空数组`);
        statusHistory = [];
      }
      
      // 添加状态历史记录
      statusHistory.push({
        status: 'created',
        timestamp: new Date(),
        note: `系统自动处理: ${message}`
      });
      
      // 如果订单已被LP认领，需要释放锁定的额度
      if (order.lpWalletAddress) {
        try {
          const lp = await LP.findOne({
            where: { walletAddress: order.lpWalletAddress }
          });
          
          if (lp) {
            // 计算需要释放的额度
            const releaseAmount = parseFloat(order.amount);
            if (!isNaN(releaseAmount) && releaseAmount > 0) {
              // 更新LP的锁定额度
              const newLockedQuota = Math.max(0, lp.lockedQuota - releaseAmount);
              const newAvailableQuota = lp.totalQuota - newLockedQuota;
              
              await lp.update({
                lockedQuota: newLockedQuota,
                availableQuota: newAvailableQuota
              });
              
              console.log(`已释放LP ${lp.walletAddress} 的锁定额度: ${releaseAmount}`);
            }
          }
        } catch (error) {
          console.error(`释放LP锁定额度时出错:`, error);
          await logPayPalError('release_locked_quota', error);
        }
      }
      
      // 更新订单状态为 created
      try {
        await order.update({
          status: 'created',
          statusHistory: statusHistory,
          lpWalletAddress: null,  // 清除 LP 关联
          lpId: null              // 同时清除 lpId
        });
        console.log(`订单 ${order.id} 状态已更新为 created`);
      } catch (updateError) {
        console.error(`更新订单 ${order.id} 状态失败:`, updateError);
        continue; // 继续处理下一个订单
      }
      
      // 更新任务池记录
      try {
        const taskPool = await TaskPool.findOne({
          where: { paymentIntentId: order.id }
        });
        
        if (taskPool) {
          console.log(`更新任务池记录 ${taskPool.id}`);
          await taskPool.update({
            status: 'created',
            lpWalletAddress: null,
            updatedAt: new Date() // 确保updatedAt被更新
          });
        } else {
          // 创建新的任务池记录
          console.log(`创建新的任务池记录`);
          await TaskPool.create({
            paymentIntentId: order.id,
            amount: order.amount,
            currency: order.currency || 'USD',
            status: 'created',
            userWalletAddress: order.userWalletAddress,
            platform: 'PayPal',
            createdAt: order.createdAt,
            updatedAt: new Date(),
            expiresAt: order.expiresAt,
            description: order.description || `系统自动重置的订单 (${reason})`
          });
        }
      } catch (error) {
        console.error(`更新任务池记录失败:`, error);
        await logPayPalError('update_task_pool', error);
      }
      
      // 记录日志
      await logPayPalEvent('order_reset', {
        paymentIntentId: order.id,
        fromStatus: 'processing',
        toStatus: 'created',
        reason: reason
      });
      
      // 通过Socket.io通知相关方
      if (global.io) {
        // 通知用户
        if (order.userWalletAddress) {
          global.io.to(order.userWalletAddress).emit('payment_intent_reset', {
            id: order.id,
            status: 'created',
            message: message
          });
        }
        
        // 通知LP（如果有）
        if (order.lpWalletAddress) {
          global.io.to(order.lpWalletAddress).emit('payment_intent_reset', {
            id: order.id,
            status: 'created',
            message: message
          });
        }
        
        // 广播到所有LP客户端，通知有新任务可用
        global.io.emit('task_pool_updated', {
          action: 'task_reset',
          paymentIntentId: order.id
        });
      }
      
      console.log(`订单 ${order.id} 已重置为待认领状态`);
    }
    
  } catch (error) {
    console.error('自动修复卡住订单时出错:', error);
    console.error('错误堆栈:', error.stack);
    await logPayPalError('auto_fix_stuck_orders', error);
  }
}

// 初始化自动修复功能
let autoFixInterval = null;
let autoFixActive = false; // 标记自动修复功能是否正在运行，防止重复调用

function initAutoFixScheduler() {
  console.log('初始化PayPal自动修复定时任务...');
  
  // 检查是否已在运行
  if (autoFixActive) {
    console.log('自动修复功能已在运行中，不重复初始化');
    return autoFixInterval;
  }
  
  // 首先清除任何可能存在的旧定时器
  if (autoFixInterval) {
    console.log('清除旧的自动修复定时器');
    clearInterval(autoFixInterval);
    autoFixInterval = null;
  }
  
  // 设置运行标志
  autoFixActive = true;
  
  // 设置新的定时任务，每10秒运行一次
  autoFixInterval = setInterval(async () => {
    console.log('===定时任务=== 自动检查处于processing状态的订单');
    try {
      await autoFixStuckProcessingOrders();
    } catch (error) {
      console.error('自动修复任务执行失败:', error);
      console.error('错误堆栈:', error.stack);
      // 记录错误，但不中断定时器
      await logPayPalError('auto_fix_task_error', error).catch(e => 
        console.error('记录错误失败:', e)
      );
    }
  }, 10 * 1000);
  
  console.log('已启动自动修复卡住订单的定时任务，每10秒运行一次');
  
  // 启动后立即运行一次，但使用try-catch捕获错误
  console.log('立即执行一次自动修复...');
  try {
    autoFixStuckProcessingOrders().catch(err => {
      console.error('初次运行自动修复任务失败:', err);
    });
  } catch (err) {
    console.error('初次运行自动修复任务发生异常:', err);
  }
  
  return autoFixInterval;
}

// 导出重置自动修复功能的辅助函数
function resetAutoFixScheduler() {
  console.log('重置自动修复定时任务...');
  autoFixActive = false;
  if (autoFixInterval) {
    clearInterval(autoFixInterval);
    autoFixInterval = null;
  }
  return initAutoFixScheduler();
}

/**
 * 自动检查并处理过期订单
 * 这个函数会定期运行，查找所有已过期的订单并将其状态更新为expired
 * @private
 */
async function autoHandleExpiredOrders() {
  try {
    console.log('开始自动检查并处理过期订单...');
    
    // 使用direct SQL查询代替Sequelize模型查询，避免missing column问题
    // 移除 deletedAt 条件，因为数据库表中不存在该字段
    const [expiredOrders] = await sequelize.query(`
      SELECT id, amount, currency, description, platform, 
             merchantInfo, userWalletAddress, merchant_paypal_email as merchantPaypalEmail, 
             userId, lpWalletAddress, lpId, status, 
             escrowStatus, statusHistory, paymentProof, 
             settlementTxHash, errorDetails, processingDetails, 
             lockTime, releaseTime, withdrawalTime, network, 
             platformFee, isDisputed, expiresAt,
             createdAt, updatedAt
      FROM payment_intents
      WHERE expiresAt < NOW()
        AND status NOT IN ('expired', 'cancelled', 'paid', 'confirmed', 'user_confirmed', 'settled')
    `);
    
    console.log(`找到 ${expiredOrders.length} 个过期订单需要处理`);
    
    // 遍历并处理这些订单
    for (const orderData of expiredOrders) {
      console.log(`处理过期订单: ${orderData.id}, 过期时间: ${orderData.expiresAt}`);
      
      // 获取完整的订单对象以便进行更新
      const order = await PaymentIntent.findByPk(orderData.id);
      if (!order) {
        console.error(`无法找到订单对象: ${orderData.id}`);
        continue;
      }
      
      // 准备状态历史
      let statusHistory = order.statusHistory || [];
      if (typeof statusHistory === 'string') {
        try {
          statusHistory = JSON.parse(statusHistory);
        } catch (e) {
          statusHistory = [];
        }
      }
      
      // 添加状态历史记录
      statusHistory.push({
        status: 'expired',
        timestamp: new Date(),
        note: '系统自动处理: 订单已过期'
      });
      
      // 如果订单已被LP认领，需要释放锁定的额度
      if (order.lpWalletAddress) {
        try {
          const lp = await LP.findOne({
            where: { walletAddress: order.lpWalletAddress }
          });
          
          if (lp) {
            // 计算需要释放的额度
            const releaseAmount = parseFloat(order.amount);
            if (!isNaN(releaseAmount) && releaseAmount > 0) {
              // 更新LP的锁定额度
              const newLockedQuota = Math.max(0, lp.lockedQuota - releaseAmount);
              const newAvailableQuota = lp.totalQuota - newLockedQuota;
              
              await lp.update({
                lockedQuota: newLockedQuota,
                availableQuota: newAvailableQuota
              });
              
              console.log(`已释放LP ${lp.walletAddress} 的锁定额度: ${releaseAmount}`);
            }
          }
        } catch (error) {
          console.error(`释放LP锁定额度时出错:`, error);
          await logPayPalError('release_locked_quota', error);
        }
      }
      
      // 更新订单状态
      await order.update({
        status: 'expired',
        statusHistory: statusHistory
      });
      
      // 记录日志
      await logPayPalEvent('order_expired', {
        paymentIntentId: order.id,
        fromStatus: order.status,
        toStatus: 'expired',
        expiresAt: order.expiresAt
      });
      
      // 通过Socket.io通知相关方
      if (global.io) {
        // 通知用户
        if (order.userWalletAddress) {
          global.io.to(order.userWalletAddress).emit('payment_intent_expired', {
            id: order.id,
            status: 'expired'
          });
        }
        
        // 通知LP
        if (order.lpWalletAddress) {
          global.io.to(order.lpWalletAddress).emit('payment_intent_expired', {
            id: order.id,
            status: 'expired'
          });
        }
      }
      
      console.log(`订单 ${order.id} 已标记为过期`);
    }
    
  } catch (error) {
    console.error('自动处理过期订单时出错:', error);
    await logPayPalError('auto_handle_expired_orders', error);
  }
}

// 设置定时任务，每分钟检查一次过期订单
let expiredOrdersInterval = setInterval(autoHandleExpiredOrders, 60 * 1000);

/**
 * 处理PayPal订单取消事件
 * @private
 */
async function handleOrderCancelled(webhookEvent) {
  try {
    const resource = webhookEvent.resource;
    const orderId = resource.id;
    
    console.log(`处理PayPal订单取消事件 - OrderID: ${orderId}`);
    await logPayPalEvent('order_cancelled_webhook', {
      orderId,
      eventId: webhookEvent.id
    });
    
    // 查找与此订单ID关联的支付意向
    let paymentIntent = null;
    
    // 1. 首先尝试从paymentProof中查找
    try {
      paymentIntent = await PaymentIntent.findOne({
        where: sequelize.literal(`paymentProof->>'$.paypalOrderId' = '${orderId}'`)
      });
    } catch (error) {
      console.error('通过paymentProof查询订单失败:', error);
    }
    
    // 2. 如果没找到，尝试从processingDetails中查找
    if (!paymentIntent) {
      try {
        paymentIntent = await PaymentIntent.findOne({
          where: sequelize.literal(`processingDetails->>'$.paypalOrderId' = '${orderId}'`)
        });
      } catch (error) {
        console.error('通过processingDetails查询订单失败:', error);
      }
    }
    
    // 3. 如果还没找到，尝试使用LIKE查询
    if (!paymentIntent) {
      try {
        const allPossibleOrders = await PaymentIntent.findAll();
        for (const order of allPossibleOrders) {
          const paymentProof = order.paymentProof;
          const processingDetails = order.processingDetails;
          
          let found = false;
          
          // 检查paymentProof
          if (paymentProof) {
            if (typeof paymentProof === 'string') {
              if (paymentProof.includes(orderId)) {
                found = true;
              }
            } else if (typeof paymentProof === 'object') {
              if (paymentProof.paypalOrderId === orderId) {
                found = true;
              }
            }
          }
          
          // 检查processingDetails
          if (!found && processingDetails) {
            if (typeof processingDetails === 'string') {
              if (processingDetails.includes(orderId)) {
                found = true;
              }
            } else if (typeof processingDetails === 'object') {
              if (processingDetails.paypalOrderId === orderId) {
                found = true;
              }
            }
          }
          
          if (found) {
            paymentIntent = order;
            break;
          }
        }
      } catch (error) {
        console.error('全表扫描查询订单失败:', error);
      }
    }
    
    if (!paymentIntent) {
      console.error(`未找到与PayPal订单ID ${orderId} 关联的支付意向`);
      return;
    }
    
    console.log(`找到支付意向 ID=${paymentIntent.id}, 当前状态: ${paymentIntent.status}`);
    
    // 准备状态历史
    let statusHistory = paymentIntent.statusHistory || [];
    if (typeof statusHistory === 'string') {
      try {
        statusHistory = JSON.parse(statusHistory);
      } catch (e) {
        statusHistory = [];
      }
    }
    if (!Array.isArray(statusHistory)) {
      statusHistory = [];
    }
    
    // 添加状态历史记录 - 明确标记为PayPal触发的取消
    statusHistory.push({
      status: 'created',
      timestamp: new Date(),
      note: 'PayPal Webhook通知：订单已取消 [PAYMENT_CANCELLED]'
    });
    
    // 再添加一条明确的取消标记记录
    statusHistory.push({
      status: 'cancelled',
      timestamp: new Date(),
      note: 'PayPal订单取消 [PAYPAL_WEBHOOK_CANCEL]'
    });
    
    // 如果订单已被LP认领，需要释放锁定的额度
    if (paymentIntent.lpWalletAddress) {
      try {
        const lp = await LP.findOne({
          where: { walletAddress: paymentIntent.lpWalletAddress }
        });
        
        if (lp) {
          // 计算需要释放的额度
          const releaseAmount = parseFloat(paymentIntent.amount);
          if (!isNaN(releaseAmount) && releaseAmount > 0) {
            // 更新LP的锁定额度
            const newLockedQuota = Math.max(0, lp.lockedQuota - releaseAmount);
            const newAvailableQuota = lp.totalQuota - newLockedQuota;
            
            await lp.update({
              lockedQuota: newLockedQuota,
              availableQuota: newAvailableQuota
            });
            
            console.log(`已释放LP ${lp.walletAddress} 的锁定额度: ${releaseAmount}`);
          }
        }
      } catch (error) {
        console.error(`释放LP锁定额度时出错:`, error);
        await logPayPalError('release_locked_quota_webhook', error);
      }
    }
    
    // 将订单状态重置为created
    try {
      await paymentIntent.update({
        status: 'created',
        statusHistory: statusHistory,
        lpWalletAddress: null,
        lpId: null
      });
      console.log(`支付意向 ${paymentIntent.id} 状态已重置为created (由PayPal Webhook触发)`);
    } catch (error) {
      console.error(`更新支付意向状态失败:`, error);
      return;
    }
    
    // 更新任务池
    try {
      const taskPool = await TaskPool.findOne({
        where: { paymentIntentId: paymentIntent.id }
      });
      
      if (taskPool) {
        await taskPool.update({
          status: 'created',
          lpWalletAddress: null
        });
        console.log(`已更新任务池记录 ${taskPool.id}`);
      } else {
        await TaskPool.create({
          paymentIntentId: paymentIntent.id,
          amount: paymentIntent.amount,
          currency: paymentIntent.currency || 'USD',
          status: 'created',
          userWalletAddress: paymentIntent.userWalletAddress,
          platform: 'PayPal',
          createdAt: paymentIntent.createdAt,
          updatedAt: new Date(),
          expiresAt: paymentIntent.expiresAt,
          description: paymentIntent.description || 'PayPal Webhook取消的订单'
        });
        console.log(`已创建新的任务池记录`);
      }
    } catch (error) {
      console.error(`更新任务池失败:`, error);
      await logPayPalError('update_task_pool_webhook', error);
    }
    
    // 通过Socket.io通知相关方
    if (global.io) {
      console.log(`准备通过Socket.io发送通知...`);
      
      // 通知用户
      if (paymentIntent.userWalletAddress) {
        global.io.to(paymentIntent.userWalletAddress).emit('payment_cancelled', {
          paymentIntentId: paymentIntent.id,
          status: 'created',
          message: 'PayPal通知：支付已取消',
          timestamp: new Date().toISOString(),
          source: 'paypal_webhook'
        });
        console.log(`已向用户 ${paymentIntent.userWalletAddress} 发送取消通知`);
      }
      
      // 广播到所有LP客户端
      global.io.emit('task_pool_updated', {
        action: 'task_returned',
        paymentIntentId: paymentIntent.id,
        status: 'created',
        cancelled: true,
        source: 'paypal_webhook'
      });
      console.log(`已广播任务池更新通知`);
    } else {
      console.warn(`Socket.io实例不可用，无法发送实时通知`);
    }
    
    return { success: true, paymentIntentId: paymentIntent.id };
  } catch (error) {
    console.error('处理订单取消事件失败:', error);
    await logPayPalError('handle_order_cancelled', error);
    return { success: false, error: error.message };
  }
}

/**
 * 处理PayPal支付取消事件
 * @private
 */
async function handlePaymentCancelled(webhookEvent) {
  // 支付取消事件与订单取消事件处理逻辑类似
  try {
    console.log('调用订单取消处理函数处理支付取消事件');
    return await handleOrderCancelled(webhookEvent);
  } catch (error) {
    console.error('处理支付取消事件失败:', error);
    await logPayPalError('handle_payment_cancelled', error);
    return { success: false, error: error.message };
  }
}

// 导出所有API端点
module.exports = {
  // 连接PayPal账号
  connectLPPayPal: exports.connectLPPayPal,
  
  // 创建PayPal订单
  createPayPalOrder: exports.createPayPalOrder,
  
  // 捕获PayPal订单支付
  capturePayPalOrder: exports.capturePayPalOrder,
  
  // 获取配置
  getConfig: exports.getConfig,
  
  // 处理WebHook
  handleWebhook: exports.handleWebhook,
  
  // 获取商家信息
  getMerchantInfo: exports.getMerchantInfo,
  
  // 退款支付
  refundPayPalPayment: exports.refundPayPalPayment,
  
  // 获取退款状态
  getPayPalRefundStatus: exports.getPayPalRefundStatus,
  
  // 取消订单
  cancelOrder: exports.cancelOrder,

  // PayPal支付状态
  getPayPalStatus: exports.getPayPalStatus,

  // PayPal捕获验证
  verifyCapture: exports.verifyCapture,
  
  // 初始化自动修复功能
  initAutoFixScheduler,
  
  // 重置自动修复功能
  resetAutoFixScheduler,
  
  // 导出自动修复函数以便直接调用
  autoFixStuckProcessingOrders
}; 