/**
 * unitpay LP前端应用
 * 实现LP注册、额度管理和接单功能
 */

// 全局变量
const API_BASE_URL = window.CONFIG.API_BASE_URL;  // 使用配置中的API基础URL
let provider;
let signer;
let walletAddress;
let currentWallet; // 添加currentWallet定义
let isWalletConnected = false;
let currentLP = null;
let currentTaskTab = 'created';
let lastRefreshTime = 0;
let socket;
let taskList = []; // 确保初始化为空数组而不是undefined
let paidAmount = 0; // 已支付额度
let DEBUG = true; // 开启调试模式，输出详细日志
const REFRESH_INTERVAL = 30000; // 30秒刷新一次
let refreshIntervalId = null;
let transactionHistory = [];
let usdtBalance = '0.00';
// 添加缓存变量
let blockExplorerUrl = null;
// 添加分页相关的全局变量
let currentPage = 1;
const itemsPerPage = 8;
// 定义合约服务
let contractService = null;
let currentNetwork = null; // 添加当前网络标识

// Toast 通知函数
function showToast(message, type = 'info') {
  // 创建 toast 容器（如果不存在）
  let toastContainer = document.getElementById('toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    toastContainer.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 9999;
    `;
    document.body.appendChild(toastContainer);
  }

  // 创建新的 toast 元素
  const toast = document.createElement('div');
  toast.style.cssText = `
    min-width: 250px;
    margin-bottom: 10px;
    padding: 15px;
    border-radius: 4px;
    font-size: 14px;
    opacity: 0;
    transition: opacity 0.3s ease-in;
    color: white;
    background-color: ${type === 'error' ? '#dc3545' : type === 'success' ? '#28a745' : '#17a2b8'};
  `;
  toast.textContent = message;

  // 添加到容器
  toastContainer.appendChild(toast);

  // 触发动画
  setTimeout(() => {
    toast.style.opacity = '1';
  }, 10);

  // 3秒后移除
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => {
      toastContainer.removeChild(toast);
      if (toastContainer.children.length === 0) {
        document.body.removeChild(toastContainer);
      }
    }, 300);
  }, 3000);
}

// 自定义日志函数，仅在DEBUG为true时输出
function log(...args) {
  if (DEBUG) {
    console.log(...args);
  }
}

function logError(...args) {
  if (DEBUG) {
    console.error(...args);
  } else {
    // 非调试模式下也保留错误关键信息，但不包含详细堆栈
    const message = args.map(arg => {
      if (arg instanceof Error) {
        return arg.message;
      }
      if (typeof arg === 'object') {
        return 'Error object';
      }
      return arg;
    }).join(' ');
    console.error('Error occurred:', message);
  }
}

function logWarn(...args) {
  if (DEBUG) {
    console.warn(...args);
  }
}

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  try {
    // 初始化事件监听器
    initEventListeners();

    // 初始化合约服务（如果已加载）
    if (typeof window.contractService !== 'undefined') {
      contractService = window.contractService;
    } else if (typeof ContractService !== 'undefined') {
      contractService = new ContractService();
    }

    // 检查钱包连接状态
    await checkWalletConnection();
    
    // 初始化合约服务
    if (isWalletConnected && walletAddress && contractService) {
      try {
        if (typeof contractService.initWeb3 === 'function') {
          await contractService.initWeb3();
        }
        if (typeof contractService.connectWallet === 'function') {
          await contractService.connectWallet();
        }
        console.log('合约服务初始化成功');
      } catch (error) {
        console.error('合约服务初始化失败:', error);
        showToast('合约服务初始化失败，部分功能可能无法使用', 'error');
      }
    } else if (isWalletConnected && walletAddress) {
      console.warn('合约服务未定义，跳过初始化');
    }
  } catch (error) {
    console.error('初始化失败:', error);
    showToast('系统初始化失败', 'error');
  }
});

// 初始化事件监听器
function initEventListeners() {
  log('初始化事件监听器');
  
  // 以太坊钱包连接按钮
  const connectEthWalletBtn = document.getElementById('connect-eth-wallet');
  if (connectEthWalletBtn) {
    connectEthWalletBtn.addEventListener('click', () => connectEthWallet());
  }
  
  // Solana 钱包连接按钮
  const connectSolanaWalletBtn = document.getElementById('connect-solana-wallet');
  if (connectSolanaWalletBtn) {
    connectSolanaWalletBtn.addEventListener('click', () => connectSolanaWallet());
  }
  
  // 连接钱包按钮
  const connectWalletBtn = document.getElementById('connect-wallet');
  if (connectWalletBtn) {
    connectWalletBtn.addEventListener('click', () => connectWallet());
  }
  
  // 注册表单提交
  const registerForm = document.getElementById('register-form');
  if (registerForm) {
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await registerLP();
    });
  }

  // 更新额度表单提交
  const updateQuotaForm = document.getElementById('update-quota-form');
  if (updateQuotaForm) {
    updateQuotaForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await updateQuota();
    });
  }

  // PayPal连接按钮
  const connectPayPalBtn = document.getElementById('connect-paypal');
  if (connectPayPalBtn) {
    connectPayPalBtn.addEventListener('click', async () => {
      await connectPayPal();
    });
  }

  // 任务池筛选器
  const platformFilter = document.getElementById('platform-filter');
  if (platformFilter) {
    platformFilter.addEventListener('change', () => loadTaskPool(currentTaskTab));
  }
  
  const amountFilter = document.getElementById('amount-filter');
  if (amountFilter) {
    amountFilter.addEventListener('change', () => loadTaskPool(currentTaskTab));
  }
  
  // 任务标签页切换
  const taskTabs = document.querySelectorAll('#taskTabs button[data-task-status]');
  if (taskTabs.length > 0) {
    taskTabs.forEach(tab => {
      tab.addEventListener('click', (e) => {
        // 获取状态
        const status = e.target.getAttribute('data-task-status');
        // 更新标签页状态
        updateTaskTabs(status);
        // 重新加载任务池
        loadTaskPool(status);
      });
    });
  }
  
  // 自动刷新LP信息和任务池
  startAutoRefresh();
  
  log('事件监听器初始化完成');
}

// 更新任务标签页状态
function updateTaskTabs(status) {
  // 更新全局状态
  currentTaskTab = status;
  
  // 更新标签页UI
  const taskTabs = document.querySelectorAll('#taskTabs button[data-task-status]');
  taskTabs.forEach(tab => {
    if (tab.getAttribute('data-task-status') === status) {
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
    } else {
      tab.classList.remove('active');
      tab.setAttribute('aria-selected', 'false');
    }
  });
}

// 检查钱包连接状态
async function checkWalletConnection() {
  try {
    // 检查以太坊钱包
    if (typeof window.ethereum !== 'undefined') {
      // 初始化 provider
      provider = new ethers.providers.Web3Provider(window.ethereum);
      const accounts = await window.ethereum.request({ method: 'eth_accounts' });
      if (accounts && accounts.length > 0) {
        walletAddress = accounts[0];
        isWalletConnected = true;
        log('检测到已连接的以太坊钱包:', walletAddress);
        currentNetwork = 'eth';

        // 同步 currentWallet
        currentWallet = { address: walletAddress };

        // 检查 LP 注册状态
        await checkLPRegistration(walletAddress);
        // 仅在 LP 已注册时隐藏连接卡片并加载任务
        if (currentLP && currentLP.isRegistered) {
          // 隐藏连接卡片
          const walletConnCardEth = document.getElementById('connect-eth-wallet')?.closest('.card');
          if (walletConnCardEth) walletConnCardEth.style.display = 'none';
          // 获取 signer
          signer = provider.getSigner();
          await loadPaidTasks();
          // 自动加载任务池
          if (typeof loadTaskPool === 'function') {
            await loadTaskPool(currentTaskTab);
          }
        }
        return;
      }
    }
    
    // 检查 Solana 钱包
    if (typeof window.solana !== 'undefined') {
      const response = await window.solana.connect({ onlyIfTrusted: true });
      if (response.publicKey) {
        walletAddress = response.publicKey.toString();
        isWalletConnected = true;
        log('检测到已连接的 Solana 钱包:', walletAddress);
        currentNetwork = 'sol'; // 设置网络类型
        
        // 同步 currentWallet
        currentWallet = { address: walletAddress };
        // 检查 LP 注册状态
        await checkLPRegistration(walletAddress);
        // 仅在 LP 已注册时隐藏连接卡片并加载任务
        if (currentLP && currentLP.isRegistered) {
          const walletConnCardSol = document.getElementById('connect-solana-wallet')?.closest('.card');
          if (walletConnCardSol) walletConnCardSol.style.display = 'none';
          await loadPaidTasks();
          // 自动加载任务池
          if (typeof loadTaskPool === 'function') {
            await loadTaskPool(currentTaskTab);
          }
        }
        return;
      }
    }
    
    isWalletConnected = false;
    log('未检测到已连接的钱包');
    hideAllSections();
    showRegistrationSection();
  } catch (error) {
    logError('检查钱包连接状态失败:', error);
    isWalletConnected = false;
    hideAllSections();
    showRegistrationSection();
  }
}

// 连接以太坊钱包
async function connectEthWallet() {
  try {
    if (typeof window.ethereum !== 'undefined') {
      // 创建provider
      provider = new ethers.providers.Web3Provider(window.ethereum);
      
      const accounts = await provider.send('eth_requestAccounts', []);
      if (accounts && accounts.length > 0) {
        walletAddress = accounts[0];
        isWalletConnected = true;
        log('以太坊钱包已连接:', walletAddress);
        currentNetwork = 'eth'; // 设置网络类型
        
        // 同步 currentWallet
        currentWallet = { address: walletAddress };
        const walletConnCardEth = document.getElementById('connect-eth-wallet').closest('.card');
        if (walletConnCardEth) walletConnCardEth.style.display = 'none';
        
        // 获取signer
        signer = provider.getSigner();
        
        // 检查LP注册状态
        await checkLPRegistration(walletAddress);
        // 仅在LP已注册时加载已支付任务
        if (currentLP && currentLP.isRegistered) {
          await loadPaidTasks();
        }
      }
    } else {
      log('MetaMask未安装');
      alert('请安装 MetaMask 钱包');
    }
  } catch (error) {
    logError('连接以太坊钱包失败:', error);
    alert('连接钱包失败: ' + error.message);
  }
}

// 连接 Solana 钱包
async function connectSolanaWallet() {
  try {
    if (window.solanaIntegration && window.solanaIntegration.connectPhantomWallet) {
      await window.solanaIntegration.connectPhantomWallet();
      const address = await window.solanaIntegration.getSolAddress();
      if (address) {
        walletAddress = address;
        isWalletConnected = true;
        log('Solana 钱包已连接:', walletAddress);
        currentNetwork = 'sol'; // 设置网络类型
        
        // 同步 currentWallet
        currentWallet = { address: walletAddress };
        const walletConnCardSol = document.getElementById('connect-solana-wallet').closest('.card');
        if (walletConnCardSol) walletConnCardSol.style.display = 'none';
        
        // 检查 LP 注册状态
        await checkLPRegistration(walletAddress);
        // 仅在 LP 已注册时隐藏连接卡片并加载任务
        if (currentLP && currentLP.isRegistered) {
          await loadPaidTasks();
          // 自动加载任务池
          if (typeof loadTaskPool === 'function') {
            await loadTaskPool(currentTaskTab);
          }
        }
        return;
      } else {
        throw new Error('无法获取 Solana 地址');
      }
    } else {
      log('solanaIntegration 对象或方法未找到');
      alert('Solana 钱包集成未正确加载');
    }
  } catch (error) {
    logError('连接 Solana 钱包失败:', error);
    alert('连接钱包失败: ' + error.message);
  }
}

// 连接钱包
async function connectWallet() {
  try {
    // 检查是否安装了MetaMask
    if (window.ethereum) {
      // 创建provider
      provider = new ethers.providers.Web3Provider(window.ethereum);
      
      // 请求账户访问
      const accounts = await provider.send('eth_requestAccounts', []);
      walletAddress = accounts[0];
      isWalletConnected = true;  // 更新连接状态
      
      // 获取signer
      signer = provider.getSigner();
      
      // 检查LP注册状态
        await checkLPRegistration(walletAddress);
      
      // 连接Socket.io
      connectSocket();
      
      return true;
    } else {
        alert('请安装MetaMask钱包插件');
      return false;
    }
  } catch (error) {
    console.error('连接钱包失败:', error);
    
    // 处理用户拒绝连接的情况 (错误代码4001)
    if (error.code === 4001) {
      console.log('用户拒绝了连接请求');
      // 不显示错误提示框，只在控制台记录
      return false;
    }
    
    // 其他错误仍然显示错误提示框
    alert('连接钱包失败: ' + (error.message || '未知错误'));
    return false;
  }
}

// 处理钱包断开连接
function handleWalletDisconnect() {
  log('钱包已断开连接');
    isWalletConnected = false;
  walletAddress = null;
  updateWalletConnectionUI(false);
    hideAllSections();
    showRegistrationSection();
}

// 更新钱包连接UI状态
function updateWalletConnectionUI(isConnected, address) {
  const connectWalletBtn = document.getElementById('connect-wallet');
  const walletStatusContainer = document.querySelector('.card.mb-4 .card-body'); // 假设这个容器总是存在
  
  if (isConnected && address) {
    // 已连接状态
    if (connectWalletBtn) {
      connectWalletBtn.style.display = 'none'; // 检查 connectWalletBtn 是否存在
    }
    
    // 检查是否已经显示了地址信息
    let walletInfoElement = document.getElementById('wallet-info');
    if (!walletInfoElement && walletStatusContainer) { // 检查容器是否存在
      // 创建钱包信息显示
      const walletInfo = document.createElement('div');
      walletInfo.id = 'wallet-info';
      walletInfo.innerHTML = `
        <p class="mb-1">钱包已连接</p>
        <p class="mb-2"><small class="text-muted">${address}</small></p>
        <button id="disconnect-wallet" class="btn btn-sm btn-outline-danger">断开连接</button>
      `;
      walletStatusContainer.appendChild(walletInfo);
      
      // 添加断开连接按钮事件
      const disconnectBtn = document.getElementById('disconnect-wallet');
      if (disconnectBtn) { // 检查按钮是否存在
          disconnectBtn.addEventListener('click', () => {
            handleWalletDisconnect();
          });
      }
    }
  } else {
    // 未连接状态
    if (connectWalletBtn) {
      connectWalletBtn.style.display = 'block'; // 检查 connectWalletBtn 是否存在
    }
    
    // 移除钱包信息显示
    const walletInfo = document.getElementById('wallet-info');
    if (walletInfo) {
      walletInfo.remove();
    }
  }
}

// 连接Socket.io
function connectSocket() {
  try {
    // 如果已经存在socket实例，先断开
    if (socket) {
      socket.disconnect();
    }
    
    // 创建Socket连接
    socket = io(API_BASE_URL, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
      autoConnect: true
    });
    
    // 连接成功事件
    socket.on('connect', () => {
      log('Socket.io连接成功');
      
      // 发送钱包连接事件
      if (walletAddress) {
        socket.emit('wallet_connect', {
          walletAddress,
          userType: 'lp'
        });
      }
    });
    
    // 连接确认事件
    socket.on('connect_confirmed', (data) => {
      log('Socket.io连接已确认:', data);
      showToast('实时连接已建立', 'success');
    });
    
    // 连接错误事件
    socket.on('connect_error', (error) => {
      logError('Socket.io连接错误:', error);
      showToast('WebSocket连接失败，部分实时功能可能不可用', 'error');
    });
    
    // 监听提款完成事件
    socket.on('payment_withdrawn', (data) => {
      console.log('收到提款完成事件:', data);
      
      // 更新UI元素
      if (data && data.id) {
        const withdrawButton = document.querySelector(`[data-payment-id="${data.id}"] .withdraw-btn`);
        if (withdrawButton) {
          withdrawButton.textContent = '已提取';
          withdrawButton.disabled = true;
          withdrawButton.classList.remove('btn-primary');
          withdrawButton.classList.add('btn-success');
        }
        
        // 更新状态标签
        const statusBadge = document.querySelector(`[data-payment-id="${data.id}"] .status-badge`);
        if (statusBadge) {
          statusBadge.textContent = '已提取';
          statusBadge.classList.remove('bg-warning', 'bg-info');
          statusBadge.classList.add('bg-success');
        }
        
        // 如果有交易哈希，更新交易哈希链接
        if (data.txHash) {
          const txHashLink = document.querySelector(`[data-payment-id="${data.id}"] .tx-hash-link`);
          if (txHashLink) {
            txHashLink.href = `https://explorer.somnia.net/tx/${data.txHash}`;
            txHashLink.textContent = formatAddress(data.txHash);
            txHashLink.classList.remove('d-none');
          }
        }
        
        // 更新交易历史
        loadTransactionHistory();
      }
    });
  } catch (error) {
    logError('创建Socket连接失败:', error);
    showToast('实时连接失败，请刷新页面重试', 'error');
  }
}

