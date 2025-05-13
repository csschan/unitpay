/**
 * payment.js - 支付页面交互逻辑
 * 包含API结算和区块链结算的功能
 */

// 全局变量
let paymentData = null;
let paypalOrderCreated = false;
let paypalPopupWindow = null;  // 存储PayPal弹出窗口引用
let paypalPopupCheckInterval = null; // 用于检查PayPal窗口是否关闭的定时器
let paymentCancelled = false;
let paymentCompleted = false;  // 添加全局变量，标记支付是否已完成
let socket = null;  // Socket.io连接

// 定义 API 基础 URL
const API_BASE_URL = '/api';  // 将API基础URL设置为'/api'，并确保所有API调用都正确添加前缀

// LP 相关功能
async function loadLPList() {
    try {
        const response = await fetch(`${API_BASE_URL}/lp/list`);
        const data = await response.json();
        const lpSelect = document.getElementById('lp');
        
        // 清空旧选项
        lpSelect.innerHTML = '';
        
        // 添加默认空选项
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = '-- 请选择 LP --';
        lpSelect.appendChild(defaultOption);
        
        // 确保有LP数据
        const lpList = Array.isArray(data) ? data : 
                      (data.success && Array.isArray(data.data)) ? data.data : 
                      (data.success && data.data && Array.isArray(data.data.lps)) ? data.data.lps : [];
        
        // 检查是否有可用的LP
        if (lpList.length === 0) {
            const noLPOption = document.createElement('option');
            noLPOption.value = '';
            noLPOption.textContent = '-- 当前没有可用的LP --';
            noLPOption.disabled = true;
            lpSelect.appendChild(noLPOption);
            return;
        }
        
        // 按费率从低到高排序LP列表
        lpList.sort((a, b) => {
            const feeRateA = a.fee_rate || 0.5;
            const feeRateB = b.fee_rate || 0.5;
            return feeRateA - feeRateB;
        });
        
        // 添加LP选项
        lpList.forEach(lp => {
            // 跳过无效的LP数据
            if (!lp || typeof lp !== 'object') return;
            
            // 使用walletAddress或address属性
            const lpAddress = lp.walletAddress || lp.address || '';
            if (!lpAddress) return;
            
            // 获取当前LP的费率
            const lpFeeRate = lp.fee_rate !== undefined ? lp.fee_rate : 0.5;
            
            const option = document.createElement('option');
            option.value = lpAddress;
            
            // 设置option的data-fee-rate属性，用于后续获取选中LP的费率
            option.setAttribute('data-fee-rate', lpFeeRate);
            
            // 格式化LP地址显示
            const shortAddress = lpAddress.slice(0, 6) + '...' + lpAddress.slice(-4);
            option.textContent = `${lp.name || 'LP'} (${shortAddress}) - 费率: ${lpFeeRate}%`;
            
            lpSelect.appendChild(option);
        });
        
        // 添加LP选择变更事件监听器
        lpSelect.addEventListener('change', function() {
            calculateTotalAmount();
            
            const selectedLpAddress = this.value;
            if (selectedLpAddress) {
                showLPInfo(selectedLpAddress);
            } else {
                const lpInfo = document.getElementById('lp-info');
                lpInfo.classList.add('hidden');
            }
        });
        
    } catch (error) {
        console.error('加载 LP 列表失败:', error);
        showError('加载 LP 列表失败');
    }
}

// 计算总金额
function calculateTotalAmount() {
    const amountInput = document.getElementById('amount');
    const lpSelect = document.getElementById('lp');
    
    // 获取支付金额
    const amount = parseFloat(amountInput.value) || 0;
    
    // 获取选中的LP费率
    let feeRate = 0;
    if (lpSelect.selectedIndex > 0) {
        const selectedOption = lpSelect.options[lpSelect.selectedIndex];
        feeRate = parseFloat(selectedOption.getAttribute('data-fee-rate')) || 0;
    }
    
    // 计算费用
    const fee = amount * (feeRate / 100);
    
    // 计算总金额
    const total = amount + fee;
    
    // 更新显示
    document.getElementById('payment-amount').textContent = amount.toFixed(2) + ' USDT';
    document.getElementById('fee-rate').textContent = feeRate.toFixed(2) + '%';
    document.getElementById('fee-amount').textContent = fee.toFixed(2) + ' USDT';
    document.getElementById('total-amount').textContent = total.toFixed(2) + ' USDT';
    
    return { amount, fee, total, feeRate };
}

// 显示 LP 信息
function showLPInfo(lpAddress) {
    const lpInfo = document.getElementById('lp-info');
    const lpAddressElement = document.getElementById('lp-address');
    const lpRateElement = document.getElementById('lp-rate');
    
    // 获取 LP 信息
    fetch(`${API_BASE_URL}/lp/${lpAddress}`)
        .then(response => response.json())
        .then(data => {
            lpAddressElement.textContent = data.address;
            lpRateElement.textContent = data.rate;
            lpInfo.classList.remove('hidden');
        })
        .catch(error => {
            console.error('获取 LP 信息失败:', error);
            showError('获取 LP 信息失败');
        });
}

// USDT 余额检查
async function checkUSDTBalance() {
    try {
        console.log('开始检查USDT余额...');
        console.log('合约服务状态:', contractService);
        
        const balance = await contractService.getUSDTBalance();
        console.log('获取到的USDT余额:', balance);
        
        const balanceElement = document.getElementById('usdt-balance-amount');
        if (balanceElement) {
            balanceElement.textContent = balance;
            console.log('余额显示已更新');
        } else {
            console.error('未找到余额显示元素');
        }
        
        // 如果余额不足，禁用锁定按钮
        const amount = document.getElementById('amount').value;
        const lockBtn = document.getElementById('lockBtn');
        if (lockBtn) {
            lockBtn.disabled = balance < amount;
            console.log('锁定按钮状态已更新, 禁用状态:', lockBtn.disabled);
        }
    } catch (error) {
        console.error('检查 USDT 余额失败:', error);
        showError('检查 USDT 余额失败');
    }
}

/**
 * 授权USDT代币
 * @param {boolean} isAutomatic - 是否是自动处理模式
 * @returns {Promise<Object>} - 授权结果
 */
