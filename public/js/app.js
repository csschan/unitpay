/**
 * unitpay 前端应用
 * 实现钱包连接、扫码支付和与后端API交互
 */

console.log('public/js/app.js v2 loaded');

// 全局变量
let provider;
let signer;
let walletAddress = null;
let isWalletConnected = false;
let currentPaymentIntentId = null;
let socket = null;
let DEBUG = true; // 修改为true以开启调试信息
let usdtContract = null; // USDT合约实例
let currentNetwork = window.currentNetwork || 'ethereum';

// API基础URL - 确保所有函数使用相同的API端点
const API_BASE_URL = '/api';

// DOM元素引用
const connectWalletBtn = document.getElementById('connect-wallet-btn');
const createPaymentBtn = document.getElementById('create-payment-btn');
const walletAddressSpan = document.getElementById('wallet-address');
const walletConnectSection = document.getElementById('wallet-connect-section');
const userDashboard = document.getElementById('user-dashboard');
const paymentPlatform = document.getElementById('payment-platform');
const refreshBalanceBtn = document.getElementById('refresh-balance-btn');
const scanQrBtn = document.getElementById('scan-qr-btn');
const qrFileInput = document.getElementById('qr-file-input');
const qrContent = document.getElementById('qr-content');
const paymentAmount = document.getElementById('payment-amount');
const paymentDescription = document.getElementById('payment-description');
const paymentForm = document.getElementById('payment-form');
const paymentTasksList = document.getElementById('payment-tasks-list');
const noTasksMessage = document.getElementById('no-tasks-message');
const confirmPaymentModal = new bootstrap.Modal(document.getElementById('confirm-payment-modal'));
const confirmAmount = document.getElementById('confirm-amount');
const confirmReceivedBtn = document.getElementById('confirm-received-btn');
const usdtBalanceSpan = document.getElementById('usdt-balance');

// 自定义日志函数，仅在DEBUG为true时输出
function log(...args) {
  if (DEBUG) {
    console.log(...args);
  }
}

// 错误日志函数，总是输出
function logError(...args) {
  console.error(...args);
}

// 警告日志函数，总是输出
function logWarn(...args) {
  console.warn(...args);
}

// 安全的localStorage访问
function safeLocalStorage(operation, key, value) {
  try {
    if (operation === 'get') {
      return localStorage.getItem(key);
    } else if (operation === 'set') {
      localStorage.setItem(key, value);
      return true;
    } else if (operation === 'remove') {
      localStorage.removeItem(key);
      return true;
    }
  } catch (error) {
    console.warn('localStorage访问失败:', error);
    return operation === 'get' ? null : false;
  }
}

// 安全的sessionStorage访问
function safeSessionStorage(operation, key, value) {
  try {
    if (operation === 'get') {
      return sessionStorage.getItem(key);
    } else if (operation === 'set') {
      sessionStorage.setItem(key, value);
      return true;
    } else if (operation === 'remove') {
      sessionStorage.removeItem(key);
      return true;
    }
  } catch (error) {
    console.warn('sessionStorage访问失败:', error);
    return operation === 'get' ? null : false;
  }
}

// 在初始化过程中确保合约服务和ethers可用
function ensureContractServiceAvailable() {
    if (typeof ContractService === 'undefined') {
        console.error('===DEBUG=== ContractService未定义！');
        alert('合约服务未加载，请刷新页面或检查网络连接。');
        return false;
    }

    if (typeof ethers === 'undefined') {
        console.error('===DEBUG=== ethers库未定义！');
        alert('ethers库未加载，请刷新页面或检查网络连接。');
        return false;
    }

    console.log('===DEBUG=== 合约服务和ethers库已可用');
    return true;
}

/**
 * 显示支付成功消息
 * @param {Object} data - 成功消息数据
 */
function showPaymentSuccessMessage(data) {
  try {
    // 如果没有交易哈希，则不显示
    if (!data || !data.txHash) return;
    
    console.log('显示支付成功信息:', data);
    
    // 获取或创建通知容器
    let notificationContainer = document.getElementById('payment-success-notification');
    if (!notificationContainer) {
      notificationContainer = document.createElement('div');
      notificationContainer.id = 'payment-success-notification';
      notificationContainer.className = 'payment-success-notification';
      document.body.appendChild(notificationContainer);
    }
    
    // 设置显示时间
    let displayTime = new Date();
    if (data.timestamp) {
      try {
        displayTime = new Date(data.timestamp);
      } catch (e) {
        console.error('解析时间戳失败:', e);
      }
    }
    
    // 格式化时间
    const timeString = displayTime.toLocaleString();
    
    // 设置区块浏览器URL
    const explorerUrl = `https://shannon-explorer.somnia.network/tx/${data.txHash}`;
    
    // 创建通知内容
    notificationContainer.innerHTML = `
      <div class="notification-content">
        <div class="success-icon"><i class="fas fa-check-circle"></i></div>
        <div class="notification-text">
          <h5>支付已锁定</h5>
          <p>金额: ${data.amount || 'N/A'} USDT</p>
          <p class="small">
            交易哈希: <a href="${explorerUrl}" target="_blank">${data.txHash.substring(0, 10)}...${data.txHash.substring(data.txHash.length - 8)}</a>
          </p>
          <p class="timestamp">时间: ${timeString}</p>
        </div>
        <button class="close-btn" onclick="this.parentElement.parentElement.remove();">&times;</button>
      </div>
    `;
    
    // 添加自动消失
    setTimeout(() => {
      if (notificationContainer && notificationContainer.parentElement) {
        notificationContainer.remove();
      }
    }, 10000); // 10秒后消失
  } catch (error) {
    console.error('显示支付成功通知失败:', error);
  }
}

// 修改initApp函数以在初始化时恢复交易信息和检查成功消息
async function initApp() {
    try {
        console.log('正在初始化应用...');
        
        // 确保依赖库可用
        if (!ensureContractServiceAvailable()) {
            console.error('依赖库不可用，应用初始化失败');
            return;
        }
        
        // 初始化全局合约服务 - 在所有操作之前确保合约服务存在
        console.log('===DEBUG=== 创建全局合约服务');
        if (!window.contractService) {
            window.contractService = new ContractService();
            console.log('===DEBUG=== 全局合约服务已创建');
        } else {
            console.log('===DEBUG=== 全局合约服务已存在');
        }
        
        // 初始化事件监听器
        initEventListeners();
        
        // 设置钱包事件监听
        setupWalletEventHandlers();
        
        // 不再自动检查钱包连接状态
        // await checkWalletConnection();
        
        // 检查是否有成功消息需要显示
        const successData = safeLocalStorage('get', 'paymentSuccessMessage');
        if (successData) {
            try {
                const data = JSON.parse(successData);
                // 只显示最近30分钟内的成功消息
                const messageTime = new Date(data.timestamp);
                const now = new Date();
                const timeDiff = (now - messageTime) / 1000 / 60; // 分钟
                
                if (timeDiff < 30) {
                    // 显示成功消息
                    setTimeout(() => {
                        showPaymentSuccessMessage(data);
                    }, 500); // 延迟显示，确保页面已加载
                }
                
                // 显示后清除消息，避免重复显示
                safeLocalStorage('remove', 'paymentSuccessMessage');
            } catch (e) {
                console.error('解析成功消息失败:', e);
                safeLocalStorage('remove', 'paymentSuccessMessage');
            }
        }
        
        // 尝试恢复交易信息
        setTimeout(() => {
            restoreTransactionDetails();
        }, 1000); // 延迟一秒执行，确保页面其他元素已加载
        
        // 尝试在初始化时加载用户支付任务
        if (typeof loadUserPaymentTasks === 'function') {
          console.log('DEBUG: initApp calling loadUserPaymentTasks');
          loadUserPaymentTasks();
        }
        
    } catch (error) {
        console.error('初始化应用失败:', error);
    }
}

// 设置钱包事件监听
function setupWalletEventHandlers() {
  if (window.ethereum) {
    // 监听账户变化
    window.ethereum.on('accountsChanged', function (accounts) {
      console.log('钱包账户变化:', accounts);
      if (accounts.length === 0) {
        // 用户断开了连接
        console.log('用户断开了钱包连接');
        walletAddress = null;
        isWalletConnected = false;
        window.web3Connected = false;
        
        // 更新UI
        updateWalletUI({
          address: null,
          chainType: currentNetwork,
          isConnected: false
        });
      } else {
        // 用户切换了账户
        walletAddress = accounts[0];
        isWalletConnected = true;
        window.web3Connected = true;
        window.selectedAccount = walletAddress;
        console.log('钱包地址已更新:', walletAddress);
        
        // 更新UI
        updateWalletUI({
          address: walletAddress,
          chainType: currentNetwork,
          isConnected: true
        });
        
        // 重新加载任务
        loadUserPaymentTasks();
        
        // 更新USDT余额
        if (typeof initUSDTContract === 'function') {
          initUSDTContract();
        }
      }
    });
    
    // 监听链ID变化
    window.ethereum.on('chainChanged', function (chainId) {
      console.log('网络链ID变化:', chainId);
      const networkType = getNetworkType(chainId);
      
      // 如果当前选择的是以太坊网络，则更新UI
      if (currentNetwork === 'ethereum') {
        updateWalletUI({
          address: walletAddress,
          chainType: 'ethereum',
          isConnected: isWalletConnected
        });
        
        // 重新加载任务和余额
        loadUserPaymentTasks();
        if (typeof initUSDTContract === 'function') {
          initUSDTContract();
        }
      }
    });
  }
  
  // 监听网络切换事件
  window.addEventListener('networkChanged', function(event) {
    console.log('网络切换事件:', event.detail);
    currentNetwork = event.detail.network;
    
    // 更新UI
    updateWalletUI({
      address: currentNetwork === 'ethereum' ? window.selectedAccount : window.solAddress,
      chainType: currentNetwork,
      isConnected: event.detail.isConnected
    });
    
    // 重新加载任务
    if (event.detail.isConnected && typeof loadUserPaymentTasks === 'function') {
      loadUserPaymentTasks();
    }
    // Balance container visibility according to network
    const ethBalCont = document.getElementById('eth-balance-container');
    const solBalCont = document.getElementById('sol-balance-container');
    const solUsdcCont = document.getElementById('sol-usdc-container');
    if (currentNetwork === 'ethereum') {
      if (ethBalCont) ethBalCont.classList.remove('d-none');
      if (solBalCont) solBalCont.classList.add('d-none');
      if (solUsdcCont) solUsdcCont.classList.add('d-none');
    } else {
      if (ethBalCont) ethBalCont.classList.add('d-none');
      if (solBalCont) solBalCont.classList.remove('d-none');
      if (solUsdcCont) solUsdcCont.classList.remove('d-none');
    }
  });
}

// 初始化事件监听器
function initEventListeners() {
  // 绑定网络切换
  const networkOptionEls = document.querySelectorAll('.network-option');
  networkOptionEls.forEach(opt => {
    opt.addEventListener('click', () => {
      const newNetwork = opt.dataset.network;
      const connected = newNetwork === 'ethereum'
        ? isWalletConnected
        : (window.solanaIntegration && typeof window.solanaIntegration.isSolanaConnected === 'function' && window.solanaIntegration.isSolanaConnected());
      window.dispatchEvent(new CustomEvent('networkChanged', { detail: { network: newNetwork, isConnected: connected } }));
    });
  });

  // 监听网络切换事件
  window.addEventListener('networkChanged', function(event) {
    console.log('网络切换事件:', event.detail);
    currentNetwork = event.detail.network;
    // 切换连接按钮
    const ethBtn = document.getElementById('connect-wallet-btn');
    const phantomBtn = document.getElementById('connect-phantom-btn');
    if (currentNetwork === 'ethereum') {
      if (ethBtn) ethBtn.style.display = 'block';
      if (phantomBtn) phantomBtn.style.display = 'none';
    } else {
      if (ethBtn) ethBtn.style.display = 'none';
      if (phantomBtn) phantomBtn.style.display = 'block';
    }
    // 更新UI
    updateWalletUI({
      address: currentNetwork === 'ethereum' ? window.selectedAccount : (window.solanaIntegration && window.solanaIntegration.getSolAddress ? window.solanaIntegration.getSolAddress() : ''),
      chainType: currentNetwork,
      isConnected: event.detail.isConnected
    });
    // 重新加载任务
    if (event.detail.isConnected && typeof loadUserPaymentTasks === 'function') {
      loadUserPaymentTasks();
    }
  });

  // 绑定以太坊钱包连接按钮
  if (connectWalletBtn) {
    connectWalletBtn.addEventListener('click', connectWallet);
  }
  // 绑定 Phantom 钱包连接按钮，直接调用 solanaIntegration.connectPhantomWallet
  const phantomBtnEl = document.getElementById('connect-phantom-btn');
  if (phantomBtnEl) {
    phantomBtnEl.addEventListener('click', async function(e) {
      e.preventDefault();
      await connectWallet();
    });
  }
  
  // 支付平台选择改变事件
  if (paymentPlatform) {
    paymentPlatform.addEventListener('change', function() {
      const paypalEmailField = document.getElementById('paypal-email-field');
      if (paypalEmailField) {
        // PayPal平台选择时显示邮箱输入
        if (this.value.toLowerCase() === 'paypal') {
          paypalEmailField.style.display = 'block';
        } else {
          paypalEmailField.style.display = 'none';
        }
      }
    });
    
    // 初始化触发一次，确保初始状态正确
    if (paymentPlatform.value.toLowerCase() === 'paypal') {
      const paypalEmailField = document.getElementById('paypal-email-field');
      if (paypalEmailField) {
        paypalEmailField.style.display = 'block';
      }
    }
  }
  
  // LP选择下拉框事件监听
  const lpSelect = document.getElementById('lp-select');
  if (lpSelect) {
    lpSelect.addEventListener('change', function() {
      const rateField = document.getElementById('rate-field');
      const feeRateInput = document.getElementById('fee-rate');
      
      if (this.value === 'auto') {
        // 系统自动匹配LP时，费率设置更重要，可以高亮显示
        rateField.classList.add('highlight-field');
        feeRateInput.setAttribute('required', 'required');
      } else {
        // 选择了特定LP时，费率字段仍然显示但不高亮
        rateField.classList.remove('highlight-field');
        feeRateInput.removeAttribute('required');
        // 新增：自动填充选中LP的费率
        const selectedOption = this.options[this.selectedIndex];
        const feeRate = selectedOption.getAttribute('data-fee-rate');
        if (feeRateInput && feeRate) {
          feeRateInput.value = feeRate;
        }
      }
    });
    
    // 初始化加载LP列表
    try {
      console.log('初始化事件监听器时加载LP列表');
      loadLPList();
    } catch (error) {
      console.error('加载LP列表失败:', error);
      showErrorMessage('LP列表加载失败，请刷新页面重试');
    }
    
    // 触发change事件以更新UI
    lpSelect.dispatchEvent(new Event('change'));
  } else {
    console.warn('未找到LP选择下拉框');
  }
  
  // 扫描二维码按钮 - 修复点击事件，确保能够找到并正确绑定
  document.addEventListener('DOMContentLoaded', function() {
    console.log("DOM加载完成，开始查找扫描二维码按钮...");
    
    // 查找扫描二维码按钮
    const scanQrBtn = document.getElementById('scan-qr-btn');
    
    // 如果找到按钮，添加点击事件
    if (scanQrBtn) {
      console.log("已找到扫描二维码按钮，绑定点击事件处理器");
      
      scanQrBtn.addEventListener('click', function() {
        // 每次点击扫描时确保支付表单可见
        if (paymentForm) paymentForm.classList.remove('d-none');
        console.log("扫描二维码按钮被点击");
        
        // 尝试通过ID查找文件输入框
        let qrFileInputElem = document.getElementById('qr-file-input');
        
        if (qrFileInputElem) {
          console.log("已找到文件输入框，触发点击事件");
          qrFileInputElem.click();
        } else {
          console.error("未找到qr-file-input元素，尝试通过选择器查找");
          
          // 通过选择器查找
          qrFileInputElem = document.querySelector('input[type="file"][accept*="image"]');
          
          if (qrFileInputElem) {
            console.log("通过选择器找到文件输入框，触发点击事件");
            qrFileInputElem.click();
          } else {
            console.error("无法找到任何文件输入框");
            alert("文件输入控件不可用，请刷新页面后重试");
          }
        }
      });
    } else {
      console.error("未找到ID为scan-qr-btn的元素，尝试通过选择器查找");
      
      // 尝试通过其他方式查找按钮
      const allButtons = document.querySelectorAll('button');
      let found = false;
      
      allButtons.forEach(button => {
        if (button.textContent.includes('扫描二维码')) {
          console.log("通过文本内容找到扫描二维码按钮");
          
          button.addEventListener('click', function() {
            console.log("扫描二维码按钮被点击(通过文本内容找到的按钮)");
            
            const fileInput = document.querySelector('input[type="file"][accept*="image"]');
            if (fileInput) {
              fileInput.click();
            } else {
              alert("文件输入控件不可用，请刷新页面后重试");
            }
          });
          
          found = true;
        }
      });
      
      if (!found) {
        console.error("未能找到任何扫描二维码按钮");
      }
    }
  });
  
  // 二维码文件输入
  const qrFileInputElement = document.getElementById('qr-file-input');
  if (qrFileInputElement) {
    console.log("已找到qr-file-input元素 (通过ID直接查找)，绑定change事件");
    qrFileInputElement.addEventListener('change', function(event) {
      console.log("文件输入变化事件触发", event);
      handleQrFileSelect(event);
    });
  } else {
    console.error("qr-file-input 元素未找到 (通过ID直接查找)");
  }
  
  // 监听创建支付按钮点击事件
  if (createPaymentBtn) {
    let isPreparingPayment = false;
    // 使用 onclick 替换 addEventListener，避免多次绑定
    createPaymentBtn.onclick = async function(e) {
      e.preventDefault();
      if (isPreparingPayment) return;
      isPreparingPayment = true;
      disablePayNowButton();
      try {
        await preparePayment();
      } catch (error) {
        showErrorMessage(`支付操作失败: ${error.message}`);
      } finally {
        isPreparingPayment = false;
        enablePayNowButton();
      }
    };
  }
  
  // 刷新余额按钮
  if (refreshBalanceBtn) {
    refreshBalanceBtn.addEventListener('click', loadUSDTBalance);
  }

  // 初始触发一次网络切换，更新连接按钮和 UI
  const initialConnected = currentNetwork === 'ethereum'
    ? isWalletConnected
    : (window.solanaIntegration && typeof window.solanaIntegration.isSolanaConnected === 'function' && window.solanaIntegration.isSolanaConnected());
  window.dispatchEvent(new CustomEvent('networkChanged', { detail: { network: currentNetwork, isConnected: initialConnected } }));
}