// 检查 LP 注册状态
async function checkLPRegistration(address) {
  try {
    if (!address && !walletAddress) {
      console.error('钱包未连接');
      showToast('请先连接钱包', 'warning');
      return;
    }

    const checkAddress = address || walletAddress;
    // Use direct endpoint that returns an isRegistered flag
    const response = await fetch(`${API_BASE_URL}/lp/direct/${checkAddress}`);
    
    if (response.ok) {
      const lpData = await response.json();
      if (lpData.isRegistered) {
        updateLPInfo(lpData);
        showLPInfoSection();
        showDashboardSection();
        hideRegistrationSection();
        // 新增: 登录时加载已支付任务和任务池
        await loadPaidTasks();
        if (typeof loadTaskPool === 'function') {
          await loadTaskPool(currentTaskTab);
        }
        // 新增: 登录时加载余额和交易历史
        if (currentNetwork === 'sol') {
          await loadUSDCBalance();
        } else {
          await loadUSDTBalance();
        }
        await loadTransactionHistory();
      } else {
        showRegistrationSection();
        hideDashboardSection();
        hideLPInfoSection();
      }
    } else if (response.status === 404) {
      showRegistrationSection();
      hideDashboardSection();
      hideLPInfoSection();
    } else {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
  } catch (error) {
    console.error('检查 LP 注册状态失败:', error);
    showToast('检查 LP 注册状态失败: ' + error.message, 'error');
  }
}

// 注册 LP
async function registerLP() {
  try {
    const name = document.getElementById('name').value;
    const email = document.getElementById('email').value;
    const totalQuota = document.getElementById('register-total-quota').value;
    const perTransactionQuota = document.getElementById('register-per-transaction-quota').value;
    const feeRate = document.getElementById('register-fee-rate').value;
    
    // 验证输入
    if (!name || !email || !totalQuota || !perTransactionQuota) {
      showToast('请填写所有必填字段', 'error');
      return;
    }
    
    // 验证费率
    if (feeRate === '' || isNaN(parseFloat(feeRate)) || parseFloat(feeRate) < 0 || parseFloat(feeRate) > 100) {
      showToast('请输入有效的费率（0-100之间的数字）', 'error');
      return;
    }
    
    // 获取选中的支付平台
    const platforms = [];
    document.querySelectorAll('input[name="platforms"]:checked').forEach(checkbox => {
      platforms.push(checkbox.value);
    });
    
    if (platforms.length === 0) {
      showToast('请至少选择一个支付平台', 'error');
      return;
    }
    
    // 构建请求数据
    const requestData = {
      walletAddress,
      name,
      email,
      supportedPlatforms: platforms,
      totalQuota: parseFloat(totalQuota),
      perTransactionQuota: parseFloat(perTransactionQuota),
      fee_rate: parseFloat(feeRate)
    };
    
    // 发送请求
    const response = await fetch(`${API_BASE_URL}/lp/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestData)
    });
    
    const data = await response.json();
    
    if (data.success) {
      showToast('LP注册成功', 'success');
      
      // 更新UI
      hideRegistrationSection();
      
      // 重新加载LP信息
      await refreshLPInfo(walletAddress);
      
      // 显示LP信息和任务池
      showLPInfoSection();
      showDashboardSection();
      // 自动加载任务池并启动自动刷新
      if (typeof loadTaskPool === 'function') {
        await loadTaskPool();
      }
      if (typeof startAutoRefresh === 'function') {
        startAutoRefresh();
      }
    } else {
      showToast(`LP注册失败: ${data.message}`, 'error');
    }
  } catch (error) {
    console.error('注册LP失败:', error);
    showToast('注册LP失败，请稍后重试', 'error');
  }
}

// 更新额度
async function updateQuota() {
  try {
    // 获取输入值
    const totalQuota = document.getElementById('update-total-quota').value;
    const perTransactionQuota = document.getElementById('update-per-transaction-quota').value;
    const feeRate = document.getElementById('update-fee-rate').value;
    
    console.log('正在更新LP信息:', {
      totalQuota: totalQuota || '未修改',
      perTransactionQuota: perTransactionQuota || '未修改',
      feeRate: feeRate || '未修改'
    });
    
    // 验证至少有一个字段被填写
    if (!totalQuota && !perTransactionQuota && !feeRate) {
      showToast('请至少填写一个需要更新的字段', 'error');
      return;
    }
    
    // 构建请求数据
    const requestData = {
      walletAddress
    };
    
    if (totalQuota) {
      requestData.totalQuota = parseFloat(totalQuota);
    }
    
    if (perTransactionQuota) {
      requestData.perTransactionQuota = parseFloat(perTransactionQuota);
    }
    
    if (feeRate) {
      // 验证费率
      const parsedFeeRate = parseFloat(feeRate);
      if (isNaN(parsedFeeRate) || parsedFeeRate < 0 || parsedFeeRate > 100) {
        showToast('请输入有效的费率（0-100之间的数字）', 'error');
        return;
      }
      
      // 重要：同时设置fee_rate和feeRate字段，确保兼容性
      requestData.fee_rate = parsedFeeRate;
      requestData.feeRate = parsedFeeRate;
    }
    
    console.log('发送更新LP信息请求:', requestData);
    
    // 尝试多个可能的API端点
    let successful = false;
    const endpoints = [
      `${API_BASE_URL}/lp/quota`,
      `${API_BASE_URL}/lp/update`,
      `${API_BASE_URL}/lp/${walletAddress}/update`
    ];
    
    let lastError = null;
    
    for (const endpoint of endpoints) {
      try {
        console.log(`尝试使用 ${endpoint} 更新LP信息...`);
        
        // 发送请求
        const response = await fetch(endpoint, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestData)
        });
        
        console.log(`${endpoint} 响应状态码:`, response.status);
        
        if (response.ok) {
          const responseText = await response.text();
          console.log(`${endpoint} 响应内容:`, responseText);
          
          let data;
          try {
            data = JSON.parse(responseText);
          } catch (e) {
            console.warn('响应不是有效的JSON:', responseText);
            continue;
          }
          
          if (data.success) {
            showToast('LP信息更新成功', 'success');
            
            // 关闭模态框
            const modal = bootstrap.Modal.getInstance(document.getElementById('update-quota-modal'));
            if (modal) {
              modal.hide();
            }
            
            // 重新加载LP信息
            await refreshLPInfo(walletAddress);
            successful = true;
            break;
          } else {
            console.warn(`${endpoint} 更新失败:`, data.message || '未知错误');
            lastError = data.message || '更新失败';
          }
        }
      } catch (endpointError) {
        console.error(`使用 ${endpoint} 更新LP信息失败:`, endpointError);
        lastError = endpointError.message;
      }
    }
    
    if (!successful) {
      // 所有端点都失败，尝试最后的备选方案
      try {
        console.log('所有标准API端点失败，尝试直接API...');
        
        // 尝试直接使用通用更新API
        const generalResponse = await fetch(`${API_BASE_URL}/lp/${walletAddress}`, {
          method: 'PATCH',  // 或 'POST'，取决于API设计
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestData)
        });
        
        if (generalResponse.ok) {
          const result = await generalResponse.json();
          if (result.success) {
            showToast('LP信息更新成功', 'success');
            
            // 关闭模态框
            const modal = bootstrap.Modal.getInstance(document.getElementById('update-quota-modal'));
            if (modal) {
              modal.hide();
            }
            
            // 重新加载LP信息
            await refreshLPInfo(walletAddress);
            return;
          }
        }
        
        throw new Error('备选API更新也失败');
      } catch (fallbackError) {
        console.error('备选API更新失败:', fallbackError);
        showToast(`LP信息更新失败: ${lastError || fallbackError.message}`, 'error');
      }
    }
  } catch (error) {
    console.error('更新LP信息失败:', error);
    showToast('更新LP信息失败，请稍后重试: ' + error.message, 'error');
  }
}

// 加载任务池
async function loadTaskPool(status = 'all') {
  console.debug('[LP DEBUG] loadTaskPool called - status:', status, 'walletAddress:', walletAddress);
  try {
    // 获取钱包地址
    if (!isWalletConnected || !walletAddress) {
      logError('钱包未连接，无法加载任务池');
      return;
    }
    
    log(`开始加载任务池(状态: ${status})，钱包地址:`, walletAddress);

    // 获取平台和金额筛选条件
    const platformFilter = document.getElementById('platform-filter').value;
    const amountFilter = document.getElementById('amount-filter').value;
    
    // 构建查询参数
    let queryParams = `walletAddress=${walletAddress}`;
    if (platformFilter) {
      queryParams += `&platform=${platformFilter}`;
    }
    
    if (amountFilter) {
      const [minAmount, maxAmount] = amountFilter.split('-');
      if (minAmount) queryParams += `&minAmount=${minAmount}`;
      if (maxAmount) queryParams += `&maxAmount=${maxAmount}`;
    }
    
    log('查询参数:', queryParams);
    
    // 发起请求
    const response = await fetch(`${API_BASE_URL}/lp/task-pool?${queryParams}`);
    
    log('任务池响应状态:', response.status);
    
    if (!response.ok) {
      const errorText = await response.text();
      logError('获取任务池失败:', errorText);
      
      let errorObj;
      try {
        errorObj = JSON.parse(errorText);
      } catch (e) {
        throw new Error(`请求失败: ${response.status} ${response.statusText}`);
      }
      
      throw new Error(errorObj.message || '获取任务池失败');
    }
    
    const responseText = await response.text();
    log('任务池原始响应:', responseText);
    
    let result;
    try {
      result = JSON.parse(responseText);
    } catch (e) {
      logError('解析响应JSON失败:', e);
      throw new Error('解析响应失败');
    }
    
    log('解析后的响应:', result);
    
    if (!result.success) {
      throw new Error(result.message || '获取任务池失败');
    }
    
    // 更新全局taskList，无前端额外过滤
    const allTasks = result.data && result.data.tasks ? result.data.tasks : [];
    taskList = allTasks;
    log('全局taskList已更新，共有 ' + taskList.length + ' 个任务');
    // 显示任务列表，由 displayTasks 根据当前选中标签过滤
    displayTasks(allTasks);

    // 加载USDT余额和交易历史
//     await loadUSDTBalance();
//     await loadTransactionHistory();
    
  } catch (error) {
    logError('加载任务池失败:', error);
    alert('加载任务池失败: ' + error.message);
  }
}

// 显示任务列表
function displayTasks(tasks) {
  console.debug('[LP DEBUG] displayTasks called with tasks length:', tasks.length, 'currentTaskTab:', currentTaskTab);
  log('当前钱包地址:', walletAddress);
  log('任务列表:', tasks);
  
  // 过滤当前标签页任务
  const filteredTasks = tasks.filter(task => {
    const status = task.status || 'created';
    if (currentTaskTab === 'created') return ['created', 'pending'].includes(status);
    if (currentTaskTab === 'claimed') return ['claimed','processing'].includes(status);
    if (currentTaskTab === 'paid') return ['paid','confirmed','user_confirmed','settled'].includes(status);
    return true;
  });
  
  const taskList = document.getElementById('task-list');
  if (!taskList) return;
  
  if (!filteredTasks || filteredTasks.length === 0) {
    taskList.innerHTML = '<div class="alert alert-info">No available tasks</div>';
    return;
  }
  
  let html = '';
  filteredTasks.forEach(task => {
    const taskId = task.id || task.taskId;
    const status = task.status || 'created';
    const amount = task.amount || 0;
    const currency = task.currency || 'USDT';
    const platform = task.platform || '未知';
    const createdAt = task.createdAt ? new Date(task.createdAt).toLocaleString() : '未知';
    const userWalletAddress = task.userWalletAddress || '未知';
    
    // 获取状态变更时间
    let statusChangeTime = '未知';
    if (task.statusHistory && Array.isArray(task.statusHistory)) {
      // 查找对应状态的最新记录
      const statusEntry = [...task.statusHistory]
        .reverse()
        .find(entry => entry.status === status);
      
      if (statusEntry && statusEntry.timestamp) {
        statusChangeTime = new Date(statusEntry.timestamp).toLocaleString();
      }
    } else if (task.updatedAt) {
      // 如果没有状态历史记录，使用更新时间
      statusChangeTime = new Date(task.updatedAt).toLocaleString();
    }
    
    log(`显示任务ID=${taskId}, 状态=${status}, 状态变更时间=${statusChangeTime}`);
    
    // 确定是否能认领任务 - 任务状态为created且当前LP已注册
    const canClaim = ['created','pending'].includes(status);
    
    // 确定是否能确认支付 - 任务状态为claimed或processing且是当前LP认领的
    const canConfirm = (status === 'claimed' || status === 'processing') && 
                      task.lpWalletAddress && 
                      task.lpWalletAddress.toLowerCase() === walletAddress.toLowerCase();
    
    // 根据任务状态显示不同的UI
    let statusInfo = '';
    let actionButtons = '';
    
    // 状态信息
    if (status === 'created') {
      statusInfo = `<span class="badge bg-primary me-2">Available</span>`;
    } else if (status === 'claimed') {
      statusInfo = `<span class="badge bg-warning me-2">Claimed</span>`;
    } else if (status === 'processing') {
      statusInfo = `<span class="badge bg-info me-2">Processing</span>`;
    } else if (status === 'paid') {
      statusInfo = `<span class="badge bg-success me-2">Paid</span>`;
    } else if (status === 'user_confirmed' || status === 'confirmed') {
      statusInfo = `<span class="badge bg-info me-2">User Confirmed</span>`;
    } else if (status === 'settled') {
      statusInfo = `<span class="badge bg-secondary me-2">Settled</span>`;
    } else if (status === 'cancelled' || status === 'expired') {
      statusInfo = `<span class="badge bg-danger me-2">Cancelled/Expired</span>`;
    } else {
      statusInfo = `<span class="badge bg-dark me-2">${status}</span>`;
    }
    
    // 操作按钮
    if (canClaim) {
      actionButtons = `<button class="btn btn-primary btn-sm" data-task-id="${taskId}" onclick="claimTask('${taskId}')">Claim Task</button>`;
    } else if (canConfirm) {
      actionButtons = `<button class="btn btn-success btn-sm" data-task-id="${taskId}" onclick="markTaskPaid('${taskId}')">Mark as Paid</button>`;
    } else if (status === 'paid') {
      // For Paid status, LP only shows view details
      actionButtons = `<button class="btn btn-info btn-sm" onclick="viewTaskDetails('${taskId}')">View Details</button>`;
    } else if (status === 'confirmed' || status === 'user_confirmed' || status === 'settled') {
      // 针对已确认或已结算状态，显示查看详情
    } else if (status === 'paid' || status === 'confirmed' || status === 'user_confirmed' || status === 'settled') {
      // 添加查看详情按钮
      actionButtons = `<button class="btn btn-info btn-sm" onclick="viewTaskDetails('${taskId}')">View Details</button>`;
      
      // 如果是已结算状态，并且有结算交易哈希，添加查看交易的链接
      if (status === 'settled' && task.settlementTxHash) {
        actionButtons += `
          <a href="#" class="btn btn-link btn-sm ms-2" onclick="openExplorerUrl('${task.settlementTxHash}'); return false;">
            View Transaction: ${formatAddress(task.settlementTxHash)}
          </a>`;
      }
    } else {
      actionButtons = '';
    }
    
    html += `
      <div class="card mb-3">
        <div class="card-body">
          <div class="d-flex justify-content-between">
            <h6 class="card-subtitle mb-2 text-muted">Task ID: ${taskId}</h6>
            ${statusInfo}
          </div>
          <div class="row mt-3">
            <div class="col-md-6">
              <p class="mb-1"><strong>Amount:</strong> ${amount} ${currency}</p>
              <p class="mb-1"><strong>Payment Platform:</strong> ${platform}</p>
              <p class="mb-1"><strong>Created At:</strong> ${createdAt}</p>
              <p class="mb-1"><strong>Status Updated:</strong> ${statusChangeTime}</p>
            </div>
            <div class="col-md-6">
              <p class="mb-1"><strong>User Wallet Address:</strong> ${formatWalletAddress(userWalletAddress)}</p>
              ${task.description ? `<p class="mb-1"><strong>Description:</strong> ${task.description}</p>` : ''}
              ${task.lpWalletAddress ? `<p class="mb-1"><strong>LP Wallet Address:</strong> ${formatWalletAddress(task.lpWalletAddress)}</p>` : ''}
              ${task.merchantPaypalEmail ? `<p class="mb-1"><strong>Merchant PayPal Email:</strong> ${task.merchantPaypalEmail}</p>` : ''}
            </div>
          </div>
          <div class="mt-3">
            ${actionButtons}
          </div>
        </div>
      </div>
    `;
  });
  
  taskList.innerHTML = html;
}

// 格式化时间戳
function formatTimestamp(timestamp) {
  if (!timestamp) return '未知';
  try {
    return new Date(timestamp).toLocaleString();
  } catch (e) {
    return timestamp;
  }
}

// 格式化地址显示
function formatAddress(address) {
  if (!address) return '';
  if (address.length < 10) return address;
  return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
}

// 获取状态对应的Badge样式类
function getStatusBadgeClass(status) {
  switch(status.toLowerCase()) {
    case 'created': return 'bg-primary';
    case 'pending': return 'bg-primary';
    case 'claimed': return 'bg-info';
    case 'paid': return 'bg-success';
    case 'canceled': return 'bg-danger';
    default: return 'bg-secondary';
  }
}

// 获取状态的显示文本
function getStatusText(status) {
  switch(status.toLowerCase()) {
    case 'created': return '待认领';
    case 'pending': return '待认领';
    case 'claimed': return '已认领';
    case 'paid': return '已支付';
    case 'canceled': 
    case 'cancelled': return '已取消';
    case 'processing': return '处理中';
    case 'confirmed':
    case 'user_confirmed': return '用户已确认';
    case 'settled': return '已结算';
    case 'settlement_failed': return '结算失败';
    case 'expired': return '已过期';
    case 'failed': return '失败';
    default: return status;
  }
}

// 认领任务
async function claimTask(taskId) {
  try {
    // 禁用按钮防止重复点击
    const claimButton = document.querySelector(`button[data-task-id="${taskId}"]`);
    if (claimButton) {
      claimButton.disabled = true;
      claimButton.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 处理中...';
    }
    
    if (!isWalletConnected || !walletAddress) {
      alert('请先连接钱包');
      return;
    }
    
    log(`认领任务 ${taskId}...`);
    
    // 验证任务状态 - 确保仍然是 created
    const isValidStatus = await verifyTaskStatus(taskId, 'created');
    if (!isValidStatus) {
      logWarn('任务状态已变更，无法认领');
      alert('任务状态已变更，无法认领');
      return;
    }
    
    // 发起认领请求
    const response = await fetch(`${API_BASE_URL}/lp/task/${taskId}/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ walletAddress, network: currentNetwork })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      log('认领失败，状态码:', response.status, '响应:', errorText);
      
      let errorObj;
      try {
        errorObj = JSON.parse(errorText);
        throw new Error(errorObj.message || `认领失败: ${response.status}`);
      } catch (e) {
        if (e instanceof SyntaxError) {
          throw new Error(`认领失败: ${response.status} ${response.statusText}`);
        }
        throw e;
      }
    }
    
    const result = await response.json();
    log('认领成功:', result);
    
    // 显示成功消息
    alert('认领任务成功!');
    
    // 刷新任务列表和LP信息
    await loadTaskPool(currentTaskTab);
    await refreshLPInfo(walletAddress);
    await loadPaidTasks();
    
  } catch (error) {
    logError('认领任务失败:', error);
    alert(`认领任务失败: ${error.message}`);
  } finally {
    // 恢复按钮状态
    const claimButton = document.querySelector(`button[data-task-id="${taskId}"]`);
    if (claimButton) {
      claimButton.disabled = false;
      claimButton.innerHTML = '认领任务';
    }
  }
}

// 确认支付任务
async function markTaskPaid(taskId, button) {
  try {
    // 查找任务
    const task = taskList.find(t => t.id == taskId);
    
    if (!task) {
      showToast('无法找到任务信息', 'error');
      return;
    }
    
    // 如果是PayPal支付，调用PayPal支付流程
    if (task.platform === 'PayPal') {
      console.log('检测到PayPal任务，使用PayPal支付流程');
      await markTaskPaidWithPayPal(taskId);
      return;
    }
    
    // 其他支付平台的处理逻辑
    const paymentModal = document.createElement('div');
  } catch (error) {
    console.error('标记任务已支付失败:', error);
    showToast('标记任务已支付失败: ' + error.message, 'error');
  }
}

// 加载PayPal SDK
async function loadPayPalSDK() {
  return new Promise((resolve, reject) => {
    if (window.paypal) {
      resolve();
      return;
    }

    fetch(`${API_BASE_URL}/payment/paypal/config`)
      .then(response => response.json())
      .then(result => {
        if (!result.success || !result.data || !result.data.clientId) {
          throw new Error('获取PayPal配置失败');
        }

        const script = document.createElement('script');
        script.src = `https://www.paypal.com/sdk/js?client-id=${result.data.clientId}&currency=${result.data.currency || 'USD'}`;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('加载PayPal SDK失败'));
        document.body.appendChild(script);
      })
      .catch(reject);
  });
}
      
      // 刷新LP信息
async function refreshLPInfo(address) {
  try {
    if (!isWalletConnected) {
      logError('钱包未连接，无法刷新LP信息');
      return;
    }
    
    const walletAddressToUse = address || walletAddress;
    
    if (!walletAddressToUse) {
      logError('无效的钱包地址，无法刷新LP信息');
      return;
    }
    
    // 添加防抖动控制，避免频繁请求
    const now = Date.now();
    if (now - lastRefreshTime < 10000) { // 至少间隔10秒
      log('刷新太频繁，跳过此次请求');
      return;
    }
    lastRefreshTime = now;
    
    log('刷新LP信息，地址:', walletAddressToUse);
    const response = await fetch(`${API_BASE_URL}/lp/direct/${walletAddressToUse}`);
    
    const responseText = await response.text();
    let lpData;
    
    try {
      lpData = JSON.parse(responseText);
    } catch (e) {
      logError('解析LP数据失败:', e, '原始数据:', responseText);
      return;
    }
    
    log('获取到LP数据:', lpData);
    
    // 检查是否注册
    if (!lpData.isRegistered) {
      log('LP未注册，显示注册表单');
      
      // 更新UI以显示注册表单
      hideAllSections();
      showRegistrationSection();
      
      // 更新当前LP数据
      currentLP = { 
        walletAddress: walletAddressToUse,
        isRegistered: false
      };
      
      return currentLP;
    }
    
    // 更新当前LP数据
    currentLP = lpData;
    
    // 更新LP信息显示
    updateLPInfo(lpData);
    
    return lpData;
  } catch (error) {
    logError('刷新LP信息失败:', error);
    
    // 添加错误计数，如果连续多次失败则停止自动刷新
    window.lpRefreshErrorCount = (window.lpRefreshErrorCount || 0) + 1;
    
    if (window.lpRefreshErrorCount > 5) {
      logError('连续多次刷新失败，暂停自动刷新');
      stopAutoRefresh();
      
      // 2分钟后尝试重新启动
      setTimeout(() => {
        window.lpRefreshErrorCount = 0;
        startAutoRefresh();
      }, 120000);
    }
    
    return null;
  }
}

