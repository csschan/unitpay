/**
 * Solana集成脚本
 * 实现Solana网络和Phantom钱包支持
 */

// 导入 Solana web3.js
const web3 = window.solanaWeb3;

// 智能合约相关常量（更新为新部署的 program_id）
const PROGRAM_ID = 'E85PHXXkTgf9YjzNM3Wh9xKysWNx6hJKbwc7y9EuGxBh';
const USDC_MINT = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

// Solana Web3 集成
const SOLANA_MAINNET = 'https://api.mainnet-beta.solana.com';
const SOLANA_TESTNET = 'https://api.testnet.solana.com';
const SOLANA_DEVNET = 'https://api.devnet.solana.com';

// 全局变量
let selectedNetwork = 'ethereum'; // 默认选择以太坊网络
let walletManager = null;
let solAddress = '';
let isSolanaConnected = false;

// Mock mode flag for Solana front-end
const isMockSolana = window.SOLANA_MODE === 'mock';

// DOM元素
const networkOptions = document.querySelectorAll('.network-option');
const connectPhantomBtn = document.getElementById('connect-phantom-btn');
const networkBadge = document.getElementById('network-badge');
const ethBalanceContainer = document.getElementById('eth-balance-container');
const solBalanceContainer = document.getElementById('sol-balance-container');
const solBalance = document.getElementById('sol-balance');
const refreshSolBalanceBtn = document.getElementById('refresh-sol-balance-btn');
const confirmCurrency = document.getElementById('confirm-currency');
// USDC余额相关元素
const solUsdcContainer = document.getElementById('sol-usdc-container');
const usdcBalance = document.getElementById('usdc-balance');
const refreshUsdcBalanceBtn = document.getElementById('refresh-usdc-balance-btn');
// 使用外部已定义的DOM元素
// walletConnectSection, userDashboard, walletAddressSpan 在app.js中已定义

// 创建全局接口对象
window.solanaIntegration = {
  // 钱包相关
  connectPhantomWallet,
  disconnectWallet: disconnectCurrentWallet,
  isSolanaConnected: () => isSolanaConnected,
  getSolAddress: () => {
    if (isMockSolana) {
      // In mock mode, bypass validation
      return solAddress || null;
    }
    // 简单验证并返回存储的Solana地址
    if (!solAddress) return null;
    // 确保地址不包含空格和特殊字符
    const cleanAddress = solAddress.trim();
    // 使用相同的验证逻辑
    const solanaAddressRegex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    if (!solanaAddressRegex.test(cleanAddress)) {
      console.error("Solana钱包地址格式不符合要求:", cleanAddress);
      return null;
    }
    // 如果有Solana PublicKey类可用，进行额外验证
    try {
      if (window.solana?.PublicKey) {
        const pubKey = new window.solana.PublicKey(cleanAddress);
        if (pubKey.toBase58() !== cleanAddress) {
          console.error("Solana钱包地址验证失败");
          return null;
        }
      }
    } catch (err) {
      console.error("Solana PublicKey验证失败:", err);
      return null;
    }
    return cleanAddress;
  },
  
  // 验证Solana地址格式
  validateAddress: (address) => {
    if (!address || typeof address !== 'string') {
      console.error("Solana地址验证失败: 地址为空或类型错误");
      return false;
    }
    
    // 去除空格
    const cleanAddress = address.trim();
    
    // 基本格式验证
    const solanaAddressRegex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    if (!solanaAddressRegex.test(cleanAddress)) {
      console.error("Solana地址验证失败: 不符合格式要求", cleanAddress);
      return false;
    }
    
    // 如果有Solana PublicKey类可用，进行额外验证
    try {
      if (window.solana?.PublicKey) {
        const pubKey = new window.solana.PublicKey(cleanAddress);
        return pubKey.toBase58() === cleanAddress;
      }
    } catch (err) {
      console.error("Solana PublicKey验证失败:", err);
      return false;
    }
    
    // 如果没有PublicKey类，只返回正则验证结果
    return true;
  },
  
  // 余额相关
  refreshSolanaBalance,
  refreshUsdcBalance,
  // USDC账户相关
  getUsdcAccount,
  createTokenAccount,
  // 交易签名
  signTransaction,
  
  // 任务相关
  loadUserPaymentTasks,
  updateTasksList: function(tasks) {
    if (!Array.isArray(tasks)) {
      console.error('updateTasksList: tasks不是数组类型');
      return;
    }
    
    console.log('使用solanaIntegration.updateTasksList直接更新UI，避免递归调用');
    
    // 获取页面上的任务列表和无任务消息元素
    const paymentTasksList = document.getElementById('payment-tasks-list');
    const noTasksMessage = document.getElementById('no-tasks-message');
    
    if (!paymentTasksList) {
      return; // 一些页面可能不需要显示任务列表
    }
    
    // 清空任务列表
    paymentTasksList.innerHTML = '';
    
    if (!tasks || tasks.length === 0) {
      // 显示无任务消息
      if (noTasksMessage) {
        noTasksMessage.classList.remove('d-none');
        noTasksMessage.textContent = '当前没有支付任务';
      }
      console.log('当前没有支付任务');
    } else {
      // 隐藏无任务消息
      if (noTasksMessage) {
        noTasksMessage.classList.add('d-none');
      }
      
      // 添加任务到列表
      console.log(`准备添加 ${tasks.length} 个任务到UI`);
      tasks.forEach(task => {
        console.log('DEBUG solanaIntegration Task keys:', Object.keys(task));
        console.log('DEBUG solanaIntegration Task id:', task.id || task._id, 'lpAddress:', task.lpAddress, 'lpWalletAddress:', task.lpWalletAddress);
        try {
          if (typeof window.addTaskToList === 'function') {
            window.addTaskToList(task);
            console.log('成功添加任务:', task.id || task._id);
          } else {
            console.error('window.addTaskToList函数不存在，使用简易方式添加任务');
            // 简易方式添加任务
            const taskElement = document.createElement('div');
            taskElement.className = 'list-group-item';
            taskElement.innerHTML = `
              <div class="d-flex w-100 justify-content-between">
                <h5 class="mb-1">${task.platform || '未知平台'} 支付</h5>
                <small>${new Date(task.createdAt || Date.now()).toLocaleString()}</small>
              </div>
              <p class="mb-1">金额: ${task.amount || '0'} ${task.currency || 'USDT'}</p>
              <p class="mb-1">状态: ${task.status || '未知'}</p>
              <p class="mb-1">ID: ${task.id || task._id || '未知'}</p>
            `;
            paymentTasksList.appendChild(taskElement);
          }
        } catch (err) {
          console.error('添加任务到UI时出错:', err);
        }
      });
      
      console.log(`已加载 ${tasks.length} 个支付任务到UI`);
    }
  },
  
  // 网络选择
  selectNetwork,
  
  // 工具函数
  shortenAddress
};