// 连接钱包
async function connectWallet(autoConnect = false) {
+  console.log('connectWallet called, currentNetwork=', currentNetwork);
  // 根据当前网络路由到对应钱包
  if (currentNetwork === 'solana') {
    if (window.solanaIntegration && typeof window.solanaIntegration.connectPhantomWallet === 'function') {
+      console.log('connectWallet: connecting.solana');
      const ok = await window.solanaIntegration.connectPhantomWallet();
+      console.log('connectWallet: solana connect result=', ok);
      if (ok) {
        updateWalletUI({ address: window.solanaIntegration.getSolAddress(), chainType: 'solana', isConnected: true });
        if (typeof loadUserPaymentTasks === 'function') loadUserPaymentTasks();
+        console.log('connectWallet: called loadUserPaymentTasks after solana connect');
        showMessage('Solana 钱包已连接', 'success');
        return true;
      }
      return ok;
    } else {
      showMessage('无法连接到 Solana 钱包', 'error');
      return false;
    }
  }
  // Ethereum 钱包连接
  try {
+    console.log('connectWallet: connecting.ethereum');
    // 检查是否安装了 MetaMask
    if (window.ethereum) {
      try {
        // 创建provider
        provider = new ethers.providers.Web3Provider(window.ethereum, "any");
        
        // 请求账户访问
        const accounts = await provider.send('eth_requestAccounts', []);
        
        if (accounts && accounts.length > 0) {
          walletAddress = accounts[0];
          isWalletConnected = true;  // 更新连接状态
          
          // 获取signer
          signer = provider.getSigner();
          
          // 更新UI
          if (walletAddressSpan) {
            walletAddressSpan.textContent = formatAddress(walletAddress);
          }
          
          if (walletConnectSection && userDashboard) {
            walletConnectSection.classList.add('d-none');
            userDashboard.classList.remove('d-none');
          }
          
          // 连接Socket.io
          connectSocket();
          
          // 加载用户支付任务（如果在主页面）
          if (typeof loadUserPaymentTasks === 'function') {
            loadUserPaymentTasks();
          }
          
          // 加载USDT余额（如果适用）
          if (typeof initUSDTContract === 'function') {
            initUSDTContract();
          }
          
          // 成功消息
          showMessage('钱包已连接', 'success');
          return true;
        } else {
          throw new Error('未能获取钱包地址');
        }
      } catch (web3Error) {
        console.error('Web3连接错误:', web3Error);
        if (!autoConnect) {
          // 提供更友好的错误信息
          if (web3Error.code === 4001) {
            showMessage('用户拒绝了连接请求', 'warning');
          } else if (web3Error.code === -32002) {
            showMessage('连接请求已挂起，请检查钱包', 'warning');
          } else {
            showMessage('连接钱包时发生错误: ' + (web3Error.message || '未知错误'), 'error');
          }
        }
        return false;
      }
    } else {
      if (!autoConnect) {
        showMessage('请安装MetaMask钱包插件', 'error');
      }
      return false;
    }
  } catch (error) {
    console.error('连接钱包失败:', error);
    if (!autoConnect) {
      showMessage('连接钱包失败: ' + error.message, 'error');
    }
    return false;
  }
}

// 检查钱包连接状态
async function checkWalletConnection() {
  try {
    if (typeof window.ethereum !== 'undefined') {
      try {
        // 创建provider
        provider = new ethers.providers.Web3Provider(window.ethereum, "any");
        
        const accounts = await provider.send('eth_accounts', []);
        if (accounts && accounts.length > 0) {
          // 只设置钱包地址，但不自动连接
          walletAddress = accounts[0];
          console.log('检测到已连接的钱包:', walletAddress);
          
          // 只检查状态，但不自动更新UI或进行连接
          isWalletConnected = false; // 设为false，需要用户手动点击连接
          
          // 不再自动更新UI，不隐藏连接按钮
          // walletAddressSpan.textContent = walletAddress;
          // walletConnectSection.classList.add('d-none');
          // userDashboard.classList.remove('d-none');
          
          // 不自动初始化合约服务
          // console.log('===DEBUG=== 初始化全局合约服务');
          // if (!window.contractService) {
          //   window.contractService = new ContractService();
          // }
          
          // 不自动初始化合约
          // if (!window.contractService.isInitialized()) {
          //   console.log('===DEBUG=== 执行合约服务初始化');
          //   await window.contractService.initializeWeb3();
          // }
          
          // 不自动连接Socket和加载任务
          // connectSocket();
          // loadUserPaymentTasks();
          // initUSDTContract();
        } else {
          isWalletConnected = false;  // 更新连接状态
        }
      } catch (web3Error) {
        console.error('检查钱包状态时发生Web3错误:', web3Error);
        isWalletConnected = false;  // 更新连接状态
      }
    } else {
      isWalletConnected = false;  // 更新连接状态
    }
  } catch (error) {
    console.error('检查钱包连接状态失败:', error);
    isWalletConnected = false;  // 更新连接状态
  }
}

/**
 * 显示通知消息
 * @param {string} message - 要显示的消息
 * @param {string} type - 消息类型 (info, success, warning, error)
 */
function showMessage(message, type = 'info') {
  // 创建通知容器（如果不存在）
  let container = document.querySelector('.notifications-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'notifications-container';
    document.body.appendChild(container);
  }

  // 创建通知元素
  const notification = document.createElement('div');
  notification.className = `notification notification-${type}`;

  // 设置图标
  const icon = document.createElement('span');
  icon.className = 'notification-icon';
  
  switch (type) {
    case 'success':
      icon.innerHTML = '✓';
      break;
    case 'warning':
      icon.innerHTML = '⚠';
      break;
    case 'error':
      icon.innerHTML = '✗';
      break;
    default: // info
      icon.innerHTML = 'ℹ';
  }

  // 设置消息文本
  const messageElement = document.createElement('div');
  messageElement.className = 'notification-message';
  messageElement.textContent = message;

  // 设置关闭按钮
  const closeButton = document.createElement('button');
  closeButton.className = 'notification-close';
  closeButton.innerHTML = '×';
  closeButton.onclick = function() {
    notification.classList.add('fade-out');
    setTimeout(() => {
      notification.remove();
    }, 500);
  };

  // 组合通知元素
  notification.appendChild(icon);
  notification.appendChild(messageElement);
  notification.appendChild(closeButton);

  // 添加到容器
  container.appendChild(notification);

  // 5秒后自动关闭
  setTimeout(() => {
    if (notification.parentNode) {
      notification.classList.add('fade-out');
      setTimeout(() => {
        if (notification.parentNode) {
          notification.remove();
        }
      }, 500);
    }
  }, 5000);
}

/**
 * 显示错误消息
 * @param {string} message - 要显示的错误消息
 */
function showErrorMessage(message) {
  showMessage(message, 'error');
}

/**
 * 连接Socket.io并监听事件
 */
function connectSocket() {
  try {
    // 先断开之前的连接
    if (socket) {
      socket.disconnect();
    }
    
    // 基础URL中不包含/api的部分
    const socketBaseUrl = window.location.origin;
    
    // 初始化Socket连接
    socket = io(socketBaseUrl, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000,
      autoConnect: true
    });
    
    // 监听连接事件
    socket.on('connect', () => {
      console.log('Socket.io连接成功');
      
      // 发送钱包连接事件
      if (walletAddress) {
        socket.emit('wallet_connect', {
          walletAddress,
          userType: 'user'
        });
      }
    });
    
    // 连接确认事件
    socket.on('connect_confirmed', (data) => {
      console.log('Socket.io连接已确认:', data);
      showMessage('实时连接已建立', 'success');
    });
    
    // 连接错误事件
    socket.on('connect_error', (error) => {
      console.error('Socket.io连接错误:', error);
      showMessage('WebSocket连接失败，部分实时功能可能不可用', 'warning');
    });
    
    // 监听支付状态更新
    socket.on('payment_status_update', (data) => {
      console.log('Payment status update:', data);
      updatePaymentStatus(data);
    });
    
    // 监听交易确认
    socket.on('transaction_confirmed', (data) => {
      console.log('Transaction confirmed:', data);
      showMessage('交易已确认！', 'success');
      updateTransactionStatus(data);
    });
    
    // 监听错误消息
    socket.on('error_message', (data) => {
      console.error('Error message:', data);
      showErrorMessage(data.message || '发生错误');
    });
  } catch (error) {
    console.error('创建Socket连接失败:', error);
    showMessage('实时连接失败，请刷新页面重试', 'error');
  }
}

/**
 * 更新支付状态UI
 * @param {Object} data - 支付状态数据
 */
function updatePaymentStatus(data) {
  const statusElement = document.getElementById('payment-status');
  if (!statusElement) return;
  
  // 更新状态文本
  statusElement.textContent = getStatusText(data.status);
  
  // 更新CSS类
  statusElement.className = 'status-badge';
  statusElement.classList.add(`status-${data.status.toLowerCase()}`);
  
  // 显示通知
  const messageType = data.status === 'COMPLETED' ? 'success' : 
                     data.status === 'FAILED' ? 'error' : 'info';
  
  showMessage(`支付状态: ${getStatusText(data.status)}`, messageType);
}

/**
 * 更新交易状态UI
 * @param {Object} data - 交易数据
 */
function updateTransactionStatus(data) {
  const txElement = document.getElementById('transaction-info');
  if (!txElement) return;
  
  // 更新交易信息
  txElement.innerHTML = `
    <div class="transaction-item">
      <strong>交易ID:</strong> 
      <a href="https://explorer.solana.com/tx/${data.signature}" target="_blank" rel="noopener noreferrer">
        ${data.signature.substring(0, 8)}...${data.signature.substring(data.signature.length - 8)}
      </a>
    </div>
    <div class="transaction-item">
      <strong>状态:</strong> 
      <span class="status-badge status-completed">已确认</span>
    </div>
    <div class="transaction-item">
      <strong>确认时间:</strong> ${new Date().toLocaleString()}
    </div>
  `;
  
  // 显示成功消息
  showMessage('交易已成功确认！', 'success');
}

/**
 * 获取状态文本
 * @param {string} status - 状态代码
 * @returns {string} 状态文本
 */
function getStatusText(status) {
  const statusMap = {
    'PENDING': '等待中',
    'PROCESSING': '处理中',
    'COMPLETED': '已完成',
    'FAILED': '失败',
    'CANCELLED': '已取消'
  };
  
  return statusMap[status] || status;
}

// 初始化Socket连接
connectSocket();

// 处理二维码文件选择
function handleQrFileSelect(event) {
  console.log("开始处理QR文件选择...");
  if (!event.target.files || event.target.files.length === 0) {
    console.error("未选择任何文件");
    return;
  }
  
  const file = event.target.files[0];
  console.log("处理文件:", file.name, "类型:", file.type, "大小:", file.size);
  
  if (!file.type.startsWith('image/')) {
    console.error("选择的文件不是图像");
    alert("请选择一个图像文件");
    return;
  }
  
  const reader = new FileReader();
  
  reader.onerror = function() {
    console.error("文件读取错误");
    alert("文件读取错误，请重试");
  };
  
  reader.onload = function(e) {
    console.log("文件加载完成，正在处理图像");
    const img = new Image();
    
    img.onerror = function() {
      console.error("图像加载错误");
      alert("图像加载错误，请选择另一个文件");
    };
    
    img.onload = function() {
      console.log("图像加载成功，尺寸:", img.width, "x", img.height);
      
      // 创建Canvas来处理图像
      const canvas = document.createElement('canvas');
      const canvasContext = canvas.getContext('2d');
      
      // 设置Canvas尺寸与图像相同
      canvas.width = img.width;
      canvas.height = img.height;
      
      // 在Canvas上绘制图像
      canvasContext.drawImage(img, 0, 0, img.width, img.height);
      
      // 获取图像数据
      const imageData = canvasContext.getImageData(0, 0, canvas.width, canvas.height);
      console.log("已准备图像数据，开始扫描二维码");
      
      // 检查jsQR是否可用
      if (typeof jsQR !== 'function') {
        console.error("jsQR库未加载，无法扫描二维码");
        
        // 尝试加载jsQR库
        const script = document.createElement('script');
        script.src = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js";
        script.onload = function() {
          console.log("jsQR库动态加载成功，正在重试扫描");
          
          try {
            const code = jsQR(imageData.data, imageData.width, imageData.height);
            processQRCode(code);
          } catch (error) {
            console.error("动态加载后扫描二维码时出错:", error);
            alert("扫描二维码失败，请重试或刷新页面");
          }
        };
        
        script.onerror = function() {
          console.error("动态加载jsQR库失败");
          alert("无法加载二维码扫描功能，请检查网络连接或刷新页面");
        };
        
        document.head.appendChild(script);
        return;
      }
      
      // 扫描二维码
      try {
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        processQRCode(code);
      } catch (error) {
        console.error("扫描二维码时出错:", error);
        alert("扫描二维码时出错，请重试");
      }
    };
    
    // 从FileReader结果加载图像
    img.src = e.target.result;
  };
  
  // 以DataURL方式读取文件
  reader.readAsDataURL(file);
  
  // 处理识别到的QR码
  function processQRCode(code) {
    if (code) {
      console.log("成功识别二维码:", code.data);
      
      // 检查DOM元素是否存在再设置值
      const qrContentEl = document.getElementById("qr-content");
      if (qrContentEl) {
        qrContentEl.value = code.data;
        console.log("已设置二维码内容到表单字段");
      } else {
        console.error("未找到qr-content元素");
      }
      
      // 尝试识别支付平台
      const platform = identifyPaymentPlatform(code.data);
      if (platform) {
        console.log("识别到的支付平台信息:", platform);
        const platformSelectEl = document.getElementById("payment-platform");
        if (platformSelectEl && platform.platform) {
          // 兼容大小写和别名
          let matched = false;
          for (let i = 0; i < platformSelectEl.options.length; i++) {
            if (
              platformSelectEl.options[i].value.toLowerCase() === platform.platform.toLowerCase() ||
              platformSelectEl.options[i].text.toLowerCase() === platform.platform.toLowerCase()
            ) {
              platformSelectEl.selectedIndex = i;
              matched = true;
              break;
            }
          }
          if (!matched) {
            // fallback: 直接赋值
            platformSelectEl.value = platform.platform;
          }
          platformSelectEl.dispatchEvent(new Event('change'));
          console.log("已设置支付平台:", platform.platform);
        } else {
          console.error("未找到payment-platform元素或platform字段无效");
        }
      }
      
      // 设置金额
      if (platform.amount) {
        const paymentAmountEl = document.getElementById("payment-amount");
        if (paymentAmountEl) {
          paymentAmountEl.value = platform.amount;
          console.log("已设置支付金额:", platform.amount);
        } else {
          console.error("未找到payment-amount元素");
        }
      }
      
      // 设置PayPal邮箱
      if (platform.email) {
        const paypalEmailEl = document.getElementById("merchant-paypal-email");
        if (paypalEmailEl) {
          paypalEmailEl.value = platform.email;
          console.log("已设置PayPal邮箱:", platform.email);
        } else {
          console.error("未找到merchant-paypal-email元素");
        }
      }
      
      // 控制PayPal邮箱字段的显示
      const paypalEmailField = document.getElementById("paypal-email-field");
      if (paypalEmailField) {
        if (platform.platform === "PayPal" || platform.platform === "paypal") {
          paypalEmailField.style.display = "block";
          console.log("已显示PayPal邮箱字段");
        } else {
          paypalEmailField.style.display = "none";
          console.log("已隐藏PayPal邮箱字段");
        }
      }
      
      // 显示支付表单
      const paymentFormEl = document.getElementById("payment-form");
      if (paymentFormEl) {
        paymentFormEl.classList.remove("d-none");
        console.log("已显示支付表单");
        
        // 确保LP列表已加载
        if (typeof loadLPList === 'function') {
          try {
            loadLPList();
            console.log("已触发LP列表加载");
          } catch (error) {
            console.error("加载LP列表失败:", error);
          }
        }
      } else {
        console.error("未找到payment-form元素");
      }
    } else {
      console.error("未能识别二维码");
      alert("未能识别二维码，请尝试另一个图像");
    }
  }
}