// 验证任务状态
async function verifyTaskStatus(taskId, expectedStatus) {
  try {
    log(`验证任务 ${taskId} 状态...`);
    
    // 直接请求单个任务详情
    const response = await fetch(`${API_BASE_URL}/lp/task/${taskId}`);
    
    if (!response.ok) {
      const errorStatus = response.status;
      let errorMessage = `获取任务详情失败: ${response.status} ${response.statusText}`;
      
      try {
        // 尝试获取更详细的错误信息
        const errorData = await response.json();
        if (errorData && errorData.message) {
          errorMessage = errorData.message;
        }
      } catch (jsonError) {
        // 无法解析JSON，使用默认错误消息
      }
      
      logError(errorMessage);
      
      // 对于不同的错误状态码提供不同的用户提示
      if (errorStatus === 404) {
        showToast('找不到该任务，可能已被删除', 'error');
      } else if (errorStatus === 500) {
        showToast('服务器内部错误，请稍后再试', 'error');
        console.error('请联系管理员检查服务器日志');
      } else {
        showToast(`获取任务信息失败: ${errorMessage}`, 'error');
      }
      
      // 刷新任务列表
      await loadTaskPool(currentTaskTab);
      return false;
    }
    
    const result = await response.json();
    if (!result.success) {
      logError(`获取任务详情失败:`, result.message);
      showToast(`获取任务详情失败: ${result.message}`, 'error');
      return false;
    }
    
    const task = result.data;
    log(`任务 ${taskId} 当前状态:`, task.status);
    
    if (expectedStatus === 'claimed' && task.status !== 'claimed' && task.status !== 'processing') {
      // 如果期望是已认领状态，但当前不是claimed或processing
      showToast(`任务状态已更改为 "${getStatusText(task.status)}"，无法执行确认支付操作`, 'warning');
      await loadTaskPool(currentTaskTab); // 重新加载当前标签页的任务
      return false;
    } else if (expectedStatus === 'created' && task.status !== 'created') {
      // 如果期望是待认领状态，但当前不是
      showToast(`任务状态已更改为 "${getStatusText(task.status)}"，无法执行认领操作`, 'warning');
      await loadTaskPool(currentTaskTab); // 重新加载当前标签页的任务
      return false;
    }
    
    return true;
  } catch (error) {
    logError('验证任务状态失败:', error);
    showToast('验证任务状态失败，请重试', 'error');
    return false;
  }
}

// 更新 LP 信息显示
function updateLPInfo(lpData) {
  log('更新LP信息:', lpData);
  
  try {
    // 更新当前LP对象
    currentLP = lpData;
    
    // 更新LP信息显示 - 添加元素存在性检查
    const walletAddressEl = document.getElementById('wallet-address');
    if (walletAddressEl) walletAddressEl.textContent = formatAddress(lpData.walletAddress);
    
    const lpNameEl = document.getElementById('lp-name');
    if (lpNameEl) lpNameEl.textContent = lpData.name || 'Unknown';
    
    const lpEmailEl = document.getElementById('lp-email');
    if (lpEmailEl) lpEmailEl.textContent = lpData.email || 'N/A';
    
    const displayTotalQuotaEl = document.getElementById('display-total-quota');
    if (displayTotalQuotaEl) displayTotalQuotaEl.textContent = parseFloat(lpData.totalQuota).toFixed(2);
    
    const displayPerTransactionQuotaEl = document.getElementById('display-per-transaction-quota');
    if (displayPerTransactionQuotaEl) displayPerTransactionQuotaEl.textContent = parseFloat(lpData.perTransactionQuota).toFixed(2);
    
    const lockedQuotaEl = document.getElementById('locked-quota');
    if (lockedQuotaEl) lockedQuotaEl.textContent = parseFloat(lpData.lockedQuota).toFixed(2);
    
    const availableQuotaEl = document.getElementById('available-quota');
    if (availableQuotaEl) availableQuotaEl.textContent = parseFloat(lpData.availableQuota).toFixed(2);
    
    const paidQuotaEl = document.getElementById('paid-quota');
    if (paidQuotaEl) paidQuotaEl.textContent = parseFloat(paidAmount).toFixed(2);
    
    // 显示费率信息
    const displayFeeRateEl = document.getElementById('display-fee-rate');
    if (displayFeeRateEl) displayFeeRateEl.textContent = formatFeeRate(lpData.fee_rate);
    
    // 设置更新表单初始值
    const updateTotalQuotaEl = document.getElementById('update-total-quota');
    if (updateTotalQuotaEl) updateTotalQuotaEl.value = lpData.totalQuota;
    
    const updatePerTransactionQuotaEl = document.getElementById('update-per-transaction-quota');
    if (updatePerTransactionQuotaEl) updatePerTransactionQuotaEl.value = lpData.perTransactionQuota;
    
    const updateFeeRateEl = document.getElementById('update-fee-rate');
    if (updateFeeRateEl) updateFeeRateEl.value = lpData.fee_rate !== undefined ? lpData.fee_rate : 0.5;
    
    // 显示PayPal邮箱(如果有)
    const lpPaypalEmailEl = document.getElementById('lp-paypal-email');
    if (lpPaypalEmailEl) {
      lpPaypalEmailEl.textContent = lpData.paypalEmail || '未设置';
    }
    
    // 更新页面状态
    if (!isWalletConnected) {
      hideAllSections();
    } else if (lpData.id) {
      // LP已注册
      const registrationSection = document.getElementById('registration-section');
      if (registrationSection) registrationSection.style.display = 'none';
      
      const lpInfoSection = document.getElementById('lp-info-section');
      if (lpInfoSection) lpInfoSection.style.display = 'block';
      
      const dashboardSection = document.getElementById('dashboard-section');
      if (dashboardSection) dashboardSection.style.display = 'block';
    } else {
      // LP未注册
      const registrationSection = document.getElementById('registration-section');
      if (registrationSection) registrationSection.style.display = 'block';
      
      const lpInfoSection = document.getElementById('lp-info-section');
      if (lpInfoSection) lpInfoSection.style.display = 'none';
      
      const dashboardSection = document.getElementById('dashboard-section');
      if (dashboardSection) dashboardSection.style.display = 'none';
    }
  } catch (error) {
    logError('更新LP信息显示失败:', error);
  }
}

// 格式化费率显示
function formatFeeRate(rate) {
  if (rate === undefined || rate === null) return '0.5';
  return parseFloat(rate).toFixed(2);
}

// 显示/隐藏各个部分函数 - 添加元素存在性检查
function showRegistrationSection() {
  const registrationSection = document.getElementById('registration-section');
  if (registrationSection) registrationSection.style.display = 'block';
}

function hideRegistrationSection() {
  const registrationSection = document.getElementById('registration-section');
  if (registrationSection) registrationSection.style.display = 'none';
}

function showLPInfoSection() {
  const lpInfoSection = document.getElementById('lp-info-section');
  if (lpInfoSection) lpInfoSection.style.display = 'block';
}

function hideLPInfoSection() {
  const lpInfoSection = document.getElementById('lp-info-section');
  if (lpInfoSection) lpInfoSection.style.display = 'none';
}

function showDashboardSection() {
  const dashboardSection = document.getElementById('dashboard-section');
  if (dashboardSection) dashboardSection.style.display = 'block';
}

function hideDashboardSection() {
  const dashboardSection = document.getElementById('dashboard-section');
  if (dashboardSection) dashboardSection.style.display = 'none';
}

function hideAllSections() {
  const registrationSection = document.getElementById('registration-section');
  if (registrationSection) registrationSection.style.display = 'none';
  
  const lpInfoSection = document.getElementById('lp-info-section');
  if (lpInfoSection) lpInfoSection.style.display = 'none';
  
  const dashboardSection = document.getElementById('dashboard-section');
  if (dashboardSection) dashboardSection.style.display = 'none';
}

// 加载已支付任务并计算总额
async function loadPaidTasks() {
  try {
    if (!currentWallet || !currentWallet.address) {
      console.error('钱包未连接');
      return;
    }

    // 调用通用任务池API
    const response = await fetch(`${API_BASE_URL}/lp/task-pool?walletAddress=${currentWallet.address}`);
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    if (data.success) {
      updateTaskList(data.data);
    } else {
      throw new Error(data.message || '获取任务池失败');
    }
  } catch (error) {
    console.error('获取任务池失败:', error);
    showToast('获取任务池失败: ' + error.message, 'error');
  }
}

// 开始自动刷新
function startAutoRefresh() {
  log('启动自动刷新');
  // 清除可能存在的旧定时器
  if (refreshIntervalId) {
    clearInterval(refreshIntervalId);
  }
  
  // 设置新的定时器
  refreshIntervalId = setInterval(async () => {
    if (isWalletConnected && walletAddress) {
      log('自动刷新LP信息和任务池');
      await refreshLPInfo(walletAddress);
      // 仅在LP已注册时加载已支付任务
      if (currentLP && currentLP.isRegistered) {
        await loadPaidTasks();
      }
    }
  }, REFRESH_INTERVAL);
  
  log('自动刷新已启动');
}

// 停止自动刷新
function stopAutoRefresh() {
  log('停止自动刷新');
  if (refreshIntervalId) {
    clearInterval(refreshIntervalId);
    refreshIntervalId = null;
  }
}

// 添加加载USDT余额的函数
async function loadUSDTBalance() {
  try {
    if (!isWalletConnected || !walletAddress) {
      console.log('钱包未连接，无法加载USDT余额');
      return '0.00';
    }
    
    console.log('开始获取USDT余额，钱包地址:', walletAddress);
    const usdtBalanceElement = document.getElementById('usdt-balance-amount') || document.getElementById('usdt-balance');
    
    if (usdtBalanceElement) {
      usdtBalanceElement.textContent = '加载中...';
    }
    
    // 首先尝试直接通过API获取余额（更可靠）
    try {
      const apiEndpoints = [
        `${API_BASE_URL}/wallet/balance?address=${walletAddress}`,
        `${API_BASE_URL}/check-balance?address=${walletAddress}`,
        `${API_BASE_URL}/balance/${walletAddress}`
      ];
      
      for (const endpoint of apiEndpoints) {
        try {
          console.log(`尝试从 ${endpoint} 获取余额...`);
          const response = await fetch(endpoint);
          
          if (response.ok) {
            const data = await response.json();
            if (data.success && (data.balance || data.balance === 0)) {
              usdtBalance = data.balance;
              console.log(`API获取余额成功: ${usdtBalance}`);
              
              // 更新UI显示
              if (usdtBalanceElement) {
                usdtBalanceElement.textContent = formatCurrency(usdtBalance, 'USDT');
              }
              
              return usdtBalance;
            }
          }
        } catch (endpointError) {
          console.warn(`从 ${endpoint} 获取余额失败:`, endpointError);
        }
      }
      
      console.warn('所有API端点均无法获取余额，尝试合约方式');
    } catch (apiError) {
      console.warn('API获取余额失败，尝试合约方式:', apiError);
    }
    
    // 如果API获取失败，尝试通过合约获取
    if (contractService && typeof contractService.getUSDTBalance === 'function') {
      console.log('使用合约服务获取USDT余额');
      try {
        const balance = await contractService.getUSDTBalance(walletAddress);
        usdtBalance = balance;
        
        // 更新UI显示
        if (usdtBalanceElement) {
          usdtBalanceElement.textContent = formatCurrency(balance, 'USDT');
        }
        
        return balance;
      } catch (contractError) {
        console.error('合约获取USDT余额失败:', contractError);
      }
    } else {
      console.warn('合约服务不可用或缺少getUSDTBalance方法');
    }
    
    // 如果通过API和合约都无法获取余额，使用默认值
    console.warn('无法获取USDT余额，使用默认值');
    usdtBalance = '0.00';
    
    if (usdtBalanceElement) {
      usdtBalanceElement.textContent = formatCurrency('0.00', 'USDT');
    }
    
    return '0.00';
  } catch (error) {
    // 如果是ENS不支持错误，静默跳过
    if (error.message && error.message.includes('network does not support ENS')) {
      console.warn('ENS不支持，跳过USDT余额获取');
    } else {
      console.error('加载USDT余额时发生错误:', error);
      showToast('加载USDT余额失败: ' + error.message, 'error');
    }
    // 设置默认值
    usdtBalance = '0.00';
    const usdtBalanceElement = document.getElementById('usdt-balance-amount') || document.getElementById('usdt-balance');
    if (usdtBalanceElement) {
      usdtBalanceElement.textContent = '0.00';
    }
    return '0.00';
  }
}

// 添加加载交易历史的函数
async function loadTransactionHistory() {
  try {
    if (!isWalletConnected || !walletAddress) {
      console.log('钱包未连接，无法加载交易历史');
      transactionHistory = [];
      updateTransactionHistoryUI();
      return;
    }
    
    console.log('开始加载交易历史，钱包地址:', walletAddress);
    
    // 尝试多个可能的API端点
    const apiEndpoints = [
      `${API_BASE_URL}/payment-intents/lp/${walletAddress}`,
      `${API_BASE_URL}/transactions/lp/${walletAddress}`,
      `${API_BASE_URL}/lp/transactions?walletAddress=${walletAddress}`
    ];
    
    let responseData = null;
    let successEndpoint = '';
    
    // 依次尝试每个端点
    for (const endpoint of apiEndpoints) {
      try {
        console.log(`尝试从 ${endpoint} 获取交易历史...`);
        const response = await fetch(endpoint);
        
        if (response.ok) {
          const result = await response.json();
          if (result && (result.success || Array.isArray(result) || result.data)) {
            responseData = result;
            successEndpoint = endpoint;
            console.log(`成功从 ${endpoint} 获取交易历史`);
            break;
          }
        }
      } catch (endpointError) {
        console.warn(`从 ${endpoint} 获取交易历史失败:`, endpointError);
      }
    }
    
    if (!responseData) {
      console.error('所有API端点均无法获取交易历史');
      transactionHistory = [];
      updateTransactionHistoryUI();
      return;
    }
    
    console.log(`从 ${successEndpoint} 获取的交易历史数据:`, responseData);
    
    // 数据格式检查和处理
    let transactionsData = null;
    
    // 处理多种可能的数据结构
    if (responseData.success && responseData.data) {
      console.log('尝试从 responseData.data 获取交易数据');
      if (Array.isArray(responseData.data)) {
        // {success: true, data: [...]}
        transactionsData = responseData.data;
        console.log('从 responseData.data 数组中获取交易数据成功');
      } else if (responseData.data.transactions && Array.isArray(responseData.data.transactions)) {
        // {success: true, data: {transactions: [...]}}
        transactionsData = responseData.data.transactions;
        console.log('从 responseData.data.transactions 获取交易数据成功');
      } else if (responseData.data.paymentIntents && Array.isArray(responseData.data.paymentIntents)) {
        // {success: true, data: {paymentIntents: [...]}}
        transactionsData = responseData.data.paymentIntents;
        console.log('从 responseData.data.paymentIntents 获取交易数据成功');
      } else {
        // 尝试从对象属性中找到数组
        console.log('尝试在 responseData.data 对象中查找数组属性');
        for (const key in responseData.data) {
          if (Array.isArray(responseData.data[key])) {
            transactionsData = responseData.data[key];
            console.log(`从 responseData.data.${key} 获取交易数据成功`);
            break;
          }
        }
      }
    } else if (Array.isArray(responseData)) {
      // 直接是数组
      transactionsData = responseData;
      console.log('原始响应直接是数组，获取交易数据成功');
    }
    
    if (!transactionsData || !Array.isArray(transactionsData)) {
      console.error('无法解析交易数据结构:', responseData);
      transactionHistory = [];
      updateTransactionHistoryUI();
      return;
    }
    
    console.log(`解析到 ${transactionsData.length} 笔交易记录`);
    
    if (transactionsData.length === 0) {
      console.log('交易历史数据为空');
      transactionHistory = [];
      updateTransactionHistoryUI();
      return;
    }
    
    // 分析第一条数据以了解数据结构
    console.log('交易记录样本:', transactionsData[0]);
    
    // 在映射前过滤只保留属于当前LP的钱包地址的交易
    transactionsData = transactionsData.filter(tx => {
      const recipient = tx.recipient || tx.to || tx.lpWalletAddress || tx.owner || null;
      return recipient && recipient.toLowerCase() === walletAddress.toLowerCase();
    });
    
    // 更新全局交易历史数据
    transactionHistory = transactionsData.map(tx => {
      // 检查所有必要字段是否存在，使用默认值替代缺失字段
      let txStatus = tx.status || tx.txStatus || 'unknown';
      const txSettlementHash = tx.settlementTxHash || 
                          (tx.paymentProof && tx.paymentProof.txHash ? tx.paymentProof.txHash : null) ||
                          tx.txHash || null;
                          
      // 确保正确标记settled状态
      // 1. 如果状态是 'settled'，无论是否有交易哈希，都保持 'settled'
      // 2. 如果有settlementTxHash但状态不是settled，将状态改为settled
      if (txStatus.toLowerCase() === 'settled') {
        txStatus = 'settled';
      } else if (txSettlementHash && 
                (txStatus.toLowerCase() === 'confirmed' || 
                 txStatus.toLowerCase() === 'paid' || 
                 txStatus.toLowerCase() === 'user_confirmed')) {
        txStatus = 'settled';
        console.log(`交易 #${tx.id || 'unknown'} 状态已从 ${tx.status} 修正为 settled`);
      }
      
      return {
        id: tx.id || tx.paymentId || tx.paymentIntentId || '未知ID',
        amount: tx.amount || 0,
        currency: tx.currency || 'USD',
        userWalletAddress: tx.userWalletAddress || tx.userAddress || tx.from || '未知地址',
        paymentMethod: tx.paymentMethod || tx.platform || tx.method || tx.currency || 'Unknown',
        date: tx.createdAt ? new Date(tx.createdAt).toLocaleString() : 
              tx.date ? new Date(tx.date).toLocaleString() : 
              tx.timestamp ? new Date(tx.timestamp).toLocaleString() : '未知日期',
        status: txStatus,
        transactionId: tx.transactionId || null,
        settlementTxHash: txSettlementHash
      };
    });
    
    console.log('处理后的交易历史:', transactionHistory);
    
    // 更新交易历史表格
    updateTransactionHistoryUI();
  } catch (error) {
    console.error('加载交易历史失败:', error);
    // 设置空数据
    transactionHistory = [];
    
    // 显示错误信息
    const container = document.getElementById('transaction-history');
    if (container) {
      container.innerHTML = `<div class="alert alert-danger">加载交易历史失败: ${error.message}</div>`;
    }
  }
}