// 初始化
document.addEventListener('DOMContentLoaded', function() {
  console.log('初始化Solana集成...');
  initWalletManager();
  setupNetworkSelector();
  setupPhantomWalletButton();
  setupSolanaBalanceRefresh();
  setupUsdcBalanceRefresh();
  
  // 检查URL参数是否指定网络
  const urlParams = new URLSearchParams(window.location.search);
  const networkParam = urlParams.get('network');
  
  // 如果URL中指定了网络，则切换到该网络
  if (networkParam === 'solana') {
    selectNetwork('solana');
  } else {
    // 否则保持默认的以太坊网络，但确保UI正确
    updateNetworkUI('ethereum');
  }
});

/**
 * 初始化钱包管理器
 */
function initWalletManager() {
  try {
    // 检查是否有 Phantom 钱包
    if (!window.solana || !window.solana.isPhantom) {
      console.warn('未检测到 Phantom 钱包');
      return false;
    }
    
    // 设置事件监听器
    window.solana.on('connect', handleWalletConnected);
    window.solana.on('disconnect', handleWalletDisconnected);
    window.solana.on('accountChanged', handleWalletConnected);
    
    console.log('钱包管理器初始化成功');
    return true;
  } catch (error) {
    console.error('初始化钱包管理器失败:', error);
    return false;
  }
}

/**
 * 设置网络选择器
 */
function setupNetworkSelector() {
  networkOptions.forEach(option => {
    option.addEventListener('click', () => {
      const network = option.getAttribute('data-network');
      if (network) {
        selectNetwork(network);
      }
    });
  });
}

/**
 * 设置Phantom钱包按钮
 */
function setupPhantomWalletButton() {
  if (connectPhantomBtn) {
    connectPhantomBtn.addEventListener('click', connectPhantomWallet);
  }
}

/**
 * 设置SOL余额刷新按钮
 */
function setupSolanaBalanceRefresh() {
  if (refreshSolBalanceBtn) {
    refreshSolBalanceBtn.addEventListener('click', refreshSolanaBalance);
  }
}

