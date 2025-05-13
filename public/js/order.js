// 订单状态监听和自动更新
class OrderStatusMonitor {
  constructor() {
    this.pollingInterval = 10000; // 10秒轮询一次
    this.activeOrders = new Set();
    this.intervalId = null;
  }

  // 添加订单到监听列表
  addOrder(orderId) {
    this.activeOrders.add(orderId);
    if (!this.intervalId && this.activeOrders.size > 0) {
      this.startPolling();
    }
  }

  // 从监听列表移除订单
  removeOrder(orderId) {
    this.activeOrders.delete(orderId);
    if (this.activeOrders.size === 0) {
      this.stopPolling();
    }
  }

  // 开始轮询
  startPolling() {
    if (this.intervalId) return;
    
    this.intervalId = setInterval(async () => {
      for (const orderId of this.activeOrders) {
        try {
          const response = await fetch(`/api/orders/${orderId}/status`);
          if (!response.ok) continue;
          
          const data = await response.json();
          if (!data.success) continue;

          const status = data.data.status;
          updateOrderStatus(orderId, status);

          // 如果订单已完成或失败，从监听列表中移除
          if (['completed', 'failed', 'cancelled'].includes(status)) {
            this.removeOrder(orderId);
          }
        } catch (error) {
          console.error(`Error updating order ${orderId} status:`, error);
        }
      }
    }, this.pollingInterval);
  }