// 更新交易历史UI的函数
function updateTransactionHistoryUI() {
  const container = document.getElementById('transaction-history');
  if (!container) return;
  
  container.innerHTML = '';
  
  if (!transactionHistory || transactionHistory.length === 0) {
    container.innerHTML = '<div class="alert alert-info">No transaction history</div>';
    return;
  }
  
  // 仅展示已处理的交易记录（已支付、已确认、用户已确认、已结算）
  const filteredHistory = transactionHistory.filter(tx => {
    const s = String(tx.status).toLowerCase();
    return ['paid','confirmed','user_confirmed','settled'].includes(s);
  });
  if (filteredHistory.length === 0) {
    container.innerHTML = '<div class="alert alert-info">No processed transactions</div>';
    return;
  }
  
  // 计算总页数
  const totalPages = Math.ceil(filteredHistory.length / itemsPerPage);
  
  // 确保当前页码在有效范围内
  if (currentPage < 1) currentPage = 1;
  if (currentPage > totalPages) currentPage = totalPages;
  
  // 计算当前页的数据范围
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = Math.min(startIndex + itemsPerPage, filteredHistory.length);
  const currentPageData = filteredHistory.slice(startIndex, endIndex);
  
  const table = document.createElement('table');
  table.className = 'table table-striped table-hover w-100';
  
  // 创建表头
  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr>
      <th>ID</th>
      <th>Amount</th>
      <th>User Wallet</th>
      <th>Payment Method</th>
      <th>Transaction Time</th>
      <th>Status</th>
      <th>Release Time</th>
      <th>Actions</th>
    </tr>
  `;
  
  // 创建表体
  const tbody = document.createElement('tbody');
  
  // 填充当前页的数据
  currentPageData.forEach(tx => {
    const tr = document.createElement('tr');
    
    const paymentMethodBadge = tx.paymentMethod ? 
      `<span class="badge ${tx.paymentMethod.toLowerCase() === 'paypal' ? 'bg-primary' : 'bg-secondary'}">${tx.paymentMethod}</span>` : 
      '<span class="badge bg-secondary">Unknown</span>';
    
    // 固定显示可点击的"查看详情"按钮，调用详情弹窗
    let viewDetailsBtn = `<button class="btn btn-sm btn-outline-info" onclick="viewTaskDetails('${tx.id}')">View Details</button>`;
    
    // 添加倒计时单元格和Claim按钮
    let releaseTimeCell = '';
    let claimButton = '';
    
    // 根据交易状态设置倒计时和操作按钮
    const txStatus = String(tx.status).toLowerCase();
    
    // 处理已结算状态 - 无论是否有交易哈希都显示"已提取"
    if (txStatus === 'settled') {
      // 已结算状态，显示"已提取"
      releaseTimeCell = '<span class="text-success">Withdrawn</span>';
      
      if (tx.settlementTxHash) {
        // 带交易哈希的按钮
        claimButton = `<button class="btn btn-secondary btn-sm" disabled>Withdrawn</button>
          <a href="#" onclick="openExplorerUrl('${tx.settlementTxHash}'); return false;" class="small d-block mt-1">View Transaction</a>`;
      } else {
        // 不带交易哈希的按钮
        claimButton = `<button class="btn btn-secondary btn-sm" disabled>Withdrawn</button>`;
      }
    } 
    // 处理可提取状态 - 确认或已支付状态
    else if (txStatus === 'confirmed' || txStatus === 'paid' || txStatus === 'user_confirmed') {
      // 计算可提取时间 = 确认时间 + 24小时
      const confirmTime = getConfirmTime(tx);
      if (confirmTime) {
        const releaseTime = new Date(confirmTime.getTime() + (24 * 60 * 60 * 1000));
        const now = new Date();
        
        if (now >= releaseTime) {
          // 已过锁定期，显示"可提取"
          releaseTimeCell = '<span class="text-success">Withdrawal</span>';
          claimButton = `<button class="btn btn-success btn-sm withdraw-btn" data-payment-id="${tx.id}" onclick="claimPayment('${tx.id}')">Withdraw Funds</button>`;
        } else {
          // 倒计时中
          releaseTimeCell = `<span class="countdown-timer" data-release-time="${releaseTime.toISOString()}">计算中...</span>`;
          claimButton = `<button class="btn btn-secondary btn-sm" disabled>Waiting Unlock</button>`;
        }
      } else {
        releaseTimeCell = '<span class="text-muted">未知</span>';
      }
    } 
    // 其他所有状态
    else {
      releaseTimeCell = '<span class="text-muted">-</span>';
      claimButton = ''; // 无按钮
    }
    
    tr.innerHTML = `
      <td>${tx.id}</td>
      <td>${formatCurrency(tx.amount, tx.currency)}</td>
      <td>${shortenAddress(tx.userWalletAddress)}</td>
      <td>${paymentMethodBadge}</td>
      <td>${tx.date}</td>
      <td><span class="badge ${getBadgeClass(txStatus)}">${tx.status}</span></td>
      <td>${releaseTimeCell}</td>
      <td>${viewDetailsBtn} ${claimButton}</td>
    `;
    
    tbody.appendChild(tr);
  });
  
  // 组装表格
  table.appendChild(thead);
  table.appendChild(tbody);
  container.appendChild(table);
  
  // 添加分页控件
  if (totalPages > 1) {
    const pagination = document.createElement('div');
    pagination.className = 'pagination-container d-flex justify-content-between align-items-center mt-3';
    
    // 添加页码信息
    const pageInfo = document.createElement('div');
    pageInfo.className = 'page-info';
    pageInfo.innerHTML = `显示 ${startIndex + 1}-${endIndex} 条，共 ${filteredHistory.length} 条`;
    
    // 添加分页按钮
    const pageButtons = document.createElement('div');
    pageButtons.className = 'btn-group';
    
    // 首页按钮
    const firstPageBtn = document.createElement('button');
    firstPageBtn.className = 'btn btn-outline-secondary btn-sm';
    firstPageBtn.innerHTML = '首页';
    firstPageBtn.disabled = currentPage === 1;
    firstPageBtn.onclick = () => {
      currentPage = 1;
      updateTransactionHistoryUI();
    };
    
    // 上一页按钮
    const prevPageBtn = document.createElement('button');
    prevPageBtn.className = 'btn btn-outline-secondary btn-sm';
    prevPageBtn.innerHTML = '上一页';
    prevPageBtn.disabled = currentPage === 1;
    prevPageBtn.onclick = () => {
      currentPage--;
      updateTransactionHistoryUI();
    };
    
    // 下一页按钮
    const nextPageBtn = document.createElement('button');
    nextPageBtn.className = 'btn btn-outline-secondary btn-sm';
    nextPageBtn.innerHTML = '下一页';
    nextPageBtn.disabled = currentPage === totalPages;
    nextPageBtn.onclick = () => {
      currentPage++;
      updateTransactionHistoryUI();
    };
    
    // 末页按钮
    const lastPageBtn = document.createElement('button');
    lastPageBtn.className = 'btn btn-outline-secondary btn-sm';
    lastPageBtn.innerHTML = '末页';
    lastPageBtn.disabled = currentPage === totalPages;
    lastPageBtn.onclick = () => {
      currentPage = totalPages;
      updateTransactionHistoryUI();
    };
    
    // 组装分页按钮
    pageButtons.appendChild(firstPageBtn);
    pageButtons.appendChild(prevPageBtn);
    pageButtons.appendChild(nextPageBtn);
    pageButtons.appendChild(lastPageBtn);
    
    // 组装分页容器
    pagination.appendChild(pageInfo);
    pagination.appendChild(pageButtons);
    container.appendChild(pagination);
  }
  
  // 初始化倒计时
  initCountdowns();
}

// 添加PayPal交易详情查看功能
function viewPayPalTransaction(transactionId) {
  if (!transactionId) {
    alert('无效的交易ID');
    return;
  }
  
  // 创建模态框容器
  const modalContainer = document.createElement('div');
  modalContainer.className = 'modal fade';
  modalContainer.id = 'paypal-transaction-modal';
  modalContainer.setAttribute('tabindex', '-1');
  modalContainer.setAttribute('aria-labelledby', 'paypal-transaction-modal-label');
  modalContainer.setAttribute('aria-hidden', 'true');
  
  // 模态框内容
  modalContainer.innerHTML = `
    <div class="modal-dialog modal-lg">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title" id="paypal-transaction-modal-label">PayPal交易详情</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
        </div>
        <div class="modal-body">
          <div class="transaction-loading">
            <span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>
            正在加载交易详情...
          </div>
          <div class="transaction-detail-container" style="display: none;">
            <div class="alert alert-info">
              <small>在实际生产环境中，您可以查看完整的PayPal交易详情，包括买家信息、支付状态和完整的交易记录。</small>
            </div>
            <div class="card mb-3">
              <div class="card-header">基本信息</div>
              <div class="card-body">
                <div class="row mb-2">
                  <div class="col-md-4"><strong>交易ID:</strong></div>
                  <div class="col-md-8" id="paypal-tx-id">${transactionId}</div>
                </div>
                <div class="row mb-2">
                  <div class="col-md-4"><strong>状态:</strong></div>
                  <div class="col-md-8" id="paypal-tx-status">COMPLETED</div>
                </div>
                <div class="row mb-2">
                  <div class="col-md-4"><strong>创建时间:</strong></div>
                  <div class="col-md-8" id="paypal-tx-create-time">${new Date().toLocaleString()}</div>
                </div>
                <div class="row mb-2">
                  <div class="col-md-4"><strong>更新时间:</strong></div>
                  <div class="col-md-8" id="paypal-tx-update-time">${new Date().toLocaleString()}</div>
                </div>
              </div>
            </div>
            
            <div class="card mb-3">
              <div class="card-header">金额信息</div>
              <div class="card-body">
                <div class="row mb-2">
                  <div class="col-md-4"><strong>总金额:</strong></div>
                  <div class="col-md-8" id="paypal-tx-gross-amount">$100.00 USD</div>
    </div>
                <div class="row mb-2">
                  <div class="col-md-4"><strong>PayPal手续费:</strong></div>
                  <div class="col-md-8" id="paypal-tx-fee">$3.20 USD</div>
                </div>
                <div class="row mb-2">
                  <div class="col-md-4"><strong>净收入:</strong></div>
                  <div class="col-md-8" id="paypal-tx-net-amount">$96.80 USD</div>
                </div>
              </div>
            </div>
            
            <div class="card">
              <div class="card-header">买家信息</div>
              <div class="card-body">
                <div class="row mb-2">
                  <div class="col-md-4"><strong>买家邮箱:</strong></div>
                  <div class="col-md-8" id="paypal-buyer-email">buyer@example.com</div>
                </div>
                <div class="row mb-2">
                  <div class="col-md-4"><strong>买家名称:</strong></div>
                  <div class="col-md-8" id="paypal-buyer-name">John Doe</div>
                </div>
                <div class="row mb-2">
                  <div class="col-md-4"><strong>买家ID:</strong></div>
                  <div class="col-md-8" id="paypal-buyer-id">BUYER12345</div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">关闭</button>
          <a href="https://sandbox.paypal.com/merchantapps/app/account/transactions" target="_blank" class="btn btn-primary">PayPal沙盒详情</a>
        </div>
      </div>
    </div>
  `;
  
  // 添加到页面
  document.body.appendChild(modalContainer);
  
  // 显示模态框
  const modal = new bootstrap.Modal(document.getElementById('paypal-transaction-modal'));
  modal.show();
  
  // 模拟数据加载
  setTimeout(() => {
    document.querySelector('.transaction-loading').style.display = 'none';
    document.querySelector('.transaction-detail-container').style.display = 'block';
    
    // 在实际应用中，这里应该从API获取真实的交易详情
    // 这里仅作模拟展示
    document.getElementById('paypal-tx-id').textContent = transactionId;
    document.getElementById('paypal-tx-status').textContent = 'COMPLETED';
    
    // 随机生成一些模拟数据
    const now = new Date();
    const createdAt = new Date(now.getTime() - Math.random() * 3600000); // 1-60分钟前
    
    document.getElementById('paypal-tx-create-time').textContent = createdAt.toLocaleString();
    document.getElementById('paypal-tx-update-time').textContent = now.toLocaleString();
    
    // 查找对应交易记录的金额
    const transaction = transactionHistory.find(tx => tx.transactionId === transactionId);
    const amount = transaction ? transaction.amount : (Math.random() * 500 + 50).toFixed(2);
    
    // 计算手续费和净额
    const fee = (amount * 0.029 + 0.30).toFixed(2);
    const netAmount = (amount - fee).toFixed(2);
    
    document.getElementById('paypal-tx-gross-amount').textContent = `$${amount} USD`;
    document.getElementById('paypal-tx-fee').textContent = `$${fee} USD`;
    document.getElementById('paypal-tx-net-amount').textContent = `$${netAmount} USD`;
    
    // 买家信息
    document.getElementById('paypal-buyer-email').textContent = 'sb-zs9v8j29741747@personal.example.com';
    document.getElementById('paypal-buyer-name').textContent = 'John Doe (沙盒测试账户)';
    document.getElementById('paypal-buyer-id').textContent = 'TESTBUYERID12345';
  }, 1500);
  
  // 在模态框关闭时移除元素
  document.getElementById('paypal-transaction-modal').addEventListener('hidden.bs.modal', function () {
    document.body.removeChild(modalContainer);
  });
}

// 格式化货币
function formatCurrency(amount, currency = 'USDT') {
  if (typeof amount !== 'number') {
    amount = parseFloat(amount) || 0;
  }
  return `${amount.toFixed(2)} ${currency}`;
}

// 添加钱包地址格式化辅助函数
function formatWalletAddress(address) {
  if (!address) return '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// 添加缩短地址的函数
function shortenAddress(address) {
  if (!address) return '';
  return formatWalletAddress(address);
}

/**
 * 获取区块链浏览器URL
 * @param {string} txHash - 交易哈希
 * @param {string} network - 网络名称 (默认为 'ethereum')
 * @returns {string} 浏览器URL
 */
async function getExplorerUrl(txHash, network = 'ethereum') {
  if (!txHash) return '';

  try {
    // 获取网络信息以确定正确的区块浏览器URL
    const response = await fetch(`${API_BASE_URL}/settlement-contract-info`);
    const result = await response.json();
    
    if (result.success && result.data.networkInfo && result.data.networkInfo.blockExplorer) {
      return `${result.data.networkInfo.blockExplorer}/tx/${txHash}`;
    }
  } catch (error) {
    console.error('获取网络配置失败:', error);
  }
  
  // 如果获取配置失败，使用默认配置（为后期多网络做准备）
  const explorers = {
    ethereum: 'https://etherscan.io',
    goerli: 'https://goerli.etherscan.io',
    sepolia: 'https://sepolia.etherscan.io',
    bsc: 'https://bscscan.com',
    polygon: 'https://polygonscan.com',
    somnia: 'https://shannon-explorer.somnia.network'
  };

  const baseUrl = explorers[network.toLowerCase()] || explorers.ethereum;
  return `${baseUrl}/tx/${txHash}`;
}

// 在页面加载时，添加新的USDT余额和交易历史区域到LP信息部分
document.addEventListener('DOMContentLoaded', function() {
  const lpInfoSection = document.getElementById('lp-info-section');
  if (lpInfoSection) {
    const transactionHistoryCard = document.createElement('div');
    transactionHistoryCard.className = 'card mb-4';
    transactionHistoryCard.innerHTML = `
      <div class="card-body">
        <h5 class="card-title">USDC Balance & Transaction History</h5>
        <div class="row mb-3">
          <div class="col-md-6">
            <p><strong>USDC Balance:</strong> <span id="usdc-balance">0.00</span> USDC</p>
          </div>
          <div class="col-md-6 text-end">
            <button id="refresh-usdc-balance" class="btn btn-sm btn-outline-primary">Refresh Balance</button>
          </div>
        </div>
        <div id="transaction-history" class="w-100">
          <!-- 交易历史将在这里动态插入 -->
        </div>
      </div>
    `;
    
    // 将交易历史卡片插入到LP信息区域后面
    lpInfoSection.appendChild(transactionHistoryCard);
    
    // 添加刷新余额按钮事件
    document.getElementById('refresh-usdc-balance').addEventListener('click', loadUSDCBalance);
  }
  
  // 初始化其他事件监听器
  initEventListeners();
  // 初始加载 USDC 余额和交易历史
  if (typeof loadUSDCBalance === 'function') {
    loadUSDCBalance().catch(err => console.error('初始加载USDC余额失败:', err));
  }
  if (typeof loadTransactionHistory === 'function') {
    loadTransactionHistory().catch(err => console.error('初始加载交易历史失败:', err));
  }
});

// 连接PayPal账户
async function connectPayPal() {
  try {
    if (!isWalletConnected || !walletAddress) {
      alert('请先连接钱包');
      return;
    }
    
    const paypalEmail = document.getElementById('paypal-email').value;
    
    if (!paypalEmail) {
      alert('请输入PayPal邮箱');
      return;
    }
    
    // 验证邮箱格式
    if (!/^\S+@\S+\.\S+$/.test(paypalEmail)) {
      alert('请输入有效的邮箱地址');
      return;
    }
    
    // 验证码确认窗口
    const verificationCode = prompt(`为了验证您拥有此PayPal账户，我们将向 ${paypalEmail} 发送一封验证邮件。请在收到邮件后输入验证码:`);
    
    if (!verificationCode) {
      alert('验证已取消');
      return;
    }
    
    // 模拟验证过程
    if (verificationCode !== '123456') { // 在实际应用中，应该是服务器端验证
      alert('验证码不正确，请重试');
      return;
    }
    
    // 确认操作
    if (!confirm(`确定要将PayPal账户 ${paypalEmail} 与当前LP钱包绑定吗？`)) {
      return;
    }
    
    const response = await fetch(`${API_BASE_URL}/lp/paypal/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        walletAddress,
        paypalEmail
      })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'PayPal账户连接失败');
    }
    
    const data = await response.json();
    
    // 更新LP信息
    document.getElementById('lp-paypal-email').textContent = data.data.paypalEmail;
    
    // 如果LP对象存在，更新它
    if (currentLP) {
      currentLP.paypalEmail = data.data.paypalEmail;
      currentLP.supportedPlatforms = data.data.supportedPlatforms;
    }
    
    alert('PayPal账户连接成功! 您的账户已通过验证。');
    
    // 刷新LP信息
    await refreshLPInfo(walletAddress);
    
  } catch (error) {
    logError('PayPal账户连接失败:', error);
    alert('PayPal账户连接失败: ' + error.message);
  }
}