/**
 * 设置USDC余额刷新按钮
 */
function setupUsdcBalanceRefresh() {
  if (refreshUsdcBalanceBtn) {
    refreshUsdcBalanceBtn.addEventListener('click', refreshUsdcBalance);
  }
}

/**
 * 更新网络UI
 */
function updateNetworkUI(network) {
  // 更新网络选择器高亮
  networkOptions.forEach(option => {
    const opt = option.getAttribute('data-network');
    if (opt === network) option.classList.add('active');
    else option.classList.remove('active');
  });
  
  // 根据网络显示对应的连接按钮
  const ethBtn = document.getElementById('connect-wallet-btn');
  const phBtn  = document.getElementById('connect-phantom-btn');
  if (ethBtn) ethBtn.style.display = network === 'ethereum' ? 'block' : 'none';
  if (phBtn)  phBtn.style.display  = network === 'solana'   ? 'block' : 'none';
}

/**
 * 选择网络
 */
function selectNetwork(network) {
  if (network === selectedNetwork) return;
  console.log('切换网络:', network);
  selectedNetwork = network;
  
  // 更新本地连接按钮、选择器等UI
  updateNetworkUI(network);
  
  // 通知主脚本网络切换，并带上连接状态
  window.dispatchEvent(new CustomEvent('networkChanged', {
    detail: { network: network, isConnected: isSolanaConnected }
  }));
  
  // 更新URL参数
  const url = new URL(window.location.href);
  url.searchParams.set('network', network);
  window.history.replaceState({}, '', url);
}

/**
 * 断开当前钱包连接
 */
async function disconnectCurrentWallet() {
  try {
    if (!window.solana) {
      throw new Error('未找到Solana对象');
    }
    
    await window.solana.disconnect();
    solAddress = '';
    isSolanaConnected = false;
    
    // 更新UI
    if (connectPhantomBtn) {
      connectPhantomBtn.textContent = '连接 Phantom';
      connectPhantomBtn.disabled = false;
    }
    
    // 清空余额显示
    if (solBalance) {
      solBalance.textContent = '0.00';
    }
    if (usdcBalance) {
      usdcBalance.textContent = '0.00';
    }
    
    console.log('钱包已断开连接');
  } catch (error) {
    console.error('断开钱包连接失败:', error);
    showErrorMessage('断开钱包失败: ' + error.message);
  }
}

/**
 * 连接Phantom钱包
 */
async function connectPhantomWallet() {
  try {
    if (!web3) throw new Error('Solana Web3 未加载');
    if (!window.solana) throw new Error('Phantom 钱包未安装');
    if (!window.solana.isPhantom) {
      throw new Error('未检测到Phantom钱包');
    }
    // 请求连接
    const resp = await window.solana.connect();
    // 更新状态
    solAddress = resp.publicKey.toString();
    isSolanaConnected = true;
    // 本地标记并更新按钮区域
    selectNetwork('solana');
    // 立即调用主应用的updateWalletUI以更新网络徽章和余额面板
    if (typeof window.updateWalletUI === 'function') {
      window.updateWalletUI({ address: solAddress, chainType: 'solana', isConnected: true });
    }
    // 更新按钮状态
    if (connectPhantomBtn) {
      connectPhantomBtn.textContent = '已连接 Phantom';
      connectPhantomBtn.disabled = true;
    }
    // 刷新余额（忽略错误以防止登录中断）
    await Promise.all([
      refreshSolanaBalance().catch(error => {
        console.error('刷新SOL余额失败（登录时忽略）:', error);
      }),
      refreshUsdcBalance().catch(error => {
        console.error('刷新USDC余额失败（登录时忽略）:', error);
      })
    ]);
    // 如果存在任务列表元素，则加载任务
    if (document.getElementById('payment-tasks-list')) {
      loadUserPaymentTasks().catch(error => {
        console.error('加载用户支付任务失败（连接后修正）:', error);
      });
    }
    return solAddress;
  } catch (error) {
    console.error('连接Phantom钱包失败:', error);
    showErrorMessage('连接钱包失败: ' + error.message);
    return null;
  }
}

/**
 * 处理钱包连接事件
 */