// 识别支付平台
function identifyPaymentPlatform(qrContent) {
  console.log("开始识别QR码内容的支付平台:", qrContent);
  
  try {
    let result = {
      platform: "",
      amount: null,
      email: null
    };
    
    // 检查是否是JSON格式
    if (qrContent.trim().startsWith('{') && qrContent.trim().endsWith('}')) {
      try {
        const data = JSON.parse(qrContent);
        console.log("检测到JSON格式数据:", data);
        
        // 检查是否是PayPal JSON格式 - 支持多种可能的字段名
        if (data.p === "P" || data.platform === "PayPal" || 
            data.platform === "paypal" || data.type === "PayPal" || 
            data.type === "paypal" || data.method === "PayPal" || 
            data.method === "paypal" || data.service === "PayPal" || 
            data.service === "paypal") {
          console.log("识别为PayPal JSON格式数据");
          result.platform = "paypal";
          
          // 提取邮箱 - 检查多个可能的字段名
          const possibleEmailFields = ['a', 'email', 'e', 'receiver', 'account', 'paypal', 'paypalEmail', 'paypal_email', 'to'];
          for (const field of possibleEmailFields) {
            if (data[field] && typeof data[field] === 'string' && data[field].includes('@')) {
              result.email = data[field];
              console.log(`从JSON的${field}字段提取到PayPal邮箱:`, result.email);
              break;
            }
          }
          
          // 提取金额 - 检查多个可能的字段名
          const possibleAmountFields = ['v', 'amount', 'value', 'total', 'price', 'sum', 'm', 'money'];
          for (const field of possibleAmountFields) {
            if (data[field] !== undefined && data[field] !== null) {
              const amount = parseFloat(data[field]);
              if (!isNaN(amount)) {
                result.amount = amount;
                console.log(`从JSON的${field}字段提取到PayPal金额:`, result.amount);
                break;
              }
            }
          }
          
          // 自动填充PayPal邮箱字段
          if (result.email) {
            const merchantPaypalEmail = document.getElementById('merchant-paypal-email');
            if (merchantPaypalEmail) {
              merchantPaypalEmail.value = result.email;
              console.log("自动填充PayPal邮箱:", result.email);
            } else {
              console.log("未找到merchant-paypal-email元素，无法自动填充邮箱");
            }
          }
          
          return result;
        }
        
        // 检查是否包含任何可能表明是PayPal的字段
        if (data.paypal || data.PayPal || 
            (data.email && typeof data.email === 'string' && data.email.includes('@')) ||
            (data.amount !== undefined && data.amount !== null)) {
          console.log("发现可能是PayPal相关的JSON数据");
          result.platform = "paypal";
          
          // 提取邮箱
          if (data.email && typeof data.email === 'string' && data.email.includes('@')) {
            result.email = data.email;
            console.log("从JSON提取到PayPal邮箱:", result.email);
          } else if (data.paypal && typeof data.paypal === 'string' && data.paypal.includes('@')) {
            result.email = data.paypal;
            console.log("从JSON的paypal字段提取到PayPal邮箱:", result.email);
          } else if (data.PayPal && typeof data.PayPal === 'string' && data.PayPal.includes('@')) {
            result.email = data.PayPal;
            console.log("从JSON的PayPal字段提取到PayPal邮箱:", result.email);
          }
          
          // 提取金额
          if (data.amount !== undefined && data.amount !== null) {
            const amount = parseFloat(data.amount);
            if (!isNaN(amount)) {
              result.amount = amount;
              console.log("从JSON提取到PayPal金额:", result.amount);
            }
          }
          
          // 自动填充PayPal邮箱字段
          if (result.email) {
            const merchantPaypalEmail = document.getElementById('merchant-paypal-email');
            if (merchantPaypalEmail) {
              merchantPaypalEmail.value = result.email;
              console.log("自动填充PayPal邮箱:", result.email);
            } else {
              console.log("未找到merchant-paypal-email元素，无法自动填充邮箱");
            }
          }
          
          return result;
        }
      } catch (jsonError) {
        console.error("JSON解析失败:", jsonError);
      }
    }
    
    // 检查是否是PayPal链接
    if (qrContent.includes('paypal.com') || qrContent.includes('paypal.me')) {
      console.log("识别为PayPal链接");
      result.platform = "paypal";
      
      // 尝试提取PayPal邮箱 - 使用多种模式匹配
      let emailMatch = qrContent.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      
      // 尝试从URL参数中提取
      if (!emailMatch) {
        emailMatch = qrContent.match(/paypal_email=([^&]+)/i);
        if (emailMatch) {
          result.email = decodeURIComponent(emailMatch[1]);
          console.log("从URL参数提取到PayPal邮箱:", result.email);
        }
      }
      
      // 尝试从receiver参数中提取
      if (!emailMatch) {
        emailMatch = qrContent.match(/receiver=([^&]+)/i);
        if (emailMatch) {
          result.email = decodeURIComponent(emailMatch[1]);
          console.log("从receiver参数提取到PayPal邮箱:", result.email);
        }
      }
      
      // 尝试从merchantEmail参数中提取
      if (!emailMatch) {
        emailMatch = qrContent.match(/merchantEmail=([^&]+)/i);
        if (emailMatch) {
          result.email = decodeURIComponent(emailMatch[1]);
          console.log("从merchantEmail参数提取到PayPal邮箱:", result.email);
        }
      }
      
      // 如果之前匹配的是标准邮箱格式
      if (emailMatch && !result.email) {
        result.email = emailMatch[0];
        console.log("提取到PayPal邮箱:", result.email);
      }
      
      // 尝试提取金额
      const amountMatch = qrContent.match(/[?&]amount=([0-9.]+)/);
      if (amountMatch) {
        result.amount = parseFloat(amountMatch[1]);
        console.log("提取到PayPal金额:", result.amount);
      }
      
      // 自动填充PayPal邮箱字段
      if (result.email) {
        const merchantPaypalEmail = document.getElementById('merchant-paypal-email');
        if (merchantPaypalEmail) {
          merchantPaypalEmail.value = result.email;
          console.log("自动填充PayPal邮箱:", result.email);
        } else {
          console.log("未找到merchant-paypal-email元素，无法自动填充邮箱");
        }
      }
      
      return result;
    }
    
    // 检查是否是微信支付
    if (qrContent.includes('wxp://') || qrContent.includes('weixin://wxpay')) {
      console.log("识别为微信支付二维码");
      result.platform = "wechat";
      
      // 尝试提取金额
      const amountMatch = qrContent.match(/amount=([0-9.]+)/);
      if (amountMatch) {
        result.amount = parseFloat(amountMatch[1]);
        console.log("提取到微信支付金额:", result.amount);
      }
      
      return result;
    }
    
    // 检查是否是支付宝
    if (qrContent.includes('alipay.com') || qrContent.includes('alipayqr://') || qrContent.includes('alipays://')) {
      console.log("识别为支付宝二维码");
      result.platform = "alipay";
      
      // 尝试提取金额
      const amountMatch = qrContent.match(/[?&]amount=([0-9.]+)/);
      if (amountMatch) {
        result.amount = parseFloat(amountMatch[1]);
        console.log("提取到支付宝金额:", result.amount);
      }
      
      return result;
    }
    
    // 如果无法确定，返回未知
    console.log("无法识别支付平台，返回空结果");
    return null;
    
  } catch (error) {
    console.error("识别支付平台时出错:", error);
    return null;
  }
}

/**
 * 显示消息提示
 * @param {string} message - 消息内容
 * @param {string} type - 消息类型 (success, error, warning, info)
 */
function showMessage(message, type = 'info') {
  try {
    console.log(`显示${type}消息:`, message);
    
    // 检查是否已有消息容器
    let messageContainer = document.getElementById('app-message-container');
    if (!messageContainer) {
      // 创建消息容器
      messageContainer = document.createElement('div');
      messageContainer.id = 'app-message-container';
      messageContainer.style.position = 'fixed';
      messageContainer.style.top = '20px';
      messageContainer.style.right = '20px';
      messageContainer.style.zIndex = '9999';
      document.body.appendChild(messageContainer);
    }
    
    // 创建消息元素
    const messageElement = document.createElement('div');
    messageElement.className = `alert alert-${type} alert-dismissible fade show`;
    messageElement.style.minWidth = '300px';
    messageElement.style.marginBottom = '10px';
    messageElement.style.boxShadow = '0 2px 10px rgba(0,0,0,0.1)';
    
    // 设置消息内容
    messageElement.innerHTML = `
      ${message}
      <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
    `;
    
    // 添加到容器
    messageContainer.appendChild(messageElement);
    
    // 设置自动消失
    setTimeout(() => {
      if (messageElement && messageElement.parentNode) {
        // 使用Bootstrap淡出效果 (如果可用)
        if (typeof bootstrap !== 'undefined' && bootstrap.Alert) {
          const bsAlert = new bootstrap.Alert(messageElement);
          bsAlert.close();
        } else {
          // 否则直接移除
          messageElement.parentNode.removeChild(messageElement);
        }
      }
    }, 5000);
    
  } catch (error) {
    console.error('显示消息失败:', error);
  }
}

/**
 * 显示错误消息 - 便捷函数
 * @param {string} message - 错误消息
 */
function showErrorMessage(message) {
  showMessage(message, 'danger');
}

// 在支付意图创建成功后处理
async function handlePaymentIntent(paymentData) {
  try {
    console.log('===DEBUG=== 处理创建的支付意图:', paymentData);
    
    // 保存支付ID
    currentPaymentIntentId = paymentData.id || paymentData.paymentIntentId;
    
    // 保存支付数据到全局变量和localStorage
    window.paymentData = paymentData;
    try {
      localStorage.setItem('paymentData', JSON.stringify(paymentData));
      console.log('===DEBUG=== 支付数据已保存到localStorage');
    } catch (e) {
      console.error('===DEBUG=== 保存支付数据失败:', e);
    }
    
    // 显示订单详情
    showPaymentDetails(paymentData);
    
    // 检查钱包是否已连接，如果没有，则显示提示信息而不是自动尝试区块链处理
    if (!window.ethereum || !window.ethereum.selectedAddress) {
      console.log('===DEBUG=== 钱包未连接，展示连接钱包提示');
      showBlockchainStatus('请先连接钱包，然后点击"开始处理"按钮进行区块链处理', 'warning');
      
      // 确保"开始处理"按钮可见和可用
      const startProcessBtn = document.getElementById('start-blockchain-process');
      if (startProcessBtn) {
        startProcessBtn.disabled = false;
        startProcessBtn.textContent = '开始处理';
        startProcessBtn.classList.remove('d-none');
      }
      
      return true;
    }
    
    // 强制处理所有支付数据，无论平台类型
    console.log('===DEBUG=== 开始执行区块链处理，无视平台类型');
    await startBlockchainProcess();
    
    return true;
  } catch (error) {
    console.error('===DEBUG=== 处理支付意图失败:', error);
    showMessage(error.message || '处理支付意图失败', 'error');
    return false;
  }
}

/**
 * 准备支付 - 检查USDC账户和余额状态，再创建支付意图
 */
async function preparePayment() {
  try {
    disablePayNowButton();
    
    // 获取支付数据
    const paymentData = getPaymentFormData();
    if (!paymentData) {
      showErrorMessage('获取支付表单数据失败');
      enablePayNowButton();
      return;
    }
    
    log('准备支付，数据:', paymentData);
    
    // 仅对Solana支付进行特殊处理
    if (currentNetwork === 'solana') {
      log('进行Solana支付前置检查');
      
      // 从UI获取USDC余额 - 最可靠的方式
      const usdcBalanceElement = document.getElementById('usdc-balance');
      let usdcBalance = 0;
      let hasAccount = false;
      
      if (usdcBalanceElement && usdcBalanceElement.textContent) {
        usdcBalance = parseFloat(usdcBalanceElement.textContent.trim());
        if (!isNaN(usdcBalance) && usdcBalance > 0) {
          log('UI显示USDC余额:', usdcBalance);
          hasAccount = true;
        }
      }
      
      // 如果UI余额大于0，直接创建支付意图
      if (usdcBalance > 0) {
        log('UI显示有USDC余额，直接创建支付意图');
        showMessage('USDC账户已验证，创建支付...', 'success');
        return await createPaymentIntent(0);
      }
      
      // 检查USDC账户
      const usdcAccount = await window.solanaIntegration.getUsdcAccount();
      if (usdcAccount) {
        log('找到USDC账户:', usdcAccount);
        showMessage('USDC账户已验证，创建支付...', 'success');
        return await createPaymentIntent(0);
      }
      
      // 如果没有USDC账户，需要创建
      log('未找到USDC账户，准备创建');
      showMessage('正在创建USDC代币账户，请在钱包中确认交易...', 'info');
      
      // 获取网络配置
      const config = window.getSolanaNetworkConfig ? window.getSolanaNetworkConfig() : window.SOLANA_NETWORK_CONFIG;
      if (!config || !config.usdcMint) {
        throw new Error('未找到USDC配置');
      }
      
      // 创建USDC代币账户
      if (typeof window.solanaIntegration.createTokenAccount !== 'function') {
        throw new Error('创建代币账户功能不可用');
      }
      
      const createResult = await window.solanaIntegration.createTokenAccount(config.usdcMint);
      
      if (!createResult || !createResult.success) {
        throw new Error(createResult?.error || '创建USDC账户失败');
      }
      
      log('USDC账户创建成功:', createResult);
      showMessage('USDC账户创建成功，等待网络同步...', 'success');
      
      // 等待30秒，让区块链有足够时间同步
      log('等待30秒让网络同步账户信息...');
      showMessage('正在等待网络同步账户信息，请稍候...', 'info');
      await new Promise(resolve => setTimeout(resolve, 30000));
      
      // 确认账户创建成功
      const finalCheck = await window.solanaIntegration.getUsdcAccount();
      if (!finalCheck) {
        throw new Error('USDC账户创建后无法验证，请稍后再试');
      }
      
      // 创建支付意图
      log('USDC账户已就绪，继续创建支付意图');
      showMessage('继续创建支付...', 'info');
      return await createPaymentIntent(0);
    } else {
      // 非Solana支付，直接创建支付意图
      return await createPaymentIntent(0);
    }
    
  } catch (error) {
    logError('支付准备失败:', error);
    showErrorMessage(`支付准备失败: ${error.message}`);
    enablePayNowButton();
    return { success: false, error: error.message };
  }
}

/**
 * 创建支付意图
 * @param {number} retryCount - 当前重试次数
 */
async function createPaymentIntent(retryCount = 0) {
+  console.log('DEBUG createPaymentIntent invoked, retryCount=', retryCount);
  try {
    disablePayNowButton();
    const MAX_RETRIES = 2;
    if (retryCount > MAX_RETRIES) {
      throw new Error(`已达到最大重试次数(${MAX_RETRIES})，请稍后再试`);
    }
    const paymentData = getPaymentFormData();
+    console.log('DEBUG createPaymentIntent payload:', paymentData);
    if (!paymentData) {
      showErrorMessage('获取支付表单数据失败');
      enablePayNowButton();
      return;
    }
    log('创建支付意图数据:', paymentData);
    if (currentNetwork === 'solana') {
      const usdcAccount = await window.solanaIntegration.getUsdcAccount();
      if (!usdcAccount) {
        throw new Error('未找到USDC代币账户');
      }
      paymentData.usdcTokenAccount = usdcAccount;
    }
    const url = currentNetwork === 'solana' 
      ? '/api/solana/payment-intents'
      : '/api/payment-intents';
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(paymentData)
    });
    log('收到响应，HTTP状态码:', response.status);
    const responseData = await response.json();
    log('服务器原始响应数据:', responseData);
    if (!responseData.success) {
      throw new Error(responseData.message || '创建支付意图失败');
    }
    createPaymentBtn.disabled = false;
    createPaymentBtn.innerHTML = '确认支付';
    // 刷新订单表格
    await loadUserPaymentTasks();
    // 隐藏支付表单并滚动到订单列表
    if (paymentForm) {
      paymentForm.classList.add('d-none');
    }
    const tasksSection = document.getElementById('payment-tasks-list');
    if (tasksSection) {
      tasksSection.scrollIntoView({ behavior: 'smooth' });
    }
    showMessage('订单创建成功！', 'success');
    return { success: true, paymentIntentId: responseData.data.paymentIntentId };
  } catch (error) {
    logError('创建支付意图失败:', error);
    showErrorMessage(`创建支付意图失败: ${error.message}`);
    enablePayNowButton();
    return { success: false, error: error.message };
  }
}

// 记录支付流程已更新
log('支付流程已更新: 先检查USDC账户和余额，再创建支付意图');

