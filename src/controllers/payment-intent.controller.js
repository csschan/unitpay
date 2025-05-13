const { PaymentIntent } = require('../models');
const PaymentService = require('../services/payment.service');
const { sequelize } = require('../config/database');

class PaymentIntentController {
  constructor() {
    this.paymentService = new PaymentService();
  }

  // 创建支付意图
  async create(req, res) {
    try {
      const {
        walletAddress,
        qrContent,
        platform,
        amount,
        description,
        paypalEmail,
        lpAddress,
        feeRate,
        networkType
      } = req.body;

      // 验证必填字段
      if (!walletAddress || !qrContent || !platform || !amount || !lpAddress || !feeRate || !networkType) {
        return res.status(400).json({
          success: false,
          message: '缺少必要参数'
        });
      }

      // 验证钱包地址格式
      if (networkType === 'solana' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) {
        return res.status(400).json({
          success: false,
          message: '无效的钱包地址格式'
        });
      }

      // 创建支付意图
      const paymentIntent = await PaymentIntent.create({
        walletAddress,
        qrContent,
        platform,
        amount,
        description,
        paypalEmail,
        lpAddress,
        feeRate,
        networkType,
        status: 'created'
      });

      res.status(201).json({
        success: true,
        message: '支付意图创建成功',
        data: {
          paymentIntent
        }
      });
    } catch (error) {
      console.error('创建支付意图失败:', error);
      res.status(500).json({
        success: false,
        message: '创建支付意图失败: ' + error.message
      });
    }
  }

  // 获取用户的支付意图列表
  async getUserPaymentIntents(req, res) {
    try {
      const { walletAddress } = req.params;

      if (!walletAddress) {
        return res.status(400).json({
          success: false,
          message: '缺少钱包地址'
        });
      }

      // 使用原始 SQL 查询避免 blockchainPaymentId 字段问题
      const [paymentIntents] = await sequelize.query(`
        SELECT id, amount, currency, description, platform, 
               merchantInfo, userWalletAddress, merchant_paypal_email as merchantPaypalEmail, 
               userId, lpWalletAddress, lpId, status, 
               escrowStatus, statusHistory, paymentProof, 
               settlementTxHash, errorDetails, processingDetails, 
               lockTime, releaseTime, withdrawalTime, network, 
               platformFee, isDisputed, expiresAt,
               createdAt, updatedAt
        FROM payment_intents
        WHERE userWalletAddress = ?
        ORDER BY createdAt DESC
      `, {
        replacements: [walletAddress]
      });

      res.json({
        success: true,
        data: {
          paymentIntents
        }
      });
    } catch (error) {
      console.error('获取用户支付意图列表失败:', error);
      res.status(500).json({
        success: false,
        message: '获取支付意图列表失败: ' + error.message
      });
    }
  }

  // 更新支付意图状态（锁定）
  async updateLockStatus(req, res) {
    try {
      const { id } = req.params;
      const { transactionHash, paymentSeed } = req.body;

      const paymentIntent = await PaymentIntent.findByPk(id);
      if (!paymentIntent) {
        return res.status(404).json({
          success: false,
          message: '支付意图不存在'
        });
      }

      await paymentIntent.update({
        status: 'locked',
        transactionHash,
        paymentSeed,
        lockTime: new Date()
      });

      res.json({
        success: true,
        message: '支付意图状态已更新',
        data: {
          paymentIntent
        }
      });
    } catch (error) {
      console.error('更新支付意图状态失败:', error);
      res.status(500).json({
        success: false,
        message: '更新支付意图状态失败: ' + error.message
      });
    }
  }

  // 获取单个支付意图
  async getById(req, res) {
    try {
      const { id } = req.params;
      const paymentIntent = await PaymentIntent.findByPk(id);

      if (!paymentIntent) {
        return res.status(404).json({
          success: false,
          message: '支付意图不存在'
        });
      }

      res.json({
        success: true,
        data: {
          paymentIntent
        }
      });
    } catch (error) {
      console.error('获取支付意图失败:', error);
      res.status(500).json({
        success: false,
        message: '获取支付意图失败: ' + error.message
      });
    }
  }
}

module.exports = new PaymentIntentController(); 