function handleWalletConnected(publicKey) {
  try {
    console.log('钱包已连接:', publicKey.toString());
    solAddress = publicKey.toString();
    isSolanaConnected = true;
    
    // 更新UI
    if (connectPhantomBtn) {
      connectPhantomBtn.textContent = '已连接 Phantom';
      connectPhantomBtn.disabled = true;
    }
    
    // 刷新余额
    Promise.all([
      refreshSolanaBalance(),
      refreshUsdcBalance()
    ]).catch(error => {
      console.error('刷新余额失败:', error);
    });
    
    // 更新钱包地址显示
    const walletAddressSpan = document.getElementById('wallet-address');
    if (walletAddressSpan) {
      walletAddressSpan.textContent = shortenAddress(publicKey.toString());
    }
    
    // 更新UI显示
    const walletConnectSection = document.getElementById('wallet-connect-section');
    const userDashboard = document.getElementById('user-dashboard');
    
    if (walletConnectSection) {
      walletConnectSection.classList.add('d-none');
    }
    if (userDashboard) {
      userDashboard.classList.remove('d-none');
    }
    
    // 加载用户任务
    loadUserPaymentTasks().catch(error => {
      console.error('加载用户任务失败:', error);
    });
  } catch (error) {
    console.error('处理钱包连接失败:', error);
  }
}

/**
 * 处理钱包断开连接事件
 */
function handleWalletDisconnected() {
  try {
    console.log('钱包已断开连接');
    solAddress = '';
    isSolanaConnected = false;
    
    // 更新UI
    if (connectPhantomBtn) {
      connectPhantomBtn.textContent = '连接 Phantom';
      connectPhantomBtn.disabled = false;
    }
    
    // 清空余额显示
    if (solBalance) {
      solBalance.textContent = '0.00';
    }
    if (usdcBalance) {
      usdcBalance.textContent = '0.00';
    }
    
    // 更新钱包地址显示
    const walletAddressSpan = document.getElementById('wallet-address');
    if (walletAddressSpan) {
      walletAddressSpan.textContent = '未连接';
    }
    
    // 更新UI显示
    const walletConnectSection = document.getElementById('wallet-connect-section');
    const userDashboard = document.getElementById('user-dashboard');
    
    if (walletConnectSection) {
      walletConnectSection.classList.remove('d-none');
    }
    if (userDashboard) {
      userDashboard.classList.add('d-none');
    }
  } catch (error) {
    console.error('处理钱包断开连接失败:', error);
  }
}

/**
 * 刷新SOL余额
 */
async function refreshSolanaBalance() {
  try {
    if (!isSolanaConnected || !solAddress) {
      if (solBalance) {
        solBalance.textContent = '0.00';
      }
      return '0.00';
    }
    
    // Use custom RPC URL if configured, otherwise default to cluster API
    const rpcUrl = (window.SOLANA_NETWORK_CONFIG && window.SOLANA_NETWORK_CONFIG.rpcUrl) || web3.clusterApiUrl('devnet');
    const connection = new web3.Connection(rpcUrl);
    
    // 获取余额
    const balance = await connection.getBalance(new web3.PublicKey(solAddress));
    const solValue = (balance / web3.LAMPORTS_PER_SOL).toFixed(4);
    
    // 更新UI
    if (solBalance) {
      solBalance.textContent = solValue;
    }
    
    return solValue;
  } catch (error) {
    console.error('获取SOL余额失败:', error);
    if (solBalance) {
      solBalance.textContent = '获取失败';
    }
    return '0.00';
  }
}

/**
 * 刷新USDC余额
 */
async function refreshUsdcBalance() {
  try {
    if (!isSolanaConnected || !solAddress) {
      if (usdcBalance) {
        usdcBalance.textContent = '0.00';
      }
      return '0.00';
    }
    
    // Use custom RPC URL if configured, otherwise default to cluster API
    const rpcUrl = (window.SOLANA_NETWORK_CONFIG && window.SOLANA_NETWORK_CONFIG.rpcUrl) || web3.clusterApiUrl('devnet');
    const connection = new web3.Connection(rpcUrl);
    
    // 获取USDC余额
    const balance = await queryUsdcBalanceLocally();
    
    // 更新UI
    if (usdcBalance) {
      usdcBalance.textContent = balance;
    }
    
    return balance;
  } catch (error) {
    console.error('获取USDC余额失败:', error);
    if (usdcBalance) {
      usdcBalance.textContent = '获取失败';
    }
    return '0.00';
  }
}

/**
 * 本地查询USDC余额
 */