// 更新LP的PayPal邮箱
async function updatePayPalEmail() {
  try {
    const newEmail = document.getElementById('paypal-email').value;
    if (!newEmail) {
      showToast('请输入PayPal邮箱', 'error');
      return;
    }

    const response = await fetch(`${API_BASE_URL}/lp/paypal/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        walletAddress: walletAddress,
        paypalEmail: newEmail
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || '更新PayPal邮箱失败');
    }

    await refreshLPInfo(walletAddress);
    showToast('PayPal邮箱更新成功', 'success');
    
    // 关闭模态框
    const modal = document.getElementById('paypal-email-modal');
    if (modal) {
      modal.style.display = 'none';
    }
  } catch (error) {
    console.error('更新PayPal邮箱失败:', error);
    showToast(error.message, 'error');
  }
}

// 显示更新PayPal邮箱的模态框
function showPayPalEmailModal() {
  // 创建模态框
  const modal = document.createElement('div');
  modal.id = 'paypal-email-modal';
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0,0,0,0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
  `;

  const content = document.createElement('div');
  content.style.cssText = `
    background: white;
    padding: 20px;
    border-radius: 8px;
    width: 400px;
  `;

  content.innerHTML = `
    <h3>更新PayPal邮箱</h3>
    <p>请输入您的PayPal沙盒商家账号邮箱：</p>
    <input type="email" id="paypal-email" class="form-control" placeholder="PayPal邮箱" value="${currentLP?.paypalEmail || ''}" style="margin: 10px 0;">
    <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 15px;">
      <button onclick="document.getElementById('paypal-email-modal').remove()" class="btn btn-secondary">取消</button>
      <button onclick="updatePayPalEmail()" class="btn btn-primary">确认</button>
    </div>
  `;
  
  modal.appendChild(content);
  document.body.appendChild(modal);
}

// 查看任务详情
async function viewTaskDetails(taskId) {
  try {
    console.log(`查看任务详情: ${taskId}`);
    
    // 获取任务详情
    const response = await fetch(`${API_BASE_URL}/lp/task/${taskId}`);
    
    if (!response.ok) {
      showToast(`获取任务详情失败: ${response.status}`, 'error');
      return;
    }
    
    const result = await response.json();
    if (!result.success) {
      showToast(`获取任务详情失败: ${result.message}`, 'error');
      return;
    }
    
    const task = result.data;
    console.log('任务详情:', task);
    
    // 提取PayPal支付信息
    let paypalInfo = { orderId: '未知', captureId: '未知', transactionTime: '未知' };
    if (task.paymentProof) {
      let proof = task.paymentProof;
      if (typeof proof === 'string') {
        try {
          proof = JSON.parse(proof);
        } catch (e) {
          console.error('解析支付凭证失败:', e);
        }
      }
      
      if (proof) {
        paypalInfo.orderId = proof.paypalOrderId || proof.orderId || '未知';
        paypalInfo.captureId = proof.paypalCaptureId || proof.captureId || proof.transactionId || '未知';
        paypalInfo.transactionTime = proof.captureTime || proof.transactionTime || '未知';
      }
    }

    // 处理状态历史
    let statusHistory = task.statusHistory || [];
    if (typeof statusHistory === 'string') {
      try {
        statusHistory = JSON.parse(statusHistory);
      } catch (e) {
        console.error('解析状态历史失败:', e);
        statusHistory = [];
      }
    }

    // 确保状态历史是数组
    if (!Array.isArray(statusHistory)) {
      statusHistory = [];
    }

    // FIRST_EDIT: 如果首条为创建或待认领状态，替换描述为动态平台支付意图创建
    if (statusHistory.length > 0) {
      const firstEntry = statusHistory[0];
      if (firstEntry.status && ['created', 'pending'].includes(firstEntry.status.toLowerCase())) {
        firstEntry.description = `${task.platform || 'Unknown'} payment intent created`;
      }
    }

    // 如果有结算交易哈希，添加到状态历史
    if (task.settlementTxHash && !statusHistory.some(entry => entry.txHash === task.settlementTxHash)) {
      statusHistory.push({
        status: 'settled',
        timestamp: task.updatedAt,
        description: 'Transaction settled',
        txHash: task.settlementTxHash,
        network: task.network || 'ethereum'
      });
    }

    // 如果有处理详情，添加到状态历史
    if (task.processingDetails) {
      let details = task.processingDetails;
      if (typeof details === 'string') {
        try {
          details = JSON.parse(details);
        } catch (e) {
          console.error('解析处理详情失败:', e);
        }
      }
      
      if (details && details.txHash && !statusHistory.some(entry => entry.txHash === details.txHash)) {
        statusHistory.push({
          status: task.status,
          timestamp: details.timestamp || task.updatedAt,
          description: details.message || 'Processing transaction',
          txHash: details.txHash,
          network: details.network || 'ethereum'
        });
      }
    }

    // 如果有错误详情，添加到状态历史
    if (task.errorDetails) {
      let errors = task.errorDetails;
      if (typeof errors === 'string') {
        try {
          errors = JSON.parse(errors);
        } catch (e) {
          console.error('解析错误详情失败:', e);
        }
      }
      
      if (errors && !statusHistory.some(entry => entry.error === errors.message)) {
        statusHistory.push({
          status: 'settlement_failed',
          timestamp: errors.timestamp || task.updatedAt,
          description: errors.message || 'Settlement failed',
          error: errors.message
        });
      }
    }
    
    // 翻译中文描述为英文
    statusHistory.forEach(entry => {
      if (entry.description) {
        entry.description = entry.description
          .replace('PayPal支付已捕获', 'PayPal payment captured')
          .replace(/订单ID/g, 'Order ID')
          .replace(/捕获ID/g, 'Capture ID')
          .replace('用户已确认收到服务', 'User confirmed receipt of service')
          .replace('认领任务', 'Task claimed')
          .replace(/，/g, ', ')
          .replace(/：/g, ': ');
      }
    });
    
    // 创建详情弹窗
    const detailModal = document.createElement('div');
    detailModal.id = 'task-detail-modal';
    detailModal.className = 'modal fade show';
    detailModal.style.display = 'block';
    detailModal.style.backgroundColor = 'rgba(0,0,0,0.5)';
    
    detailModal.innerHTML = `
      <div class="modal-dialog modal-lg modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">Task Details #${task.id}</h5>
            <button type="button" class="btn-close" id="close-task-detail-modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">
            <div class="row">
              <div class="col-md-6">
                <div class="card mb-3">
                  <div class="card-header">Basic Information</div>
                  <div class="card-body">
                    <p><strong>Task ID:</strong> ${task.id}</p>
                    <p><strong>Payment Amount:</strong> ${task.amount} ${task.currency || 'USD'}</p>
                    <p><strong>Payment Platform:</strong> ${task.platform || 'Unknown'}</p>
                    <p><strong>Created At:</strong> ${new Date(task.createdAt).toLocaleString()}</p>
                    <p><strong>Status:</strong> <span class="badge ${getBadgeClass(task.status)}">${task.status}</span></p>
                    <p><strong>User Wallet Address:</strong> ${task.userWalletAddress || 'Unknown'}</p>
                  </div>
                </div>
              </div>
              <div class="col-md-6">
                <div class="card mb-3">
                  <div class="card-header">PayPal Transaction Information</div>
                  <div class="card-body">
                    <p><strong>Order ID:</strong> <span class="text-primary">${paypalInfo.orderId}</span></p>
                    <p><strong>Transaction ID:</strong> <span class="text-primary">${paypalInfo.captureId}</span></p>
                    <p><strong>Transaction Time:</strong> ${paypalInfo.transactionTime ? new Date(paypalInfo.transactionTime).toLocaleString() : 'Unknown'}</p>
                    <div class="mt-3">
                      <a href="https://sandbox.paypal.com/merchantapps/app/account/transactions" target="_blank" class="btn btn-sm btn-outline-primary">PayPal Sandbox Merchant Center</a>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            
            <div class="card mb-3">
              <div class="card-header">Status History</div>
              <div class="card-body">
                <div class="table-responsive">
                  <table class="table table-sm table-striped">
                    <thead>
                      <tr>
                        <th>Status</th>
                        <th>Time</th>
                        <th>Details</th>
                      </tr>
                    </thead>
                    <tbody id="status-history-table">
                      ${renderStatusHistory(statusHistory)}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" id="close-detail-button">Close</button>
          </div>
      </div>
    </div>
  `;
  
    document.body.appendChild(detailModal);
    
    // 关闭按钮事件
    document.getElementById('close-task-detail-modal').addEventListener('click', function() {
      document.body.removeChild(detailModal);
    });
    
    document.getElementById('close-detail-button').addEventListener('click', function() {
      document.body.removeChild(detailModal);
    });
    
  } catch (error) {
    console.error('查看任务详情失败:', error);
    showToast('查看任务详情失败: ' + error.message, 'error');
  }
}

// 渲染状态历史
function renderStatusHistory(statusHistory) {
  if (!statusHistory) return '<tr><td colspan="3" class="text-center">No status history</td></tr>';
  
  let history = statusHistory;
  if (typeof history === 'string') {
    try {
      history = JSON.parse(history);
    } catch (e) {
      return '<tr><td colspan="3" class="text-center">Failed to parse status history</td></tr>';
    }
  }
  
  if (!Array.isArray(history)) {
    const entries = [];
    for (const [status, timestamp] of Object.entries(history)) {
      entries.push({
        status: status,
        timestamp: timestamp,
        note: ''
      });
    }
    history = entries;
  }

  if (history.length === 0) {
    return '<tr><td colspan="3" class="text-center">No status history</td></tr>';
  }

  return history.map(entry => {
    let description = entry.description || entry.note || '';
    if (entry.txHash) {
      if (description) description += '<br>';
      description += `<a href="#" onclick="openExplorerUrl('${entry.txHash}'); return false;" class="text-primary">Transaction Hash: ${entry.txHash}</a>`;
    }
    
    return `
      <tr>
        <td><span class="badge ${getBadgeClass(entry.status)}">${entry.status}</span></td>
        <td>${new Date(entry.timestamp).toLocaleString()}</td>
        <td>${description}</td>
      </tr>
    `;
  }).join('');
}

// 打开浏览器地址
async function openExplorerUrl(txHash) {
  if (!txHash) return;
  
  try {
    const url = await getExplorerUrl(txHash);
    if (url) {
      window.open(url, '_blank');
    } else {
      console.error('无法获取浏览器地址');
    }
  } catch (error) {
    console.error('打开交易浏览器失败:', error);
  }
}

// 添加一个函数来更新浏览器链接
async function updateExplorerUrl(linkElement, txHash) {
  try {
    const response = await fetch(`${API_BASE_URL}/settlement-contract-info`);
    const result = await response.json();
    
    if (result.success && result.data.networkInfo && result.data.networkInfo.blockExplorer) {
      const explorerUrl = `${result.data.networkInfo.blockExplorer}/tx/${txHash}`;
      window.open(explorerUrl, '_blank');
    }
  } catch (error) {
    console.error('获取浏览器地址失败:', error);
  }
}

/**
 * 创建订单
 * @param {number} amount 订单金额
 * @param {string} description 订单描述
 * @returns {Promise<Object>} 订单信息
 */
async function createOrder(amount, description) {
  try {
    // 检查钱包连接
    if (!contractService.walletAddress) {
      showToast('error', '请先连接钱包');
      return null;
    }
    
    // 检查USDT余额
    const balance = await contractService.getUSDTBalance();
    if (balance < amount) {
      showToast('error', 'USDT余额不足');
      return null;
    }
    
    // 检查USDT授权
    const allowance = await contractService.checkUSDTAllowance();
    if (allowance < amount) {
      showToast('info', '正在请求USDT授权...');
      const approved = await contractService.approveUSDT(amount);
      if (!approved) {
        showToast('error', 'USDT授权失败');
        return null;
      }
    }
    
    // 选择LP
    const selectedLP = await showLPSelectionDialog(amount);
    if (!selectedLP) {
      return null;
    }
    
    // 验证LP选择
    const isValid = await handleLPSelection(selectedLP, amount);
    if (!isValid) {
      return null;
    }
    
    // 创建订单
    const response = await fetch('/api/order/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        amount,
        description,
        lpWalletAddress: selectedLP.walletAddress,
        userWalletAddress: contractService.walletAddress
      })
    });
    
    if (!response.ok) {
      throw new Error('创建订单失败');
    }
    
    const data = await response.json();
    if (!data.success) {
      throw new Error(data.message || '创建订单失败');
    }
    
    // 锁定USDT
    const locked = await contractService.lockUSDT(amount, data.data.orderId);
    if (!locked) {
      showToast('error', '锁定USDT失败');
      return null;
    }
    
    showToast('success', '订单创建成功');
    return data.data;
    
  } catch (error) {
    console.error('创建订单失败:', error);
    showToast('error', error.message || '创建订单失败');
    return null;
  }
}

// 处理提币请求
async function handleWithdrawal(paymentIntentId) {
  try {
    const response = await fetch('/api/request-withdrawal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        paymentIntentId
      })
    });
    
    const result = await response.json();
    if (!result.success) {
      showToast('error', '申请提币失败: ' + result.error);
      return false;
    }
    
    showToast('success', '提币申请已提交');
    return true;
  } catch (error) {
    console.error('申请提币失败:', error);
    showToast('error', '申请提币失败: ' + error.message);
    return false;
  }
}

// 修改交易记录渲染函数
function renderTransactionHistory(transactions) {
  const tbody = document.getElementById('transaction-history-table');
  if (!tbody) return;
  
  tbody.innerHTML = '';
  
  if (!transactions || transactions.length === 0) {
    const row = document.createElement('tr');
    row.innerHTML = '<td colspan="6" class="text-center">暂无交易记录</td>';
    tbody.appendChild(row);
    return;
  }
  
  transactions.forEach(tx => {
    const row = document.createElement('tr');
    
    // 基本信息
    row.innerHTML = `
      <td>${tx.id}</td>
      <td>${tx.amount} USDT</td>
      <td>${new Date(tx.createdAt).toLocaleString()}</td>
    `;
    
    // 锁定状态
    const statusCell = document.createElement('td');
    statusCell.innerHTML = `
      <span class="badge ${getEscrowStatusBadgeClass(tx.escrowStatus)}">
        ${getEscrowStatusText(tx.escrowStatus)}
      </span>
    `;
    row.appendChild(statusCell);
    
    // 提现状态
    const withdrawalCell = document.createElement('td');
    if (tx.withdrawalStatus) {
      withdrawalCell.innerHTML = `
        <span class="badge ${getWithdrawalStatusBadgeClass(tx.withdrawalStatus)}">
          ${getWithdrawalStatusText(tx.withdrawalStatus)}
        </span>
      `;
    } else {
      withdrawalCell.textContent = '-';
    }
    row.appendChild(withdrawalCell);
    
    // 操作按钮
    const actionsCell = document.createElement('td');
    
    // 查看详情按钮
    const detailBtn = document.createElement('button');
    detailBtn.className = 'btn btn-sm btn-info';
    detailBtn.textContent = '详情';
    detailBtn.onclick = () => showTaskDetail(tx.id);
    actionsCell.appendChild(detailBtn);
    
    // 确认按钮和倒计时
    if (tx.escrowStatus === 'locked' && tx.lockExpireTime) {
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'btn btn-sm btn-primary ms-2';
      confirmBtn.textContent = '确认';
      confirmBtn.onclick = () => confirmTransaction(tx.id);
      actionsCell.appendChild(confirmBtn);

      const countdownSpan = document.createElement('span');
      countdownSpan.className = 'text-warning ms-2';
      actionsCell.appendChild(countdownSpan);
      
      const timer = updateCountdown(countdownSpan, tx.lockExpireTime);
      countdownSpan.dataset.timerId = timer;
    }
    
    // 提现按钮
    if (tx.escrowStatus === 'released' && tx.withdrawalTime) {
      const withdrawalTime = new Date(tx.withdrawalTime);
      const now = new Date();
      
      if (now >= withdrawalTime) {
        const withdrawBtn = document.createElement('button');
        withdrawBtn.className = 'btn btn-sm btn-success ms-2';
        withdrawBtn.textContent = '提现';
        withdrawBtn.onclick = () => handleWithdrawal(tx.id);
        actionsCell.appendChild(withdrawBtn);
      } else {
        const timeLeft = Math.max(0, withdrawalTime - now);
        const hours = Math.floor(timeLeft / (60 * 60 * 1000));
        const countdownSpan = document.createElement('span');
        countdownSpan.className = 'text-muted ms-2';
        countdownSpan.textContent = `还需等待 ${hours} 小时`;
        actionsCell.appendChild(countdownSpan);
      }
    }
    
    row.appendChild(actionsCell);
    tbody.appendChild(row);
  });
}

// 添加确认交易功能
async function confirmTransaction(paymentIntentId) {
  try {
    const response = await fetch(`${API_BASE_URL}/payment-intents/confirm/${paymentIntentId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`确认失败: ${response.status}`);
    }

    const result = await response.json();
    if (result.success) {
      showToast('success', '交易已确认');
//       await loadTransactionHistory(); // 刷新列表
    } else {
      throw new Error(result.error || '确认失败');
    }
  } catch (error) {
    console.error('确认交易失败:', error);
    showToast('error', '确认失败: ' + error.message);
  }
}

// 添加倒计时功能
function updateCountdown(element, targetTime) {
  const update = () => {
    const now = new Date();
    const target = new Date(targetTime);
    const diff = target - now;

    if (diff <= 0) {
      element.textContent = '已到期';
      return;
    }

    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    element.textContent = `${hours}时${minutes}分${seconds}秒`;
  };

  update();
  return setInterval(update, 1000);
}

// 添加锁定状态样式
function getEscrowStatusBadgeClass(status) {
  switch(status) {
    case 'locked':
      return 'bg-warning';
    case 'confirmed':
      return 'bg-info';
    case 'released':
      return 'bg-success';
    default:
      return 'bg-secondary';
  }
}

// 添加锁定状态文本
function getEscrowStatusText(status) {
  switch(status) {
    case 'locked':
      return '已锁定';
    case 'confirmed':
      return '已确认';
    case 'released':
      return '已释放';
    default:
      return status;
  }
}

// 添加提现状态样式
function getWithdrawalStatusBadgeClass(status) {
  switch(status) {
    case 'pending':
      return 'bg-warning';
    case 'processing':
      return 'bg-info';
    case 'completed':
      return 'bg-success';
    case 'failed':
      return 'bg-danger';
    default:
      return 'bg-secondary';
  }
}

// 添加提现状态文本
function getWithdrawalStatusText(status) {
  switch(status) {
    case 'pending':
      return '待处理';
    case 'processing':
      return '处理中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    default:
      return status;
  }
}

// 选择LP处理订单
async function selectLPForOrder(orderId) {
  try {
    const order = await fetchOrderDetails(orderId);
    if (!order) {
      showNotification('订单不存在', 'error');
      return;
    }

    // 检查LP余额
    const hasEnoughBalance = await contractService.checkLPEscrowBalance(
      currentWallet,
      order.amount
    );

    if (!hasEnoughBalance) {
      showNotification('托管资金不足，请先充值', 'error');
      return;
    }

    // 锁定资金
    await contractService.lockUSDT(
      order.amount,
      orderId,
      currentWallet
    );

    // 更新订单状态
    await fetch('/api/payment-intents/lp/assign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        orderId,
        lpWalletAddress: currentWallet
      })
    });

    showNotification('成功接单', 'success');
    updateTaskList();
  } catch (error) {
    console.error('接单失败:', error);
    showNotification('接单失败: ' + error.message, 'error');
  }
}

// 显示LP选择模态框
function showLPSelectionModal(orderId) {
  const modal = document.createElement('div');
  modal.className = 'modal fade';
  modal.id = 'lpSelectionModal';
  modal.innerHTML = `
    <div class="modal-dialog">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title">选择LP</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body">
          <div class="mb-3">
            <label class="form-label">可用托管额度</label>
            <div id="availableEscrow" class="form-control"></div>
          </div>
          <div class="mb-3">
            <label class="form-label">订单金额</label>
            <div id="orderAmount" class="form-control"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">取消</button>
          <button type="button" class="btn btn-primary" id="confirmLPSelection">确认接单</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  const modalInstance = new bootstrap.Modal(modal);
  modalInstance.show();

  // 加载数据
  loadLPSelectionData(orderId);

  // 绑定事件
  document.getElementById('confirmLPSelection').addEventListener('click', () => {
    selectLPForOrder(orderId);
    modalInstance.hide();
  });

  modal.addEventListener('hidden.bs.modal', () => {
    modal.remove();
  });
}

// 加载LP选择数据
async function loadLPSelectionData(orderId) {
  try {
    const order = await fetchOrderDetails(orderId);
    const availableEscrow = await contractService.getLPAvailableEscrow(currentWallet);

    document.getElementById('availableEscrow').textContent = `${availableEscrow} USDT`;
    document.getElementById('orderAmount').textContent = `${order.amount} USDT`;

    const confirmButton = document.getElementById('confirmLPSelection');
    confirmButton.disabled = parseFloat(availableEscrow) < parseFloat(order.amount);
  } catch (error) {
    console.error('加载LP数据失败:', error);
    showNotification('加载数据失败', 'error');
  }
}

// 检查LP托管资金
async function checkLPEscrowBalance() {
  try {
    const balance = await contractService.getLPAvailableEscrow(currentWallet);
    return parseFloat(balance);
  } catch (error) {
    console.error('检查托管余额失败:', error);
    showNotification('检查托管余额失败', 'error');
    return 0;
  }
}

// 更新LP托管余额显示
async function updateEscrowBalance() {
  try {
    const escrowContract = await contractService.getEscrowContract();
    const currentWallet = localStorage.getItem('currentWallet');
    const balance = await escrowContract.methods.getEscrowBalance(currentWallet).call();
    const balanceInEth = web3.utils.fromWei(balance, 'ether');
    document.getElementById('escrowBalance').textContent = balanceInEth;
  } catch (error) {
    console.error('获取托管余额失败:', error);
    document.getElementById('escrowBalance').textContent = '获取失败';
  }
}

// 处理LP接单
async function handleTaskClaim(taskId) {
  try {
    const task = await fetchOrderDetails(taskId);
    if (!task) {
      showNotification('订单不存在', 'error');
      return;
    }

    // 检查托管余额
    const escrowBalance = await checkLPEscrowBalance();
    if (escrowBalance < parseFloat(task.amount)) {
      showNotification('托管资金不足，请先充值', 'error');
      return;
    }

    // 锁定资金
    await contractService.lockUSDT(
      task.amount,
      taskId,
      currentWallet
    );

    // 更新订单状态
    await fetch('/api/payment-intents/lp/assign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        orderId: taskId,
        lpWalletAddress: currentWallet
      })
    });

    showNotification('成功接单', 'success');
    updateTaskList();
    updateEscrowBalance();
  } catch (error) {
    console.error('接单失败:', error);
    showNotification('接单失败: ' + error.message, 'error');
  }
}

// 在页面加载时更新托管余额
document.addEventListener('DOMContentLoaded', () => {
  if (currentWallet) {
    updateEscrowBalance();
  }
});

// 在钱包连接后更新托管余额
async function onWalletConnected(address) {
  currentWallet = address;
  updateWalletConnectionUI(true, address);
  await updateEscrowBalance();
  await loadTaskPool();
}

// 释放托管资金
async function releaseEscrowFunds(orderId) {
  try {
    const escrowContract = await contractService.getEscrowContract();
    const accounts = await web3.eth.getAccounts();
    
    await escrowContract.methods.releaseFunds(orderId)
      .send({ from: accounts[0] });
    
    showNotification('资金已释放', 'success');
    updateEscrowBalance();
    updateTaskList();
  } catch (error) {
    console.error('释放资金失败:', error);
    showNotification('释放资金失败: ' + error.message, 'error');
  }
}

