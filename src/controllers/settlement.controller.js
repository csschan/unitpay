const { PaymentIntent, LP } = require('../models/mysql');
const SettlementService = require('../services/settlement.service');

/**
 * 手动开始结算
 * @route POST /api/settlement/start
 * @access Public
 */
exports.startSettlement = async (req, res) => {
  try {
    const { paymentIntentId, lpWalletAddress } = req.body;
    
    if (!paymentIntentId) {
      return res.status(400).json({
        success: false,
        message: '缺少支付意图ID'
      });
    }
    
    // 查找支付意图
    const paymentIntent = await PaymentIntent.findByPk(paymentIntentId);
    if (!paymentIntent) {
      return res.status(404).json({
        success: false,
        message: '支付意图不存在'
      });
    }
    
    // 验证LP权限
    if (lpWalletAddress && paymentIntent.lpWalletAddress !== lpWalletAddress) {
      return res.status(403).json({
        success: false,
        message: '无权启动此支付意图的结算'
      });
    }
    
    // 检查状态是否为已确认（confirmed或user_confirmed）
    if (paymentIntent.status !== 'confirmed' && paymentIntent.status !== 'user_confirmed') {
      return res.status(400).json({
        success: false,
        message: `支付意图当前状态为${paymentIntent.status}，只有confirmed或user_confirmed状态可以结算`
      });
    }
    
    // 添加到结算队列
    if (req.settlementQueue) {
      req.settlementQueue.add({
        paymentIntentId: paymentIntent.id,
        amount: paymentIntent.amount,
        userWalletAddress: paymentIntent.userWalletAddress,
        lpWalletAddress: paymentIntent.lpWalletAddress
      });
      
      console.log(`支付意图 ${paymentIntent.id} 已添加到结算队列`);
      
      return res.status(200).json({
        success: true,
        message: '支付意图已添加到结算队列',
        data: {
          paymentIntentId: paymentIntent.id
        }
      });
    } else {
      return res.status(500).json({
        success: false,
        message: '结算队列未初始化'
      });
    }
  } catch (error) {
    console.error('启动结算失败:', error);
    return res.status(500).json({
      success: false,
      message: '启动结算失败: ' + error.message
    });
  }
};

/**
 * 获取结算状态
 * @route GET /api/settlement/:id/status
 * @access Public
 */
exports.getSettlementStatus = async (req, res) => {
  try {
    const { id } = req.params;
    
    const paymentIntent = await PaymentIntent.findByPk(id);
    if (!paymentIntent) {
      return res.status(404).json({
        success: false,
        message: '支付意图不存在'
      });
    }
    
    return res.status(200).json({
      success: true,
      data: {
        paymentIntentId: paymentIntent.id,
        status: paymentIntent.status,
        settlementTxHash: paymentIntent.settlementTxHash
      }
    });
  } catch (error) {
    console.error('获取结算状态失败:', error);
    return res.status(500).json({
      success: false,
      message: '获取结算状态失败: ' + error.message
    });
  }
}; 