// 从PayPal链接中提取邮箱
function extractPayPalEmail(text) {
  try {
    // 检查是否是JSON格式
    if (text.startsWith('{') && text.endsWith('}')) {
      const data = JSON.parse(text);
      return data.email || data.paypalEmail || data.receiver || null;
    }
    
    // 检查是否是URL格式
    if (text.startsWith('http')) {
      try {
        const url = new URL(text);
        return url.searchParams.get('paypalEmail') || 
               url.searchParams.get('receiver') || 
               url.searchParams.get('merchantEmail') || 
               url.searchParams.get('paypal_email');
      } catch (e) {
        // URL解析失败，尝试正则匹配
        const emailMatch = text.match(/paypal_email=([^&]+)/i) || 
                         text.match(/receiver=([^&]+)/i) || 
                         text.match(/merchantEmail=([^&]+)/i);
        if (emailMatch) {
          return decodeURIComponent(emailMatch[1]);
        }
      }
    }
    
    // 直接搜索邮箱格式
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const emailMatch = text.match(emailRegex);
    if (emailMatch) {
      return emailMatch[0];
    }
    
    return null;
  } catch (e) {
    console.error('提取PayPal邮箱失败:', e);
    return null;
  }
}

// 加载用户支付任务
async function loadUserPaymentTasks() {
+  console.log('DEBUG loadUserPaymentTasks invoked');
  try {
    console.log('开始加载用户支付任务');
    
    // 确保API_BASE_URL已定义
    const API_BASE_URL = window.API_BASE_URL || '/api';
    console.log('使用API基础URL:', API_BASE_URL);
    
    // 确保钱包已连接
    const isEthWalletConnected = isWalletConnected && walletAddress;
    const isSolWalletConnected = window.solanaIntegration && 
                                typeof window.solanaIntegration.isSolanaConnected === 'function' && 
                                window.solanaIntegration.isSolanaConnected();
    
    if (!isEthWalletConnected && !isSolWalletConnected) {
      console.error('无法加载任务：钱包未连接');
      updateTasksList([], 'Please connect your wallet to view your tasks');
      return;
    }
    
    // 获取钱包地址
    let userWalletAddress = isEthWalletConnected ? walletAddress : null;
    
    // 如果是Solana钱包，获取地址
    if (isSolWalletConnected && window.solanaIntegration) {
      try {
        userWalletAddress = window.solanaIntegration.getSolAddress();
      } catch (error) {
        console.error('获取Solana地址失败:', error);
      }
    }
    
    // 验证钱包地址的有效性
    if (!userWalletAddress || typeof userWalletAddress !== 'string' || userWalletAddress.trim() === '') {
      console.error('钱包地址无效:', userWalletAddress);
      updateTasksList([], '无法获取有效的钱包地址');
      return;
    }
    
    // 显示加载状态
    updateTasksList(null, 'Loading payment tasks...');
    
    // 发送API请求获取用户的支付任务
    const response = await fetch(`${API_BASE_URL}/payment-intents/user/${userWalletAddress}`);
    
    if (!response.ok) {
      throw new Error(`获取任务列表失败: ${response.status}`);
    }
    
    const result = await response.json();
    console.log('DEBUG loadUserPaymentTasks raw result data:', result.data.paymentIntents);
    
    if (!result.success) {
      throw new Error(result.message || '获取任务列表失败');
    }
    
    // 更新任务列表
    updateTasksList(result.data.paymentIntents);
    
  } catch (error) {
    console.error('加载用户支付任务失败:', error);
    updateTasksList([], `加载失败: ${error.message}`);
  }
}

// 更新任务列表UI的辅助函数
function updateTasksList(tasks, message = null) {
  console.log('updateTasksList called', { tasksLength: tasks ? tasks.length : tasks, message });
  const tasksList = document.getElementById('payment-tasks-list');
  if (!tasksList) return;
  
  // 加载状态
  if (tasks === null && message) {
    tasksList.innerHTML = `
      <div class="text-center my-3">
        <div class="spinner-border text-primary" role="status">
          <span class="visually-hidden">Loading...</span>
        </div>
        <p class="mt-2">${message}</p>
      </div>
    `;
    return;
  }
  
  // 无任务或错误
  if (!tasks || tasks.length === 0) {
    tasksList.innerHTML = `<div class="text-center py-3" id="no-tasks-message">${message || 'No payment tasks'}</div>`;
    return;
  }
  
  // 渲染任务列表
  tasksList.innerHTML = '';
  tasks.forEach(task => {
+    console.log('DEBUG Task object:', task);
+    console.log('DEBUG Task object keys:', Object.keys(task));
    console.log('updateTasksList: Task ID=', task.id || task._id, 'Status=', task.status);
    const isPaidStatus = ['paid', 'completed'].includes((task.status || '').toLowerCase());
    const statusKey = (task.status || '').toLowerCase();
    const statusMap = { created: 'secondary', pending: 'warning', locked: 'info', paid: 'primary', completed: 'primary', confirmed: 'success', cancelled: 'danger', failed: 'danger' };
    const badgeClass = statusMap[statusKey] || 'secondary';
    const lpAddress = task.lpWalletAddress || task.lpAddress || '';
    console.log('DEBUG LP Address for task', task.id || task._id, ':', lpAddress);
    // Create styled card with grouped task info
    const card = document.createElement('div');
    card.className = 'card mb-3 rounded-lg shadow-md';
    card.innerHTML = `
      <div class="card-body p-4">
        <div class="d-flex justify-content-between align-items-center mb-3">
          <h5 class="card-title fw-bold fs-4 mb-0"><span class="me-2">💸</span>${task.platform || 'Payment'} Payment</h5>
          <small class="text-muted"><i class="bi bi-clock me-1"></i>${new Date(task.createdAt || Date.now()).toLocaleString()}</small>
        </div>
        <hr class="my-3">
        <div class="row g-2 mb-3">
          <div class="col-md-6"><strong>Amount:</strong> ${task.amount || '0'} ${task.currency || 'USDT'}</div>
          <div class="col-md-6"><strong>Description:</strong> ${task.description || 'None'}</div>
        </div>
        <div class="row g-2 mb-3">
          <div class="col-md-6"><strong>Status:</strong> <span class="badge bg-${badgeClass}">${task.status || 'Unknown'}</span></div>
          <div class="col-md-6"><strong>LP Address:</strong> <span class="text-truncate">${lpAddress || 'None'}</span></div>
        </div>
        <div class="row g-2 mb-3">
          <div class="col-md-6"><strong>ID:</strong> ${task.id || task._id || 'Unknown'}</div>
          <div class="col-md-6"><strong>Created At:</strong> ${new Date(task.createdAt || Date.now()).toLocaleString()}</div>
        </div>
        <div class="d-flex justify-content-end gap-2">
          ${isPaidStatus ? `<button class="btn btn-success btn-sm" onclick="confirmReceipt('${task.id}')"><i class="bi bi-check2-circle me-1"></i> Confirm Receipt</button>` : ''}
          <button class="btn btn-secondary btn-sm" onclick="viewDetails('${task.id || task._id}')"><i class="bi bi-eye me-1"></i> View Details</button>
        </div>
      </div>
    `;
    tasksList.appendChild(card);
  });
}

/**
 * 授权USDT (适用于app.js)
 * @returns {Promise<Object>} 授权结果
 */
async function approveAppUSDT() {
    try {
        console.log('===DEBUG=== 开始授权USDT');
        
        // 确保钱包已连接
        if (!window.ethereum || !window.ethereum.selectedAddress) {
            console.error('===DEBUG=== 钱包未连接，无法授权USDT');
            return {
                success: false,
                error: '请先连接钱包',
                errorCode: 'WALLET_NOT_CONNECTED'
            };
        }
        
        // 初始化合约服务 - 优先使用已存在的实例
        if (!window.contractService) {
            console.log('===DEBUG=== 创建合约服务实例');
            window.contractService = new ContractService();
        }
        
        // 确保Web3已初始化
        if (!window.contractService.isInitialized()) {
            console.log('===DEBUG=== 初始化Web3');
            const web3Initialized = await window.contractService.initializeWeb3();
            if (!web3Initialized) {
                console.error('===DEBUG=== Web3初始化失败');
                return {
                    success: false,
                    error: 'Web3初始化失败，请确保钱包已正确连接',
                    errorCode: 'WEB3_INIT_FAILED'
                };
            }
        }
        
        // 确保合约已初始化
        try {
            console.log('===DEBUG=== 初始化合约');
            await window.contractService.initializeContracts();
        } catch (contractError) {
            console.error('===DEBUG=== 合约初始化失败:', contractError);
            return {
                success: false,
                error: `合约初始化失败: ${contractError.message}`,
                errorCode: 'CONTRACT_INIT_FAILED'
            };
        }
        
        // 验证支付数据
        if (!window.paymentData || !window.paymentData.amount) {
            return {
                success: false,
                error: '支付数据缺失或金额无效',
                errorCode: 'INVALID_PAYMENT_DATA'
            };
        }
        
        // 获取费率和计算总金额
        const originalAmount = parseFloat(window.paymentData.amount);
        const feeRate = window.paymentData.feeRate || 0.5;
        const totalAmount = originalAmount * (1 + feeRate / 100);
        
        // 四舍五入到6位小数（USDT标准）
        const formattedTotalAmount = totalAmount.toFixed(6);
        
        console.log('===DEBUG=== 授权USDT金额:', {
            originalAmount: originalAmount,
            feeRate: feeRate + '%',
            totalAmount: formattedTotalAmount
        });
        
        // 授权包含费率的总金额
        const result = await window.contractService.approveUSDT(formattedTotalAmount);
        console.log('===DEBUG=== 授权结果:', result);
        
        return result;
    } catch (error) {
        console.error('===DEBUG=== 授权USDT失败:', error);
        return {
            success: false,
            error: error.message,
            errorCode: 'APPROVE_FAILED'
        };
    }
}

// 规范化支付数据
function normalizePaymentData(rawData) {
    if (!rawData) {
        console.error('===DEBUG=== 没有提供支付数据');
        return null;
    }
    
    console.log('===DEBUG=== 规范化支付数据:', rawData);
    
    // 检查LP地址字段
    const lpAddressValue = rawData.lpWalletAddress || rawData.lpAddress;
    
    // 获取费率，默认为0.5%
    const feeRate = rawData.feeRate || 0.5;
    
    // 创建标准化数据对象
    const normalizedData = {
        id: rawData.id || rawData.paymentIntentId || '',
        paymentIntentId: rawData.paymentIntentId || rawData.id || '',
        amount: rawData.amount || '0',
        lpWalletAddress: lpAddressValue || '',
        lpAddress: lpAddressValue || '',
        platform: rawData.platform || 'Other',
        status: rawData.status || 'created',
        description: rawData.description || '',
        currency: rawData.currency || 'USDT',
        feeRate: feeRate // 添加费率字段
    };
    
    console.log('===DEBUG=== 规范化后的数据:', normalizedData);
    return normalizedData;
}

// 显示区块链处理状态
function showBlockchainStatus(message, type = 'info') {
    const statusElement = document.getElementById('blockchain-status');
    if (statusElement) {
        statusElement.innerHTML = `<div class="alert alert-${type}">${message}</div>`;
    }
}

// 启用区块链操作按钮
function enableBlockchainButtons() {
    const approveButton = document.getElementById('approve-usdt');
    const settleButton = document.getElementById('settle-payment');
    
    if (approveButton) approveButton.disabled = false;
    if (settleButton) settleButton.disabled = false;
}

// 禁用区块链操作按钮
function disableBlockchainButtons() {
    const approveButton = document.getElementById('approve-usdt');
    const settleButton = document.getElementById('settle-payment');
    
    if (approveButton) approveButton.disabled = true;
    if (settleButton) settleButton.disabled = true;
}

/**
 * 从本地存储恢复交易信息
 */
function restoreTransactionDetails() {
    try {
        // 尝试获取存储的交易哈希和支付状态
        const txHash = safeLocalStorage('get', 'lastTxHash');
        const paymentStatus = safeLocalStorage('get', 'paymentStatus');
        
        if (!txHash || paymentStatus !== 'locked') {
            return false;
        }
        
        console.log('===DEBUG=== 从本地存储恢复交易信息:', { txHash, status: paymentStatus });
        
        // 获取其他交易详情
        const blockNumber = safeLocalStorage('get', 'lastBlockNumber') || '已确认';
        const txTime = safeLocalStorage('get', 'lastTxTime') || new Date().toISOString();
        const paymentAmount = safeLocalStorage('get', 'lastPaymentAmount') || '';
        const paymentId = safeLocalStorage('get', 'lastPaymentId') || '';
        const lpAddress = safeLocalStorage('get', 'lastLpAddress') || '';
        
        // 如果存在支付数据，恢复为全局变量
        if (paymentId && paymentAmount && lpAddress) {
            window.paymentData = {
                id: paymentId,
                paymentIntentId: paymentId,
                amount: paymentAmount,
                lpWalletAddress: lpAddress,
                lpAddress: lpAddress,
                status: 'locked'
            };
            console.log('===DEBUG=== 恢复payment数据:', window.paymentData);
        }
        
        // 模拟交易结果对象
        const mockResult = {
            success: true,
            txHash: txHash,
            receipt: {
                blockNumber: blockNumber
            },
            txTime: txTime
        };
        
        // 生成交易详情面板
        displayTransactionDetails(mockResult);
        
        // 更新状态显示
        const statusElement = document.getElementById('payment-status');
        if (statusElement) {
            statusElement.textContent = '已锁定';
            statusElement.className = 'status locked';
        }
        
        // 显示成功消息
        showBlockchainStatus('交易已成功处理并保存到区块链', 'success');
        
        // 禁用处理按钮
        const startProcessBtn = document.getElementById('start-blockchain-process');
        if (startProcessBtn) {
            startProcessBtn.disabled = true;
            startProcessBtn.textContent = '处理完成';
        }
        
        // 如果存在支付金额，显示到UI
        if (paymentAmount) {
            const amountElement = document.getElementById('payment-amount');
            if (amountElement && !amountElement.textContent.includes(paymentAmount)) {
                amountElement.textContent = `${paymentAmount} USDT`;
            }
        }
        
        // 如果存在LP地址，显示到UI
        if (lpAddress) {
            const lpAddressElement = document.getElementById('lp-address');
            if (lpAddressElement && !lpAddressElement.textContent.includes(lpAddress)) {
                lpAddressElement.textContent = lpAddress;
            }
        }
        
        return true;
    } catch (e) {
        console.error('===DEBUG=== 恢复交易信息失败:', e);
        return false;
    }
}

// 页面加载完成后初始化应用
document.addEventListener('DOMContentLoaded', initApp);

/**
 * 模拟后端响应
 * @param {string} type - 响应类型 (blockchain-lock, confirm, etc)
 * @param {Object} data - 响应数据
 * @returns {Object} 模拟的响应结果
 */
function simulateBackendResponse(type, data = {}) {
    console.log(`===DEBUG=== 模拟后端${type}响应:`, data);
    
    // 根据不同类型返回不同的模拟数据
    switch(type) {
        case 'blockchain-lock':
            return {
                success: true,
                message: '交易已记录',
                status: 'locked',
                updatedAt: new Date().toISOString(),
                txHash: data.txHash || 'unknown'
            };
        case 'confirm':
            return {
                success: true,
                message: '支付已确认',
                status: 'confirmed',
                updatedAt: new Date().toISOString()
            };
        case 'cancel':
            return {
                success: true,
                message: '支付已取消',
                status: 'cancelled',
                updatedAt: new Date().toISOString()
            };
        default:
            return {
                success: true,
                message: '操作已模拟',
                status: 'processed',
                updatedAt: new Date().toISOString()
            };
    }
}

/**
 * 确认收到付款
 * @param {string} paymentId - 支付ID
 */
async function confirmReceipt(paymentId) {
  if (!confirm('确认已收到支付？')) return;
  try {
    const API_BASE_URL = window.API_BASE_URL || '/api';
    const res = await fetch(`${API_BASE_URL}/payment-intents/${paymentId}/confirm`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({})
    });
    const result = await res.json();
    if (!result.success) throw new Error(result.message);
    alert('确认收款成功');
    loadUserPaymentTasks();
  } catch (error) {
    console.error('确认收款失败:', error);
    alert('确认收款失败: ' + error.message);
  }
}

/**
 * 获取交易浏览器URL
 * @param {string} txHash - 交易哈希
 * @returns {string} 交易浏览器URL
 */
function getExplorerTxUrl(txHash) {
  // 使用 ContractService 获取交易浏览器URL
  return ContractService.getExplorerTxUrl(txHash);
}

/**
 * 缩短哈希值显示
 * @param {string} hash - 哈希值
 * @returns {string} 缩短后的哈希值
 */
function shortenHash(hash) {
  if (!hash) return '';
  return hash.substring(0, 6) + '...' + hash.substring(hash.length - 4);
}

/**
 * 释放支付
 * @param {string} paymentId - 支付ID
 */
