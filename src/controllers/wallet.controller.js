const { ethers } = require('ethers');
const { Connection, PublicKey } = require('@solana/web3.js');
const { Token, TOKEN_PROGRAM_ID } = require('@solana/spl-token');

// Solana 网络配置
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const USDT_TOKEN_ADDRESS = process.env.USDT_TOKEN_ADDRESS || 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';

/**
 * 获取 Solana 钱包余额
 * @route GET /api/sol/wallet/balance
 * @access Public
 */
exports.getSolanaBalance = async (req, res) => {
  try {
    const { address } = req.query;
    
    if (!address) {
      return res.status(400).json({
        success: false,
        message: '缺少钱包地址参数'
      });
    }
    
    // 验证 Solana 地址格式
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      return res.status(400).json({
        success: false,
        message: '无效的 Solana 钱包地址格式'
      });
    }
    
    // 连接 Solana 网络
    const connection = new Connection(SOLANA_RPC_URL);
    
    // 获取原生 SOL 余额
    const publicKey = new PublicKey(address);
    const solBalance = await connection.getBalance(publicKey);
    
    // 获取 USDC 余额
    const tokenPublicKey = new PublicKey(USDT_TOKEN_ADDRESS);
    const tokenAccount = await connection.getTokenAccountsByOwner(publicKey, {
      mint: tokenPublicKey
    });
    
    let usdtBalance = 0;
    if (tokenAccount.value.length > 0) {
      const tokenAccountInfo = await connection.getTokenAccountBalance(tokenAccount.value[0].pubkey);
      usdtBalance = tokenAccountInfo.value.uiAmount || 0;
    }
    
    return res.status(200).json({
      success: true,
      data: {
        sol: solBalance / 1e9, // 转换为 SOL
        usdt: usdtBalance
      }
    });
    
  } catch (error) {
    console.error('获取 Solana 钱包余额失败:', error);
    return res.status(500).json({
      success: false,
      message: '获取 Solana 钱包余额失败',
      error: process.env.NODE_ENV === 'development' ? error.message : '服务器内部错误'
    });
  }
};

/**
 * 获取以太坊钱包余额
 * @route GET /api/eth/wallet/balance
 * @access Public
 */
exports.getEthereumBalance = async (req, res) => {
  try {
    const { address } = req.query;
    
    if (!address) {
      return res.status(400).json({
        success: false,
        message: '缺少钱包地址参数'
      });
    }
    
    // 验证以太坊地址格式
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({
        success: false,
        message: '无效的以太坊钱包地址格式'
      });
    }
    
    // 连接以太坊网络
    const provider = new ethers.providers.JsonRpcProvider(process.env.ETH_RPC_URL);
    
    // 获取 ETH 余额
    const ethBalance = await provider.getBalance(address);
    
    // 获取 USDT 余额
    const usdtContract = new ethers.Contract(
      process.env.USDT_TOKEN_ADDRESS,
      ['function balanceOf(address) view returns (uint256)'],
      provider
    );
    
    const usdtBalance = await usdtContract.balanceOf(address);
    
    return res.status(200).json({
      success: true,
      data: {
        eth: ethers.utils.formatEther(ethBalance),
        usdt: ethers.utils.formatUnits(usdtBalance, 6) // USDT 使用 6 位小数
      }
    });
    
  } catch (error) {
    console.error('获取以太坊钱包余额失败:', error);
    return res.status(500).json({
      success: false,
      message: '获取以太坊钱包余额失败',
      error: process.env.NODE_ENV === 'development' ? error.message : '服务器内部错误'
    });
  }
}; 
