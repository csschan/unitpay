/**
 * Solana钱包适配器
 * 实现与Phantom钱包的交互
 */

class SolanaAdapter {
  constructor() {
    this.connection = null;
    this.address = null;
    this.isConnected = false;
    
    // 绑定方法
    this.handleConnect = this.handleConnect.bind(this);
    this.handleDisconnect = this.handleDisconnect.bind(this);
    this.handleAccountChange = this.handleAccountChange.bind(this);
    
    // 初始化
    this.init();
  }
  
  /**
   * 初始化适配器
   */
  init() {
    try {
      if (window.solana && window.solana.isPhantom) {
        // 连接到Solana网络
        this.connection = new window.solanaWeb3.Connection(
          window.solanaWeb3.clusterApiUrl('devnet')
        );
        
        // 设置事件监听器
        window.solana.on('connect', this.handleConnect);
        window.solana.on('disconnect', this.handleDisconnect);
        window.solana.on('accountChanged', this.handleAccountChange);
        
        console.log('Solana适配器初始化成功');
      }
    } catch (error) {
      console.error('初始化Solana适配器失败:', error);
    }
  }
  
  /**
   * 获取钱包名称
   */
  getName() {
    return 'Phantom';
  }
  
  /**
   * 获取钱包图标
   */
  getIcon() {
    return 'https://raw.githubusercontent.com/phantom-labs/brand/master/Phantom%20Icon/SVG/Phantom_Icon_Purple.svg';
  }
  
  /**
   * 检查钱包是否可用
   */
  isAvailable() {
    return window.solana && window.solana.isPhantom;
  }
  
  /**
   * 检查是否已连接
   */
  isConnected() {
    return this.isConnected;
  }
  
  /**
   * 获取钱包地址
   */
  getAddress() {
    return this.address;
  }
  
  /**
   * 获取连接对象
   */
  getConnection() {
    return this.connection;
  }
  
  /**
   * 连接钱包
   */
  async connect() {
    try {
      if (!this.isAvailable()) {
        throw new Error('请安装Phantom钱包');
      }
      
      // 请求连接
      const resp = await window.solana.connect();
      this.address = resp.publicKey.toString();
      this.isConnected = true;
      
      return {
        success: true,
        address: this.address
      };
    } catch (error) {
      console.error('连接Phantom失败:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * 断开连接
   */
  async disconnect() {
    try {
      await window.solana.disconnect();
      this.address = null;
      this.isConnected = false;
      
      return true;
    } catch (error) {
      console.error('断开Phantom连接失败:', error);
      return false;
    }
  }
  
  /**
   * 获取代币余额
   */
  async getBalance(tokenAddress) {
    try {
      if (!this.isConnected) {
        throw new Error('钱包未连接');
      }
      
      if (!tokenAddress) {
        // 获取SOL余额
        const balance = await this.connection.getBalance(
          new window.solanaWeb3.PublicKey(this.address)
        );
        return (balance / window.solanaWeb3.LAMPORTS_PER_SOL).toFixed(4);
      } else {
        // 获取代币余额
        const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
          new window.solanaWeb3.PublicKey(this.address),
          {
            mint: new window.solanaWeb3.PublicKey(tokenAddress)
          }
        );
        
        if (tokenAccounts.value.length === 0) {
          return '0.00';
        }
        
        const accountInfo = tokenAccounts.value[0].account.data.parsed.info;
        return (accountInfo.tokenAmount.uiAmount || 0).toFixed(2);
      }
    } catch (error) {
      console.error('获取余额失败:', error);
      throw error;
    }
  }
  
  /**
   * 发送交易
   */
  async sendTransaction(to, amount, options = {}) {
    try {
      if (!this.isConnected) {
        throw new Error('钱包未连接');
      }
      
      const transaction = new window.solanaWeb3.Transaction().add(
        window.solanaWeb3.SystemProgram.transfer({
          fromPubkey: new window.solanaWeb3.PublicKey(this.address),
          toPubkey: new window.solanaWeb3.PublicKey(to),
          lamports: amount * window.solanaWeb3.LAMPORTS_PER_SOL
        })
      );
      
      // 获取最新的区块哈希
      const { blockhash } = await this.connection.getRecentBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = new window.solanaWeb3.PublicKey(this.address);
      
      // 发送交易
      const signed = await window.solana.signAndSendTransaction(transaction);
      
      return {
        success: true,
        hash: signed.signature
      };
    } catch (error) {
      console.error('发送交易失败:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
  
  /**
   * 签名消息
   */
  async signMessage(message) {
    try {
      if (!this.isConnected) {
        throw new Error('钱包未连接');
      }
      
      const encodedMessage = new TextEncoder().encode(message);
      const signedMessage = await window.solana.signMessage(
        encodedMessage,
        'utf8'
      );
      
      return signedMessage.signature;
    } catch (error) {
      console.error('签名消息失败:', error);
      throw error;
    }
  }
  
  /**
   * 获取链信息
   */
  async getChainInfo() {
    try {
      if (!this.isConnected) {
        throw new Error('钱包未连接');
      }
      
      const version = await this.connection.getVersion();
      return {
        chainId: 'solana',
        name: 'Solana',
        version: version['solana-core']
      };
    } catch (error) {
      console.error('获取链信息失败:', error);
      throw error;
    }
  }
  
  /**
   * 处理连接事件
   */
  handleConnect(publicKey) {
    this.address = publicKey.toString();
    this.isConnected = true;
    
    // 触发地址变更事件
    window.dispatchEvent(new CustomEvent('walletAddressChanged', {
      detail: { address: this.address }
    }));
  }
  
  /**
   * 处理断开连接事件
   */
  handleDisconnect() {
    this.disconnect();
  }
  
  /**
   * 处理账户变更事件
   */
  handleAccountChange(publicKey) {
    if (publicKey) {
      this.address = publicKey.toString();
      
      // 触发地址变更事件
      window.dispatchEvent(new CustomEvent('walletAddressChanged', {
        detail: { address: this.address }
      }));
    } else {
      this.disconnect();
    }
  }
}

// 注册适配器
window.SolanaAdapter = SolanaAdapter; 