async function approveUSDT(isAutomatic = false) {
    try {
        console.log('===DEBUG=== 开始授权USDT:', {
            isAutomatic,
            hasPaymentData: !!window.paymentData,
            hasContractService: !!window.contractService
        });
        
        // 验证支付数据
        if (!window.paymentData) {
            throw new Error('无法找到支付数据');
        }
        
        // 验证支付金额
        const paymentAmount = window.paymentData.amount;
        if (!paymentAmount || isNaN(parseFloat(paymentAmount)) || parseFloat(paymentAmount) <= 0) {
            throw new Error('无效的支付金额');
        }
        
        // 初始化合约服务（如果尚未初始化）
        if (!window.contractService || !window.contractService.isInitialized()) {
            console.log('===DEBUG=== 初始化合约服务');
            window.contractService = new ContractService();
            await window.contractService.initializeWeb3();
            await window.contractService.initializeContracts();
        }
        
        if (!isAutomatic) {
            // 更新UI状态
            const approveBtn = document.getElementById('approve-usdt');
            if (approveBtn) {
                approveBtn.disabled = true;
                approveBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 授权中...';
            }
        }
        
        // 调用合约服务进行授权
        console.log('===DEBUG=== 调用合约服务授权USDT, 金额:', paymentAmount);
        const result = await window.contractService.approveUSDT(paymentAmount);
        
        if (!result.success) {
            throw new Error(`USDT授权失败: ${result.error}`);
        }
        
        console.log('===DEBUG=== USDT授权成功:', result);
        
        if (!isAutomatic) {
            // 更新UI状态
            const approveBtn = document.getElementById('approve-usdt');
            if (approveBtn) {
                approveBtn.disabled = false;
                approveBtn.textContent = 'USDT已授权';
                approveBtn.classList.remove('btn-primary');
                approveBtn.classList.add('btn-success');
            }
            
            // 启用结算按钮
            const settleBtn = document.getElementById('settle-payment');
            if (settleBtn) {
                settleBtn.disabled = false;
            }
            
            // 显示成功消息
            showSuccess('approve', {
                txHash: result.txHash,
                message: 'USDT授权成功'
            });
        }
        
        return result;
    } catch (error) {
        console.error('===DEBUG=== 授权USDT失败:', error);
        
        if (!isAutomatic) {
            // 重置按钮状态
            const approveBtn = document.getElementById('approve-usdt');
            if (approveBtn) {
                approveBtn.disabled = false;
                approveBtn.textContent = '授权USDT';
            }
            
            // 显示错误消息
            showError(`授权USDT失败: ${error.message}`);
        }
        
        return {
            success: false,
            error: error.message
        };
    }
}

// 锁定 USDT
async function lockUSDT() {
    try {
        const amount = document.getElementById('amount').value;
        const lpAddress = document.getElementById('lp').value;
        await contractService.lockUSDT(amount, lpAddress);
        showSuccess('USDT 锁定成功');
    } catch (error) {
        console.error('USDT 锁定失败:', error);
        showError('USDT 锁定失败');
    }
}

// Socket.io连接初始化
function initSocketConnection() {
    // 如果已连接，不再重复连接
    if (socket) return;
    
    try {
        console.log('初始化Socket.io连接...');
        socket = io();
        
        // 连接成功处理
        socket.on('connect', () => {
            console.log('Socket.io连接成功, socket.id:', socket.id);
            
            // 订阅当前钱包地址的消息
            const walletAddress = getUserWalletAddress();
            if (walletAddress) {
                console.log('订阅钱包地址通知:', walletAddress);
                socket.emit('subscribe', walletAddress);
            }
        });
        
        // 处理支付取消通知
        socket.on('payment_cancelled', (data) => {
            console.log('===DEBUG=== [CRITICAL] 收到支付取消通知:', JSON.stringify(data));
            
            // 检查是否为当前支付
            const currentPaymentId = document.getElementById('payment-intent-id')?.value 
                || localStorage.getItem('paymentIntentId')
                || sessionStorage.getItem('currentPaymentIntentId');
                
            if (data.paymentIntentId === currentPaymentId) {
                console.log('===DEBUG=== [CRITICAL] 收到当前支付的取消通知');
                
                // 立即设置取消标志
                paymentCancelled = true;
                localStorage.setItem('paymentCancelledAt', Date.now().toString());
                
                // 停止状态检查
                if (window.paypalStatusCheckInterval) {
                    clearInterval(window.paypalStatusCheckInterval);
                    window.paypalStatusCheckInterval = null;
                    window.paypalStatusCheckActive = false;
                }
                
                // 清除支付完成标志
                paymentCompleted = false;
                sessionStorage.removeItem('paymentCompleted');
                
                // 显示取消UI
                hidePayPalProcessingUI();
                showCancelledUI();
                
                // 刷新页面状态
                refreshPaymentDetails();
            }
        });
        
        // 处理Solana交易签名请求
        socket.on('solana_tx_ready', async (data) => {
            console.log('===DEBUG=== 收到Solana交易签名请求:', JSON.stringify(data));
            
            // 检查是否为当前支付
            const currentPaymentId = document.getElementById('payment-intent-id')?.value 
                || localStorage.getItem('paymentIntentId')
                || sessionStorage.getItem('currentPaymentIntentId');
                
            if (data.paymentIntentId === currentPaymentId) {
                console.log('===DEBUG=== 准备签名当前支付的Solana交易:', data.paymentIntentId);
                
                // 获取交易详情
                try {
                    const response = await fetch(`/api/payment-intents/${data.paymentIntentId}`);
                    const result = await response.json();
                    
                    if (result.success && result.data) {
                        // 保存交易数据
                        window.pendingTx = {
                            paymentIntentId: data.paymentIntentId,
                            serializedTx: result.data.blockchainTxData?.serializedTx,
                            paymentAccount: result.data.blockchainTxData?.paymentAccount,
                            paymentSeed: result.data.blockchainTxData?.paymentSeed
                        };
                        
                        // 自动开始区块链处理流程
                        if (window.pendingTx.serializedTx) {
                            console.log('===DEBUG=== 自动开始Solana交易签名流程');
                            await startBlockchainProcess();
                        } else {
                            console.error('===DEBUG=== 无法获取序列化交易数据');
                            showError('无法获取交易数据，请稍后重试');
                        }
                    } else {
                        console.error('===DEBUG=== 获取交易详情失败:', result.message || '未知错误');
                    }
                } catch (error) {
                    console.error('===DEBUG=== 获取交易详情失败:', error);
                }
            }
        });
        
        // 处理支付状态更新
        socket.on('payment_status_update', (data) => {
            console.log('===DEBUG=== 收到支付状态更新:', JSON.stringify(data));
            
            // 检查是否为当前支付
            const currentPaymentId = document.getElementById('payment-intent-id')?.value 
                || localStorage.getItem('paymentIntentId')
                || sessionStorage.getItem('currentPaymentIntentId');
                
            if (data.paymentIntentId === currentPaymentId) {
                console.log('===DEBUG=== 刷新当前支付状态:', data.status);
                refreshPaymentDetails();
                
                // 如果状态包含取消标记，立即显示取消状态
                if (data.cancelled === true) {
                    paymentCancelled = true;
                    localStorage.setItem('paymentCancelledAt', Date.now().toString());
                    hidePayPalProcessingUI();
                    showCancelledUI();
                }
            }
        });
        
        // 连接错误处理
        socket.on('connect_error', (error) => {
            console.error('Socket.io连接失败:', error);
        });
        
        // 断开连接处理
        socket.on('disconnect', (reason) => {
            console.log('Socket.io断开连接:', reason);
        });
        
    } catch (error) {
        console.error('初始化Socket.io连接时出错:', error);
    }
}