async function releasePayment(e) {
  e.preventDefault();
  closeModals();

  try {
    // 显示加载提示
    startLoading('正在解锁支付，请稍候...');
    
    // 获取当前支付ID
    if (!currentPaymentIntentId) {
      throw new Error('未找到支付ID，请刷新页面重试');
    }
    
    let paymentId = currentPaymentIntentId;
    console.log(`正在解锁支付，前端ID: ${paymentId}`);
    
    // 获取区块链支付ID（如果存在）
    // 检查多种可能的ID映射键格式
    let blockchainPaymentId = null;
    
    // 首先检查标准格式
    blockchainPaymentId = localStorage.getItem(`blockchain_id_${paymentId}`);
    
    // 然后检查其他可能的格式
    if (!blockchainPaymentId) {
      blockchainPaymentId = localStorage.getItem(`blockchain_payment_id_${paymentId}`);
    }
    
    if (!blockchainPaymentId) {
      blockchainPaymentId = localStorage.getItem(`payment_blockchain_id_${paymentId}`);
    }
    
    if (!blockchainPaymentId) {
      // 如果找不到映射，则使用原始ID
      blockchainPaymentId = paymentId;
      console.warn(`找不到支付ID: ${paymentId} 的区块链ID映射，将直接使用前端ID`);
    } else {
      console.log(`找到区块链ID映射: 前端ID ${paymentId} -> 区块链ID ${blockchainPaymentId}`);
    }
    
    // 执行解锁交易
    console.log(`提交解锁交易，使用区块链ID: ${blockchainPaymentId}...`);
    const tx = await settlementContract.releasePayment(blockchainPaymentId);
    console.log('解锁支付交易已提交:', tx.hash);
    
    // 更新UI
    showMessage('解锁支付交易已提交，等待区块确认...', 'info');
    updateTransactionStatus('解锁交易已提交，等待确认', 'inProgress', getExplorerTxUrl(tx.hash));
    
    // 等待交易确认
    const receipt = await tx.wait();
    console.log('解锁支付交易已确认:', receipt);
    
    // 判断交易是否成功
    if (receipt.status === 1) {
      // 更新UI显示
      showMessage('支付已成功解锁给接收方', 'success');
      updateTransactionStatus('支付已解锁', 'success', getExplorerTxUrl(receipt.transactionHash));
      document.getElementById('releasePaymentBtn').disabled = true;
      document.getElementById('releasePaymentBtn').textContent = '已解锁';
      
      // 更新支付状态
      loadPaymentDetails(paymentId);
    } else {
      showMessage('解锁支付失败，交易被回滚', 'error');
      updateTransactionStatus('解锁支付失败', 'error', getExplorerTxUrl(receipt.transactionHash));
    }
  } catch (error) {
    console.error('解锁支付时发生错误:', error);
    handleContractError(error, '解锁支付失败');
  } finally {
    stopLoading();
  }
}

/**
 * 检查支付状态是否允许确认
 * @param {string} paymentId - 支付ID
 * @returns {Promise<boolean>} 是否可以确认
 */
async function isPaymentConfirmable(paymentId) {
  try {
    console.log(`[isPaymentConfirmable] 开始检查支付是否可确认, ID: ${paymentId}`);
    
    if (!paymentId) {
      console.error('[isPaymentConfirmable] 支付ID为空');
      showMessage('支付ID不能为空', 'error');
      return false;
    }
    
    if (!window.contractService) {
      console.error('[isPaymentConfirmable] 合约服务未初始化');
      showMessage('区块链服务未初始化，请刷新页面重试', 'error');
      return false;
    }
    
    // 确保合约服务已初始化
    if (!window.contractService.isInitialized()) {
      console.log('[isPaymentConfirmable] 合约服务未初始化，尝试初始化...');
      try {
        await window.contractService.initializeWeb3();
        console.log('[isPaymentConfirmable] 合约服务初始化成功');
      } catch (initError) {
        console.error('[isPaymentConfirmable] 合约服务初始化失败:', initError);
        showMessage('初始化区块链服务失败，请检查钱包连接并刷新页面', 'error');
        return false;
      }
    }
    
    // 检查钱包地址
    const walletAddress = window.contractService.walletAddress;
    if (!walletAddress) {
      console.error('[isPaymentConfirmable] 未检测到钱包地址');
      showMessage('请先连接钱包', 'warning');
      return false;
    }
    console.log(`[isPaymentConfirmable] 当前钱包地址: ${walletAddress}`);
    
    // 获取托管合约
    let settlementContract;
    try {
      settlementContract = await window.contractService.getEscrowContract();
      console.log('[isPaymentConfirmable] 托管合约获取成功');
    } catch (contractError) {
      console.error('[isPaymentConfirmable] 获取托管合约失败:', contractError);
      showMessage('获取智能合约失败，请检查网络连接', 'error');
      return false;
    }
    
    try {
      // 尝试使用getPayment方法（如果存在）
      console.log(`[isPaymentConfirmable] 尝试获取支付状态，支付ID: ${paymentId}`);
      
      // 由于我们不确定合约上确切的方法名称，尝试几种可能的方法名
      let payment;
      let methodUsed = '';
      
      if (typeof settlementContract.getPayment === 'function') {
        try {
          payment = await settlementContract.getPayment(paymentId);
          methodUsed = 'getPayment';
          console.log(`[isPaymentConfirmable] 使用${methodUsed}获取到支付状态:`, payment);
        } catch (e) {
          console.warn(`[isPaymentConfirmable] ${methodUsed}方法调用失败:`, e.message);
        }
      }
      
      if (!payment && typeof settlementContract.getEscrow === 'function') {
        try {
          payment = await settlementContract.getEscrow(paymentId);
          methodUsed = 'getEscrow';
          console.log(`[isPaymentConfirmable] 使用${methodUsed}获取到支付状态:`, payment);
        } catch (e) {
          console.warn(`[isPaymentConfirmable] ${methodUsed}方法调用失败:`, e.message);
        }
      }
      
      if (!payment && typeof settlementContract.payments === 'function') {
        try {
          payment = await settlementContract.payments(paymentId);
          methodUsed = 'payments';
          console.log(`[isPaymentConfirmable] 使用${methodUsed}获取到支付状态:`, payment);
        } catch (e) {
          console.warn(`[isPaymentConfirmable] ${methodUsed}方法调用失败:`, e.message);
        }
      }
      
      if (!payment && typeof settlementContract.escrows === 'function') {
        try {
          payment = await settlementContract.escrows(paymentId);
          methodUsed = 'escrows';
          console.log(`[isPaymentConfirmable] 使用${methodUsed}获取到支付状态:`, payment);
        } catch (e) {
          console.warn(`[isPaymentConfirmable] ${methodUsed}方法调用失败:`, e.message);
        }
      }
      
      // 如果能获取到payment对象，分析它的结构
      if (payment) {
        console.log(`[isPaymentConfirmable] 成功通过${methodUsed}获取支付对象:`, payment);
        
        // 尝试从返回的结构中确定状态
        // 如果返回的是数组，尝试按照标准Escrow结构解析
        if (Array.isArray(payment)) {
          // 标准Escrow返回: [user, token, amount, lp, timestamp, released]
          const released = payment[5]; // 假设第6个元素是released状态
          const owner = payment[0];    // 假设第1个元素是所有者地址
          
          console.log(`[isPaymentConfirmable] 支付对象是数组，解析结果 - 所有者: ${owner}, 已释放: ${released}`);
          
          // 检查用户是否为支付的所有者
          const currentWallet = window.contractService.walletAddress;
          const isOwner = owner && currentWallet ? 
                          owner.toLowerCase() === currentWallet.toLowerCase() : 
                          false;
          
          console.log(`[isPaymentConfirmable] 当前钱包是否为所有者: ${isOwner}`);
          
          // 如果不是所有者，显示错误
          if (!isOwner) {
            showMessage('您不是此支付的所有者，无法确认', 'warning');
            return false;
          }
          
          // 如果已释放，显示错误
          if (released) {
            showMessage('此支付已释放，无法再次确认', 'warning');
            return false;
          }
          
          // 支付未释放且当前用户是所有者，则可以确认
          console.log('[isPaymentConfirmable] 支付状态检查通过，可以确认');
          return true;
        } 
        // 如果返回的是对象，查找status或state属性
        else if (typeof payment === 'object') {
          const status = payment.status || payment.state;
          const owner = payment.user || payment.owner;
          const released = payment.released || payment.isReleased || payment.status === 'RELEASED';
          
          console.log(`[isPaymentConfirmable] 支付对象是对象，解析结果 - 所有者: ${owner}, 状态: ${status}, 已释放: ${released}`);
          
          // 检查用户是否为支付的所有者
          const currentWallet = window.contractService.walletAddress;
          const isOwner = owner && currentWallet ? 
                          owner.toLowerCase() === currentWallet.toLowerCase() : 
                          false;
                          
          console.log(`[isPaymentConfirmable] 当前钱包是否为所有者: ${isOwner}`);
          
          // 如果不是所有者，显示错误
          if (!isOwner) {
            showMessage('您不是此支付的所有者，无法确认', 'warning');
            return false;
          }
          
          // 如果已释放，显示错误
          if (released) {
            showMessage('此支付已释放，无法再次确认', 'warning');
            return false;
          }
          
          // 如果有明确的status或state字段
          if (status) {
            const validStatuses = ['ACTIVE', 'LOCKED', 'CREATED'];
            const canConfirm = validStatuses.includes(status);
            
            console.log(`[isPaymentConfirmable] 状态(${status})是否允许确认: ${canConfirm}`);
            
            if (!canConfirm) {
              showMessage(`当前支付状态(${status})不允许确认`, 'warning');
              return false;
            }
            
            return true;
          }
          
          // 否则看released字段
          console.log('[isPaymentConfirmable] 支付状态检查通过，可以确认');
          return !released && isOwner;
        }
      } else {
        console.log('[isPaymentConfirmable] 无法通过合约方法获取支付信息，尝试使用估算gas方式检查');
      }
      
      // 尝试调用confirmPayment方法进行估算，看是否会失败
      try {
        // 这里我们不实际执行交易，只是估算gas
        console.log(`[isPaymentConfirmable] 尝试估算确认交易gas，支付ID: ${paymentId}`);
        const gasEstimate = await settlementContract.estimateGas.confirmPayment(paymentId);
        console.log('[isPaymentConfirmable] 确认交易gas估算成功:', gasEstimate.toString());
        // 如果能够成功估算gas，说明支付状态允许确认
        console.log('[isPaymentConfirmable] Gas估算成功，支付可以确认');
        return true;
      } catch (gasError) {
        console.error('[isPaymentConfirmable] 确认交易gas估算失败:', gasError);
        
        // 解析合约错误消息
        let errorReason = '';
        const errorObject = gasError.error || gasError;
        const errorData = errorObject?.data?.data;
        
        // 尝试从错误数据中提取实际错误消息
        if (errorData) {
          try {
            // 错误数据通常是十六进制编码的字符串，需要解码
            // 截取错误数据的有效部分（跳过前缀）并解码
            // 典型格式: 0x08c379a0...
            const PREFIX_LENGTH = 138; // 典型的错误数据前缀长度
            if (typeof ethers !== 'undefined' && typeof ethers.utils !== 'undefined') {
              const decodedError = ethers.utils.toUtf8String('0x' + errorData.slice(PREFIX_LENGTH));
              console.log('[isPaymentConfirmable] 解码后的错误消息:', decodedError);
              errorReason = decodedError;
            }
          } catch (decodeError) {
            console.error('[isPaymentConfirmable] 解析错误数据失败:', decodeError);
          }
        }
        
        // 合约错误: Payment not found
        if ((errorReason && errorReason.includes('Payment not found')) || 
            (gasError.message && gasError.message.includes('Payment not found'))) {
          showMessage(`支付ID "${paymentId}" 在链上不存在，请确认ID是否正确或重新创建订单`, 'warning');
          return false;
        }
        
        // 合约错误: Invalid payment status - 提供更具体的错误信息
        if ((errorReason && (errorReason.includes('Invalid payment status') || errorReason.includes('invalid status'))) ||
            (gasError.message && (gasError.message.includes('Invalid payment status') || gasError.message.includes('invalid status')))) {
          
          console.log('[isPaymentConfirmable] 检测到无效支付状态错误，尝试获取详细信息');
          
          // 尝试获取支付的当前状态来提供更详细的错误信息
          try {
            // 尝试调用查询方法获取支付状态（如果存在）
            let paymentStatus = null;
            let statusName = "未知";
            
            // 根据合约提供的方法获取状态
            if (typeof settlementContract.getPaymentStatus === 'function') {
              paymentStatus = await settlementContract.getPaymentStatus(paymentId);
              console.log(`[isPaymentConfirmable] 通过getPaymentStatus获取到状态:`, paymentStatus);
            } else if (typeof settlementContract.getEscrowStatus === 'function') {
              paymentStatus = await settlementContract.getEscrowStatus(paymentId);
              console.log(`[isPaymentConfirmable] 通过getEscrowStatus获取到状态:`, paymentStatus);
            }
            
            // 如果能获取到状态，提供更具体的信息
            if (paymentStatus !== null) {
              // 解析状态码为状态名称
              if (typeof paymentStatus === 'number') {
                statusName = getPaymentStatusName(paymentStatus);
              } else if (typeof paymentStatus === 'string') {
                statusName = paymentStatus;
              }
              
              if (statusName === "CONFIRMED" || statusName === "SETTLED" || 
                  statusName.includes('confirm') || statusName.includes('settle')) {
                showMessage(`此支付已被确认，不能重复确认`, 'warning');
              } else if (statusName === "RELEASED" || statusName.includes('release')) {
                showMessage(`此支付已被释放，无法确认`, 'warning');
              } else if (statusName === "CANCELLED" || statusName.includes('cancel')) {
                showMessage(`此支付已被取消，无法确认`, 'warning');
              } else if (statusName === "DISPUTED" || statusName.includes('dispute')) {
                showMessage(`此支付处于争议状态，请联系客服处理`, 'warning');
              } else {
                showMessage(`支付当前状态(${statusName})不允许确认`, 'warning');
              }
            } else {
              // 无法获取具体状态时提供一般性信息
              showMessage(`支付状态不允许确认，可能已被确认、释放或取消`, 'warning');
            }
          } catch (statusError) {
            console.error('[isPaymentConfirmable] 获取支付状态失败:', statusError);
            showMessage(`支付状态不允许确认，可能已被确认、释放或取消`, 'warning');
          }
          
          return false;
        }
        
        // 合约错误: Not owner
        if ((errorReason && errorReason.includes('not owner')) ||
            (gasError.message && gasError.message.includes('not owner'))) {
          showMessage('您不是此支付的所有者，无法确认', 'warning');
          return false;
        }
        
        // 从错误消息中检查常见错误
        const message = gasError.message || '';
        if (message.includes('Payment not found') || errorObject?.data?.message?.includes('Payment not found')) {
          showMessage(`支付ID "${paymentId}" 在链上不存在，请确认ID是否正确或重新创建订单`, 'warning');
          return false;
        }
        
        if (message.includes('invalid status') || message.includes('InvalidStatus')) {
          showMessage('支付状态不允许确认，可能已确认或已释放', 'warning');
          return false;
        }
        
        if (message.includes('not owner')) {
          showMessage('您不是此支付的所有者，无法确认', 'warning');
          return false;
        }
        
        // 默认错误信息，如果无法确定具体原因
        const errorMessage = errorReason || message || '未知错误';
        console.error(`[isPaymentConfirmable] 未能识别的合约错误: ${errorMessage}`);
        showMessage(`无法确认支付，原因: ${errorMessage}`, 'warning');
        return false;
      }
      
    } catch (contractError) {
      console.error('[isPaymentConfirmable] 获取支付详情失败:', contractError);
      
      // 如果错误是因为找不到支付记录
      if (contractError.message && (
          contractError.message.includes('not found') || 
          contractError.message.includes('Payment not found') ||
          contractError.message.includes('revert')
      )) {
        showMessage('找不到支付记录，可能ID无效或已被删除', 'warning');
        return false;
      }
      
      // 尝试调用confirmPayment方法，看是否会成功
      // 这是一个兜底处理方案
      console.log('[isPaymentConfirmable] 获取支付详情失败，尝试使用gas估算作为最后手段');
      try {
        // 只估算gas，不实际执行交易
        const gasEstimate = await settlementContract.estimateGas.confirmPayment(paymentId);
        console.log('[isPaymentConfirmable] 确认交易gas估算成功，支付可能可以确认:', gasEstimate.toString());
        return true;
      } catch (gasError) {
        console.error('[isPaymentConfirmable] 确认交易gas估算失败，支付不能确认:', gasError);
        
        // 尝试解析错误消息
        if (gasError.message) {
          if (gasError.message.includes('not found') || gasError.message.includes('Payment not found')) {
            showMessage('找不到对应的支付记录', 'warning');
          } else if (gasError.message.includes('not owner')) {
            showMessage('您不是此支付的所有者', 'warning');
          } else if (gasError.message.includes('invalid status')) {
            showMessage('支付状态不允许确认', 'warning');
          } else {
            showMessage(`确认失败: ${gasError.message}`, 'error');
          }
        } else {
          showMessage('确认支付失败，请稍后重试', 'error');
        }
        
        return false;
      }
    }
  } catch (error) {
    console.error('[isPaymentConfirmable] 检查支付状态过程中发生未处理的错误:', error);
    showMessage(`检查支付状态失败: ${error.message || '未知错误'}`, 'error');
    return false;
  }
}

/**
 * 根据状态码获取支付状态名称
 * @param {number} statusCode - 状态码
 * @returns {string} 状态名称
 */
function getPaymentStatusName(statusCode) {
  // 根据合约中的状态码定义映射状态名称
  const statusMap = {
    0: 'CREATED',    // 初始创建
    1: 'LOCKED',     // 资金已锁定
    2: 'CONFIRMED',  // 已确认
    3: 'RELEASED',   // 已释放
    4: 'CANCELLED',  // 已取消
    5: 'DISPUTED',   // 争议中
    6: 'REFUNDED'    // 已退款
  };
  
  return statusMap[statusCode] || `未知状态(${statusCode})`;
}