// 处理订单完成
async function handleOrderComplete(orderId) {
  try {
    // 释放托管资金
    await releaseEscrowFunds(orderId);
    
    // 更新订单状态
    await fetch(`/api/payment-intents/${orderId}/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    showNotification('订单已完成', 'success');
    updateTaskList();
  } catch (error) {
    console.error('完成订单失败:', error);
    showNotification('完成订单失败: ' + error.message, 'error');
  }
}

// 更新任务列表中的操作按钮
function updateTaskActions(task) {
  const actions = [];
  
  if (task.status === 'pending') {
    actions.push(`
      <button class="btn btn-primary btn-sm" onclick="handleTaskClaim('${task.id}')">
        接单
      </button>
    `);
  } else if (task.status === 'processing') {
    actions.push(`
      <button class="btn btn-success btn-sm" onclick="handleOrderComplete('${task.id}')">
        完成订单
      </button>
    `);
  }
  
  return actions.join('');
}

// 充值托管资金
async function depositEscrowFunds(amount) {
  try {
    const escrowContract = await contractService.getEscrowContract();
    const accounts = await web3.eth.getAccounts();
    
    await escrowContract.methods.deposit()
      .send({ 
        from: accounts[0],
        value: web3.utils.toWei(amount.toString(), 'ether')
      });
    
    showNotification('托管资金充值成功', 'success');
    updateEscrowBalance();
  } catch (error) {
    console.error('充值托管资金失败:', error);
    showNotification('充值失败: ' + error.message, 'error');
  }
}

// 显示充值模态框
function showDepositModal() {
  const modal = document.createElement('div');
  modal.className = 'modal fade';
  modal.id = 'depositModal';
  modal.innerHTML = `
    <div class="modal-dialog">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title">充值托管资金</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
        </div>
        <div class="modal-body">
          <div class="mb-3">
            <label class="form-label">充值金额 (USDT)</label>
            <input type="number" class="form-control" id="depositAmount" min="0" step="0.01">
          </div>
          <div class="mb-3">
            <label class="form-label">当前托管余额</label>
            <div id="currentEscrowBalance" class="form-control"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">取消</button>
          <button type="button" class="btn btn-primary" id="confirmDeposit">确认充值</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  const modalInstance = new bootstrap.Modal(modal);
  modalInstance.show();

  // 加载当前余额
  updateEscrowBalance().then(() => {
    const balanceElement = document.getElementById('currentEscrowBalance');
    if (balanceElement) {
      balanceElement.textContent = `${balance} USDT`;
    }
  });

  // 绑定事件
  document.getElementById('confirmDeposit').addEventListener('click', async () => {
    const amount = document.getElementById('depositAmount').value;
    if (!amount || parseFloat(amount) <= 0) {
      showNotification('请输入有效的充值金额', 'error');
      return;
    }
    await depositEscrowFunds(amount);
    modalInstance.hide();
  });

  modal.addEventListener('hidden.bs.modal', () => {
    modal.remove();
  });
}

// 更新托管状态显示
function updateEscrowStatus(task) {
  const statusElement = document.getElementById(`escrowStatus-${task.id}`);
  if (statusElement) {
    const status = task.escrowStatus || 'pending';
    statusElement.className = `badge ${getEscrowStatusBadgeClass(status)}`;
    statusElement.textContent = getEscrowStatusText(status);
  }
}

// 监听托管事件
async function initEscrowEvents() {
  try {
    await contractService.listenEscrowEvents((eventType, data) => {
      if (eventType === 'locked') {
        showNotification('资金已锁定', 'success');
        updateEscrowBalance();
        updateTaskList();
      } else if (eventType === 'released') {
        showNotification('资金已释放', 'success');
        updateEscrowBalance();
        updateTaskList();
      }
    });
  } catch (error) {
    console.error('初始化托管事件监听失败:', error);
  }
}

// 在页面加载时初始化事件监听
document.addEventListener('DOMContentLoaded', () => {
  if (currentWallet) {
    initEscrowEvents();
  }
});

// ... existing code ...
  // 初始化页面
  async function initPage() {
    try {
      // 检查钱包连接状态
      const currentWallet = localStorage.getItem('currentWallet');
      if (!currentWallet) {
        showNotification('请先连接钱包', 'warning');
        return;
      }

      // 添加托管余额显示和充值按钮
      const headerContainer = document.createElement('div');
      headerContainer.className = 'd-flex justify-content-between align-items-center mb-4';
      headerContainer.innerHTML = `
        <div class="escrow-balance">
          <h5>托管余额: <span id="escrowBalance">加载中...</span> USDT</h5>
        </div>
        <button class="btn btn-primary" onclick="showDepositModal()">
          充值托管资金
        </button>
      `;
      document.querySelector('.container').insertBefore(headerContainer, document.getElementById('taskList'));

      // 更新托管余额
      await updateEscrowBalance();

      // 初始化托管事件监听
      await initEscrowEvents();

      // 加载交易历史
      await updateTaskList();
    } catch (error) {
      console.error('初始化页面失败:', error);
      showNotification('初始化页面失败: ' + error.message, 'error');
    }
  }

  // 更新托管余额显示
  async function updateEscrowBalance() {
    try {
      const escrowContract = await contractService.getEscrowContract();
      const currentWallet = localStorage.getItem('currentWallet');
      const balance = await escrowContract.methods.getEscrowBalance(currentWallet).call();
      const balanceInEth = web3.utils.fromWei(balance, 'ether');
      document.getElementById('escrowBalance').textContent = balanceInEth;
    } catch (error) {
      console.error('获取托管余额失败:', error);
      document.getElementById('escrowBalance').textContent = '获取失败';
    }
  }
// ... existing code ...

/**
 * 显示LP选择对话框
 * @param {number} amount 订单金额
 * @returns {Promise<string>} 选中的LP地址
 */
async function showLPSelectionDialog(amount) {
  return new Promise(async (resolve, reject) => {
    try {
      const lpList = await getAvailableLPs();
      if (!lpList || lpList.length === 0) {
        showToast('error', '没有可用的LP');
        reject(new Error('No available LPs'));
        return;
      }

      const modal = document.getElementById('lpSelectionModal');
      const lpListContainer = document.getElementById('lpList');
      lpListContainer.innerHTML = '';

      lpList.forEach(lp => {
        const row = document.createElement('tr');
        row.innerHTML = `
          <td>${lp.name || '未命名'}</td>
          <td>${lp.walletAddress}</td>
          <td>${lp.availableBalance} USDT</td>
          <td>
            <button class="btn btn-primary btn-sm select-lp" data-address="${lp.walletAddress}">
              选择
            </button>
          </td>
        `;
        lpListContainer.appendChild(row);
      });

      // 绑定选择按钮事件
      const selectButtons = modal.querySelectorAll('.select-lp');
      selectButtons.forEach(button => {
        button.addEventListener('click', () => {
          const selectedAddress = button.getAttribute('data-address');
          $(modal).modal('hide');
          resolve(selectedAddress);
        });
      });

      $(modal).modal('show');

      // 处理关闭事件
      $(modal).on('hidden.bs.modal', () => {
        reject(new Error('LP selection cancelled'));
      });
    } catch (error) {
      console.error('Error showing LP selection dialog:', error);
      showToast('error', '显示LP选择对话框失败');
      reject(error);
    }
  });
}

// 加载LP列表
async function loadLPList() {
  try {
    const response = await fetch(`${API_BASE_URL}/lp/list`);
    const result = await response.json();
    
    if (result.success) {
      return result.data;
    } else {
      console.error('获取LP列表失败:', result.message);
      return [];
    }
  } catch (error) {
    console.error('获取LP列表失败:', error);
    return [];
  }
}

/**
 * 获取可用的LP列表
 * @returns {Promise<Array>} LP列表
 */
async function getAvailableLPs() {
  try {
    const response = await fetch('/api/lp/available');
    if (!response.ok) {
      throw new Error('获取LP列表失败');
    }
    const data = await response.json();
    return data.success ? data.data.lps : [];
  } catch (error) {
    console.error('获取LP列表失败:', error);
    showToast('error', '获取LP列表失败');
    return [];
  }
}

/**
 * 显示LP选择对话框
 * @param {number} amount 订单金额
 * @returns {Promise<Object|null>} 选择的LP信息
 */
async function showLPSelectionDialog(amount) {
  return new Promise(async (resolve) => {
    try {
      // 获取LP列表
      const lps = await getAvailableLPs();
      
      // 过滤出可用额度足够的LP
      const availableLPs = lps.filter(lp => 
        lp.availableQuota >= amount && 
        lp.perTransactionQuota >= amount
      );
      
      if (availableLPs.length === 0) {
        showToast('error', '没有找到符合条件的LP');
        resolve(null);
        return;
      }
      
      // 创建对话框
      const dialog = document.createElement('div');
      dialog.className = 'lp-selection-dialog';
      dialog.innerHTML = `
        <div class="dialog-content">
          <h3>选择LP</h3>
          <div class="lp-list">
            ${availableLPs.map(lp => `
              <div class="lp-item" data-wallet="${lp.walletAddress}">
                <div class="lp-info">
                  <div>钱包地址: ${lp.walletAddress}</div>
                  <div>可用额度: ${lp.availableQuota} USDT</div>
                  <div>单笔限额: ${lp.perTransactionQuota} USDT</div>
                </div>
                <button class="select-lp-btn">选择</button>
              </div>
            `).join('')}
          </div>
          <button class="close-dialog-btn">取消</button>
        </div>
      `;
      
      // 添加样式
      const style = document.createElement('style');
      style.textContent = `
        .lp-selection-dialog {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0, 0, 0, 0.5);
          display: flex;
          justify-content: center;
          align-items: center;
          z-index: 1000;
        }
        .dialog-content {
          background: white;
          padding: 20px;
          border-radius: 8px;
          max-width: 600px;
          width: 90%;
          max-height: 80vh;
          overflow-y: auto;
        }
        .lp-item {
          border: 1px solid #ddd;
          padding: 10px;
          margin: 10px 0;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .select-lp-btn {
          padding: 5px 15px;
          background: #007bff;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
        }
        .close-dialog-btn {
          margin-top: 20px;
          padding: 8px 20px;
          background: #6c757d;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
        }
      `;
      
      document.head.appendChild(style);
      document.body.appendChild(dialog);
      
      // 处理选择事件
      dialog.addEventListener('click', async (e) => {
        if (e.target.classList.contains('select-lp-btn')) {
          const walletAddress = e.target.closest('.lp-item').dataset.wallet;
          const selectedLP = availableLPs.find(lp => lp.walletAddress === walletAddress);
          dialog.remove();
          resolve(selectedLP);
        } else if (e.target.classList.contains('close-dialog-btn')) {
          dialog.remove();
          resolve(null);
        }
      });
      
    } catch (error) {
      console.error('显示LP选择对话框失败:', error);
      showToast('error', '显示LP选择对话框失败');
      resolve(null);
    }
  });
}

/**
 * 处理LP选择
 * @param {Object} lp 选择的LP信息
 * @param {number} amount 订单金额
 * @returns {boolean} 是否选择成功
 */
async function handleLPSelection(lp, amount) {
  try {
    if (!lp) {
      showToast('error', '未选择LP');
      return false;
    }
    
    // 验证LP额度
    if (lp.availableQuota < amount) {
      showToast('error', 'LP可用额度不足');
      return false;
    }
    
    if (lp.perTransactionQuota < amount) {
      showToast('error', '超出LP单笔交易限额');
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('处理LP选择失败:', error);
    showToast('error', '处理LP选择失败');
    return false;
  }
}

// 获取交易状态对应的标记CSS类
function getBadgeClass(status) {
  switch(status.toLowerCase()) {
    case 'created': return 'bg-primary';
    case 'pending': return 'bg-primary';
    case 'claimed': return 'bg-info';
    case 'paid': return 'bg-success';
    case 'confirmed': 
    case 'user_confirmed': return 'bg-info';
    case 'settled': return 'bg-secondary';
    case 'canceled': 
    case 'cancelled': 
    case 'expired': return 'bg-danger';
    default: return 'bg-secondary';
  }
}

/* 标记任务已支付 - PayPal方式 */
async function markTaskPaidWithPayPal(taskId) {
  try {
    // 确保任务列表已加载
    if (!taskList || !Array.isArray(taskList)) {
      console.log('任务列表未加载，尝试加载任务池...');
      await loadTaskPool(currentTaskTab);
      
      if (!taskList || !Array.isArray(taskList)) {
        showToast('无法加载任务信息，请刷新页面重试', 'error');
        return;
      }
    }
    
    // 查找任务
    let task = taskList.find(t => t.id == taskId);
    
    if (!task) {
      // 如果在当前标签页找不到，尝试直接请求
      try {
        console.log(`在当前任务列表中未找到任务ID ${taskId}，尝试直接请求...`);
        const response = await fetch(`${API_BASE_URL}/lp/task/${taskId}`);
        
        if (!response.ok) {
          throw new Error(`获取任务详情失败: ${response.status}`);
        }
        
        const result = await response.json();
        if (!result.success || !result.data) {
          throw new Error('获取任务详情返回无效数据');
        }
        
        // 使用API获取的任务数据
        task = result.data;
      } catch (fetchError) {
        console.error('直接获取任务失败:', fetchError);
        showToast('无法找到任务信息', 'error');
        return;
      }
    }
    
    if (!task) {
      showToast('无法找到任务信息', 'error');
      return;
    }

    // 检查任务状态，如果已经是已支付状态，显示提示信息并退出
    if (task.status === 'paid') {
      console.log('该任务已经处于支付状态，无需再次支付');
      showToast('该任务已经支付完成，无需再次支付', 'warning');
      return;
    }

    console.log('准备通过PayPal支付任务:', task);
    
    // 格式化金额
    const formattedAmount = parseFloat(task.amount).toFixed(2);
    
    // 创建支付确认模态框
    const paymentConfirmation = document.createElement('div');
    paymentConfirmation.id = 'payment-confirmation';
    paymentConfirmation.className = 'modal fade show';
    paymentConfirmation.style.display = 'block';
    document.body.appendChild(paymentConfirmation);

    // 在创建PayPal订单之前，先获取任务的商家邮箱信息
    console.log('开始获取商家信息...');
    let merchantEmail = null;
    let merchantEmailSource = "未知";
    let merchantInfoDetails = null;

    try {
      // 首先尝试从任务本身获取merchantInfo
      if (task.merchantInfo && typeof task.merchantInfo === 'object') {
        console.log('尝试从任务merchantInfo字段获取商家邮箱');
        if (task.merchantInfo.paypalEmail && 
            task.merchantInfo.paypalEmail.includes('@') && 
            !task.merchantInfo.paypalEmail.includes('personal.example.com')) {
          merchantEmail = task.merchantInfo.paypalEmail;
          merchantEmailSource = "支付订单商家信息";
          console.log(`从任务商家信息获取到PayPal邮箱: ${merchantEmail}`);
        }
      }
      
      // 其次尝试从任务merchantPaypalEmail字段获取
      if (!merchantEmail && task.merchantPaypalEmail && 
          task.merchantPaypalEmail.includes('@') && 
          !task.merchantPaypalEmail.includes('personal.example.com')) {
        merchantEmail = task.merchantPaypalEmail;
        merchantEmailSource = "支付订单商家邮箱";
        console.log(`从任务merchantPaypalEmail字段获取邮箱: ${merchantEmail}`);
      }
      
      // 最后尝试通过API获取
      if (!merchantEmail) {
        console.log('通过API获取商家信息:', `${API_BASE_URL}/payment/paypal/merchant-info/${task.id}`);
        const merchantInfoResponse = await fetch(`${API_BASE_URL}/payment/paypal/merchant-info/${task.id}`);
        
        if (merchantInfoResponse.ok) {
          const merchantInfo = await merchantInfoResponse.json();
          console.log('API返回的商家信息:', merchantInfo);
          
          if (merchantInfo.success && merchantInfo.data) {
            merchantInfoDetails = merchantInfo.data;
            if (merchantInfo.data.email && merchantInfo.data.email.includes('@') &&
                !merchantInfo.data.email.includes('personal.example.com')) {
              merchantEmail = merchantInfo.data.email;
              merchantEmailSource = merchantInfo.data.sourceType || "API获取";
              console.log(`从API获取到商家PayPal邮箱: ${merchantEmail}, 来源: ${merchantEmailSource}`);
            } else {
              console.warn('API返回的商家邮箱无效:', merchantInfo.data.email);
            }
          } else {
            console.error('API返回商家信息失败:', merchantInfo);
          }
        } else {
          console.error('获取商家信息API调用失败:', await merchantInfoResponse.text());
        }
      }
    } catch (error) {
      console.error('获取商家信息过程中出错:', error);
    }

    // 如果所有尝试都失败，使用系统默认值
    if (!merchantEmail || !merchantEmail.includes('@') || merchantEmail.includes('personal.example.com')) {
      console.warn('无法获取有效的商家邮箱，尝试获取系统默认值');
      try {
        const configResponse = await fetch(`${API_BASE_URL}/payment/paypal/config`);
        if (configResponse.ok) {
          const config = await configResponse.json();
          if (config.data && config.data.defaultMerchantEmail) {
            merchantEmail = config.data.defaultMerchantEmail;
            merchantEmailSource = "系统默认";
            console.log(`使用系统默认商家邮箱: ${merchantEmail}`);
          }
        }
      } catch (error) {
        console.error('获取系统默认商家邮箱失败:', error);
      }
    }
    
    // 最后的保底措施 - 使用硬编码的默认值
    if (!merchantEmail || !merchantEmail.includes('@') || merchantEmail.includes('personal.example.com')) {
      merchantEmail = 'sb-o3jcs29741632@business.example.com';
      merchantEmailSource = "硬编码默认";
      console.log(`使用硬编码默认商家邮箱: ${merchantEmail}`);
    }

    // 创建支付UI
    paymentConfirmation.innerHTML = `
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">Confirm PayPal Payment</h5>
            <button type="button" class="btn-close" id="close-payment-confirmation"></button>
          </div>
          <div class="modal-body">
            <div class="alert alert-info">
              <div class="d-flex align-items-center mb-2">
                <i class="bi bi-info-circle me-2"></i>
                <strong>Payment Information</strong>
              </div>
              <p>Task ID: ${task.id}</p>
              <p>Payment Amount: $${formattedAmount} ${task.currency || 'USD'}</p>
              <p>Description: ${task.description || 'No description'}</p>
              <p class="text-primary"><strong>Merchant: ${merchantEmail}</strong></p>
              <p class="text-muted small">Merchant Email Source: ${merchantEmailSource}</p>
            </div>
            <div class="alert alert-warning">
              <i class="bi bi-exclamation-triangle me-2"></i>
              <strong>Please confirm the merchant email is correct before proceeding.</strong> After payment is completed, the system will automatically update the task status.
            </div>
            <div class="alert alert-secondary">
              <small>The payment will be processed through PayPal using your PayPal account. Please ensure you have sufficient balance.</small>
            </div>
            <div id="paypal-button-container"></div>
            <div class="text-center mt-3">
              <button type="button" class="btn btn-secondary" id="cancel-payment">Cancel</button>
            </div>
          </div>
        </div>
      </div>
    `;

    // 添加关闭和取消事件处理
    document.getElementById('close-payment-confirmation').addEventListener('click', () => {
      document.body.removeChild(paymentConfirmation);
    });

    document.getElementById('cancel-payment').addEventListener('click', () => {
      document.body.removeChild(paymentConfirmation);
    });

    // 确保PayPal SDK已加载
    if (typeof paypal === 'undefined') {
      console.log('PayPal SDK未加载，开始加载...');
      await loadPayPalSDK();
    }
    
    console.log('渲染PayPal按钮...');
    // 渲染PayPal按钮
    paypal.Buttons({
      style: {
        layout: 'vertical',
        color: 'blue',
        shape: 'rect',
        label: 'pay'
      },
      
      createOrder: async function() {
        try {
          console.log('创建PayPal订单，使用商家邮箱:', merchantEmail);
          // 创建PayPal订单
          const orderResponse = await fetch(`${API_BASE_URL}/payment/paypal/create-order`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              paymentIntentId: task.id,
              amount: task.amount,
              currency: task.currency || 'USD',
              description: task.description || 'UnitPay Payment',
              merchantPaypalEmail: merchantEmail // 确保使用有效的商家邮箱
            })
          });
          
          if (!orderResponse.ok) {
            const errorData = await orderResponse.json();
            console.error('创建PayPal订单API返回错误:', errorData);
            throw new Error(errorData.message || '创建PayPal订单失败');
          }
          
          const orderResult = await orderResponse.json();
          
          if (!orderResult.success) {
            console.error('创建订单返回失败状态:', orderResult);
            throw new Error(orderResult.message || '创建PayPal订单返回失败状态');
          }
          
          const orderId = orderResult.data.paypalOrderId;
          console.log('PayPal订单创建成功:', orderId);
          return orderId;
        } catch (error) {
          console.error('创建PayPal订单发生错误:', error);
          alert(`创建PayPal订单失败: ${error.message}`);
          document.body.removeChild(paymentConfirmation);
          throw error;
        }
      },
      
      onApprove: async function(data, actions) {
        try {
          console.log('PayPal支付已批准，OrderID:', data.orderID);
          
          // 显示处理中状态
          const paypalButtonContainer = document.getElementById('paypal-button-container');
          if (paypalButtonContainer) {
            paypalButtonContainer.innerHTML = '<div class="text-center"><div class="spinner-border" role="status"></div><p class="mt-2">支付处理中，请稍候...</p></div>';
          }
          
          // 添加任务信息到记录中
          console.log('捕获支付的任务信息:', { 
            taskId, 
            amount: task.amount,
            currency: task.currency,
            merchantEmail
          });
          
          // 捕获支付
          const captureResponse = await fetch(`${API_BASE_URL}/payment/paypal/capture-order`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              orderId: data.orderID,
              paymentIntentId: taskId,
              merchantPaypalEmail: merchantEmail // 传递商家邮箱确保一致性
            })
          });
          
          if (!captureResponse.ok) {
            const errorData = await captureResponse.json();
            console.error('支付捕获失败, 状态码:', captureResponse.status, '错误信息:', errorData);
            throw new Error(errorData.message || '支付捕获失败');
          }
          
          const captureResult = await captureResponse.json();
          
          if (!captureResult.success) {
            console.error('捕获返回失败状态:', captureResult);
            throw new Error(captureResult.message || '支付捕获返回失败状态');
          }
          
          // 支付捕获成功
          console.log('PayPal支付捕获成功:', captureResult);
          
          // 移除PayPal按钮，显示成功信息
          if (paypalButtonContainer) {
            paypalButtonContainer.innerHTML = `
              <div class="alert alert-success text-center">
                <i class="bi bi-check-circle-fill me-2"></i>
                <strong>支付成功!</strong><br>
                <span>交易ID: ${captureResult.data?.transactionId || captureResult.purchase_units?.[0]?.payments?.captures?.[0]?.id || data.orderID}</span><br>
                <small class="text-muted">您的PayPal支付已完成</small>
              </div>
            `;
          }
          
          // 更新UI，标记任务为已支付
          const taskElement = document.querySelector(`[data-task-id="${taskId}"]`);
          if (taskElement) {
            const statusBadge = taskElement.querySelector('.badge');
            if (statusBadge) {
              statusBadge.className = 'badge bg-success';
              statusBadge.textContent = '已支付';
            }
          }
          
          // 更新任务状态
          const markPaidResponse = await fetch(`${API_BASE_URL}/lp/task/${taskId}/mark-paid`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              platform: 'PayPal',
              transactionId: captureResult.data?.transactionId || captureResult.purchase_units?.[0]?.payments?.captures?.[0]?.id || data.orderID,
              paymentDetails: {
                paypalOrderId: data.orderID,
                payerEmail: captureResult.data?.payerEmail || captureResult.purchase_units?.[0]?.payee?.email_address || 'unknown',
                merchantEmail: merchantEmail
              }
            })
          });
          
          if (!markPaidResponse.ok) {
            console.warn('API标记任务已支付失败, 状态码:', markPaidResponse.status);
            // 即使API调用失败，用户也已经付款了，所以我们不应该中断流程
          } else {
            const markPaidResult = await markPaidResponse.json();
            console.log('标记任务已支付API结果:', markPaidResult);
          }
          
          // 显示成功信息
          showToast('PayPal支付成功！任务已标记为已支付', 'success');
          
          // 刷新任务池
          setTimeout(() => {
            // 3秒后移除确认框并刷新任务
            document.body.removeChild(paymentConfirmation);
            loadTaskPool(currentTaskTab);
          }, 3000);
          
        } catch (error) {
          console.error('PayPal支付处理失败:', error);
          
          const paypalButtonContainer = document.getElementById('paypal-button-container');
          if (paypalButtonContainer) {
            paypalButtonContainer.innerHTML = `
              <div class="alert alert-danger text-center">
                <i class="bi bi-exclamation-circle-fill me-2"></i>
                <strong>支付处理失败</strong><br>
                <span>${error.message}</span><br>
                <button class="btn btn-sm btn-outline-danger mt-2" id="retry-payment">重试</button>
              </div>
            `;
            
            document.getElementById('retry-payment')?.addEventListener('click', () => {
              // 移除现有模态框
              document.body.removeChild(paymentConfirmation);
              // 重新尝试支付流程
              markTaskPaidWithPayPal(taskId);
            });
          }
        }
      },
      
      onCancel: function() {
        console.log('用户取消了PayPal支付');
        showToast('PayPal支付已取消', 'info');
        
        // 移除支付确认模态框
        document.body.removeChild(paymentConfirmation);
      },
      
      onError: function(error) {
        console.error('PayPal按钮发生错误:', error);
        showToast('PayPal支付过程中发生错误: ' + error.message, 'error');
        
        // 移除支付确认模态框
        document.body.removeChild(paymentConfirmation);
      }
      
    }).render('#paypal-button-container');
    
  } catch (error) {
    console.error('标记任务已支付失败:', error);
    showToast('标记任务已支付失败: ' + error.message, 'error');
  }
}