// 添加全局事件监听器，监听PayPal窗口关闭
window.addEventListener('message', function(event) {
    // 检查消息来源和数据
    if (event.data === 'paypal_window_closed' || 
        (event.data && event.data.type === 'paypal_window_closed') ||
        (event.data && event.data.action === 'cancel')) {
        
        console.log('检测到PayPal窗口关闭事件消息:', event.data);
        handlePayPalWindowClosed();
    }
});

// 处理PayPal窗口关闭事件
function handlePayPalWindowClosed() {
    const timestamp = new Date().toISOString();
    console.log('===DEBUG=== [CRITICAL] handlePayPalWindowClosed被调用', timestamp);
    
    // 记录当前状态
    const currentState = {
        paymentCancelled,
        paymentCompleted,
        paypalOrderCreated,
        localStorageCancelled: localStorage.getItem('paymentCancelledAt'),
        sessionCompleted: sessionStorage.getItem('paymentCompleted'),
        paymentIntentId: document.getElementById('payment-intent-id')?.value || localStorage.getItem('paymentIntentId'),
        orderId: localStorage.getItem('paypalOrderId'),
        paymentProcessing: sessionStorage.getItem('paymentProcessing'),
        statusCheckActive: window.paypalStatusCheckActive,
        hasStatusCheckInterval: !!window.paypalStatusCheckInterval
    };
    console.log('===DEBUG=== [CRITICAL] 窗口关闭时状态:', JSON.stringify(currentState));
    
    // 立即停止任何状态检查 - 最高优先级操作
    if (window.paypalStatusCheckInterval) {
        console.log('===DEBUG=== [CRITICAL] 立即停止支付状态检查', window.paypalStatusCheckInterval);
        clearInterval(window.paypalStatusCheckInterval);
        window.paypalStatusCheckInterval = null;
        window.paypalStatusCheckActive = false;
    }
    
    // 检查是否存在支付完成标志，且不存在用户取消标志
    const isPaymentCompletedWithoutCancellation = 
        (paymentCompleted || sessionStorage.getItem('paymentCompleted') === 'true') && 
        !paymentCancelled && 
        !localStorage.getItem('paymentCancelledAt');
    
    if (isPaymentCompletedWithoutCancellation) {
        console.log('===DEBUG=== [CRITICAL] 检测到支付已完成且未被取消，允许完成流程继续');
        return;
    }
    
    // 达到这里意味着支付未完成或已取消 - 立即设置取消标志
    paymentCancelled = true;
    localStorage.setItem('paymentCancelledAt', Date.now().toString());
    console.log('===DEBUG=== [CRITICAL] 已设置取消标志');
    
    // 清除支付完成标志 - 确保取消状态优先
    paymentCompleted = false;
    sessionStorage.removeItem('paymentCompleted');
    console.log('===DEBUG=== [CRITICAL] 已清除支付完成标志');
    
    // 如果订单未创建，直接显示错误并返回
    if (!paypalOrderCreated) {
        console.log('===DEBUG=== [CRITICAL] PayPal订单未创建就关闭了窗口');
        showError('PayPal payment process was interrupted before order creation.');
        hidePayPalProcessingUI();
        showCancelledUI();
        return;
    }
    
    // 检查是否有存储的订单ID和支付意向ID
    const orderId = localStorage.getItem('paypalOrderId');
    const paymentIntentId = document.getElementById('payment-intent-id')?.value || localStorage.getItem('paymentIntentId');
    
    console.log('===DEBUG=== [CRITICAL] 检查存储的IDs:', {orderId, paymentIntentId});
    
    // 如果缺少必要信息，显示错误并返回
    if (!orderId || !paymentIntentId) {
        console.log('===DEBUG=== [CRITICAL] 无法找到支付订单信息');
        showError('Payment information is missing. Cannot proceed with cancellation.');
        showCancelledUI();
        return;
    }
    
    // 防止重复处理
    if (sessionStorage.getItem('handleClosedInProgress') === 'true') {
        console.log('===DEBUG=== [CRITICAL] 已有取消处理进程在运行，避免重复处理');
        return;
    }
    
    // 设置处理锁
    sessionStorage.setItem('handleClosedInProgress', 'true');
    
    // 确保UI显示取消状态
    showCancelledUI();
    
    // 确保支付处理UI隐藏
    hidePayPalProcessingUI();
    
    // 延迟调用取消API，给onApprove回调一些时间优先执行
    // 但取消标志已设置，onApprove会检测到它并中断操作
    setTimeout(async () => {
        console.log('===DEBUG=== [CRITICAL] 延迟后执行取消API调用');
        
        try {
            // 调用取消API
            await cancelPayPalPayment(true);
        } catch (error) {
            console.error('===DEBUG=== [CRITICAL] 调用取消API失败:', error);
            // 即使API调用失败，仍然保持取消状态
        } finally {
            // 确保UI显示取消状态，无论API调用成功与否
            showCancelledUI();
            
            // 刷新页面以获取最新状态
            setTimeout(() => {
                refreshPaymentDetails();
            }, 1000);
            
            // 释放处理锁
            sessionStorage.removeItem('handleClosedInProgress');
        }
    }, 500);
}

// 确保取消UI显示
function showCancelledUI() {
    console.log('===DEBUG=== [CRITICAL] 显示取消UI');
    
    // 隐藏处理中UI
    hidePayPalProcessingUI();
    
    // 显示取消消息
    showMessage('Payment was cancelled.', 'info');
    
    // 更新取消UI中的支付ID
    const paymentIntentId = document.getElementById('payment-intent-id')?.value || localStorage.getItem('paymentIntentId');
    const cancelledPaymentId = document.getElementById('cancelled-payment-id');
    
    if (cancelledPaymentId && paymentIntentId) {
        cancelledPaymentId.textContent = paymentIntentId;
    }
    
    // 显示取消UI
    const paymentCancelledElement = document.getElementById('payment-cancelled');
    if (paymentCancelledElement) {
        paymentCancelledElement.style.display = 'block';
    }
    
    // 隐藏其他状态UI
    const paymentSuccess = document.getElementById('payment-success');
    if (paymentSuccess) {
        paymentSuccess.style.display = 'none';
    }
}