async function queryUsdcBalanceLocally() {
  try {
    // Use custom RPC URL if configured, otherwise default to cluster API
    const rpcUrl = (window.SOLANA_NETWORK_CONFIG && window.SOLANA_NETWORK_CONFIG.rpcUrl) || web3.clusterApiUrl('devnet');
    const connection = new web3.Connection(rpcUrl);
    
    // USDC代币的Mint地址 (Devnet)
    const USDC_MINT = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';
    
    // 获取用户的代币账户
    const userAddress = new web3.PublicKey(solAddress);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(userAddress, {
      mint: new web3.PublicKey(USDC_MINT)
    });
    
    // 如果没有找到代币账户，返回0
    if (tokenAccounts.value.length === 0) {
      return '0.00';
    }
    
    // 获取余额
    const accountInfo = tokenAccounts.value[0].account.data.parsed.info;
    const balance = (accountInfo.tokenAmount.uiAmount || 0).toFixed(2);
    
    return balance;
  } catch (error) {
    console.error('本地查询USDC余额失败:', error);
    throw error;
  }
}

/**
 * 获取用户USDC代币账户地址
 */
async function getUsdcAccount() {
  try {
    if (!isSolanaConnected || !solAddress) {
      console.warn('未连接钱包，无法获取USDC账户');
      return null;
    }
    // Use custom RPC URL if configured, otherwise default to cluster API
    const rpcUrl = (window.SOLANA_NETWORK_CONFIG && window.SOLANA_NETWORK_CONFIG.rpcUrl) || web3.clusterApiUrl('devnet');
    const connection = new web3.Connection(rpcUrl);
    const ownerPubkey = new web3.PublicKey(solAddress);
    const mintPubkey = new web3.PublicKey(USDC_MINT);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(ownerPubkey, { mint: mintPubkey });
    if (tokenAccounts.value.length === 0) {
      return null;
    }
    return tokenAccounts.value[0].pubkey.toBase58();
  } catch (error) {
    console.error('获取USDC账户失败:', error);
    return null;
  }
}

/**
 * 创建代币账户（占位实现）
 */
async function createTokenAccount(mintAddress) {
  // 暂时返回功能未实现
  return { success: false, error: '创建代币账户功能暂未实现' };
}

/**
 * 使用 Phantom 钱包签名交易
 * @param {Buffer} rawTx - 解码后的交易字节
 * @returns {string|null} - base58 编码的已签名交易或 null
 */
async function signTransaction(rawTx) {
  if (isMockSolana) {
    console.log('Solana mock 模式，跳过签名，返回模拟签名');
    // 返回合法的 base58 字符串
    return '11111111111111111111111111111111';
  }
  try {
    if (!window.solana || typeof window.solana.signTransaction !== 'function') {
      console.error('Phantom 钱包签名函数不存在');
      return null;
    }
    // 构造 Transaction 对象并通过钱包签名
    const transaction = web3.Transaction.from(rawTx);
    const signed = await window.solana.signTransaction(transaction);
    const serialized = signed.serialize();
    // 返回 base58 编码的已签名交易
    return bs58.encode(serialized);
  } catch (error) {
    console.error('signTransaction 失败:', error);
    return null;
  }
}

/**
 * 缩短地址显示
 */
function shortenAddress(address) {
  if (!address) return '';
  return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
}

/**
 * 显示错误消息
 */
function showErrorMessage(message) {
  try {
    // 如果有全局的错误提示函数，使用它
    if (typeof window.showError === 'function') {
      window.showError(message);
    } else {
      // 否则使用alert
      alert(message);
    }
  } catch (error) {
    console.error('显示错误消息失败:', error);
    alert(message);
  }
}

/**
 * 加载用户支付任务
 */
async function loadUserPaymentTasks() {
  try {
    if (!solAddress) {
      console.warn('未连接钱包，无法加载任务');
      window.solanaIntegration.updateTasksList([]);
      return;
    }
    console.log('加载用户支付任务...');
    // 获取任务列表
    const response = await fetch(`/api/payment-intents/user/${solAddress}`);
    if (!response.ok) {
      throw new Error('获取支付任务失败');
    }
    const data = await response.json();
    console.log('DEBUG solanaIntegration loadUserPaymentTasks raw data:', data.data.paymentIntents);
    if (!data.success) {
      throw new Error(data.message || '获取支付任务失败');
    }
    // 更新UI
    window.solanaIntegration.updateTasksList(data.data.paymentIntents);
    console.log('支付任务加载完成');
  } catch (error) {
    console.error('加载用户支付任务失败:', error);
    // 更新为空列表，避免页面卡住
    window.solanaIntegration.updateTasksList([]);
  }
}