// 从状态历史中获取确认时间
function getConfirmTime(transaction) {
  // 使用交易的date字段作为确认时间
  if (transaction.date) {
    return new Date(transaction.date);
  }
  
  // 如果没有date字段，尝试从状态历史中获取确认时间
  if (transaction.statusHistory) {
    let history = transaction.statusHistory;
    if (typeof history === 'string') {
      try {
        history = JSON.parse(history);
      } catch (e) {
        console.error('解析状态历史失败:', e);
        return null;
      }
    }
    
    if (Array.isArray(history)) {
      // 查找confirmed状态的记录
      const confirmedEntry = history.find(entry => entry.status === 'confirmed' || entry.status === 'user_confirmed');
      if (confirmedEntry && confirmedEntry.timestamp) {
        return new Date(confirmedEntry.timestamp);
      }
    }
  }
  
  return null;
}

// 初始化并更新所有倒计时
function initCountdowns() {
  const countdowns = document.querySelectorAll('.countdown-timer');
  countdowns.forEach(element => {
    const releaseTime = new Date(element.dataset.releaseTime);
    updateCountdown(element, releaseTime);
  });
}

// 更新单个倒计时元素
function updateCountdown(element, targetTime) {
  const update = () => {
    const now = new Date();
    const diff = targetTime - now;
    
    if (diff <= 0) {
      // 倒计时结束，刷新页面显示可提取状态
      element.innerHTML = '<span class="text-success">可提取</span>';
      // 启用相应的按钮
      const row = element.closest('tr');
      if (row) {
        const claimBtn = row.querySelector('button[disabled]');
        if (claimBtn && claimBtn.textContent.includes('等待解锁')) {
          claimBtn.className = 'btn btn-sm btn-success ms-2';
          claimBtn.disabled = false;
          claimBtn.textContent = '提取资金';
        }
      }
      return;
    }
    
    // 计算剩余时间
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);
    
    // 更新显示
    element.textContent = `${hours}小时${minutes}分${seconds}秒`;
    
    // 继续倒计时
    setTimeout(update, 1000);
  };
  
  // 开始更新
  update();
}

// 提取资金到钱包
async function claimPayment(paymentId) {
  try {
    if (!isWalletConnected || !walletAddress) {
      showToast('请先连接钱包', 'warning');
      return;
    }
    
    // 确认操作
    if (!confirm('确定要提取此笔交易的资金吗？')) {
      return;
    }
    
    showToast('正在初始化交易...', 'info');
    
    // 初始化Web3和合约
    const provider = new ethers.providers.Web3Provider(window.ethereum);
    const signer = provider.getSigner();
    
    // UnitPaySettlementV2合约ABI（提现和查询支付状态函数）
    const settlementABI = [
      "function withdrawPayment(string calldata paymentId) external returns (bool)",
      "function getPaymentStatus(string calldata paymentId) external view returns (uint8 status, bool isDisputed, address owner, address recipient, uint256 amount, uint256 timestamp, uint256 lockTime, uint256 releaseTime)"
    ];
    
    // 确保CONFIG对象存在
    if (!window.CONFIG || !window.CONFIG.SETTLEMENT_CONTRACT_ADDRESS) {
      console.error('合约配置不可用');
      showToast('合约配置不可用，请联系管理员', 'error');
      return;
    }
    
    // 初始化合约实例
    const contract = new ethers.Contract(
      window.CONFIG.SETTLEMENT_CONTRACT_ADDRESS,
      settlementABI,
      signer
    );
    
    // 获取区块链支付ID的步骤:
    // 1. 先检查localStorage
    // 2. 如果不存在，从服务器获取支付详情
    // 3. 如果服务器也没有，显示错误信息
    
    // 步骤1: 从localStorage中获取区块链支付ID
    let blockchainPaymentId = localStorage.getItem(`blockchain_id_${paymentId}`);
    console.log('从localStorage获取的区块链ID:', blockchainPaymentId);
    
    // 步骤2: 如果localStorage中没有，尝试从服务器获取支付详情
    if (!blockchainPaymentId) {
      try {
        console.log('从服务器获取支付详情...');
        console.log(`请求URL: /api/payment-intent/${paymentId}`);
        
        const response = await fetch(`/api/payment-intent/${paymentId}`);
        
        if (response.ok) {
          const paymentData = await response.json();
          console.log('服务器返回的支付详情:', paymentData);
          
          if (paymentData.data && paymentData.data.blockchainPaymentId) {
            blockchainPaymentId = paymentData.data.blockchainPaymentId;
            console.log('从服务器获取到区块链支付ID:', blockchainPaymentId);
            
            // 将其存储到localStorage以备将来使用
            localStorage.setItem(`blockchain_id_${paymentId}`, blockchainPaymentId);
          } else if (paymentData.data && paymentData.data.settlementTxHash) {
            showToast(`该支付已有区块链交易，但找不到区块链支付ID。请联系管理员并提供交易哈希: ${paymentData.data.settlementTxHash}`, 'warning');
            return;
          } else {
            console.error('支付详情中缺少区块链支付ID:', paymentData);
            showToast('支付详情中缺少区块链支付ID，请联系管理员', 'error');
            return;
          }
        } else {
          const errorText = await response.text();
          console.error(`获取支付详情失败 (HTTP ${response.status}):`, errorText);
          let errorJson;
          try {
            errorJson = JSON.parse(errorText);
            console.error('错误详情:', errorJson);
          } catch (e) {
            console.error('无法解析错误响应为JSON:', e);
          }
          
          if (response.status === 404) {
            console.error(`支付ID为 ${paymentId} 的记录不存在`);
            // 尝试生成区块链ID
            try {
              console.log(`尝试为支付ID ${paymentId} 生成区块链ID...`);
              const generateResponse = await fetch(`/api/payment-intent/${paymentId}/generate-blockchain-id`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
              });
              
              if (generateResponse.ok) {
                const result = await generateResponse.json();
                console.log('生成区块链ID结果:', result);
                
                if (result.success && result.data && result.data.blockchainPaymentId) {
                  blockchainPaymentId = result.data.blockchainPaymentId;
                  localStorage.setItem(`blockchain_id_${paymentId}`, blockchainPaymentId);
                  console.log(`成功生成并存储区块链ID: ${blockchainPaymentId}`);
                  // 继续执行后续操作，不返回
                } else {
                  showToast(`无法生成区块链ID: ${result.message || '未知错误'}`, 'error');
                  return;
                }
              } else {
                showToast(`生成区块链ID失败: ${generateResponse.status} ${generateResponse.statusText}`, 'error');
                return;
              }
            } catch (genError) {
              console.error('生成区块链ID请求异常:', genError);
              showToast(`找不到支付ID为 ${paymentId} 的记录，请确认支付ID正确，或联系管理员`, 'error');
              return;
            }
          } else {
            showToast(`获取支付详情失败: ${response.status} ${response.statusText}`, 'error');
            return;
          }
        }
      } catch (error) {
        console.error('获取支付详情请求异常:', error);
        showToast(`请求失败: ${error.message}`, 'error');
        return;
      }
    }
    
    // 步骤3: 如果仍然没有找到区块链支付ID，显示错误信息
    if (!blockchainPaymentId) {
      showToast('找不到该支付的区块链ID。请联系管理员处理，并提供支付ID: ' + paymentId, 'error');
      return;
    }
    
    // 先检查支付状态
    try {
      const status = await contract.getPaymentStatus(blockchainPaymentId);
      console.log('支付状态:', status);
      
      // 支付记录不存在
      if (status.status === 0 && status.owner === '0x0000000000000000000000000000000000000000') {
        showToast('支付记录在区块链上不存在，请确认支付ID正确', 'error');
        return;
      }
      
      // 检查是否是托管类型并且状态为已确认
      if (status.status !== 2) { // 2对应EscrowStatus.CONFIRMED
        let statusText = '未知';
        switch(parseInt(status.status)) {
          case 0: statusText = '无'; break;
          case 1: statusText = '锁定中'; break;
          case 2: statusText = '已确认'; break;
          case 3: statusText = '已释放'; break;
          case 4: statusText = '已退款'; break;
        }
        showToast(`支付状态(${statusText})不允许提取，必须是已确认状态。请等待支付完成确认后再试。`, 'error');
        return;
      }
      
      // 检查是否是LP
      if (status.recipient.toLowerCase() !== walletAddress.toLowerCase()) {
        showToast('您不是该支付的收款人，无法提取资金', 'error');
        return;
      }
      
      // 检查锁定时间
      const releaseTime = new Date(status.releaseTime.toNumber() * 1000);
      const lockEndTime = new Date(status.releaseTime.toNumber() * 1000 + 24 * 60 * 60 * 1000); // T+1=24小时
      const now = new Date();
      
      if (now < lockEndTime) {
        const timeLeft = Math.ceil((lockEndTime - now) / 1000 / 60); // 剩余分钟
        showToast(`资金锁定期未到，还需等待约${timeLeft}分钟`, 'warning');
        return;
      }
      
      // 检查是否处于争议状态
      if (status.isDisputed) {
        showToast('该支付存在争议，无法提取资金', 'error');
        return;
      }
    } catch (error) {
      console.error('查询支付状态失败:', error);
      // 继续尝试提取，让合约自行处理错误
    }
    
    // 调用智能合约的withdrawPayment函数，使用区块链上的ID
    const tx = await contract.withdrawPayment(blockchainPaymentId);
    
    showToast('交易已提交，等待确认...', 'info');
    
    // 等待交易确认
    const receipt = await tx.wait();
    
    if (receipt.status === 1) {
      console.log('交易成功，交易哈希:', tx.hash);
      showToast('资金提取成功！', 'success');
      
      // 调用后端API更新提款状态
      try {
        const updateResponse = await fetch(`/api/payment-intent/${paymentId}/withdraw-complete`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            txHash: tx.hash,
            walletAddress: walletAddress
          })
        });
        
        if (updateResponse.ok) {
          console.log('支付状态已更新为已提款');
        } else {
          console.error('更新支付状态失败:', await updateResponse.text());
        }
      } catch (updateError) {
        console.error('调用状态更新API失败:', updateError);
      }
      
      // 无论API更新是否成功，都更新本地数据和UI
      // 1. 更新全局交易数据
      if (transactionHistory) {
        for (let i = 0; i < transactionHistory.length; i++) {
          if (transactionHistory[i].id == paymentId) {
            transactionHistory[i].status = 'settled';
            transactionHistory[i].settlementTxHash = tx.hash;
            break;
          }
        }
      }
      
      // 2. 更新UI (使用强制刷新)
//       await loadTransactionHistory(); // 重新从服务器加载数据
      
      // 3. 如果服务器没有返回更新的数据，至少更新当前按钮
      const withdrawButton = document.querySelector(`button.withdraw-btn[data-payment-id="${paymentId}"]`);
      if (withdrawButton) {
        // 替换整个按钮和其父元素内容
        const buttonCell = withdrawButton.closest('td');
        if (buttonCell) {
          const viewDetailsBtn = buttonCell.querySelector('button.btn-outline-info, button.btn-outline-secondary');
          const viewDetailsHtml = viewDetailsBtn ? viewDetailsBtn.outerHTML : '';
          
          buttonCell.innerHTML = `
            ${viewDetailsHtml}
            <button class="btn btn-secondary btn-sm" disabled>已提取</button>
            <a href="#" onclick="openExplorerUrl('${tx.hash}'); return false;" class="small d-block mt-1">查看交易</a>
          `;
        }
      }
    } else {
      throw new Error('交易失败');
    }
  } catch (error) {
    console.error('提取资金失败:', error);
    
    // 解析合约错误消息
    let errorMessage = error.message;
    
    // 试图从错误中提取有用信息
    if (error.data) {
      try {
        // 解析合约返回的错误
        const reason = error.data.message || "未知错误";
        errorMessage = `合约错误: ${reason}`;
      } catch (e) {
        // 无法解析，使用原始错误
      }
    } else if (error.reason) {
      errorMessage = `合约错误: ${error.reason}`;
    }
    
    showToast(`提取资金失败: ${errorMessage}`, 'error');
  }
}

/**
 * 测试获取支付详情
 * 用法: testGetPaymentIntent(289)  
 * 在浏览器控制台中调用
 */
async function testGetPaymentIntent(paymentId) {
  console.log(`===== 测试获取支付详情 ID: ${paymentId} =====`);
  try {
    console.log(`请求URL: /api/payment-intent/${paymentId}`);
    const response = await fetch(`/api/payment-intent/${paymentId}`);
    
    console.log(`HTTP状态: ${response.status}`);
    const data = await response.text();
    
    try {
      const jsonData = JSON.parse(data);
      console.log('响应数据:', jsonData);
      
      if (jsonData.data && jsonData.data.blockchainPaymentId) {
        console.log(`成功获取区块链ID: ${jsonData.data.blockchainPaymentId}`);
        console.log(`将区块链ID存入localStorage: blockchain_id_${paymentId}`);
        localStorage.setItem(`blockchain_id_${paymentId}`, jsonData.data.blockchainPaymentId);
      } else {
        console.log('响应中没有区块链ID');
      }
    } catch (e) {
      console.log('响应不是JSON格式:', data);
    }
  } catch (error) {
    console.error('测试API调用失败:', error);
  }
  
  // 检查localStorage中是否已存储区块链ID
  const storedId = localStorage.getItem(`blockchain_id_${paymentId}`);
  console.log(`localStorage中的区块链ID: ${storedId || '未找到'}`);
}

// 导出测试函数到window对象，方便在控制台使用
window.testGetPaymentIntent = testGetPaymentIntent;
window.claimPaymentTest = async (paymentId) => {
  try {
    await claimPayment(paymentId);
    return "提取操作已执行";
  } catch (e) {
    console.error("提取操作失败:", e);
    return "提取操作失败: " + e.message;
  }
};

/**
 * 测试支付状态查询功能
 * 用法: testCheckPaymentStatus('blockchainPaymentId')
 * 在浏览器控制台中调用
 */
