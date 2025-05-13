// Somnia网络配置
const NETWORK_CONFIG = {
  chainId: 50312,
  chainName: 'Somnia Shannon Testnet',
  rpcUrls: ['https://dream-rpc.somnia.network'],
  nativeCurrency: {
    name: 'Somnia Token',
    symbol: 'STT',
    decimals: 18
  },
  blockExplorerUrls: [
    'https://shannon-explorer.somnia.network',
    'https://somnia-testnet.socialscan.io'
  ]
};

// 工具函数：获取网络配置
function getNetworkConfig() {
  return NETWORK_CONFIG;
}

// 工具函数：十进制转十六进制字符串
function toHexChainId(chainId) {
  try {
    if (!chainId) return null;
    return '0x' + Number(chainId).toString(16);
  } catch (error) {
    console.error('十进制转十六进制失败:', error);
    return '0xC478'; // 默认值，50312的十六进制
  }
}

// 工具函数：十六进制字符串转十进制
function toDecimalChainId(hexString) {
  try {
    if (!hexString) return null;
    if (typeof hexString === 'number') return hexString;
    
    let hexStr = hexString;
    if (!hexStr.startsWith('0x')) {
      hexStr = '0x' + hexStr;
    }
    return parseInt(hexStr, 16);
  } catch (error) {
    console.error('十六进制转十进制失败:', error);
    return 50312; // 默认值
  }
}

// 工具函数：检查chainId是否匹配
function isValidChainId(chainId) {
  try {
    return toDecimalChainId(chainId) === NETWORK_CONFIG.chainId;
  } catch (error) {
    console.error('检查chainId匹配失败:', error);
    return false;
  }
}

// 工具函数：获取区块浏览器URL
function getExplorerUrl(txHash) {
  try {
    return `${NETWORK_CONFIG.blockExplorerUrls[0]}/tx/${txHash}`;
  } catch (error) {
    console.error('获取区块浏览器URL失败:', error);
    return `https://shannon-explorer.somnia.network/tx/${txHash}`;
  }
}

// 确保网络配置立即生效
function initNetworkConfig() {
  try {
    console.log('初始化网络配置');
    // 浏览器环境
    window.NETWORK_CONFIG = NETWORK_CONFIG;
    
    // 确保 config 对象存在
    if (typeof window.config === 'undefined') {
      window.config = {};
    }
    
    // 确保 somnia 配置存在
    if (typeof window.config.somnia === 'undefined') {
      window.config.somnia = {};
    }
    
    // 强制更新配置
    const hexChainId = toHexChainId(NETWORK_CONFIG.chainId);
    window.config.somnia = {
      ...window.config.somnia,
      CHAIN_ID: hexChainId,
      CHAIN_ID_DECIMAL: NETWORK_CONFIG.chainId,
      CHAIN_NAME: NETWORK_CONFIG.chainName,
      RPC_URL: NETWORK_CONFIG.rpcUrls[0],
      BLOCK_EXPLORER: NETWORK_CONFIG.blockExplorerUrls[0],
      NATIVE_CURRENCY: NETWORK_CONFIG.nativeCurrency
    };
    
    // 确保工具函数可用
    window.getNetworkConfig = getNetworkConfig;
    window.toHexChainId = toHexChainId;
    window.toDecimalChainId = toDecimalChainId;
    window.isValidChainId = isValidChainId;
    window.getExplorerUrl = getExplorerUrl;
    
    console.log('网络配置初始化完成:', window.config.somnia);
    return true;
  } catch (error) {
    console.error('初始化网络配置失败:', error);
    return false;
  }
}

// 根据运行环境导出配置
if (typeof window !== 'undefined') {
  // 初始化配置
  initNetworkConfig();
  
  // 确保配置总是可用，即使脚本加载顺序有问题
  document.addEventListener('DOMContentLoaded', function() {
    if (!window.config || !window.config.somnia || !window.config.somnia.CHAIN_ID) {
      console.warn('DOMContentLoaded: 配置未正确初始化，正在尝试重新初始化');
      initNetworkConfig();
    }
  });
  
  // 额外的安全检查
  setTimeout(function() {
    if (!window.config || !window.config.somnia || !window.config.somnia.CHAIN_ID) {
      console.warn('延迟检查: 配置未正确初始化，正在尝试重新初始化');
      initNetworkConfig();
    }
  }, 500);
  
} else {
  // Node.js 环境
  module.exports = {
    NETWORK_CONFIG,
    getNetworkConfig,
    toHexChainId,
    toDecimalChainId,
    isValidChainId,
    getExplorerUrl
  };
} 