// 监控PayPal弹出窗口的状态
function monitorPayPalPopupWindow(popup) {
    console.log('===DEBUG=== 开始监控PayPal弹窗', new Date().toISOString(), 'paymentCancelled=', paymentCancelled, 'paymentCompleted=', paymentCompleted);
    
    if (!popup) {
        console.error('===DEBUG=== monitorPayPalPopupWindow收到null弹窗引用');
        return;
    }
    
    // 保存弹出窗口引用
    paypalPopupWindow = popup;
    
    // 保存初始状态，用于调试
    const initialPaymentState = {
        paymentCancelled,
        paymentCompleted,
        paypalOrderCreated,
        localStorageCancelled: localStorage.getItem('paymentCancelledAt'),
        sessionCompleted: sessionStorage.getItem('paymentCompleted'),
        paymentProcessing: sessionStorage.getItem('paymentProcessing')
    };
    console.log('===DEBUG=== PayPal弹窗初始状态:', JSON.stringify(initialPaymentState));
    
    // 尝试设置beforeunload事件监听器
    try {
        console.log('===DEBUG=== 尝试为PayPal弹窗设置beforeunload事件监听');
        if (popup.addEventListener) {
            popup.addEventListener('beforeunload', function() {
                console.log('===DEBUG=== PayPal弹窗beforeunload事件触发', new Date().toISOString(), 
                           'paymentCancelled=', paymentCancelled, 
                           'paymentCompleted=', paymentCompleted);
                // 不立即执行关闭处理，留给窗口状态检查处理
            });
        }
    } catch (e) {
        console.log('===DEBUG=== 无法设置PayPal弹窗beforeunload事件:', e);
    }
    
    // 清除之前的检查定时器
    if (paypalPopupCheckInterval) {
        console.log('===DEBUG=== 清除之前的PayPal弹窗检查定时器:', paypalPopupCheckInterval);
        clearInterval(paypalPopupCheckInterval);
    }
    
    // 生成唯一的监控ID用于日志跟踪
    const monitorId = Math.random().toString(36).substring(2, 8);
    console.log(`===DEBUG=== 创建新的PayPal弹窗监控实例 ID=${monitorId}`);
    
    // 记录初始窗口状态
    try {
        console.log(`===DEBUG=== 监控器${monitorId}: 初始窗口状态 - closed=${popup.closed}`);
    } catch (e) {
        console.error(`===DEBUG=== 监控器${monitorId}: 无法获取初始窗口状态:`, e);
    }
    
    // 设置新的检查定时器
    paypalPopupCheckInterval = setInterval(() => {
        // 检查窗口是否已关闭
        try {
            if (!paypalPopupWindow) {
                console.log(`===DEBUG=== 监控器${monitorId}: PayPal弹窗引用为空`);
                clearInterval(paypalPopupCheckInterval);
                return;
            }
            
            const currentState = {
                paymentCancelled,
                paymentCompleted,
                paypalOrderCreated,
                localStorageCancelled: localStorage.getItem('paymentCancelledAt'),
                sessionCompleted: sessionStorage.getItem('paymentCompleted'),
                paymentProcessing: sessionStorage.getItem('paymentProcessing')
            };
            
            console.log(`===DEBUG=== 监控器${monitorId}: 检查窗口状态, closed=${paypalPopupWindow.closed}, paymentState=${JSON.stringify(currentState)}`);
            
            if (paypalPopupWindow.closed) {
                console.log(`===DEBUG=== 监控器${monitorId}: 检测到PayPal弹窗已关闭`, new Date().toISOString(), 
                           'paymentCancelled=', paymentCancelled, 
                           'paymentCompleted=', paymentCompleted,
                           'paypalOrderCreated=', paypalOrderCreated);
                
                clearInterval(paypalPopupCheckInterval);
                paypalPopupWindow = null;
                
                // 记录当前支付状态
                const closedState = {
                    paymentCancelled,
                    paymentCompleted,
                    paypalOrderCreated,
                    localStorageCancelled: localStorage.getItem('paymentCancelledAt'),
                    sessionCompleted: sessionStorage.getItem('paymentCompleted'),
                    paymentProcessing: sessionStorage.getItem('paymentProcessing'),
                    closedAt: new Date().toISOString()
                };
                console.log(`===DEBUG=== 监控器${monitorId}: 窗口关闭时状态:`, JSON.stringify(closedState));
                
                // 延迟处理窗口关闭事件，避免与onApprove回调竞争
                console.log(`===DEBUG=== 监控器${monitorId}: 延迟300ms调用handlePayPalWindowClosed`);
                setTimeout(() => {
                    console.log(`===DEBUG=== 监控器${monitorId}: 延迟结束，现在调用handlePayPalWindowClosed, paymentCancelled=${paymentCancelled}, paymentCompleted=${paymentCompleted}`);
                    handlePayPalWindowClosed();
                }, 300);
                return;
            }
            
            // 尝试访问窗口位置以检查窗口是否仍然可访问
            try {
                const url = paypalPopupWindow.location.href;
                console.log(`===DEBUG=== 监控器${monitorId}: PayPal弹窗当前URL: ${url}`);
                
                // 检查URL变化，可能表明用户执行了某些操作
                if (url.includes('cancel') || url.includes('Cancelled')) {
                    console.log(`===DEBUG=== 监控器${monitorId}: 检测到取消URL模式 - ${url}, paymentCancelled=${paymentCancelled}, paymentCompleted=${paymentCompleted}`);
                }
                
                if (url.includes('success') || url.includes('approved')) {
                    console.log(`===DEBUG=== 监控器${monitorId}: 检测到成功URL模式 - ${url}, paymentCancelled=${paymentCancelled}, paymentCompleted=${paymentCompleted}`);
                }
            } catch (e) {
                // 如果由于跨域而无法访问，这是正常的
                console.log(`===DEBUG=== 监控器${monitorId}: 无法访问PayPal弹窗URL (可能是跨域限制)`);
            }
        } catch (e) {
            console.error(`===DEBUG=== 监控器${monitorId}: 监控PayPal弹窗出错:`, e);
        }
    }, 500); // 每500毫秒检查一次
    
    // 设置监控超时，防止无限监控
    setTimeout(() => {
        if (paypalPopupCheckInterval) {
            console.log(`===DEBUG=== 监控器${monitorId}: 监控超时(2分钟)，清除监控器, paymentCancelled=${paymentCancelled}, paymentCompleted=${paymentCompleted}`);
            clearInterval(paypalPopupCheckInterval);
            paypalPopupCheckInterval = null;
            
            // 如果窗口仍然存在但订单状态未变，可能是用户忘记了窗口
            try {
                if (paypalPopupWindow && !paypalPopupWindow.closed && paypalOrderCreated) {
                    console.log(`===DEBUG=== 监控器${monitorId}: 检测到可能的遗忘窗口，尝试关闭`);
                    paypalPopupWindow.close();
                    paypalPopupWindow = null;
                    
                    // 处理窗口关闭
                    console.log(`===DEBUG=== 监控器${monitorId}: 调用handlePayPalWindowClosed处理遗忘窗口, paymentCancelled=${paymentCancelled}, paymentCompleted=${paymentCompleted}`);
                    handlePayPalWindowClosed();
                }
            } catch (e) {
                console.error(`===DEBUG=== 监控器${monitorId}: 关闭遗忘窗口失败:`, e);
            }
        }
    }, 120000); // 2分钟超时
}