async function testCheckPaymentStatus(blockchainPaymentId) {
  console.log(`===== 测试查询支付状态 ID: ${blockchainPaymentId} =====`);
  try {
    // 确保CONFIG对象存在
    if (!window.CONFIG || !window.CONFIG.SETTLEMENT_CONTRACT_ADDRESS) {
      console.error('合约配置不可用');
      return;
    }
    
    // 初始化Web3和合约
    const provider = new ethers.providers.Web3Provider(window.ethereum);
    const signer = provider.getSigner();
    
    // UnitPaySettlementV2合约ABI（提现和查询支付状态函数）
    const settlementABI = [
      "function withdrawPayment(string calldata paymentId) external returns (bool)",
      "function getPaymentStatus(string calldata paymentId) external view returns (uint8 status, bool isDisputed, address owner, address recipient, uint256 amount, uint256 timestamp, uint256 lockTime, uint256 releaseTime)"
    ];
    
    // 初始化合约实例
    const contract = new ethers.Contract(
      window.CONFIG.SETTLEMENT_CONTRACT_ADDRESS,
      settlementABI,
      signer
    );
    
    console.log('尝试查询支付状态...');
    const status = await contract.getPaymentStatus(blockchainPaymentId);
    console.log('区块链上的支付状态:', status);
    
    let statusText = '未知';
    switch(parseInt(status.status)) {
      case 0: statusText = '无'; break;
      case 1: statusText = '锁定中'; break;
      case 2: statusText = '已确认'; break;
      case 3: statusText = '已释放'; break;
      case 4: statusText = '已退款'; break;
    }
    
    console.log(`支付状态: ${statusText} (${status.status})`);
    console.log(`支付金额: ${ethers.utils.formatUnits(status.amount, 'ether')} USDT`);
    console.log(`收款地址: ${status.recipient}`);
    
    return status;
  } catch (error) {
    console.error('查询支付状态失败:', error);
    return null;
  }
}

/**
 * 综合测试函数，查询支付详情并验证区块链状态
 * 用法: testPaymentWorkflow(289)
 */
async function testPaymentWorkflow(paymentId) {
  console.log(`\n========= 开始测试支付ID: ${paymentId} =========\n`);
  
  // 步骤1: 获取支付详情
  await testGetPaymentIntent(paymentId);
  
  // 步骤2: 从localStorage获取区块链ID
  const blockchainId = localStorage.getItem(`blockchain_id_${paymentId}`);
  if (!blockchainId) {
    console.error('找不到区块链ID，无法继续测试');
    return;
  }
  
  // 步骤3: 查询区块链状态
  console.log(`\n使用区块链ID ${blockchainId} 查询状态...\n`);
  const status = await testCheckPaymentStatus(blockchainId);
  
  console.log(`\n========= 测试完成 =========\n`);
  return { paymentId, blockchainId, status };
}

// 导出所有测试函数到window对象
window.testGetPaymentIntent = testGetPaymentIntent;
window.testCheckPaymentStatus = testCheckPaymentStatus;
window.testPaymentWorkflow = testPaymentWorkflow;
window.claimPaymentTest = async (paymentId) => {
  try {
    await claimPayment(paymentId);
    return "提取操作已执行";
  } catch (e) {
    console.error("提取操作失败:", e);
    return "提取操作失败: " + e.message;
  }
};

// 定义claimPaymentTest作为独立函数而不是箭头函数表达式
async function claimPaymentTest(paymentId) {
  console.log(`执行提取操作，支付ID: ${paymentId}`);
  try {
    await claimPayment(paymentId);
    console.log("提取操作已执行完成");
    return "提取操作已执行完成";
  } catch (e) {
    console.error("提取操作失败:", e);
    return "提取操作失败: " + e.message;
  }
}

// 为window对象添加测试函数
window.testApiCall = async function(paymentId) {
  console.log(`测试获取支付详情，ID: ${paymentId}`);
  const response = await fetch(`/api/payment-intents/${paymentId}`);
  const result = await response.json();
  console.log(`API响应:`, result);
  return result;
};

window.testBlockchainStatus = async function(blockchainId) {
  if (!window.ethereum) {
    console.error("MetaMask未连接");
    return "需要先连接MetaMask钱包";
  }
  
  if (!window.CONFIG || !window.CONFIG.SETTLEMENT_CONTRACT_ADDRESS) {
    console.error("合约配置不可用");
    return "缺少合约配置";
  }
  
  const provider = new ethers.providers.Web3Provider(window.ethereum);
  const signer = provider.getSigner();
  const settlementABI = [
    "function getPaymentStatus(string calldata paymentId) external view returns (uint8 status, bool isDisputed, address owner, address recipient, uint256 amount, uint256 timestamp, uint256 lockTime, uint256 releaseTime)"
  ];
  const contract = new ethers.Contract(
    window.CONFIG.SETTLEMENT_CONTRACT_ADDRESS,
    settlementABI,
    signer
  );
  
  console.log(`查询区块链状态，ID: ${blockchainId}`);
  const status = await contract.getPaymentStatus(blockchainId);
  console.log(`区块链状态:`, status);
  return status;
};

window.testClaimPayment = async function(paymentId) {
  console.log(`测试提取操作，ID: ${paymentId}`);
  try {
    await claimPayment(paymentId);
    console.log("提取操作已执行完成");
    return "提取操作已执行完成";
  } catch (e) {
    console.error("提取操作失败:", e);
    return "提取操作失败: " + e.message;
  }
};

// 将原始的claimPayment函数引用暴露给window对象
window.claimPayment = claimPayment;

window.testClaimPayment = async function(paymentId) {
  console.log(`测试提取操作，ID: ${paymentId}`);
  try {
    // 直接使用window.claimPayment
    await window.claimPayment(paymentId);
    console.log("提取操作已执行完成");
    return "提取操作已执行完成";
  } catch (e) {
    console.error("提取操作失败:", e);
    return "提取操作失败: " + e.message;
  }
};

// 将关键函数导出到window对象，用于测试
window.claimPayment = claimPayment;

// 创建测试函数
window.testAll = async function(paymentId) {
  console.log(`===== 综合测试 ID: ${paymentId} =====`);
  
  // 步骤1: 尝试获取支付详情
  console.log(`\n[步骤1] 获取支付详情...`);
  try {
    const response = await fetch(`/api/payment-intents/${paymentId}`);
    const data = await response.json();
    console.log('API响应:', data);
    
    // 检查是否包含区块链ID
    if (data.data && data.data.blockchainPaymentId) {
      console.log(`支付记录包含区块链ID: ${data.data.blockchainPaymentId}`);
      // 保存到localStorage
      localStorage.setItem(`blockchain_id_${paymentId}`, data.data.blockchainPaymentId);
    } else {
      console.log('支付记录中没有区块链ID');
    }
  } catch (error) {
    console.error('获取支付详情失败:', error);
  }
  
  // 步骤2: 检查localStorage中是否有区块链ID
  console.log(`\n[步骤2] 检查localStorage...`);
  const blockchainId = localStorage.getItem(`blockchain_id_${paymentId}`);
  console.log(`localStorage中的区块链ID: ${blockchainId || '未找到'}`);
  
  // 步骤3: 如果有区块链ID，查询其状态
  if (blockchainId) {
    console.log(`\n[步骤3] 查询区块链状态...`);
    try {
      if (!window.ethereum) {
        console.error("MetaMask未连接");
        return;
      }
      
      const provider = new ethers.providers.Web3Provider(window.ethereum);
      const signer = provider.getSigner();
      const settlementABI = [
        "function getPaymentStatus(string calldata paymentId) external view returns (uint8 status, bool isDisputed, address owner, address recipient, uint256 amount, uint256 timestamp, uint256 lockTime, uint256 releaseTime)"
      ];
      const contract = new ethers.Contract(
        window.CONFIG.SETTLEMENT_CONTRACT_ADDRESS,
        settlementABI,
        signer
      );
      
      const status = await contract.getPaymentStatus(blockchainId);
      console.log('区块链状态:', status);
      
      let statusText = '未知';
      switch(parseInt(status.status)) {
        case 0: statusText = '无'; break;
        case 1: statusText = '锁定中'; break;
        case 2: statusText = '已确认'; break;
        case 3: statusText = '已释放'; break;
        case 4: statusText = '已退款'; break;
      }
      console.log(`支付状态: ${statusText} (${status.status})`);
    } catch (error) {
      console.error('查询区块链状态失败:', error);
    }
  }
  
  console.log(`\n===== 测试完成 =====`);
  return "测试完成";
};

// 添加一个自包含的测试函数
(function() {
  // 立即将函数添加到window对象
  window.testPayment = async function(paymentId) {
    console.log(`===== 测试支付ID: ${paymentId} =====`);
    
    // 获取支付详情
    console.log(`\n[步骤1] 获取支付详情...`);
    try {
      const response = await fetch(`/api/payment-intents/${paymentId}`);
      const data = await response.json();
      console.log('API响应:', data);
      
      // 检查是否包含区块链ID
      let blockchainPaymentId = null;
      if (data.data && data.data.blockchainPaymentId) {
        blockchainPaymentId = data.data.blockchainPaymentId;
        console.log(`支付记录包含区块链ID: ${blockchainPaymentId}`);
        // 保存到localStorage
        localStorage.setItem(`blockchain_id_${paymentId}`, blockchainPaymentId);
      } else {
        console.log('支付记录中没有区块链ID');
      }
      
      // 如果没有从API获取区块链ID，检查localStorage
      if (!blockchainPaymentId) {
        blockchainPaymentId = localStorage.getItem(`blockchain_id_${paymentId}`);
        if (blockchainPaymentId) {
          console.log(`从localStorage获取到区块链ID: ${blockchainPaymentId}`);
        } else {
          console.log('localStorage中也没有区块链ID');
        }
      }
      
      // 如果有区块链ID，检查区块链状态
      if (blockchainPaymentId) {
        console.log(`\n[步骤2] 查询区块链状态...`);
        try {
          if (!window.ethereum) {
            console.error("MetaMask未连接");
            return "需要先连接MetaMask钱包";
          }
          
          const provider = new ethers.providers.Web3Provider(window.ethereum);
          const signer = provider.getSigner();
          const settlementABI = [
            "function getPaymentStatus(string calldata paymentId) external view returns (uint8 status, bool isDisputed, address owner, address recipient, uint256 amount, uint256 timestamp, uint256 lockTime, uint256 releaseTime)"
          ];
          
          // 合约地址
          const contractAddress = window.CONFIG?.SETTLEMENT_CONTRACT_ADDRESS || '0x4277F6dfcEca682043CAd97464aeDcC1a533DEa6';
          
          const contract = new ethers.Contract(
            contractAddress,
            settlementABI,
            signer
          );
          
          console.log('查询区块链支付状态...');
          const status = await contract.getPaymentStatus(blockchainPaymentId);
          console.log('区块链状态:', status);
          
          let statusText = '未知';
          switch(parseInt(status.status)) {
            case 0: statusText = '无'; break;
            case 1: statusText = '锁定中'; break;
            case 2: statusText = '已确认'; break;
            case 3: statusText = '已释放'; break;
            case 4: statusText = '已退款'; break;
          }
          console.log(`支付状态: ${statusText} (${status.status})`);
          
          if (parseInt(status.status) === 2) {
            console.log('\n[步骤3] 支付状态为已确认，可以提取资金');
            console.log('要提取资金，请手动调用window.triggerClaim函数');
          }
        } catch (error) {
          console.error('查询区块链状态失败:', error);
        }
      }
      
      console.log(`\n===== 测试完成 =====`);
      return "测试完成";
    } catch (error) {
      console.error(`测试失败:`, error);
      return `测试失败: ${error.message}`;
    }
  };
  
  // 单独的提取资金函数
  window.triggerClaim = async function(paymentId) {
    console.log(`尝试提取支付ID: ${paymentId} 的资金...`);
    try {
      if (!window.ethereum) {
        throw new Error("MetaMask未连接");
      }
      
      // 获取区块链ID
      const blockchainPaymentId = localStorage.getItem(`blockchain_id_${paymentId}`);
      if (!blockchainPaymentId) {
        throw new Error(`找不到支付ID ${paymentId} 的区块链ID，请先运行testPayment函数`);
      }
      
      // 初始化Web3和合约
      const provider = new ethers.providers.Web3Provider(window.ethereum);
      const signer = provider.getSigner();
      
      // 合约ABI
      const settlementABI = [
        "function withdrawPayment(string calldata paymentId) external returns (bool)",
        "function getPaymentStatus(string calldata paymentId) external view returns (uint8 status, bool isDisputed, address owner, address recipient, uint256 amount, uint256 timestamp, uint256 lockTime, uint256 releaseTime)"
      ];
      
      // 合约地址
      const contractAddress = window.CONFIG?.SETTLEMENT_CONTRACT_ADDRESS || '0x4277F6dfcEca682043CAd97464aeDcC1a533DEa6';
      
      // 初始化合约实例
      const contract = new ethers.Contract(
        contractAddress,
        settlementABI,
        signer
      );
      
      // 检查支付状态
      console.log('检查支付状态...');
      const status = await contract.getPaymentStatus(blockchainPaymentId);
      console.log('支付状态:', status);
      
      if (parseInt(status.status) !== 2) {
        throw new Error(`支付状态不是"已确认"，当前状态: ${status.status}`);
      }
      
      // 调用智能合约的withdrawPayment函数
      console.log('提交提款交易...');
      const tx = await contract.withdrawPayment(blockchainPaymentId);
      console.log('交易已提交，等待确认:', tx.hash);
      
      // 等待交易确认
      const receipt = await tx.wait();
      console.log('交易已确认:', receipt);
      
      if (receipt.status === 1) {
        console.log('提款成功!');
        return {success: true, txHash: tx.hash, receipt};
      } else {
        throw new Error('交易失败');
      }
    } catch (error) {
      console.error('提款失败:', error);
      return {success: false, error: error.message};
    }
  };
  
  console.log('测试函数已加载，可以使用window.testPayment(289)和window.triggerClaim(289)进行测试');
})();

// ... existing code ...
// 添加调试测试函数
async function testTransactionStatus(paymentId, newStatus) {
  try {
    console.log(`===== 测试交易状态更新 ID: ${paymentId} =====`);
    
    // 查找该ID的交易
    if (!transactionHistory) {
//       await loadTransactionHistory();
    }
    
    const tx = transactionHistory.find(t => t.id == paymentId);
    if (!tx) {
      console.error(`找不到ID为 ${paymentId} 的交易`);
      return null;
    }
    
    console.log('当前交易状态:', tx);
    
    // 如果指定了新状态，模拟状态更新
    if (newStatus) {
      // 备份原状态
      const originalStatus = tx.status;
      const originalHash = tx.settlementTxHash;
      
      // 更新状态
      tx.status = newStatus;
      if (newStatus === 'settled' && !tx.settlementTxHash) {
        // 生成模拟的交易哈希
        tx.settlementTxHash = '0x' + Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('');
      }
      
      console.log(`状态已更新: ${originalStatus} -> ${newStatus}`);
      if (tx.settlementTxHash !== originalHash) {
        console.log(`添加模拟交易哈希: ${tx.settlementTxHash}`);
      }
      
      // 刷新UI显示
      updateTransactionHistoryUI();
      
      // 提供恢复原状态的函数
      return function restoreStatus() {
        tx.status = originalStatus;
        tx.settlementTxHash = originalHash;
        updateTransactionHistoryUI();
        console.log(`已恢复交易 ${paymentId} 的原始状态`);
      };
    }
    
    return tx;
  } catch (error) {
    console.error('测试交易状态失败:', error);
    return null;
  }
}

// 导出测试函数到window对象，方便在控制台使用
window.testTransactionStatus = testTransactionStatus;
window.testGetPaymentIntent = testGetPaymentIntent;
window.claimPaymentTest = async (paymentId) => {
  try {
    await claimPayment(paymentId);
    return "提取操作已执行";
  } catch (e) {
    console.error("提取操作失败:", e);
    return "提取操作失败: " + e.message;
  }
};
// ... existing code ...

// ... existing code ...
// 添加一个强制刷新交易历史的调试函数
async function forceRefreshTransactions() {
  console.log('强制刷新交易历史...');
//   await loadTransactionHistory();
  console.log('刷新完成，当前交易数据:', transactionHistory);
  return '刷新完成';
}

// 导出测试函数到window对象，方便在控制台使用
window.testTransactionStatus = testTransactionStatus;
window.testGetPaymentIntent = testGetPaymentIntent;
window.claimPaymentTest = async (paymentId) => {
  try {
    await claimPayment(paymentId);
    return "提取操作已执行";
  } catch (e) {
    console.error("提取操作失败:", e);
    return "提取操作失败: " + e.message;
  }
};
window.forceRefreshTransactions = forceRefreshTransactions;
// ... existing code ...

// 添加简单的测试函数实现，供现有代码调用
window.testPayment = (id) => {
  console.log('测试函数已被清理');
  return Promise.resolve();
};

window.triggerClaim = (id) => {
  console.log('测试函数已被清理');
  return Promise.resolve();
};

// 添加简单替代的测试函数
window.testPayment = (id) => {
  console.log('测试函数已被清理');
  return Promise.resolve();
};

window.triggerClaim = (id) => {
  console.log('测试函数已被清理');
  return Promise.resolve();
};

/**
 * 检查交易状态并更改状态
 * 仅用于调试，不应在生产环境使用
 */
async function testTransactionStatus(paymentId, newStatus) {
  try {
    console.log(`===== 测试交易状态更新 ID: ${paymentId} =====`);
    
    // 查找该ID的交易
    if (!transactionHistory) {
//       await loadTransactionHistory();
    }
    
    const tx = transactionHistory.find(t => t.id == paymentId);
    if (!tx) {
      console.error(`找不到ID为 ${paymentId} 的交易`);
      return null;
    }
    
    console.log('当前交易状态:', tx);
    
    // 如果指定了新状态，模拟状态更新
    if (newStatus) {
      // 备份原状态
      const originalStatus = tx.status;
      const originalHash = tx.settlementTxHash;
      
      // 更新状态
      tx.status = newStatus;
      if (newStatus === 'settled' && !tx.settlementTxHash) {
        // 生成模拟的交易哈希
        tx.settlementTxHash = '0x' + Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('');
      }
      
      console.log(`状态已更新: ${originalStatus} -> ${newStatus}`);
      if (tx.settlementTxHash !== originalHash) {
        console.log(`添加模拟交易哈希: ${tx.settlementTxHash}`);
      }
      
      // 刷新UI显示
      updateTransactionHistoryUI();
      
      // 提供恢复原状态的函数
      return function restoreStatus() {
        tx.status = originalStatus;
        tx.settlementTxHash = originalHash;
        updateTransactionHistoryUI();
        console.log(`已恢复交易 ${paymentId} 的原始状态`);
      };
    }
    
    return tx;
  } catch (error) {
    console.error('测试交易状态失败:', error);
    return null;
  }
}

// 根据网络类型获取 API 前缀
function getApiPrefix() {
  if (currentNetwork === 'sol') return '/sol';
  if (currentNetwork === 'eth') return '/eth';
  return ''; // 未知网络
}

// 新增：定义 updateTaskList，避免 ReferenceError，并更新已支付总额
function updateTaskList(data) {
  // data.tasks 包含任务数组
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  // 仅计算支付完成相关状态的已支付总额
  const paidStatuses = ['paid', 'confirmed', 'user_confirmed', 'settled'];
  paidAmount = tasks
    .filter(t => paidStatuses.includes((t.status || '').toLowerCase()))
    .reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
  // 更新已支付额度显示
  const paidQuotaEl = document.getElementById('paid-quota');
  if (paidQuotaEl) paidQuotaEl.textContent = paidAmount.toFixed(2);
  // 显示任务列表，根据当前页签过滤
  displayTasks(tasks);
}

// 新增：加载 USDC 余额并刷新交易历史
async function loadUSDCBalance() {
  try {
    let balance = '0.00';
    // 调用 solana-integration 中的刷新函数
    if (window.solanaIntegration && typeof window.solanaIntegration.refreshUsdcBalance === 'function') {
      balance = await window.solanaIntegration.refreshUsdcBalance();
    } else {
      console.error('SolanaIntegration 或 refreshUsdcBalance 方法未定义');
    }
    // 更新 LP 页面 USDC 余额显示
    const el = document.getElementById('usdc-balance');
    if (el) el.textContent = balance;
    // 加载交易历史
    if (typeof loadTransactionHistory === 'function') {
      await loadTransactionHistory();
    }
  } catch (error) {
    console.error('加载USDC余额失败:', error);
    showToast('加载USDC余额失败: ' + error.message, 'error');
  }
}