/**
 * 检查并显示支付状态，并提供刷新解决方案
 * @param {string} paymentId - 前端支付ID
 * @param {string} blockchainId - 区块链支付ID
 * @returns {Promise<boolean>} 支付是否可操作
 */
async function checkAndShowPaymentStatus(paymentId, blockchainId) {
  try {
    console.log(`[checkAndShowPaymentStatus] 开始检查支付状态，前端ID: ${paymentId}, 区块链ID: ${blockchainId}`);
    
    // 先尝试从localStorage获取之前同步的状态
    const cachedStatusName = localStorage.getItem(`payment_status_name_${paymentId}`);
    const lastSyncTime = localStorage.getItem(`payment_status_last_sync_${paymentId}`);
    
    if (cachedStatusName && lastSyncTime) {
      const syncTime = new Date(lastSyncTime);
      const now = new Date();
      const diffMinutes = (now - syncTime) / (1000 * 60);
      
      // 如果缓存状态较新（5分钟内）直接使用
      if (diffMinutes < 5) {
        console.log(`[checkAndShowPaymentStatus] 使用缓存状态: ${cachedStatusName}，同步于 ${diffMinutes.toFixed(1)} 分钟前`);
        createStatusMessage(paymentId, blockchainId, cachedStatusName);
        
        // 根据状态确定是否可操作
        const actionableStatuses = ['LOCKED', '1'];
        return actionableStatuses.includes(cachedStatusName);
      }
    }
    
    // 如果没有缓存或缓存过期，同步状态
    const syncResult = await syncPaymentStatus(paymentId);
    
    if (syncResult.success) {
      createStatusMessage(paymentId, blockchainId, syncResult.statusName);
      
      // 根据状态确定是否可操作
      return syncResult.statusName === 'LOCKED' || syncResult.status === 1;
    } else {
      // 同步失败，创建错误状态消息
      // 如果是NOT_FOUND错误，建议创建新订单
      if (syncResult.status === 'NOT_FOUND') {
        createStatusMessage(paymentId, blockchainId, syncResult.status || 'NOT_FOUND', '系统已升级到新的智能合约，请创建新订单');
      } else {
        createStatusMessage(paymentId, blockchainId, syncResult.status || 'ERROR', syncResult.error);
      }
      return false;
    }
    
  } catch (error) {
    console.error('[checkAndShowPaymentStatus] 执行过程中发生错误:', error);
    showMessage('检查支付状态失败: ' + error.message, 'error');
    
    // 创建错误消息，建议创建新订单
    const errorMsg = document.createElement('div');
    errorMsg.className = 'alert alert-danger mt-3';
    errorMsg.innerHTML = `
      <i class="fas fa-exclamation-triangle"></i> 获取支付状态失败<br>
      <p>系统已升级到新的智能合约，建议创建新订单</p>
      <button onclick="showPaymentDiagnostics('${paymentId}')" class="btn btn-sm btn-primary mt-2">诊断问题</button>
    `;
    
    // 添加到页面
    const confirmBtn = document.getElementById('confirmPaymentBtn') || document.getElementById('confirm-receipt-btn');
    if (confirmBtn && confirmBtn.parentNode) {
      const existingStatus = confirmBtn.parentNode.querySelector('.alert');
      if (existingStatus) {
        existingStatus.replaceWith(errorMsg);
      } else {
        confirmBtn.parentNode.appendChild(errorMsg);
      }
    } else {
      document.body.appendChild(errorMsg);
    }
    
    return false;
  }
}

/**
 * 创建并显示状态消息
 * @param {string} paymentId - 支付ID
 * @param {string} blockchainId - 区块链ID
 * @param {string} statusName - 状态名称
 * @param {string} errorMessage - 错误消息（可选）
 */
function createStatusMessage(paymentId, blockchainId, statusName, errorMessage) {
  // 创建状态消息元素
  const statusMsg = document.createElement('div');
  statusMsg.id = 'payment-status-msg';
  
  // 根据状态提供不同的消息和操作建议
  if (statusName === 'LOCKED' || statusName === '1') {
    statusMsg.className = 'alert alert-success mt-3';
    statusMsg.innerHTML = '<i class="fas fa-check-circle"></i> 支付状态正常，可以进行确认操作';
  } else if (statusName === 'CONFIRMED' || statusName === '2' || 
              statusName.includes('confirm') || statusName.includes('settle')) {
    statusMsg.className = 'alert alert-info mt-3';
    statusMsg.innerHTML = `
      <i class="fas fa-info-circle"></i> 此支付已被确认，无需重复操作<br>
      <a href="javascript:void(0)" onclick="location.reload()" class="btn btn-sm btn-primary mt-2">刷新页面</a>
    `;
  } else if (statusName === 'RELEASED' || statusName === '3' || statusName.includes('release')) {
    statusMsg.className = 'alert alert-info mt-3';
    statusMsg.innerHTML = `
      <i class="fas fa-info-circle"></i> 此支付已被释放，无需操作<br>
      <a href="javascript:void(0)" onclick="location.reload()" class="btn btn-sm btn-primary mt-2">刷新页面</a>
    `;
  } else if (statusName === 'CANCELLED' || statusName === '4' || statusName.includes('cancel')) {
    statusMsg.className = 'alert alert-warning mt-3';
    statusMsg.innerHTML = `
      <i class="fas fa-exclamation-triangle"></i> 此支付已被取消<br>
      <a href="javascript:void(0)" onclick="location.reload()" class="btn btn-sm btn-primary mt-2">刷新页面</a>
    `;
  } else if (statusName === 'DISPUTED' || statusName === '5' || statusName.includes('dispute')) {
    statusMsg.className = 'alert alert-danger mt-3';
    statusMsg.innerHTML = `
      <i class="fas fa-exclamation-triangle"></i> 此支付处于争议状态，请联系客服处理
    `;
  } else if (statusName === 'REFUNDED' || statusName === '6' || statusName.includes('refund')) {
    statusMsg.className = 'alert alert-info mt-3';
    statusMsg.innerHTML = `
      <i class="fas fa-info-circle"></i> 此支付已退款<br>
      <a href="javascript:void(0)" onclick="location.reload()" class="btn btn-sm btn-primary mt-2">刷新页面</a>
    `;
  } else if (statusName === 'NOT_FOUND') {
    statusMsg.className = 'alert alert-danger mt-3';
    statusMsg.innerHTML = `
      <i class="fas fa-exclamation-triangle"></i> 找不到此支付记录<br>
      <p>${errorMessage || '系统已升级到最新智能合约V2版本，建议创建新订单'}</p>
      <a href="/create-payment.html" class="btn btn-sm btn-success mt-2">创建新订单</a>
      <button onclick="showPaymentDiagnostics('${paymentId}')" class="btn btn-sm btn-primary mt-2">诊断问题</button>
    `;
  } else if (statusName === 'INVALID_STATUS') {
    statusMsg.className = 'alert alert-warning mt-3';
    statusMsg.innerHTML = `
      <i class="fas fa-exclamation-triangle"></i> 支付状态异常，无法确认<br>
      <p>系统已升级到最新智能合约V2版本，可能与旧订单不兼容</p>
      <a href="/create-payment.html" class="btn btn-sm btn-success mt-2">创建新订单</a>
      <button onclick="showPaymentDiagnostics('${paymentId}')" class="btn btn-sm btn-primary mt-2">诊断问题</button>
    `;
  } else if (statusName === 'NOT_OWNER') {
    statusMsg.className = 'alert alert-warning mt-3';
    statusMsg.innerHTML = `
      <i class="fas fa-exclamation-triangle"></i> 您不是此支付的所有者，无法进行操作<br>
      <button onclick="showPaymentDiagnostics('${paymentId}')" class="btn btn-sm btn-primary mt-2">诊断问题</button>
    `;
  } else if (statusName === 'ERROR') {
    statusMsg.className = 'alert alert-danger mt-3';
    statusMsg.innerHTML = `
      <i class="fas fa-exclamation-triangle"></i> 获取支付状态出错: ${errorMessage || '未知错误'}<br>
      <p>系统已升级到最新智能合约V2版本，建议创建新订单</p>
      <a href="/create-payment.html" class="btn btn-sm btn-success mt-2">创建新订单</a>
      <button onclick="showPaymentDiagnostics('${paymentId}')" class="btn btn-sm btn-primary mt-2">诊断问题</button>
    `;
  } else {
    statusMsg.className = 'alert alert-warning mt-3';
    statusMsg.innerHTML = `
      <i class="fas fa-exclamation-triangle"></i> 支付状态(${statusName})不允许确认<br>
      <button onclick="showPaymentDiagnostics('${paymentId}')" class="btn btn-sm btn-primary mt-2">诊断问题</button>
    `;
  }
  
  // 添加到页面
  const confirmBtn = document.getElementById('confirmPaymentBtn') || document.getElementById('confirm-receipt-btn');
  if (confirmBtn && confirmBtn.parentNode) {
    const existingStatus = confirmBtn.parentNode.querySelector('.alert');
    if (existingStatus) {
      existingStatus.replaceWith(statusMsg);
    } else {
      confirmBtn.parentNode.appendChild(statusMsg);
    }
  } else {
    document.body.appendChild(statusMsg);
  }
}

/**
 * 刷新支付状态（可以从页面上调用）
 * @param {string} paymentId - 支付ID
 */
function refreshPaymentStatus(paymentId) {
  showMessage('正在刷新支付状态...', 'info');
  
  // 获取区块链ID
  let blockchainId = localStorage.getItem(`blockchain_id_${paymentId}`);
  if (!blockchainId) {
    blockchainId = localStorage.getItem(`blockchain_payment_id_${paymentId}`);
  }
  if (!blockchainId) {
    blockchainId = localStorage.getItem(`payment_blockchain_id_${paymentId}`);
  }
  
  if (!blockchainId) {
    blockchainId = paymentId;
    console.warn(`找不到支付ID: ${paymentId} 的区块链ID映射，将尝试使用前端ID`);
  }
  
  // 使用新的同步机制
  syncPaymentStatus(paymentId).then(syncResult => {
    if (syncResult.success) {
      showMessage(`支付状态已更新: ${syncResult.statusName}`, 'success');
      
      // 重新检查和显示支付状态
      checkAndShowPaymentStatus(paymentId, syncResult.blockchainId || blockchainId).then(isActionable => {
        if (isActionable) {
          showMessage('支付可以确认，请点击确认按钮', 'success');
        }
      });
    } else {
      showMessage(`刷新状态失败: ${syncResult.error}`, 'warning');
      
      // 如果同步失败，显示诊断界面
      showPaymentDiagnostics(paymentId);
    }
  }).catch(error => {
    console.error('刷新支付状态失败:', error);
    showMessage(`刷新支付状态失败: ${error.message}`, 'error');
  });
}

/**
 * 同步支付状态，确保前端显示的状态与链上一致
 * @param {string} paymentId - 前端支付ID
 * @returns {Promise<Object>} 同步结果，包含状态信息
 */
async function syncPaymentStatus(paymentId) {
  try {
    console.log(`[syncPaymentStatus] 尝试同步支付状态，ID: ${paymentId}`);
    
    // 获取区块链ID
    let blockchainId = localStorage.getItem(`blockchain_id_${paymentId}`);
    if (!blockchainId) {
      blockchainId = localStorage.getItem(`blockchain_payment_id_${paymentId}`);
    }
    if (!blockchainId) {
      blockchainId = localStorage.getItem(`payment_blockchain_id_${paymentId}`);
    }
    
    if (!blockchainId) {
      console.warn(`[syncPaymentStatus] 找不到支付ID: ${paymentId} 的区块链ID映射`);
      return { success: false, error: '找不到区块链ID映射', status: null };
    }
    
    // 获取合约服务
    if (!window.contractService) {
      return { success: false, error: '合约服务未初始化', status: null };
    }
    
    if (!window.contractService.isInitialized()) {
      try {
        await window.contractService.initializeWeb3();
      } catch (initError) {
        console.error('[syncPaymentStatus] 初始化合约服务失败:', initError);
        return { success: false, error: '初始化合约服务失败', status: null };
      }
    }
    
    // 获取托管合约
    const settlementContract = await window.contractService.getEscrowContract();
    if (!settlementContract) {
      return { success: false, error: '无法获取托管合约', status: null };
    }
    
    // 获取链上支付状态
    let onChainStatus = null;
    let statusCode = null;
    let statusName = '未知';
    
    // 尝试不同的方法获取支付状态
    try {
      if (typeof settlementContract.getPaymentStatus === 'function') {
        statusCode = await settlementContract.getPaymentStatus(blockchainId);
        onChainStatus = statusCode;
        console.log(`[syncPaymentStatus] 通过getPaymentStatus获取状态:`, statusCode);
      } else if (typeof settlementContract.getEscrowStatus === 'function') {
        statusCode = await settlementContract.getEscrowStatus(blockchainId);
        onChainStatus = statusCode;
        console.log(`[syncPaymentStatus] 通过getEscrowStatus获取状态:`, statusCode);
      } else if (typeof settlementContract.getPayment === 'function') {
        const paymentData = await settlementContract.getPayment(blockchainId);
        if (paymentData && typeof paymentData === 'object') {
          if (typeof paymentData.status !== 'undefined') {
            statusCode = paymentData.status;
            onChainStatus = statusCode;
          } else if (Array.isArray(paymentData) && paymentData.length > 5) {
            // 如果返回的是数组，尝试从固定位置获取状态信息
            const released = paymentData[5]; // 假设第6个元素是released状态
            statusCode = released ? 3 : 1;  // 3=RELEASED, 1=LOCKED
            onChainStatus = statusCode;
          }
          console.log(`[syncPaymentStatus] 通过getPayment获取状态:`, onChainStatus);
        }
      }
    } catch (statusError) {
      console.error('[syncPaymentStatus] 获取链上状态失败:', statusError);
      
      // 尝试从错误中提取信息
      if (statusError.message) {
        if (statusError.message.includes('Payment not found')) {
          return { 
            success: false, 
            error: '支付不存在', 
            errorDetail: statusError.message,
            status: 'NOT_FOUND'
          };
        }
      }
      
      return { 
        success: false, 
        error: '获取链上状态失败', 
        errorDetail: statusError.message,
        status: null
      };
    }
    
    // 尝试用gas估算来判断状态
    if (onChainStatus === null) {
      try {
        // 估算gas，看是否允许确认
        await settlementContract.estimateGas.confirmPayment(blockchainId);
        // 如果能估算成功，说明支付处于可确认状态
        statusCode = 1; // LOCKED
        onChainStatus = statusCode;
        console.log(`[syncPaymentStatus] 通过gas估算判断支付状态为可确认`);
      } catch (gasError) {
        console.log(`[syncPaymentStatus] gas估算失败，尝试从错误中提取状态信息:`, gasError);
        
        // 从错误中提取信息
        if (gasError.message) {
          if (gasError.message.includes('Payment not found')) {
            return { 
              success: false, 
              error: '支付不存在', 
              errorDetail: gasError.message,
              status: 'NOT_FOUND'
            };
          } else if (gasError.message.includes('Invalid payment status') || 
                    gasError.message.includes('invalid status')) {
            // 尝试解析详细错误数据
            const errorObject = gasError.error || gasError;
            const errorData = errorObject?.data?.data;
            
            if (errorData && typeof ethers !== 'undefined' && typeof ethers.utils !== 'undefined') {
              try {
                const PREFIX_LENGTH = 138;
                const decodedError = ethers.utils.toUtf8String('0x' + errorData.slice(PREFIX_LENGTH));
                console.log('[syncPaymentStatus] 解码后的错误消息:', decodedError);
                
                if (decodedError.includes('already confirmed')) {
                  statusCode = 2; // CONFIRMED
                  onChainStatus = statusCode;
                } else if (decodedError.includes('already released')) {
                  statusCode = 3; // RELEASED
                  onChainStatus = statusCode;
                } else if (decodedError.includes('cancelled')) {
                  statusCode = 4; // CANCELLED
                  onChainStatus = statusCode;
                }
              } catch (decodeError) {
                console.error('[syncPaymentStatus] 解析错误数据失败:', decodeError);
              }
            }
            
            if (onChainStatus === null) {
              // 如果仍然无法确定具体状态，返回INVALID_STATUS
              return { 
                success: false, 
                error: '支付状态异常', 
                errorDetail: gasError.message,
                status: 'INVALID_STATUS'
              };
            }
          }
        }
      }
    }
    
    if (onChainStatus !== null) {
      // 将数字状态码转换为状态名称
      if (typeof onChainStatus === 'number') {
        statusName = getPaymentStatusName(onChainStatus);
      } else if (typeof onChainStatus === 'string') {
        statusName = onChainStatus;
      }
      
      // 将链上状态保存到localStorage
      localStorage.setItem(`payment_status_${paymentId}`, typeof onChainStatus === 'number' ? 
                           onChainStatus.toString() : onChainStatus);
      localStorage.setItem(`payment_status_name_${paymentId}`, statusName);
      localStorage.setItem(`payment_status_last_sync_${paymentId}`, new Date().toISOString());
      
      console.log(`[syncPaymentStatus] 已同步支付状态: ${statusName} (${onChainStatus})`);
      
      return { 
        success: true, 
        status: onChainStatus,
        statusName: statusName,
        blockchainId: blockchainId
      };
    }
    
    return { 
      success: false, 
      error: '无法确定链上状态', 
      status: null 
    };
  } catch (error) {
    console.error(`[syncPaymentStatus] 同步支付状态失败:`, error);
    return { 
      success: false, 
      error: '同步支付状态失败', 
      errorDetail: error.message,
      status: null 
    };
  }
}