// 初始化页面
document.addEventListener('DOMContentLoaded', () => {
    console.log('===DEBUG=== DOMContentLoaded事件触发');
    
    try {
        // 初始化 Socket 连接
        initSocketConnection();
        
        // 加载 LP 列表
        loadLPList();
        
        // 检查 USDT 余额
        checkUSDTBalance();
        
        // LP 选择变化时更新信息
        document.getElementById('lp').addEventListener('change', (e) => {
            if (e.target.value) {
                showLPInfo(e.target.value);
            }
        });
        
        // 金额变化时检查余额
        document.getElementById('amount').addEventListener('change', checkUSDTBalance);
        
        // 初始化其他事件监听
        initEventListeners();
        
        // 处理URL参数，加载支付详情
        const urlParams = new URLSearchParams(window.location.search);
        const paymentId = urlParams.get('id');
        if (paymentId) {
            console.log('===DEBUG=== 从URL获取支付ID:', paymentId);
            loadPaymentDetails(paymentId);
        }
    } catch (error) {
        console.error('===DEBUG=== 初始化时发生错误:', error);
    }
});

// 加载支付详情
async function loadPaymentDetails(paymentId) {
    try {
        const response = await fetch(`/api/payment-intents/${paymentId}`);
        
        if (response.status === 404) {
            showError('找不到该支付');
            return;
        }
        
        if (!response.ok) {
            const errorData = await response.json();
            showError(`加载支付详情失败: ${errorData.message || '未知错误'}`);
            return;
        }
        
        const rawData = await response.json();
        console.log('===DEBUG=== 从API获取的原始支付数据:', rawData);
        
        // 使用normalizePaymentData处理数据
        const processedData = normalizePaymentData(rawData);
        
        if (!processedData) {
            showError('无法处理支付数据');
            return;
        }
        
        // 保存处理后的数据到全局变量
        paymentData = processedData;
        window.paymentData = processedData;
        
        // 保存到localStorage
        try {
            localStorage.setItem('paymentData', JSON.stringify(processedData));
            console.log('===DEBUG=== 支付数据已保存到localStorage');
        } catch (e) {
            console.error('===DEBUG=== 保存支付数据到localStorage失败:', e);
        }
        
        // 更新UI显示支付详情
        updatePaymentDetailsUI(processedData);
        
        // 检查是否有未完成的PayPal支付
        checkPendingPayPalPayment(paymentId);
        
        return processedData; // 返回处理后的数据
    } catch (error) {
        console.error('加载支付详情错误:', error);
        showError(`加载支付详情失败: ${error.message}`);
    }
}

// 更新支付详情UI
function updatePaymentDetailsUI(data) {
    document.getElementById('payment-id').textContent = data.id || '-';
    document.getElementById('payment-amount').textContent = `${data.amount} ${data.currency || 'USDT'}`;
    document.getElementById('payment-status').textContent = getStatusText(data.status);
    document.getElementById('lp-address').textContent = data.lpWalletAddress || '-';
    
    // 添加商家PayPal邮箱信息（如果存在）
    const merchantEmailElement = document.getElementById('merchant-paypal-email');
    if (merchantEmailElement) {
        if (data.merchantPaypalEmail) {
            merchantEmailElement.textContent = data.merchantPaypalEmail;
            document.getElementById('merchant-email-container').style.display = 'flex';
        } else {
            document.getElementById('merchant-email-container').style.display = 'none';
        }
    }
    
    // 格式化创建时间
    const createdDate = data.createdAt ? new Date(data.createdAt) : null;
    document.getElementById('created-at').textContent = createdDate ? 
        createdDate.toLocaleString() : '-';
    
    // 添加PayPal交易详情
    const paymentProofSection = document.querySelector('.payment-info');
    if (paymentProofSection && (data.status === 'paid' || data.status === 'confirmed')) {
        let paymentProof = data.paymentProof;
        
        if (typeof paymentProof === 'string') {
            try {
                paymentProof = JSON.parse(paymentProof);
            } catch (e) {
                console.error('解析支付凭证失败:', e);
                paymentProof = {};
            }
        }
        
        // 如果已有交易详情元素，则移除它
        const existingProofDetails = document.getElementById('payment-proof-details');
        if (existingProofDetails) {
            existingProofDetails.remove();
        }
        
        // 创建交易详情元素
        const proofDetails = document.createElement('div');
        proofDetails.id = 'payment-proof-details';
        proofDetails.className = 'card mt-3';
        proofDetails.innerHTML = `
            <div class="card-body">
                <h4>交易详情</h4>
                <div class="info-row">
                    <label>支付平台:</label>
                    <span>${data.platform || '未知'}</span>
                </div>
                ${paymentProof?.paypalOrderId ? `
                <div class="info-row">
                    <label>PayPal订单ID:</label>
                    <span style="font-family: monospace;">${paymentProof.paypalOrderId}</span>
                </div>` : ''}
                ${paymentProof?.paypalCaptureId ? `
                <div class="info-row">
                    <label>PayPal交易ID:</label>
                    <span style="font-family: monospace;">${paymentProof.paypalCaptureId}</span>
                </div>` : ''}
                ${paymentProof?.captureId ? `
                <div class="info-row">
                    <label>交易ID:</label>
                    <span style="font-family: monospace;">${paymentProof.captureId}</span>
                </div>` : ''}
                ${paymentProof?.transactionId ? `
                <div class="info-row">
                    <label>交易ID:</label>
                    <span style="font-family: monospace;">${paymentProof.transactionId}</span>
                </div>` : ''}
                ${paymentProof?.transactionTime ? `
                <div class="info-row">
                    <label>支付时间:</label>
                    <span>${new Date(paymentProof.transactionTime).toLocaleString()}</span>
                </div>` : ''}
                <div class="mt-3">
                    <a href="https://sandbox.paypal.com/merchantapps/app/account/transactions" target="_blank" class="btn btn-sm btn-outline-primary">
                        PayPal商家中心
                    </a>
                </div>
            </div>
        `;
        
        // 插入到支付详情卡片中
        document.getElementById('payment-details').appendChild(proofDetails);
    }
    
    // 如果支付状态是已支付或已确认，显示退款按钮
    const refundButtonContainer = document.getElementById('refund-button-container');
    if (refundButtonContainer) {
        if (data.status === 'paid' || data.status === 'confirmed') {
            refundButtonContainer.style.display = 'block';
            document.getElementById('refund-button').onclick = () => handlePayPalRefund(data.id);
        } else if (data.status === 'refunded') {
            refundButtonContainer.style.display = 'block';
            document.getElementById('refund-button').textContent = '检查退款状态';
            document.getElementById('refund-button').onclick = () => checkPayPalRefundStatus(data.id);
        } else {
            refundButtonContainer.style.display = 'none';
        }
    }
    
    // 如果支付状态为失败，显示错误详情
    const errorDetailsContainer = document.getElementById('error-details-container');
    if (errorDetailsContainer) {
        if (data.status === 'failed' && data.errorDetails) {
            let errorDetails = data.errorDetails;
            if (typeof errorDetails === 'string') {
                try {
                    errorDetails = JSON.parse(errorDetails);
                } catch (e) {
                    errorDetails = { message: errorDetails };
                }
            }
            
            errorDetailsContainer.style.display = 'block';
            document.getElementById('error-message').textContent = errorDetails.message || '未知错误';
            document.getElementById('error-code').textContent = errorDetails.code || '无错误代码';
            document.getElementById('error-time').textContent = errorDetails.timestamp ? 
                new Date(errorDetails.timestamp).toLocaleString() : '-';
        } else {
            errorDetailsContainer.style.display = 'none';
        }
    }
}