  // 停止轮询
  stopPolling() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

// 创建全局订单状态监听器实例
const orderStatusMonitor = new OrderStatusMonitor();

// 更新订单状态UI
function updateOrderStatus(orderId, status) {
  const orderElement = document.querySelector(`[data-order-id="${orderId}"]`);
  if (!orderElement) return;

  const statusElement = orderElement.querySelector('.order-status');
  const actionButtons = orderElement.querySelector('.order-actions');
  
  if (statusElement) {
    statusElement.textContent = getStatusText(status);
    statusElement.className = `order-status badge ${getStatusClass(status)}`;
  }

  if (actionButtons) {
    updateActionButtons(actionButtons, status);
  }
}

// 获取状态文本
function getStatusText(status) {
  const statusMap = {
    'pending': '等待中',
    'processing': '处理中',
    'completed': '已完成',
    'failed': '失败',
    'cancelled': '已取消'
  };
  return statusMap[status] || status;
}

// 获取状态对应的样式类
function getStatusClass(status) {
  const classMap = {
    'pending': 'bg-warning',
    'processing': 'bg-info',
    'completed': 'bg-success',
    'failed': 'bg-danger',
    'cancelled': 'bg-secondary'
  };
  return classMap[status] || 'bg-secondary';
}

// 更新操作按钮
function updateActionButtons(actionButtons, status) {
  actionButtons.innerHTML = '';
  
  switch (status) {
    case 'pending':
      actionButtons.innerHTML = `
        <button class="btn btn-sm btn-danger cancel-order">取消订单</button>
      `;
      break;
    case 'completed':
      actionButtons.innerHTML = `
        <button class="btn btn-sm btn-primary view-details">查看详情</button>
      `;
      break;
    case 'failed':
    case 'cancelled':
      actionButtons.innerHTML = `
        <button class="btn btn-sm btn-primary retry-order">重试</button>
        <button class="btn btn-sm btn-danger delete-order">删除</button>
      `;
      break;
  }

  // 绑定按钮事件
  bindActionButtonEvents(actionButtons);
}

// 绑定操作按钮事件
function bindActionButtonEvents(actionButtons) {
  const orderId = actionButtons.closest('[data-order-id]').dataset.orderId;

  actionButtons.querySelectorAll('button').forEach(button => {
    button.addEventListener('click', async (e) => {
      e.preventDefault();
      
      switch (button.className.match(/\b(cancel|view|retry|delete)-order\b/)[1]) {
        case 'cancel':
          await handleCancelOrder(orderId);
          break;
        case 'view':
          await handleViewDetails(orderId);
          break;
        case 'retry':
          await handleRetryOrder(orderId);
          break;
        case 'delete':
          await handleDeleteOrder(orderId);
          break;
      }
    });
  });
}

// 处理订单取消
async function handleCancelOrder(orderId) {
  try {
    const response = await fetch(`/api/orders/${orderId}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    if (data.success) {
      showToast('success', '订单已取消');
      updateOrderStatus(orderId, 'cancelled');
    } else {
      showToast('error', data.message || '取消订单失败');
    }
  } catch (error) {
    console.error('Error cancelling order:', error);
    showToast('error', '取消订单失败');
  }
}

// 处理查看详情
async function handleViewDetails(orderId) {
  try {
    const response = await fetch(`/api/orders/${orderId}`);
    const data = await response.json();
    
    if (data.success) {
      showOrderDetailsModal(data.data);
    } else {
      showToast('error', data.message || '获取订单详情失败');
    }
  } catch (error) {
    console.error('Error fetching order details:', error);
    showToast('error', '获取订单详情失败');
  }
}

// 处理重试订单
async function handleRetryOrder(orderId) {
  try {
    const response = await fetch(`/api/orders/${orderId}/retry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    if (data.success) {
      showToast('success', '订单已重新提交');
      updateOrderStatus(orderId, 'pending');
      orderStatusMonitor.addOrder(orderId);
    } else {
      showToast('error', data.message || '重试订单失败');
    }
  } catch (error) {
    console.error('Error retrying order:', error);
    showToast('error', '重试订单失败');
  }
}

// 处理删除订单
async function handleDeleteOrder(orderId) {
  if (!confirm('确定要删除此订单吗？此操作不可撤销。')) {
    return;
  }

  try {
    const response = await fetch(`/api/orders/${orderId}`, {
      method: 'DELETE'
    });

    const data = await response.json();
    if (data.success) {
      showToast('success', '订单已删除');
      const orderElement = document.querySelector(`[data-order-id="${orderId}"]`);
      if (orderElement) {
        orderElement.remove();
      }
    } else {
      showToast('error', data.message || '删除订单失败');
    }
  } catch (error) {
    console.error('Error deleting order:', error);
    showToast('error', '删除订单失败');
  }
}

// 显示订单详情模态框
function showOrderDetailsModal(orderData) {
  const modalHtml = `
    <div class="modal fade" id="orderDetailsModal" tabindex="-1">
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title">订单详情</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <div class="mb-3">
              <strong>订单ID：</strong>
              <span>${orderData.id}</span>
            </div>
            <div class="mb-3">
              <strong>创建时间：</strong>
              <span>${new Date(orderData.createdAt).toLocaleString()}</span>
            </div>
            <div class="mb-3">
              <strong>金额：</strong>
              <span>${orderData.amount} USDT</span>
            </div>
            <div class="mb-3">
              <strong>LP地址：</strong>
              <span>${orderData.lpAddress}</span>
            </div>
            <div class="mb-3">
              <strong>状态：</strong>
              <span class="badge ${getStatusClass(orderData.status)}">${getStatusText(orderData.status)}</span>
            </div>
            ${orderData.txHash ? `
              <div class="mb-3">
                <strong>交易哈希：</strong>
                <a href="${getExplorerUrl(orderData.txHash)}" target="_blank">${orderData.txHash}</a>
              </div>
            ` : ''}
            ${orderData.error ? `
              <div class="mb-3">
                <strong>错误信息：</strong>
                <span class="text-danger">${orderData.error}</span>
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    </div>
  `;

  // 移除可能存在的旧模态框
  const oldModal = document.getElementById('orderDetailsModal');
  if (oldModal) {
    oldModal.remove();
  }

  // 添加新模态框
  document.body.insertAdjacentHTML('beforeend', modalHtml);

  // 显示模态框
  const modal = new bootstrap.Modal(document.getElementById('orderDetailsModal'));
  modal.show();
}

// 获取区块浏览器URL
function getExplorerUrl(txHash) {
  // 这里需要根据实际使用的网络返回对应的区块浏览器URL
  return `https://explorer.somnia.network/tx/${txHash}`;
} 