/**
 * 诊断支付状态问题
 * @param {string} paymentId - 前端支付ID 
 * @returns {Promise<Object>} 诊断结果
 */
async function diagnosePaymentStatus(paymentId) {
  console.log(`[diagnosePaymentStatus] 开始诊断支付状态，ID: ${paymentId}`);
  
  const results = {
    findings: [],
    hasSolution: false,
    solutionType: null,
    solution: '',
    status: null,
    blockchainId: null
  };
  
  try {
    // 1. 检查区块链ID映射
    let blockchainId = localStorage.getItem(`blockchain_id_${paymentId}`);
    if (!blockchainId) {
      blockchainId = localStorage.getItem(`blockchain_payment_id_${paymentId}`);
    }
    if (!blockchainId) {
      blockchainId = localStorage.getItem(`payment_blockchain_id_${paymentId}`);
    }
    
    if (!blockchainId) {
      results.findings.push('找不到区块链ID映射，无法在链上查询支付');
      results.findings.push('系统已升级到最新智能合约V2版本');
      results.hasSolution = true;
      results.solutionType = 'RECREATE';
      results.solution = '系统已升级到新的智能合约，建议创建新订单';
      return results;
    }
    
    results.blockchainId = blockchainId;
    results.findings.push(`找到区块链ID映射: ${blockchainId}`);
    results.findings.push('系统已升级到最新智能合约V2版本');
    
    // 2. 同步支付状态
    const syncResult = await syncPaymentStatus(paymentId);
    if (!syncResult.success) {
      results.findings.push(`同步状态失败: ${syncResult.error}`);
      
      if (syncResult.status === 'NOT_FOUND') {
        results.findings.push('支付在区块链上不存在，可能是因为系统已升级到新的智能合约');
        results.hasSolution = true;
        results.solutionType = 'RECREATE';
        results.solution = '系统已升级到新的智能合约，建议创建新订单';
      } else if (syncResult.status === 'INVALID_STATUS') {
        results.findings.push('支付状态异常，不允许确认操作');
        results.hasSolution = true;
        results.solutionType = 'RECREATE';
        results.solution = '系统已升级到新的智能合约，建议创建新订单';
      } else {
        results.findings.push('无法确定支付状态，系统已升级到新的智能合约');
        results.hasSolution = true;
        results.solutionType = 'RECREATE';
        results.solution = '建议创建新订单以使用最新合约功能';
      }
    } else {
      results.status = syncResult.status;
      results.findings.push(`支付当前状态: ${syncResult.statusName}`);
      
      // 根据状态提供解决方案
      if (syncResult.statusName === 'CONFIRMED' || syncResult.status === 2) {
        results.findings.push('支付已被确认，无需再次确认');
        results.hasSolution = true;
        results.solutionType = 'RELOAD';
        results.solution = '刷新页面，查看最新支付状态';
      } else if (syncResult.statusName === 'RELEASED' || syncResult.status === 3) {
        results.findings.push('支付已被释放，无法确认');
        results.hasSolution = true;
        results.solutionType = 'RELOAD';
        results.solution = '刷新页面，查看最新支付状态';
      } else if (syncResult.statusName === 'CANCELLED' || syncResult.status === 4) {
        results.findings.push('支付已被取消，无法确认');
        results.hasSolution = true;
        results.solutionType = 'RECREATE';
        results.solution = '需要重新创建支付';
      } else if (syncResult.statusName === 'LOCKED' || syncResult.status === 1) {
        results.findings.push('支付状态正常，可以确认');
        results.hasSolution = true;
        results.solutionType = 'CONFIRM';
        results.solution = '尝试再次确认支付';
      } else {
        results.findings.push(`支付处于未知状态: ${syncResult.statusName}`);
        results.findings.push('系统已升级到新的智能合约V2版本');
        results.hasSolution = true;
        results.solutionType = 'RECREATE';
        results.solution = '建议创建新订单以使用最新合约功能';
      }
    }
    
    // 3. 检查钱包权限
    const walletAddress = window.contractService?.walletAddress;
    if (!walletAddress) {
      results.findings.push('当前未连接钱包，无法确认支付');
      results.hasSolution = true;
      results.solutionType = 'CONNECT_WALLET';
      results.solution = '请先连接钱包';
      return results;
    }
    
    // 4. 检查链上余额
    try {
      const balance = await window.contractService.getUSDTBalance(walletAddress);
      results.findings.push(`当前钱包USDT余额: ${balance}`);
      
      if (parseFloat(balance) <= 0) {
        results.findings.push('钱包USDT余额不足');
        results.hasSolution = false;
        results.solution = '请确保钱包中有足够的USDT用于支付Gas费';
      }
    } catch (balanceError) {
      // 如果是 ENS 不支持错误，仅警告并跳过
      if (balanceError.message && balanceError.message.includes('network does not support ENS')) {
        console.warn('[diagnosePaymentStatus] ENS 不支持，跳过余额检查');
      } else {
        console.error('[diagnosePaymentStatus] 获取余额失败:', balanceError);
      }
      results.findings.push('无法获取钱包余额');
    }
    
    return results;
  } catch (error) {
    console.error(`[diagnosePaymentStatus] 诊断过程中发生错误:`, error);
    results.findings.push(`诊断过程出错: ${error.message}`);
    results.findings.push('系统已升级到新的智能合约V2版本');
    results.hasSolution = true;
    results.solutionType = 'RECREATE';
    results.solution = '建议创建新订单以使用最新合约功能';
    return results;
  }
}

/**
 * 显示支付状态诊断结果模态框
 * @param {string} paymentId - 支付ID
 */
async function showPaymentDiagnostics(paymentId) {
  // 创建模态框
  const modalId = 'payment-diagnostic-modal';
  let diagnosticModal = document.getElementById(modalId);
  
  if (!diagnosticModal) {
    diagnosticModal = document.createElement('div');
    diagnosticModal.className = 'modal fade';
    diagnosticModal.id = modalId;
    diagnosticModal.innerHTML = `
      <div class="modal-dialog modal-lg">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">支付状态诊断 (ID: ${paymentId})</h5>
            <button type="button" class="close" data-dismiss="modal">&times;</button>
          </div>
          <div class="modal-body">
            <div class="alert alert-info">
              <strong>系统提示:</strong> 本系统已升级到最新智能合约V2版本，旧合约上的订单可能无法正常操作。建议创建新订单。
            </div>
            <div id="diagnostic-loading" class="text-center">
              <div class="spinner-border text-primary"></div>
              <p class="mt-2">正在诊断支付状态，请稍候...</p>
            </div>
            <div id="diagnostic-results" class="mt-3" style="display:none;">
              <h6>诊断发现:</h6>
              <ul id="diagnostic-findings" class="list-group mb-3"></ul>
              
              <div id="diagnostic-solution-container" class="mt-3">
                <h6>解决方案:</h6>
                <div id="diagnostic-solution" class="alert"></div>
              </div>
              
              <div id="diagnostic-actions" class="mt-3"></div>
            </div>
          </div>
          <div class="modal-footer">
            <a href="/create-payment.html" class="btn btn-success">创建新订单</a>
            <button type="button" class="btn btn-secondary" data-dismiss="modal">关闭</button>
          </div>
        </div>
      </div>
    `;
    
    document.body.appendChild(diagnosticModal);
  }
  
  // 显示模态框
  if (typeof $ !== 'undefined') {
    $(diagnosticModal).modal('show');
  } else {
    diagnosticModal.style.display = 'block';
  }
  
  // 执行诊断
  try {
    const results = await diagnosePaymentStatus(paymentId);
    
    // 显示诊断结果
    const loadingDiv = document.getElementById('diagnostic-loading');
    const resultsDiv = document.getElementById('diagnostic-results');
    const findingsList = document.getElementById('diagnostic-findings');
    const solutionDiv = document.getElementById('diagnostic-solution');
    const actionsDiv = document.getElementById('diagnostic-actions');
    
    // 填充发现列表
    findingsList.innerHTML = '';
    results.findings.forEach(finding => {
      const li = document.createElement('li');
      li.className = 'list-group-item';
      li.innerText = finding;
      findingsList.appendChild(li);
    });
    
    // 显示解决方案
    solutionDiv.innerHTML = results.solution;
    solutionDiv.className = results.hasSolution ? 
      'alert alert-success' : 'alert alert-warning';
    
    // 添加操作按钮
    actionsDiv.innerHTML = '';
    
    if (results.hasSolution) {
      switch (results.solutionType) {
        case 'RELOAD':
          actionsDiv.innerHTML = `
            <button onclick="location.reload()" class="btn btn-primary">刷新页面</button>
          `;
          break;
        case 'RECREATE':
          actionsDiv.innerHTML = `
            <a href="/create-payment.html" class="btn btn-success">创建新订单</a>
          `;
          break;
        case 'RECOVER':
          actionsDiv.innerHTML = `
            <button onclick="refreshPaymentStatus('${paymentId}')" class="btn btn-primary">刷新状态</button>
            <button onclick="resetPaymentState('${paymentId}')" class="btn btn-warning ml-2">重置状态</button>
          `;
          break;
        case 'CONFIRM':
          actionsDiv.innerHTML = `
            <button onclick="confirmPaymentReceivedByID('${paymentId}')" class="btn btn-success">确认支付</button>
          `;
          break;
        case 'CONNECT_WALLET':
          actionsDiv.innerHTML = `
            <button onclick="connectWallet()" class="btn btn-primary">连接钱包</button>
          `;
          break;
      }
    } else {
      actionsDiv.innerHTML = `
        <div class="alert alert-info">
          系统已升级到最新智能合约V2版本，建议创建新订单<br>
          <a href="/create-payment.html" class="btn btn-success mt-2">创建新订单</a>
        </div>
      `;
    }
    
    // 显示结果，隐藏加载
    loadingDiv.style.display = 'none';
    resultsDiv.style.display = 'block';
    
  } catch (error) {
    console.error('诊断失败:', error);
    
    // 显示错误
    const loadingDiv = document.getElementById('diagnostic-loading');
    const resultsDiv = document.getElementById('diagnostic-results');
    
    resultsDiv.innerHTML = `
      <div class="alert alert-danger">
        <strong>诊断失败:</strong> ${error.message}
      </div>
      <div class="alert alert-info mt-3">
        系统已升级到最新智能合约V2版本，建议创建新订单<br>
        <a href="/create-payment.html" class="btn btn-success mt-2">创建新订单</a>
      </div>
    `;
    
    loadingDiv.style.display = 'none';
    resultsDiv.style.display = 'block';
  }
}

/**
 * 重置支付状态
 * @param {string} paymentId - 支付ID
 */
async function resetPaymentState(paymentId) {
  try {
    if (!confirm('确定要重置支付状态吗？这将清除本地缓存的状态信息。')) {
      return;
    }
    
    // 清除状态相关的localStorage
    localStorage.removeItem(`payment_status_${paymentId}`);
    localStorage.removeItem(`payment_status_name_${paymentId}`);
    localStorage.removeItem(`payment_status_last_sync_${paymentId}`);
    
    showMessage('支付状态已重置，正在刷新...', 'info');
    
    // 重新同步状态
    const syncResult = await syncPaymentStatus(paymentId);
    
    if (syncResult.success) {
      showMessage(`支付状态已刷新: ${syncResult.statusName}`, 'success');
    } else {
      showMessage(`重置状态后出现问题: ${syncResult.error}`, 'warning');
    }
    
    // 刷新页面以更新UI
    setTimeout(() => {
      location.reload();
    }, 2000);
    
  } catch (error) {
    console.error('重置支付状态失败:', error);
    showMessage(`重置支付状态失败: ${error.message}`, 'error');
  }
}

/**
 * 显示一般消息
 * @param {string} message - 消息内容
 * @param {string} type - 消息类型 (info, success, warning, error)
 */
function showMessage(message, type = 'info') {
  // 获取或创建通知容器
  let notificationsContainer = document.getElementById('notifications-container');
  if (!notificationsContainer) {
    notificationsContainer = document.createElement('div');
    notificationsContainer.id = 'notifications-container';
    notificationsContainer.className = 'notifications-container';
    document.body.appendChild(notificationsContainer);
  }
  
  // 创建通知元素
  const notification = document.createElement('div');
  notification.className = `notification notification-${type}`;
  
  // 设置图标
  let icon = 'info-circle';
  if (type === 'success') icon = 'check-circle';
  if (type === 'warning') icon = 'exclamation-triangle';
  if (type === 'error') icon = 'times-circle';
  
  // 设置通知内容
  notification.innerHTML = `
    <div class="notification-icon">
      <i class="fas fa-${icon}"></i>
    </div>
    <div class="notification-message">${message}</div>
    <button class="notification-close" onclick="this.parentElement.remove()">
      <i class="fas fa-times"></i>
    </button>
  `;
  
  // 添加到容器
  notificationsContainer.appendChild(notification);
  
  // 设置自动消失
  setTimeout(() => {
    if (notification.parentElement) {
      notification.classList.add('fade-out');
      setTimeout(() => notification.remove(), 500);
    }
  }, 5000);
}

/**
 * 显示错误消息
 * @param {string} message - 错误消息内容
 */
function showErrorMessage(message) {
  showMessage(message, 'error');
}

/**
 * 格式化地址显示，缩短长地址
 * @param {string} address - 钱包地址或交易哈希
 * @param {number} startChars - 开始保留的字符数
 * @param {number} endChars - 结尾保留的字符数
 * @returns {string} 格式化后的地址
 */
function formatAddress(address, startChars = 6, endChars = 4) {
  if (!address) return '';
  
  if (address.length <= startChars + endChars) {
    return address;
  }
  
  return `${address.substring(0, startChars)}...${address.substring(address.length - endChars)}`;
}

// 加载LP列表函数，从服务器获取LP列表并填充到下拉框中
async function loadLPList() {
  try {
    console.log('开始加载LP列表...');
    
    // 确保API基础URL存在
    const API_URL = '/api';
    
    const lpSelect = document.getElementById('lp-select');
    
    if (!lpSelect) {
      console.warn('未找到LP选择下拉框，可能在其他页面');
      return;
    }
    
    // 显示加载状态
    lpSelect.innerHTML = '<option value="auto">正在加载...</option>';
    
    // 获取LP列表 - 使用绝对路径
    const response = await fetch(`${API_URL}/lp/list`);
    if (!response.ok) {
      throw new Error(`API响应错误: ${response.status}`);
    }
    
    const result = await response.json();
    console.log('获取到LP列表数据:', result);
    
    // 重置下拉框
    lpSelect.innerHTML = '';
    
    // 添加自动匹配选项
    const autoOption = document.createElement('option');
    autoOption.value = 'auto';
    autoOption.textContent = '系统自动匹配LP (根据费率)';
    lpSelect.appendChild(autoOption);
    
    // 确保有LP数据，处理不同的数据格式
    const lpList = Array.isArray(result) ? result : 
                 (result.success && Array.isArray(result.data)) ? result.data : 
                 (result.success && result.data && Array.isArray(result.data.lps)) ? result.data.lps : [];
    
    // 排序LP列表（费率从低到高）
    lpList.sort((a, b) => {
      const feeRateA = a.feeRate || a.fee_rate || 0.5;
      const feeRateB = b.feeRate || b.fee_rate || 0.5;
      return feeRateA - feeRateB;
    });
    
    // 添加LP选项
    lpList.forEach(lp => {
      // 跳过无效数据
      if (!lp || typeof lp !== 'object') return;
      
      // 获取LP地址（支持不同格式）
      const lpAddress = lp.walletAddress || lp.address || '';
      if (!lpAddress) return;
      
      // 获取LP费率（支持不同字段名）
      const lpFeeRate = lp.feeRate !== undefined ? lp.feeRate : 
                       (lp.fee_rate !== undefined ? lp.fee_rate : 0.5);
      
      // 创建选项
      const option = document.createElement('option');
      option.value = lpAddress;
      option.setAttribute('data-fee-rate', lpFeeRate);
      
      // 格式化显示文本
      const shortAddress = formatAddress(lpAddress);
      const lpName = lp.name || 'LP';
      option.textContent = `${lpName} (${shortAddress}) - 费率: ${lpFeeRate}%`;
      
      lpSelect.appendChild(option);
    });
    
    // 如果没有LP选项，添加提示
    if (lpList.length === 0) {
      const noLPOption = document.createElement('option');
      noLPOption.value = 'auto';
      noLPOption.textContent = '当前没有可用的LP（将使用系统LP）';
      lpSelect.appendChild(noLPOption);
    }
    
    console.log(`加载了 ${lpList.length} 个LP选项`);
    
    // 触发change事件以更新UI
    lpSelect.dispatchEvent(new Event('change'));
    
  } catch (error) {
    console.error('加载LP列表失败:', error);
    
    // 处理LP列表加载失败的情况
    const lpSelect = document.getElementById('lp-select');
    if (lpSelect) {
      lpSelect.innerHTML = '<option value="auto">无法加载LP列表</option>';
      
      // 创建一个默认系统LP选项
      const defaultOption = document.createElement('option');
      defaultOption.value = 'auto';
      defaultOption.textContent = '使用系统默认LP';
      lpSelect.appendChild(defaultOption);
      
      // 触发change事件以更新UI
      lpSelect.dispatchEvent(new Event('change'));
      
      // 显示错误提示
      const errorAlert = document.createElement('div');
      errorAlert.className = 'alert alert-danger mt-2';
      errorAlert.innerHTML = '<strong>错误:</strong> LP列表加载失败，请刷新页面重试或联系管理员。';
      
      if (lpSelect.parentNode) {
        lpSelect.parentNode.appendChild(errorAlert);
      }
    }
  }
}