// 获取状态文本
function getStatusText(status) {
    const statusMap = {
        'created': '已创建',
        'processing': '处理中',
        'succeeded': '已完成',
        'canceled': '已取消',
        'failed': '失败'
    };
    
    return statusMap[status] || status;
}

// 初始化事件监听器
function initEventListeners() {
    // 标签切换
    document.getElementById('tab-api').addEventListener('click', () => switchTab('api'));
    document.getElementById('tab-blockchain').addEventListener('click', () => switchTab('blockchain'));
    
    // API结算表单提交
    document.getElementById('payment-form').addEventListener('submit', handleApiSettlement);
    
    // 区块链结算按钮
    document.getElementById('approve-usdt').addEventListener('click', approveUSDT);
    document.getElementById('settle-payment').addEventListener('click', settlePaymentOnChain);
    
    // 返回仪表板按钮
    document.getElementById('back-to-dashboard').addEventListener('click', () => {
        window.location.href = '/';
    });
    
    // 支付取消UI中的按钮
    const retryPaymentBtn = document.getElementById('retry-payment');
    if (retryPaymentBtn) {
        retryPaymentBtn.addEventListener('click', () => {
            // 隐藏取消UI，显示支付选项
            document.getElementById('payment-cancelled').style.display = 'none';
            document.getElementById('payment-options').style.display = 'block';
            
            // 重置支付状态
            resetPaymentState();
            
            // 重新初始化PayPal按钮
            initPayPalButton();
        });
    }
    
    const backFromCancelBtn = document.getElementById('back-from-cancel');
    if (backFromCancelBtn) {
        backFromCancelBtn.addEventListener('click', () => {
            window.location.href = '/';
        });
    }
    
    // 支付方式选择变更
    document.getElementById('payment-method').addEventListener('change', function() {
        const paymentMethod = this.value;
        const proofContainer = document.getElementById('payment-proof-container');
        const paypalButtonContainer = document.getElementById('paypal-button-container');
        
        if (paymentMethod === 'paypal') {
            proofContainer.style.display = 'none';
            paypalButtonContainer.style.display = 'block';
            
            // 初始化PayPal按钮
            initPayPalButton();
        } else {
            proofContainer.style.display = 'block';
            paypalButtonContainer.style.display = 'none';
        }
    });
    
    // 支付平台选择变更 (创建支付时)
    const platformSelect = document.getElementById('platform');
    if (platformSelect) {
        platformSelect.addEventListener('change', function() {
            const paypalEmailContainer = document.getElementById('merchant-paypal-email-container');
            if (paypalEmailContainer) {
                if (this.value === 'PayPal') {
                    paypalEmailContainer.style.display = 'block';
                } else {
                    paypalEmailContainer.style.display = 'none';
                }
            }
        });
    }
}

// 切换标签
function switchTab(tabName) {
    // 更新标签按钮状态
    document.getElementById('tab-api').classList.toggle('active', tabName === 'api');
    document.getElementById('tab-blockchain').classList.toggle('active', tabName === 'blockchain');
    
    // 显示/隐藏相应的表单
    document.getElementById('api-settlement').classList.toggle('hidden', tabName !== 'api');
    document.getElementById('blockchain-settlement').classList.toggle('hidden', tabName !== 'blockchain');
}

// 处理API结算
async function handleApiSettlement(event) {
    event.preventDefault();
    
    const paymentMethod = document.getElementById('payment-method').value;
    
    // 如果是PayPal支付，不进行常规提交
    if (paymentMethod === 'paypal') {
        // PayPal支付通过PayPal按钮直接处理
        return;
    }
    
    const submitButton = document.getElementById('submit-payment');
    submitButton.disabled = true;
    submitButton.textContent = '提交中...';
    
    try {
        const paymentProof = document.getElementById('payment-proof').value;
        
        if (!paymentMethod || !paymentProof) {
            showError('请填写所有必填字段');
            submitButton.disabled = false;
            submitButton.textContent = '提交支付';
            return;
        }
        
        // 构建支付证明数据
        const proofData = {
            method: paymentMethod,
            proof: paymentProof
        };
        
        // 确认支付
        const response = await fetch(`/api/payment-intents/${paymentData.id}/confirm`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ proof: proofData })
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || '支付确认失败');
        }
        
        // 显示成功信息
        const successData = await response.json();
        showSuccess('api', successData);
    } catch (error) {
        console.error('API结算错误:', error);
        showError(`支付确认失败: ${error.message}`);
        submitButton.disabled = false;
        submitButton.textContent = '提交支付';
    }
}

// 连接钱包
async function connectWallet() {
  const connectButton = document.getElementById('connect-wallet');
  const originalText = connectButton.textContent;
  connectButton.disabled = true;
  connectButton.textContent = '连接中...';

  try {
    const address = await contractService.connectWallet();
    
    // 更新UI
    document.getElementById('connect-wallet').classList.add('hidden');
    document.getElementById('wallet-connected').classList.remove('hidden');
    document.getElementById('wallet-address').textContent = shortenAddress(address);
    
    // 更新步骤状态
    document.getElementById('step1-status').textContent = '已连接';
    document.getElementById('step1-status').className = 'step-status success';
    
    // 启用下一步按钮
    document.getElementById('approve-usdt').disabled = false;
    
    // 获取并显示USDT余额
    updateUSDTBalance();
  } catch (error) {
    console.error('连接钱包失败:', error);
    showError(error.message || '连接钱包失败，请重试');
  } finally {
    connectButton.disabled = false;
    connectButton.textContent = originalText;
  }
}

// 更新USDT余额显示
async function updateUSDTBalance() {
  try {
    const balance = await contractService.getUSDTBalance();
    document.getElementById('usdt-balance').textContent = `${balance} USDT`;
  } catch (error) {
    console.error('获取USDT余额失败:', error);
    document.getElementById('usdt-balance').textContent = '获取余额失败';
  }
}

// 监听钱包事件
window.addEventListener('walletDisconnected', () => {
  // 重置UI状态
  document.getElementById('connect-wallet').classList.remove('hidden');
  document.getElementById('wallet-connected').classList.add('hidden');
  document.getElementById('step1-status').textContent = '未连接';
  document.getElementById('step1-status').className = 'step-status';
  document.getElementById('approve-usdt').disabled = true;
  document.getElementById('settle-payment').disabled = true;
});

window.addEventListener('walletChanged', (event) => {
  // 更新显示的钱包地址
  document.getElementById('wallet-address').textContent = shortenAddress(event.detail.address);
  // 更新USDT余额
  updateUSDTBalance();
});

window.addEventListener('networkChanged', async () => {
  // 更新USDT余额
  updateUSDTBalance();
});

