/**
 * 合约控制器
 * 提供合约相关的API
 */

const { ethereum: ethereumContractService, solana: solanaContractService } = require('../services/contract.service');
const { PaymentIntent } = require('../models');
const { contracts } = require('../config/contracts.config');
const networkConfig = require('../../public/js/network.config');
const { validateUSDTContract } = require('../utils/contract.validator');
const { ethers } = require('ethers');

const contractController = {
    // 获取USDT授权额度
    async getAllowance(req, res) {
        try {
            const { address } = req.params;
            const allowance = await ethereumContractService.checkAllowance(address);
            res.json({ allowance: allowance.toString() });
        } catch (error) {
            console.error('获取授权额度失败:', error);
            res.status(500).json({ error: '获取授权额度失败' });
        }
    },

    // 处理直接支付
    async handleDirectPayment(req, res) {
        try {
            const { paymentIntentId, userAddress, lpAddress, amount } = req.body;
            
            // 验证支付意向
            const paymentIntent = await PaymentIntent.findByPk(paymentIntentId);
            if (!paymentIntent) {
                return res.status(404).json({ error: '支付意向不存在' });
            }

            // 调用合约服务
            const tx = await ethereumContractService.handleDirectPayment(
                paymentIntentId,
                userAddress,
                lpAddress,
                amount
            );

            res.json({
                success: true,
                txHash: tx.hash,
                message: '支付交易已提交'
            });
        } catch (error) {
            console.error('直接支付失败:', error);
            res.status(500).json({ error: '直接支付失败' });
        }
    },

    // 获取合约信息
    async getContractInfo(req, res) {
        try {
            const networkType = req.networkType || 'ethereum';
            let info;

            if (networkType === 'ethereum') {
                await ethereumContractService.ensureInitialized();
                info = {
                    network: 'ethereum',
                    contractAddress: ethereumContractService.contract.address,
                    usdtAddress: ethereumContractService.usdtContract.address,
                    escrowAddress: ethereumContractService.escrowContract.address
                };
            } else {
                await solanaContractService.ensureInitialized();
                info = {
                    network: 'solana',
                    rpcUrl: process.env.SOLANA_RPC_URL
                };
            }

            res.json({
                success: true,
                data: info
            });
        } catch (error) {
            console.error('获取合约信息失败:', error);
            res.status(500).json({
                success: false,
                message: '获取合约信息失败',
                error: error.message
            });
        }
    },

    // 获取结算合约信息
    async getSettlementContractInfo(req, res) {
        try {
            return res.json({
                success: true,
                data: {
                    address: process.env.SETTLEMENT_CONTRACT_ADDRESS || '0x0',
                    network: process.env.ETH_NETWORK || 'goerli',
                    deployedAt: '2025-04-01T00:00:00Z',
                    version: '1.0.0'
                }
            });
        } catch (error) {
            console.error('获取结算合约信息失败:', error);
            return res.status(500).json({
                success: false,
                message: '获取结算合约信息失败',
                error: error.message
            });
        }
    },

    // 获取托管合约信息
    async getEscrowContractInfo(req, res) {
        try {
            return res.json({
                success: true,
                data: {
                    address: process.env.ESCROW_CONTRACT_ADDRESS || '0x0',
                    network: process.env.ETH_NETWORK || 'goerli',
                    deployedAt: '2025-04-01T00:00:00Z',
                    version: '1.0.0'
                }
            });
        } catch (error) {
            console.error('获取托管合约信息失败:', error);
            return res.status(500).json({
                success: false,
                message: '获取托管合约信息失败',
                error: error.message
            });
        }
    },

    // 处理托管支付
    async handleEscrowPayment(req, res) {
        try {
            const { paymentIntentId, userAddress, lpAddress, amount } = req.body;
            
            // 验证支付意向
            const paymentIntent = await PaymentIntent.findByPk(paymentIntentId);
            if (!paymentIntent) {
                return res.status(404).json({ error: '支付意向不存在' });
            }

            // 调用合约服务
            const tx = await ethereumContractService.handleEscrowPayment(
                paymentIntentId,
                userAddress,
                lpAddress,
                amount
            );

            res.json({
                success: true,
                txHash: tx.hash,
                message: '托管支付已锁定'
            });
        } catch (error) {
            console.error('托管支付失败:', error);
            res.status(500).json({ error: '托管支付失败' });
        }
    },

    // 确认托管支付
    async confirmEscrowPayment(req, res) {
        try {
            const { paymentIntentId, userAddress } = req.body;
            
            // 验证支付意向
            const paymentIntent = await PaymentIntent.findByPk(paymentIntentId);
            if (!paymentIntent) {
                return res.status(404).json({ error: '支付意向不存在' });
            }

            if (paymentIntent.escrowStatus !== 'LOCKED') {
                return res.status(400).json({ error: '支付状态不正确' });
            }

            // 调用合约服务
            const tx = await ethereumContractService.confirmEscrowPayment(
                paymentIntentId,
                userAddress
            );

            res.json({
                success: true,
                txHash: tx.hash,
                message: '托管支付已确认'
            });
        } catch (error) {
            console.error('确认托管支付失败:', error);
            res.status(500).json({ error: '确认托管支付失败' });
        }
    },

    // 处理LP提现
    async handleWithdrawal(req, res) {
        try {
            const { paymentIntentId, lpAddress } = req.body;
            
            // 验证支付意向
            const paymentIntent = await PaymentIntent.findByPk(paymentIntentId);
            if (!paymentIntent) {
                return res.status(404).json({ error: '支付意向不存在' });
            }

            if (paymentIntent.escrowStatus !== 'CONFIRMED') {
                return res.status(400).json({ error: '支付状态不正确' });
            }

            // 检查是否到达提现时间
            if (new Date() < new Date(paymentIntent.withdrawalTime)) {
                return res.status(400).json({ error: '尚未到达提现时间' });
            }

            // 调用合约服务
            const tx = await ethereumContractService.handleWithdrawal(
                paymentIntentId,
                lpAddress
            );

            res.json({
                success: true,
                txHash: tx.hash,
                message: '提现交易已提交'
            });
        } catch (error) {
            console.error('提现失败:', error);
            res.status(500).json({ error: '提现失败' });
        }
    },

    // 获取交易状态
    async getTransactionStatus(req, res) {
        try {
            const { paymentIntentId } = req.params;
            
            const paymentIntent = await PaymentIntent.findByPk(paymentIntentId);
            if (!paymentIntent) {
                return res.status(404).json({ error: '支付意向不存在' });
            }

            // 同步交易状态
            await ethereumContractService.syncTransactionStatus(paymentIntentId);

            // 返回最新状态
            res.json({
                status: paymentIntent.status,
                escrowStatus: paymentIntent.escrowStatus,
                txHash: paymentIntent.txHash
            });
        } catch (error) {
            console.error('获取交易状态失败:', error);
            res.status(500).json({ error: '获取交易状态失败' });
        }
    },

    // 获取合约余额
    async getContractBalance(req, res) {
        try {
            const networkType = req.networkType || 'ethereum';
            let balance;

            if (networkType === 'ethereum') {
                await ethereumContractService.ensureInitialized();
                const usdtBalance = await ethereumContractService.usdtContract.balanceOf(
                    ethereumContractService.contract.address
                );
                balance = usdtBalance.toString();
            } else {
                await solanaContractService.ensureInitialized();
                // TODO: 实现 Solana 余额查询
                balance = '0';
            }

            res.json({
                success: true,
                data: { balance }
            });
        } catch (error) {
            console.error('获取合约余额失败:', error);
            res.status(500).json({
                success: false,
                message: '获取合约余额失败',
                error: error.message
            });
        }
    },

    // 启动合约事件监听
    async startEventListener(req, res) {
        try {
            return res.json({
                success: true,
                message: '合约事件监听已启动'
            });
        } catch (error) {
            console.error('启动合约事件监听失败:', error);
            return res.status(500).json({
                success: false,
                message: '启动合约事件监听失败',
                error: error.message
            });
        }
    },

    // 停止合约事件监听
    async stopEventListener(req, res) {
        try {
            return res.json({
                success: true,
                message: '合约事件监听已停止'
            });
        } catch (error) {
            console.error('停止合约事件监听失败:', error);
            return res.status(500).json({
                success: false,
                message: '停止合约事件监听失败',
                error: error.message
            });
        }
    },

    // 获取合约事件历史
    async getEventHistory(req, res) {
        try {
            return res.json({
                success: true,
                data: {
                    events: []
                }
            });
        } catch (error) {
            console.error('获取合约事件历史失败:', error);
            return res.status(500).json({
                success: false,
                message: '获取合约事件历史失败',
                error: error.message
            });
        }
    }
};

module.exports = contractController;