/**
 * 禁用支付按钮并显示加载状态
 */
function disablePayNowButton() {
  const createPaymentBtn = document.getElementById('create-payment-btn');
  if (createPaymentBtn) {
    createPaymentBtn.disabled = true;
    createPaymentBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 处理中...';
  }
}

/**
 * 启用支付按钮
 */
function enablePayNowButton() {
  const createPaymentBtn = document.getElementById('create-payment-btn');
  if (createPaymentBtn) {
    createPaymentBtn.disabled = false;
    createPaymentBtn.innerHTML = '确认支付';
  }
}

/**
 * 获取支付表单数据
 * @returns {Object|null} 支付表单数据或null
 */
function getPaymentFormData() {
  try {
    // 检查钱包连接 - 支持Solana和以太坊两种连接方式
    const isEthWalletConnected = isWalletConnected && walletAddress;
    const isSolWalletConnected = window.solanaIntegration && 
                               typeof window.solanaIntegration.isSolanaConnected === 'function' && 
                               window.solanaIntegration.isSolanaConnected();
    
    if (!isEthWalletConnected && !isSolWalletConnected) {
      throw new Error("请先连接钱包");
    }
    
    // 获取钱包地址 - 优先使用连接的钱包类型
    let userWalletAddress;
    if (isEthWalletConnected) {
      userWalletAddress = walletAddress;
    } else if (isSolWalletConnected && window.solanaIntegration.getSolAddress) {
      userWalletAddress = window.solanaIntegration.getSolAddress();
      if (!userWalletAddress) {
        throw new Error("无法获取有效的Solana钱包地址，请重新连接钱包");
      }
    } else {
      throw new Error("无法获取有效的钱包地址");
    }
    
    // 验证钱包地址格式
    if (typeof userWalletAddress !== 'string' || userWalletAddress.trim() === '') {
      console.error("钱包地址格式不正确:", userWalletAddress);
      throw new Error("无效的钱包地址格式");
    }
    
    // 确保地址干净（移除空格）
    userWalletAddress = userWalletAddress.trim();
    
    // 获取表单数据
    const qrContentValue = qrContent ? qrContent.value : "";
    const platformValue = paymentPlatform ? paymentPlatform.value : "Unknown";
    const amountValue = paymentAmount ? parseFloat(paymentAmount.value) : 0;
    const descriptionValue = paymentDescription ? paymentDescription.value : "";
    
    // 验证数据
    if (!qrContentValue) {
      throw new Error("请先扫描二维码");
    }
    
    if (!platformValue || platformValue === "Unknown") {
      throw new Error("请选择支付平台");
    }
    
    if (!amountValue || amountValue <= 0) {
      throw new Error("请输入有效的支付金额");
    }
    
    // 检查LP选择
    const lpSelect = document.getElementById('lp-select');
    if (!lpSelect || lpSelect.value === "auto") {
      throw new Error("请选择一个特定的LP");
    }
    
    // 如果是PayPal，验证邮箱
    let paypalEmail = null;
    const paypalEmailField = document.getElementById('merchant-paypal-email');
    if (platformValue.toLowerCase() === 'paypal' && paypalEmailField) {
      paypalEmail = paypalEmailField.value;
      if (!paypalEmail || !paypalEmail.includes('@')) {
        throw new Error("PayPal支付需要提供有效的商家邮箱");
      }
    }
    
    // 获取费率
    const feeRateInput = document.getElementById('fee-rate');
    const feeRate = feeRateInput ? parseFloat(feeRateInput.value) : 0.5;
    
    // 准备数据对象
    const paymentDataObj = {
      walletAddress: userWalletAddress,
      platform: platformValue,
      amount: amountValue,
      description: descriptionValue,
      merchantPaypalEmail: paypalEmail,
      lpAddress: lpSelect.value,
      feeRate: feeRate,
      networkType: isSolWalletConnected ? 'solana' : 'ethereum'
    };
    console.log('DEBUG getPaymentFormData paymentData:', paymentDataObj);
    return paymentDataObj;
    
  } catch (error) {
    showErrorMessage(error.message);
    logError("获取支付表单数据失败:", error);
    return null;
  }
}

// 更新钱包UI
function updateWalletUI(wallet) {
  try {
    console.log('更新钱包UI:', wallet);
    
    const walletAddressSpan = document.getElementById('wallet-address');
    const walletConnectSection = document.getElementById('wallet-connect-section');
    const userDashboard = document.getElementById('user-dashboard');
    const networkOptions = document.querySelectorAll('.network-option');
    
    // 更新钱包地址显示
    if (walletAddressSpan) {
      walletAddressSpan.textContent = wallet.isConnected ? shortenAddress(wallet.address) : '未连接';
    }
    
    // 更新网络选择器
    networkOptions.forEach(option => {
      if (option.dataset.network === wallet.chainType) {
        option.classList.add('active');
      } else {
        option.classList.remove('active');
      }
    });
    
    // 更新连接区域和仪表板显示
    if (walletConnectSection && userDashboard) {
      walletConnectSection.classList.toggle('d-none', wallet.isConnected);
      userDashboard.classList.toggle('d-none', !wallet.isConnected);
    }
    
    // 更新顶部网络徽章显示
    const networkBadgeEl = document.getElementById('network-badge');
    if (networkBadgeEl) {
      // 文本为中文 '以太坊' 或 'Solana'
      networkBadgeEl.textContent = wallet.chainType === 'ethereum' ? '以太坊' : 'Solana';
      // 更新样式类
      networkBadgeEl.className = `network-badge ${wallet.chainType}`;
    }
    
    // 更新余额容器显示
    const ethBalanceContainer = document.getElementById('eth-balance-container');
    const solBalanceContainer = document.getElementById('sol-balance-container');
    const solUsdcContainer = document.getElementById('sol-usdc-container');
    
    if (ethBalanceContainer) {
      ethBalanceContainer.classList.toggle('d-none', wallet.chainType !== 'ethereum');
    }
    if (solBalanceContainer) {
      solBalanceContainer.classList.toggle('d-none', wallet.chainType !== 'solana');
    }
    if (solUsdcContainer) {
      solUsdcContainer.classList.toggle('d-none', wallet.chainType !== 'solana');
    }
  } catch (error) {
    console.error('更新钱包UI失败:', error);
  }
}

// 添加网络类型判断的辅助函数
function getNetworkType(chainId) {
  const networks = {
    '0x1': 'ethereum',    // Ethereum Mainnet
    '0x5': 'goerli',     // Goerli Testnet
    '0xaa36a7': 'sepolia', // Sepolia Testnet
    '0x38': 'bsc',       // BSC Mainnet
    '0x89': 'polygon',   // Polygon Mainnet
    '0x1c': 'somnia'     // Somnia Network
  };
  return networks[chainId.toLowerCase()] || 'ethereum';
}

// 新增扫码/签名入口函数
async function startSolanaPayment(paymentIntentId) {
  try {
    showMessage('正在拉取订单详情...', 'info');
    // 拉取订单详情
    const resp = await fetch(`/api/solana/payment-intents/${paymentIntentId}`);
    if (!resp.ok) throw new Error('获取订单详情失败');
    const result = await resp.json();
    if (!result.success || !result.data || !result.data.paymentIntent) throw new Error('订单详情无效');
    const order = result.data.paymentIntent;
    // mock 签名（合法base58字符串）
    const mockSignature = '11111111111111111111111111111111';
    // 提交签名到后端
    showMessage('正在提交签名...', 'info');
    const submitResp = await fetch('/api/solana/transaction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paymentIntentId: order.id || order.paymentIntentId,
        userWalletAddress: order.userWalletAddress,
        signature: mockSignature
      })
    });
    const submitResult = await submitResp.json();
    if (!submitResult.success) throw new Error(submitResult.message || '支付失败');
    showMessage('支付成功！', 'success');
    // 刷新订单列表
    await loadUserPaymentTasks();
  } catch (error) {
    showErrorMessage('扫码/支付失败: ' + error.message);
  }
}

// 新增确认收款函数
async function confirmReceipt(paymentId) {
  if (!confirm('确认已收到支付？')) return;
  try {
    const API_BASE_URL = window.API_BASE_URL || '/api';
    const res = await fetch(`${API_BASE_URL}/payment-intents/${paymentId}/confirm`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({})
    });
    const result = await res.json();
    if (!result.success) throw new Error(result.message);
    alert('确认收款成功');
    loadUserPaymentTasks();
  } catch (error) {
    console.error('确认收款失败:', error);
    alert('确认收款失败: ' + error.message);
  }
}

// 为 Solana 集成定义全局 addTaskToList，以使用主页面的任务渲染逻辑
let _addTaskLogged = false;
 window.addTaskToList = function(task) {
  if (!_addTaskLogged) {
    console.log('DEBUG addTaskToList Task keys:', Object.keys(task));
    console.log('DEBUG Task lpAddress:', task.lpAddress);
    console.log('DEBUG Task lpWalletAddress:', task.lpWalletAddress);
    _addTaskLogged = true;
  }
  const tasksList = document.getElementById('payment-tasks-list');
  const noTasksMsg = document.getElementById('no-tasks-message');
  if (!tasksList) return;
  if (noTasksMsg) noTasksMsg.classList.add('d-none');
  const taskElement = document.createElement('div');
  taskElement.className = 'list-group-item mb-3 shadow-sm border p-3';
  const status = (task.status || '').toLowerCase();
  const isPaidStatus = ['paid', 'completed'].includes(status);
  // 准备状态徽章和LP地址
  const statusMap2 = { created: 'secondary', pending: 'warning', locked: 'info', paid: 'primary', completed: 'primary', confirmed: 'success', cancelled: 'danger', failed: 'danger' };
  const badgeClass2 = statusMap2[status] || 'secondary';
  const lpAddress2 = task.lpWalletAddress || task.lpAddress || '';
  taskElement.innerHTML = `
    <div class="d-flex w-100 justify-content-between">
      <h5 class="mb-1">${task.platform || 'Unknown Platform'} Payment</h5>
      <small>${new Date(task.createdAt || Date.now()).toLocaleString()}</small>
    </div>
    <p class="mb-1"><strong>Amount:</strong> ${task.amount || '0'} ${task.currency || 'USDT'}</p>
    <p class="mb-1"><strong>Description:</strong> ${task.description || 'None'}</p>
    <p class="mb-1"><strong>Status:</strong> <span class="badge bg-${badgeClass2}">${task.status || 'Unknown'}</span></p>
    <p class="mb-1"><strong>LP Address:</strong> <span style="word-break: break-all;">${lpAddress2 || 'None'}</span></p>
    <p class="mb-1"><strong>ID:</strong> ${task.id || task._id || 'Unknown'}</p>
    <p class="mb-1 text-muted"><strong>Created At:</strong> ${new Date(task.createdAt || Date.now()).toLocaleString()}</p>
    ${isPaidStatus
      ? `<button class="btn btn-success btn-sm task-btn mt-2 me-2" onclick="confirmReceipt('${task.id}')">Confirm Receipt</button>
         <button class="btn btn-secondary btn-sm task-btn mt-2" onclick="viewDetails('${task.id}')">View Details</button>`
      : `<button class="btn btn-secondary btn-sm task-btn mt-2" onclick="viewDetails('${task.id || task._id}')">View Details</button>`
    }
  `;
  tasksList.appendChild(taskElement);
  console.log('addTaskToList: added task', task.id || task._id);
};

// 修改 viewDetails 函数调用显示支付详情模态框
async function viewDetails(paymentId) {
  try {
    const API_BASE_URL = window.API_BASE_URL || '/api';
    const res = await fetch(`${API_BASE_URL}/payment-intents/${paymentId}`);
    const result = await res.json();
    if (!result.success) throw new Error(result.message || '获取交易详情失败');
    displayDetailModal(result.data);
  } catch (error) {
    showErrorMessage(`无法获取交易详情: ${error.message}`);
  }
}

// 新增显示支付详情模态框函数
function displayDetailModal(data) {
  const modalEl = document.getElementById('detail-modal');
  // 填充基本信息
  document.getElementById('detail-amount').innerText = `${data.amount} ${data.currency || 'USDT'}`;
  const statusKey = data.status.toLowerCase();
  const statusMap = { created: 'secondary', pending: 'warning', locked: 'info', paid: 'primary', confirmed: 'success', cancelled: 'danger', failed: 'danger' };
  const statusCls = statusMap[statusKey] || 'secondary';
  document.getElementById('detail-status').innerHTML = `<span class="badge bg-${statusCls}">${data.status}</span>`;
  document.getElementById('detail-platform').innerText = data.platform;
  document.getElementById('detail-created-at').innerText = new Date(data.createdAt).toLocaleString();
  // 根据状态显示或隐藏"Confirm Receipt"按钮
  const confirmBtn = document.getElementById('detail-confirm-btn');
  if (confirmBtn) {
    const allowed = ['paid', 'completed'];
    if (allowed.includes(statusKey)) {
      confirmBtn.classList.remove('d-none');
    } else {
      confirmBtn.classList.add('d-none');
    }
  }
  // 填充 LP 信息
  document.getElementById('detail-lp-address').innerText = data.lpWalletAddress || '';
  document.getElementById('detail-proof-btn').onclick = () => {
    window.open(`${window.API_BASE_URL || '/api'}/payment-intents/${data.id}/proof`, '_blank');
  };
  // 填充状态历史，交替背景并添加状态标签
  const tbody = document.getElementById('detail-history-body');
  tbody.innerHTML = '';
  (data.statusHistory || []).forEach((entry, idx) => {
    const tr = document.createElement('tr');
    const time = new Date(entry.timestamp).toLocaleString();
    // 状态标签颜色
    const key = entry.status.toLowerCase();
    const map = { created: 'secondary', pending: 'warning', locked: 'info', paid: 'primary', confirmed: 'success', cancelled: 'danger', failed: 'danger' };
    const badgeClass = map[key] || 'secondary';
    // 根据状态设置行背景
    tr.classList.add(`table-${badgeClass}`);
    const statusLabel = `<span class="badge bg-${badgeClass}">${entry.status}</span>`;
    const note = idx === 0 ? `${data.platform} Payment Intent Created` : (entry.description || entry.note || '');
    tr.innerHTML = `<td>${time}</td><td>${statusLabel}</td><td>${note}</td>`;
    tbody.appendChild(tr);
  });
  // 确认按钮
  document.getElementById('detail-confirm-btn').onclick = () => {
    // 隐藏详情模态框
    const bsModal = bootstrap.Modal.getInstance(modalEl) || new bootstrap.Modal(modalEl);
    bsModal.hide();
    // 展示确认模态框
    currentPaymentIntentId = data.id;
    confirmAmount.innerText = data.amount;
    document.getElementById('confirm-lp-address').innerText = data.lpWalletAddress || '';
    const confirmModal = new bootstrap.Modal(document.getElementById('confirm-payment-modal'));
    confirmModal.show();
  };
  // 显示模态框
  const bsModal = new bootstrap.Modal(modalEl);
  bsModal.show();
}

// 填充并展示交易详情弹窗
function displayTransactionDetails({ lpAddress, amount, txHash, explorerUrl }) {
  const modal = document.getElementById('transaction-status-modal');
  document.getElementById('tx-lp-address').innerText = lpAddress;
  document.getElementById('tx-amount').innerText = amount;
  const hashContainer = document.getElementById('tx-hash-container');
  const hashElem = document.getElementById('tx-hash');
  const explorerBtn = document.getElementById('view-explorer-btn');
  if (txHash) {
    hashContainer.style.display = '';
    hashElem.innerText = txHash;
    if (explorerUrl) {
      explorerBtn.href = explorerUrl;
      explorerBtn.style.display = '';
    } else {
      explorerBtn.style.display = 'none';
    }
  } else {
    hashContainer.style.display = 'none';
    explorerBtn.style.display = 'none';
  }
  modal.style.display = 'block';
}

// 绑定关闭交易详情弹窗事件
(function() {
  const closeButtons = document.querySelectorAll('.close-transaction, #close-transaction-btn');
  closeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('transaction-status-modal').style.display = 'none';
    });
  });
})();

// FIRST_EDIT: bind click handler for confirm-payment-modal confirm button
if (confirmReceivedBtn) {
  confirmReceivedBtn.addEventListener('click', () => {
    // confirm receipt of service and authorize payment
    confirmReceipt(currentPaymentIntentId);
    const modalEl = document.getElementById('confirm-payment-modal');
    const bsModal = bootstrap.Modal.getInstance(modalEl) || new bootstrap.Modal(modalEl);
    bsModal.hide();
  });
}