/**
 * 在区块链上结算支付
 * @param {boolean} isAutomatic - 是否自动处理模式
 * @returns {Promise<Object>} - 结算结果
 */
async function settlePaymentOnChain(isAutomatic = false) {
    try {
        console.log('===DEBUG=== 开始区块链结算:', {
            isAutomatic,
            hasPaymentData: !!window.paymentData,
            hasContractService: !!window.contractService
        });
        
        if (!window.paymentData) {
            throw new Error('支付数据不可用，无法进行结算');
        }
        
        console.log('===DEBUG=== 结算数据:', {
            id: window.paymentData.id,
            amount: window.paymentData.amount,
            lpAddress: window.paymentData.lpAddress,
            lpWalletAddress: window.paymentData.lpWalletAddress
        });
        
        // 验证LP钱包地址
        const lpWalletAddress = window.paymentData.lpWalletAddress || window.paymentData.lpAddress;
        if (!lpWalletAddress || !ethers.utils.isAddress(lpWalletAddress)) {
            const errorMsg = `无效的LP钱包地址: ${lpWalletAddress}`;
            console.error('===DEBUG=== ❌', errorMsg);
            throw new Error(errorMsg);
        }
        
        // 验证金额
        const amount = parseFloat(window.paymentData.amount);
        if (isNaN(amount) || amount <= 0) {
            const errorMsg = `无效的支付金额: ${window.paymentData.amount}`;
            console.error('===DEBUG=== ❌', errorMsg);
            throw new Error(errorMsg);
        }
        
        // 验证支付ID
        const paymentId = window.paymentData.id || window.paymentData.paymentIntentId;
        if (!paymentId) {
            const errorMsg = '无效的支付ID';
            console.error('===DEBUG=== ❌', errorMsg);
            throw new Error(errorMsg);
        }
        
        // 只有在非自动模式下才更新UI
        if (!isAutomatic) {
            const settleBtn = document.getElementById('settle-payment');
            if (settleBtn) {
                settleBtn.disabled = true;
                settleBtn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 结算中...';
            }
        }
        
        // 初始化合约服务（如果尚未初始化）
        if (!window.contractService || !window.contractService.isInitialized()) {
            console.log('===DEBUG=== 初始化合约服务');
            window.contractService = new ContractService();
            await window.contractService.initializeWeb3();
            await window.contractService.initializeContracts();
            console.log('===DEBUG=== ✅ 合约服务初始化成功');
        }
        
        // 显示处理中UI - 检查USDT余额
        showProcessingUI('正在检查USDT余额...');
        
        // 检查USDT余额
        const hasBalance = await checkUSDTBalance();
        if (!hasBalance) {
            throw new Error('USDT余额不足，请确保您有足够的USDT');
        }
        console.log('===DEBUG=== ✅ USDT余额充足');
        
        // 显示处理中UI - 授权USDT
        showProcessingUI('正在授权USDT...');
        
        // 授权USDT
        const approveResult = await approveUSDT(true);
        if (!approveResult.success) {
            throw new Error(`USDT授权失败: ${approveResult.error}`);
        }
        console.log('===DEBUG=== ✅ USDT授权成功:', approveResult);
        
        // 显示处理中UI - 结算支付
        showProcessingUI('正在结算支付...');
        
        // 执行实际的结算逻辑
        console.log('===DEBUG=== 执行区块链结算交易');
        const txResult = await window.contractService.settlePayment(
            lpWalletAddress,
            window.contractService.usdtTokenAddress,
            amount.toString(),
            'Somnia',
            paymentId
        );
        
        const result = {
            success: true,
            txHash: txResult.transactionHash
        };
        
        console.log('===DEBUG=== ✅ 结算交易成功:', result);
        
        // 隐藏处理中UI
        hideProcessingUI();
        
        // 显示成功消息
        showSuccess('blockchain', {
            txHash: result.txHash,
            message: '区块链处理完成'
        });
        
        // 向后端API报告区块链结算
        await reportBlockchainSettlement(result.txHash, paymentId, paymentId);
        
        return result;
    } catch (error) {
        console.error('===DEBUG=== ❌ 区块链处理失败:', error);
        
        // 隐藏处理中UI
        hideProcessingUI();
        
        // 显示错误
        showBlockchainError(error);
        
        throw error;
    }
}

// 显示区块链处理错误并添加重试按钮
function showBlockchainError(error) {
    console.error('===DEBUG=== 显示区块链错误:', error.message);
    
    // 移除旧的错误容器（如果存在）
    const oldErrorContainer = document.getElementById('blockchain-error-container');
    if (oldErrorContainer) {
        oldErrorContainer.remove();
    }
    
    // 创建错误容器
    const errorContainer = document.createElement('div');
    errorContainer.id = 'blockchain-error-container';
    errorContainer.className = 'blockchain-error mt-3 p-3 bg-light border rounded';
    errorContainer.innerHTML = `
        <div class="error-message text-danger mb-2">${error.message}</div>
        <button id="retry-blockchain" class="btn btn-primary mt-2">重试区块链处理</button>
        <button id="manual-blockchain" class="btn btn-secondary mt-2 ml-2">手动处理</button>
    `;
    
    // 添加到区块链结算区域
    const blockchainSettlement = document.getElementById('blockchain-settlement');
    if (blockchainSettlement) {
        blockchainSettlement.appendChild(errorContainer);
    } else {
        // 如果没有找到区块链结算区域，添加到页面底部
        document.body.appendChild(errorContainer);
    }
    
    // 添加重试按钮事件
    document.getElementById('retry-blockchain').addEventListener('click', () => {
        errorContainer.remove();
        startBlockchainProcess();
    });
    
    // 添加手动处理按钮事件
    document.getElementById('manual-blockchain').addEventListener('click', () => {
        errorContainer.remove();
        enableManualBlockchainButtons();
    });
    
    // 显示错误消息
    showError(`区块链处理失败: ${error.message}`);
}

/**
 * 启动自动化区块链处理过程
 * @returns {Promise<void>}
 */
async function startBlockchainProcess() {
    console.log('===DEBUG=== 开始自动化区块链处理流程');
    
    try {
        // 检查支付数据
        if (!window.paymentData) {
            // 尝试从localStorage恢复数据
            try {
                const savedData = localStorage.getItem('paymentData');
                if (savedData) {
                    window.paymentData = JSON.parse(savedData);
                    console.log('===DEBUG=== 从localStorage恢复支付数据:', window.paymentData);
                }
            } catch (e) {
                console.error('===DEBUG=== 恢复支付数据失败:', e);
            }
            
            if (!window.paymentData) {
                throw new Error('未找到支付数据');
            }
        }
        
        // 验证支付数据
        const paymentData = normalizePaymentData(window.paymentData);
        if (!paymentData) {
            throw new Error('支付数据无效');
        }
        
        // 显示处理中UI
        showProcessingUI('正在连接钱包...');
        
        // 连接钱包
        const isConnected = await connectWallet();
        if (!isConnected) {
            throw new Error('钱包连接失败');
        }
        
        // 检查USDT余额
        showProcessingUI('正在检查USDT余额...');
        const hasBalance = await checkUSDTBalance();
        if (!hasBalance) {
            throw new Error('USDT余额不足');
        }
        
        // 授权USDT
        showProcessingUI('正在授权USDT...');
        const approveResult = await approveUSDT(true);
        if (!approveResult.success) {
            throw new Error(`USDT授权失败: ${approveResult.error}`);
        }
        
        // 结算支付
        showProcessingUI('正在结算支付...');
        try {
            const settleResult = await settlePaymentOnChain(false); // 传递false以避免重复处理
            
            if (!settleResult.success) {
                console.error('===DEBUG=== ❌ 结算支付失败:', settleResult.error);
                showBlockchainError('结算支付失败', settleResult.error || '未知错误');
                return false;
            }
            
            console.log('===DEBUG=== ✅ 支付结算成功:', settleResult);
        } catch (error) {
            console.error('===DEBUG=== ❌ 结算支付错误:', error);
            showBlockchainError('结算支付错误', error.message || '未知错误');
            return false;
        }
        
        // 成功处理
        hideProcessingUI();
        showSuccess('blockchain', {
            txHash: settleResult.txHash,
            message: '区块链处理完成'
        });
        
    } catch (error) {
        console.error('===DEBUG=== 区块链自动处理失败:', error);
        hideProcessingUI();
        showBlockchainError(error);
    }
}

/**
 * 规范化支付数据格式，确保所有必要字段都存在
 * @param {Object} rawData - 原始支付数据
 * @returns {Object} - 规范化后的数据
 */
function normalizePaymentData(rawData) {
    if (!rawData) {
        console.error('===DEBUG=== ❌ normalizePaymentData: 没有提供数据');
        return null;
    }
    
    console.log('===DEBUG=== normalizePaymentData: 开始处理原始数据', rawData);
    console.log('===DEBUG=== 字段检查:', {
        hasId: !!rawData.id,
        hasPaymentIntentId: !!rawData.paymentIntentId,
        hasLpAddress: !!rawData.lpAddress,
        hasLpWalletAddress: !!rawData.lpWalletAddress,
        hasAmount: !!rawData.amount
    });
    
    // 检查LP地址字段 - 这是最关键的字段
    const lpAddressValue = rawData.lpWalletAddress || rawData.lpAddress;
    if (!lpAddressValue) {
        console.error('===DEBUG=== ❌ normalizePaymentData: LP地址字段缺失', {
            rawLpAddress: rawData.lpAddress,
            rawLpWalletAddress: rawData.lpWalletAddress
        });
    } else {
        console.log('===DEBUG=== ✅ normalizePaymentData: 找到LP地址:', lpAddressValue);
    }
    
    // 创建包含所有必要字段的标准化数据
    const normalizedData = {
        // 核心字段 - 确保双向映射
        id: rawData.id || rawData.paymentIntentId || '',
        paymentIntentId: rawData.paymentIntentId || rawData.id || '',
        amount: rawData.amount || '0',
        lpWalletAddress: lpAddressValue || '',
        lpAddress: lpAddressValue || '',
        status: rawData.status || 'pending',
        platform: rawData.platform || 'Other',
        description: rawData.description || '',
        createdAt: rawData.createdAt || new Date().toISOString()
    };
    
    // 输出规范化后的数据
    console.log('===DEBUG=== 规范化后的数据:', normalizedData);
    
    // 验证核心字段
    if (!normalizedData.id || !normalizedData.amount || !normalizedData.lpWalletAddress) {
        console.error('===DEBUG=== ❌ 规范化失败: 缺少核心字段', {
            hasId: !!normalizedData.id,
            hasAmount: !!normalizedData.amount,
            hasLpWalletAddress: !!normalizedData.lpWalletAddress
        });
        
        // 尽管数据不完整，仍然返回规范化的数据，让调用方决定如何处理
    }
    
    return normalizedData;
}

// 创建支付
function createPayment() {
    // 获取表单数据
    const walletAddress = document.getElementById('walletAddress').value;
    const amount = parseFloat(document.getElementById('amount').value);
    const platform = document.getElementById('platform').value;
    const description = document.getElementById('description').value;
    const lpAddress = document.getElementById('lp').value;
    
    // 基础验证
    if (!walletAddress || !amount || !platform || !lpAddress) {
        showError('请填写所有必要字段');
        return;
    }
    
    // 获取费率计算结果
    const { fee, total, feeRate } = calculateTotalAmount();
    
    // 构建支付数据
    const paymentData = {
        userWalletAddress: walletAddress,
        amount: amount,
        platform: platform,
        description: description,
        lpWalletAddress: lpAddress,
        fee_rate: feeRate,
        fee_amount: fee,
        total_amount: total
    };
    
    // 特殊处理PayPal支付
    if (platform === 'PayPal') {
        const merchantPaypalEmail = document.getElementById('merchant-paypal-email').value;
        if (merchantPaypalEmail) {
            paymentData.merchantPaypalEmail = merchantPaypalEmail;
        }
    }
    
    // 调用API创建支付
    fetch(`${API_BASE_URL}/payment-intents`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(paymentData)
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showSuccess('支付创建成功');
            
            // 保存支付数据，用于后续处理
            window.paymentData = data.data;
            
            // 显示成功界面
            document.getElementById('payment-success').classList.remove('hidden');
            document.getElementById('success-payment-id').textContent = data.data.id;
            document.getElementById('success-amount').textContent = `${data.data.amount} ${data.data.currency}`;
            
            // 设置查看链接
            const viewLink = document.getElementById('view-payment-link');
            viewLink.href = `/payment-detail.html?id=${data.data.id}`;
            
            // 隐藏表单
            document.querySelector('form').style.display = 'none';
        } else {
            showError(`支付创建失败: ${data.message}`);
        }
    })
    .catch(error => {
        console.error('创建支付失败:', error);
        showError('创建支付失败，请稍后重试');
    });
}

/**
 * 向后端API报告区块链结算
 * @param {string} txHash - 交易哈希
 * @param {string} blockchainId - 区块链支付ID
 * @param {string} originalId - 原始支付ID
 * @returns {Promise<void>}
 */
async function reportBlockchainSettlement(txHash, blockchainId, originalId) {
    try {
        const response = await fetch(`/api/payment-intents/${originalId}/confirm`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                proof: {
                    method: 'blockchain',
                    proof: txHash,
                    blockchain: 'Somnia',
                    blockchainId: blockchainId // 添加区块链ID
                }
            })
        });
        
        if (!response.ok) {
            const errorData = await response.json();
            console.error('报告区块链结算到API失败:', errorData);
        } else {
            console.log('成功将区块链结算信息同步到服务器:', {
                txHash,
                blockchainId,
                originalId
            });
        }
    } catch (error) {
        console.error('报告区块链结算错误:', error);
    }
}